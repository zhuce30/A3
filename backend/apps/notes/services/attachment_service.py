from __future__ import annotations

import hashlib
import html.parser
import io
import os
import re
import stat
import tempfile
import unicodedata
import urllib.parse
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment
from backend.apps.notes.services.link_fetcher import SafeLinkError, fetch_safe_link


MAX_ATTACHMENTS_PER_NOTE = 30
MAX_ARCHIVE_ENTRIES = 10_000
MAX_ARCHIVE_RATIO = 200

OFFICE_MIMES = {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
ALLOWED_TYPES = {
    ".pdf": {"application/pdf"},
    ".docx": {OFFICE_MIMES[".docx"]},
    ".pptx": {OFFICE_MIMES[".pptx"]},
    ".xlsx": {OFFICE_MIMES[".xlsx"]},
    ".txt": {"text/plain"},
    ".md": {"text/markdown", "text/plain", "text/x-markdown"},
    ".markdown": {"text/markdown", "text/plain", "text/x-markdown"},
    ".png": {"image/png"},
    ".jpg": {"image/jpeg"},
    ".jpeg": {"image/jpeg"},
    ".webp": {"image/webp"},
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
OFFICE_ROOTS = {".docx": "word/document.xml", ".pptx": "ppt/presentation.xml", ".xlsx": "xl/workbook.xml"}
ACTIVE_OFFICE_PARTS = ("vbaproject", "activex/", "embeddings/", "oleobject")
EXECUTABLE_SIGNATURES = (b"MZ", b"\x7fELF", b"\xfe\xed\xfa", b"\xcf\xfa\xed\xfe")


class AttachmentServiceError(Exception):
    def __init__(self, message: str, *, code: str = "invalid_attachment", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class AttachmentNotFound(AttachmentServiceError):
    def __init__(self, message: str = "附件不存在") -> None:
        super().__init__(message, code="not_found", status=404)


def serialize_attachment(attachment: NoteAttachment) -> dict[str, Any]:
    return {
        "id": str(attachment.id),
        "noteId": str(attachment.note_id),
        "kind": attachment.kind,
        "displayName": attachment.display_name,
        "mimeType": attachment.mime_type,
        "sizeBytes": attachment.size_bytes,
        "parseStatus": attachment.parse_status,
        "parseGeneration": attachment.parse_generation,
        "parseStartedAt": attachment.parse_started_at.isoformat() if attachment.parse_started_at else None,
        "errorCode": attachment.error_code,
        "errorMessage": attachment.error_message,
        "createdAt": attachment.created_at.isoformat() if attachment.created_at else None,
        "updatedAt": attachment.updated_at.isoformat() if attachment.updated_at else None,
    }


def get_owned_note(user, note_id) -> Note:
    try:
        return Note.objects.get(user=user, pk=note_id, deleted_at__isnull=True)
    except (Note.DoesNotExist, ValueError) as exc:
        raise AttachmentNotFound("笔记不存在") from exc


def get_owned_attachment(user, attachment_id, *, lock: bool = False) -> NoteAttachment:
    queryset = NoteAttachment.objects.select_for_update() if lock else NoteAttachment.objects
    try:
        return queryset.select_related("note").get(
            user=user,
            pk=attachment_id,
            deleted_at__isnull=True,
            note__deleted_at__isnull=True,
        )
    except (NoteAttachment.DoesNotExist, ValueError) as exc:
        raise AttachmentNotFound() from exc


def _safe_filename(value: Any) -> tuple[str, str]:
    if not isinstance(value, str):
        raise AttachmentServiceError("附件名称无效", code="invalid_attachment_name")
    normalized = unicodedata.normalize("NFKC", value).strip()
    if (
        not normalized
        or len(normalized) > 255
        or normalized in {".", ".."}
        or "/" in normalized
        or "\\" in normalized
        or any(ord(char) < 32 or ord(char) == 127 for char in normalized)
    ):
        raise AttachmentServiceError("附件名称无效", code="invalid_attachment_name")
    suffix = Path(normalized).suffix.lower()
    if suffix not in ALLOWED_TYPES:
        raise AttachmentServiceError("不支持该附件类型", code="unsupported_attachment_type")
    stem = Path(normalized).stem.strip().strip(".") or "attachment"
    stem = re.sub(r"[^\w .()-]", "_", stem, flags=re.UNICODE).strip(" .") or "attachment"
    safe_name = f"{stem[:220]}{suffix}"
    return safe_name, suffix


def validate_attachment_filename(value: Any) -> str:
    """Validate an unsanitized client filename at service boundaries."""
    return _safe_filename(value)[0]


def _read_upload(upload) -> bytes:
    maximum = int(settings.A3_NOTES_ATTACHMENT_MAX_BYTES)
    declared_size = getattr(upload, "size", None)
    if declared_size is not None and declared_size > maximum:
        raise AttachmentServiceError("附件超过大小限制", code="attachment_too_large", status=413)
    chunks: list[bytes] = []
    total = 0
    for chunk in upload.chunks():
        total += len(chunk)
        if total > maximum:
            raise AttachmentServiceError("附件超过大小限制", code="attachment_too_large", status=413)
        chunks.append(chunk)
    return b"".join(chunks)


def _validate_signature(suffix: str, content: bytes) -> None:
    if any(content.startswith(signature) for signature in EXECUTABLE_SIGNATURES):
        raise AttachmentServiceError("附件包含不安全内容", code="unsafe_attachment_content")
    signatures = {
        ".pdf": content.startswith(b"%PDF-"),
        ".png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        ".jpg": content.startswith(b"\xff\xd8\xff"),
        ".jpeg": content.startswith(b"\xff\xd8\xff"),
        ".webp": len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP",
    }
    if suffix in signatures and not signatures[suffix]:
        raise AttachmentServiceError("附件内容与扩展名不一致", code="attachment_signature_mismatch")
    if suffix in OFFICE_MIMES:
        _validate_office_container(suffix, content)
    elif suffix in {".txt", ".md", ".markdown"}:
        if b"\x00" in content[:8192]:
            raise AttachmentServiceError("文本附件包含无效二进制内容", code="attachment_signature_mismatch")
        try:
            content[:8192].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AttachmentServiceError("文本附件必须使用 UTF-8 编码", code="attachment_signature_mismatch") from exc


def _validate_office_container(suffix: str, content: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            infos = archive.infolist()
            names = {info.filename.replace("\\", "/").lstrip("/") for info in infos}
            if len(infos) > MAX_ARCHIVE_ENTRIES or OFFICE_ROOTS[suffix] not in names or "[Content_Types].xml" not in names:
                raise ValueError("invalid office structure")
            total_uncompressed = 0
            archive_limit = max(int(settings.A3_NOTES_ATTACHMENT_MAX_BYTES) * 10, 2 * 1024 * 1024)
            for info in infos:
                path = PurePosixPath(info.filename.replace("\\", "/"))
                lowered = str(path).lower().lstrip("/")
                if path.is_absolute() or ".." in path.parts or info.flag_bits & 0x1:
                    raise ValueError("unsafe archive entry")
                if stat.S_ISLNK(info.external_attr >> 16) or any(marker in lowered for marker in ACTIVE_OFFICE_PARTS):
                    raise ValueError("active office content")
                total_uncompressed += info.file_size
                if total_uncompressed > archive_limit:
                    raise ValueError("decompression limit")
                if info.compress_size == 0 and info.file_size > 0:
                    raise ValueError("invalid compression ratio")
                if info.compress_size and info.file_size / info.compress_size > MAX_ARCHIVE_RATIO:
                    raise ValueError("compression ratio")
            content_types = archive.read("[Content_Types].xml").lower()
            if OFFICE_MIMES[suffix].encode("ascii") not in content_types:
                raise ValueError("office content type mismatch")
            if b"macroenabled" in content_types or b"vbaproject" in content_types:
                raise ValueError("macro content type")
            for info in infos:
                if info.filename.lower().endswith(".rels") and info.file_size <= 1024 * 1024:
                    relationships = archive.read(info).lower()
                    if b'targetmode="external"' in relationships and b"/hyperlink" not in relationships:
                        raise ValueError("external active relationship")
    except (zipfile.BadZipFile, KeyError, ValueError, RuntimeError) as exc:
        raise AttachmentServiceError("Office 附件结构不安全或已损坏", code="unsafe_office_document") from exc


def _validate_declared_mime(suffix: str, declared_mime: str) -> str:
    normalized = str(declared_mime or "").split(";", 1)[0].strip().lower()
    if normalized not in ALLOWED_TYPES[suffix]:
        raise AttachmentServiceError("附件 MIME 类型与扩展名不一致", code="attachment_mime_mismatch")
    return OFFICE_MIMES.get(suffix, "text/markdown" if suffix in {".md", ".markdown"} else normalized)


def storage_root() -> Path:
    root = Path(settings.A3_NOTES_STORAGE_ROOT).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _user_storage_uuid(user) -> uuid.UUID:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"urn:a3:personal-notes:user:{user.pk}")


def resolve_relative_path(relative_path: str, *, require_file: bool = False) -> Path:
    pure = PurePosixPath(str(relative_path))
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        raise AttachmentNotFound()
    root = storage_root()
    candidate = root.joinpath(*pure.parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise AttachmentNotFound() from exc
    if require_file and (not candidate.is_file() or candidate.is_symlink()):
        raise AttachmentNotFound()
    return candidate


def _check_capacity(user, note: Note, incoming_bytes: int) -> None:
    get_user_model().objects.select_for_update().get(pk=user.pk)
    active = NoteAttachment.objects.filter(user=user, deleted_at__isnull=True)
    if active.filter(note=note).count() >= MAX_ATTACHMENTS_PER_NOTE:
        raise AttachmentServiceError("每条笔记最多可保留 30 个附件", code="attachment_count_exceeded", status=409)
    physically_stored = NoteAttachment.objects.filter(
        user=user,
        kind__in=[NoteAttachment.Kind.FILE, NoteAttachment.Kind.IMAGE],
    ).exclude(relative_path="")
    used = physically_stored.aggregate(total=Sum("size_bytes"))["total"] or 0
    if used + incoming_bytes > int(settings.A3_NOTES_USER_QUOTA_BYTES):
        raise AttachmentServiceError("个人附件空间不足", code="attachment_quota_exceeded", status=409)


def create_file_attachment(user, note_id, upload) -> NoteAttachment:
    note = get_owned_note(user, note_id)
    safe_name, suffix = _safe_filename(getattr(upload, "name", ""))
    content = _read_upload(upload)
    mime_type = _validate_declared_mime(suffix, getattr(upload, "content_type", ""))
    _validate_signature(suffix, content)
    attachment_id = uuid.uuid4()
    relative_path = PurePosixPath(
        str(_user_storage_uuid(user)), str(note.pk), str(attachment_id), safe_name
    ).as_posix()
    final_path = resolve_relative_path(relative_path)
    final_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=final_path.parent, prefix=".upload-", delete=False) as temporary:
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        try:
            with transaction.atomic():
                _check_capacity(user, note, len(content))
                os.replace(temporary_path, final_path)
                temporary_path = None
                return NoteAttachment.objects.create(
                    id=attachment_id,
                    user=user,
                    note=note,
                    kind=NoteAttachment.Kind.IMAGE if suffix in IMAGE_EXTENSIONS else NoteAttachment.Kind.FILE,
                    display_name=safe_name,
                    relative_path=relative_path,
                    mime_type=mime_type,
                    size_bytes=len(content),
                    sha256=hashlib.sha256(content).hexdigest(),
                )
        except Exception:
            final_path.unlink(missing_ok=True)
            raise
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def create_link_attachment(user, note_id, data: dict[str, Any]) -> NoteAttachment:
    note = get_owned_note(user, note_id)
    url = data.get("url")
    try:
        fetched = fetch_safe_link(url)
    except SafeLinkError as exc:
        raise AttachmentServiceError(str(exc), code=exc.code) from exc
    display_name = data.get("displayName") or urllib.parse.urlsplit(fetched.final_url).hostname or "网页链接"
    if not isinstance(display_name, str) or not display_name.strip() or len(display_name.strip()) > 255:
        raise AttachmentServiceError("链接名称无效", code="invalid_attachment_name")
    extracted_text = _decode_web_body(
        fetched.body,
        fetched.mime_type,
        maximum=int(settings.A3_NOTES_EXTRACTED_TEXT_MAX_CHARS),
    )
    with transaction.atomic():
        _check_capacity(user, note, 0)
        if not Note.objects.filter(user=user, pk=note.pk, deleted_at__isnull=True).exists():
            raise AttachmentNotFound("笔记不存在")
        return NoteAttachment.objects.create(
            user=user,
            note=note,
            kind=NoteAttachment.Kind.LINK,
            display_name=unicodedata.normalize("NFKC", display_name).strip(),
            source_url=fetched.final_url,
            mime_type=fetched.mime_type,
            size_bytes=0,
            sha256=hashlib.sha256(fetched.body).hexdigest(),
            parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            extracted_text=extracted_text,
            preview_metadata={"parser": "safe_link", "truncated": len(extracted_text) >= int(settings.A3_NOTES_EXTRACTED_TEXT_MAX_CHARS)},
        )


def soft_delete_attachment(user, attachment_id) -> NoteAttachment:
    with transaction.atomic():
        attachment = get_owned_attachment(user, attachment_id, lock=True)
        attachment.deleted_at = timezone.now()
        attachment.save(update_fields={"deleted_at", "updated_at"})
        return attachment


def reset_attachment_for_reparse(user, attachment_id) -> NoteAttachment:
    with transaction.atomic():
        attachment = get_owned_attachment(user, attachment_id, lock=True)
        attachment.parse_generation += 1
        attachment.parse_status = NoteAttachment.ParseStatus.PENDING
        attachment.parse_started_at = None
        attachment.extracted_text = ""
        attachment.error_code = ""
        attachment.error_message = ""
        attachment.preview_metadata = {}
        attachment.save(update_fields={
            "parse_generation", "parse_status", "parse_started_at", "extracted_text",
            "error_code", "error_message", "preview_metadata", "updated_at"
        })
        return attachment


class _TextExtractor(html.parser.HTMLParser):
    def __init__(self, maximum: int) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden_depth = 0
        self.maximum = max(0, int(maximum))
        self.length = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript"}:
            self.hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.hidden_depth:
            self.hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        text = data.strip()
        if self.hidden_depth or not text or self.length >= self.maximum:
            return
        prefix = "\n" if self.parts else ""
        remaining = self.maximum - self.length
        value = (prefix + text)[:remaining]
        self.parts.append(value)
        self.length += len(value)


def _decode_web_body(body: bytes, mime_type: str, *, maximum: int) -> str:
    text = body.decode("utf-8", errors="replace")
    if mime_type in {"text/html", "application/xhtml+xml"}:
        parser = _TextExtractor(maximum)
        parser.feed(text)
        return "".join(parser.parts)
    return text[:maximum]


def extract_attachment_text(attachment: NoteAttachment) -> tuple[str, dict[str, Any]]:
    maximum = int(settings.A3_NOTES_EXTRACTED_TEXT_MAX_CHARS)
    if attachment.kind == NoteAttachment.Kind.LINK:
        try:
            fetched = fetch_safe_link(attachment.source_url)
        except SafeLinkError as exc:
            raise AttachmentServiceError(str(exc), code=exc.code) from exc
        text = _decode_web_body(fetched.body, fetched.mime_type, maximum=maximum)
        return text, {"truncated": len(text) >= maximum, "parser": "safe_link"}
    path = resolve_relative_path(attachment.relative_path, require_file=True)
    mime_type = str(attachment.mime_type or "").split(";", 1)[0].strip().lower()
    from backend.domains.knowledge_base.attachment_text_parser import parse_attachment_text

    result = parse_attachment_text(path, mime_type, max_chars=maximum)
    return result.text, result.metadata


def parse_and_persist_attachment(attachment: NoteAttachment, expected_generation: int) -> dict[str, Any]:
    text, metadata = extract_attachment_text(attachment)
    updated = NoteAttachment.objects.filter(
        pk=attachment.pk,
        deleted_at__isnull=True,
        parse_generation=expected_generation,
        parse_status=NoteAttachment.ParseStatus.PROCESSING,
    ).update(
        parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
        parse_started_at=None,
        extracted_text=text,
        preview_metadata=metadata,
        error_code="",
        error_message="",
        updated_at=timezone.now(),
    )
    if not updated:
        return {"skipped": True, "attachmentId": str(attachment.pk)}
    return {"status": "succeeded", "attachmentId": str(attachment.pk)}
