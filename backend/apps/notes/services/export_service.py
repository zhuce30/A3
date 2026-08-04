from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteExportJob
from backend.apps.notes.services.attachment_service import AttachmentNotFound, resolve_relative_path, storage_root


EXPORT_SCHEMA_VERSION = "a3.personal-notes-export.v1"
EXPORT_RETENTION = timedelta(hours=24)
COPY_CHUNK_SIZE = 1024 * 1024


class ExportServiceError(Exception):
    def __init__(self, message: str, *, code: str = "export_error", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class ExportNotFound(ExportServiceError):
    def __init__(self) -> None:
        super().__init__("导出任务不存在", code="export_not_found", status=404)


class ExportBuildError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ExportDownload:
    file: BinaryIO
    filename: str


def _normalize_note_ids(note_ids: Any) -> list[uuid.UUID]:
    if not isinstance(note_ids, list) or not note_ids or len(note_ids) > 100:
        raise ExportServiceError("noteIds 必须是包含 1 到 100 个笔记 ID 的数组", code="invalid_note_ids")
    normalized: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    for value in note_ids:
        try:
            identifier = uuid.UUID(str(value))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ExportServiceError("noteIds 包含无效的笔记 ID", code="invalid_note_ids") from exc
        if identifier not in seen:
            normalized.append(identifier)
            seen.add(identifier)
    return normalized


def _attachment_snapshot(attachment: NoteAttachment) -> dict[str, Any]:
    return {
        "id": str(attachment.id),
        "displayName": attachment.display_name,
        "relativePath": attachment.relative_path,
        "mimeType": attachment.mime_type,
        "sizeBytes": int(attachment.size_bytes),
        "sha256": attachment.sha256,
    }


@transaction.atomic
def create_export_job(*, user, note_ids: Any, format: str) -> NoteExportJob:
    if format not in NoteExportJob.Format.values:
        raise ExportServiceError("format 仅支持 markdown_zip 或 json_zip", code="invalid_export_format")
    identifiers = _normalize_note_ids(note_ids)
    notes_by_id = {
        note.id: note
        for note in Note.objects.filter(user=user, id__in=identifiers, deleted_at__isnull=True)
    }
    selected = [notes_by_id[identifier] for identifier in identifiers if identifier in notes_by_id]
    if not selected:
        raise ExportServiceError("没有可导出的笔记", code="no_exportable_notes")
    attachments_by_note: dict[uuid.UUID, list[NoteAttachment]] = {}
    attachments = NoteAttachment.objects.filter(
        user=user,
        note_id__in=[note.id for note in selected],
        note__deleted_at__isnull=True,
        deleted_at__isnull=True,
        kind__in=[NoteAttachment.Kind.FILE, NoteAttachment.Kind.IMAGE],
    ).order_by("created_at", "id")
    for attachment in attachments:
        attachments_by_note.setdefault(attachment.note_id, []).append(attachment)
    snapshot = {
        "schemaVersion": EXPORT_SCHEMA_VERSION,
        "notes": [
            {
                "id": str(note.id),
                "version": int(note.version),
                "title": note.title,
                "content": note.content_json,
                "contentText": note.content_text,
                "attachments": [
                    _attachment_snapshot(item) for item in attachments_by_note.get(note.id, [])
                ],
            }
            for note in selected
        ],
    }
    return NoteExportJob.objects.create(
        user=user,
        format=format,
        selection_snapshot=snapshot,
        expires_at=timezone.now() + EXPORT_RETENTION,
    )


def get_owned_export(user, job_id) -> NoteExportJob:
    try:
        return NoteExportJob.objects.get(user=user, pk=job_id)
    except (NoteExportJob.DoesNotExist, ValueError) as exc:
        raise ExportNotFound() from exc


def serialize_export(job: NoteExportJob) -> dict[str, Any]:
    notes = job.selection_snapshot.get("notes", []) if isinstance(job.selection_snapshot, dict) else []
    return {
        "id": str(job.id),
        "status": job.status,
        "format": job.format,
        "selection": {"noteCount": len(notes)},
        "deferred": job.status == NoteExportJob.Status.QUEUED and bool(job.error_code),
        "enqueueAttempts": int(job.enqueue_attempts),
        "sizeBytes": int(job.output_size_bytes),
        "sha256": job.output_sha256,
        "errorCode": job.error_code,
        "errorMessage": job.error_message,
        "expiresAt": job.expires_at.isoformat() if job.expires_at else None,
        "createdAt": job.created_at.isoformat(),
        "updatedAt": job.updated_at.isoformat(),
    }


def _safe_name(value: Any, fallback: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip()
    normalized = re.sub(r"[\\/:*?\"<>|\x00-\x1f\x7f]", "_", normalized)
    normalized = normalized.strip(" .")
    if normalized in {"", ".", ".."}:
        normalized = fallback
    return normalized[:180]


def _dedupe_path(path: PurePosixPath, used: set[str]) -> PurePosixPath:
    candidate = path
    counter = 2
    while unicodedata.normalize("NFKC", candidate.as_posix()).casefold() in used:
        candidate = path.with_name(f"{path.stem} ({counter}){path.suffix}")
        counter += 1
    used.add(unicodedata.normalize("NFKC", candidate.as_posix()).casefold())
    return candidate


def _zip_info(name: str) -> zipfile.ZipInfo:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ExportBuildError("export_unsafe_path", "导出路径不安全")
    info = zipfile.ZipInfo(path.as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    info.create_system = 3
    return info


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _safe_export_destination(relative: PurePosixPath) -> Path:
    root = storage_root()
    try:
        resolve_relative_path(relative.as_posix())
    except AttachmentNotFound as exc:
        raise ExportBuildError("export_unsafe_path", "导出目录不安全") from exc
    current = root
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink() or bool(getattr(current, "is_junction", lambda: False)()):
            raise ExportBuildError("export_unsafe_path", "导出目录不安全")
        current.mkdir(exist_ok=True)
        try:
            current.resolve().relative_to(root)
        except ValueError as exc:
            raise ExportBuildError("export_unsafe_path", "导出目录不安全") from exc
    final_path = current / relative.name
    if final_path.is_symlink() or bool(getattr(final_path, "is_junction", lambda: False)()):
        raise ExportBuildError("export_unsafe_path", "导出路径不安全")
    try:
        return resolve_relative_path(relative.as_posix())
    except AttachmentNotFound as exc:
        raise ExportBuildError("export_unsafe_path", "导出路径不安全") from exc


def _claim_job(
    job_id: str,
    expected_generation: int | None = None,
    expected_lease_token: str | None = None,
) -> NoteExportJob | None:
    with transaction.atomic():
        try:
            job = NoteExportJob.objects.select_for_update().get(pk=job_id)
        except (NoteExportJob.DoesNotExist, ValueError):
            return None
        if job.status == NoteExportJob.Status.SUCCEEDED:
            return job
        if job.status != NoteExportJob.Status.QUEUED:
            return None
        if expected_generation is not None or expected_lease_token is not None:
            try:
                lease_token = uuid.UUID(str(expected_lease_token))
                generation = int(expected_generation)
            except (TypeError, ValueError, AttributeError):
                return None
            if job.run_generation != generation or job.run_lease_token != lease_token:
                return None
        else:
            if job.run_lease_token is None:
                job.run_generation += 1
                job.run_lease_token = uuid.uuid4()
        if job.expires_at and job.expires_at <= timezone.now():
            job.status = NoteExportJob.Status.EXPIRED
            job.run_lease_token = None
            job.run_started_at = None
            job.error_code = "export_expired"
            job.error_message = "导出文件已过期"
            job.save(update_fields={
                "status", "run_lease_token", "run_started_at",
                "error_code", "error_message", "updated_at",
            })
            return None
        job.status = NoteExportJob.Status.PROCESSING
        job.run_started_at = timezone.now()
        job.error_code = ""
        job.error_message = ""
        job.save(update_fields={
            "status", "run_generation", "run_lease_token", "run_started_at",
            "error_code", "error_message", "updated_at",
        })
        return job


def _validate_snapshot(job: NoteExportJob) -> list[dict[str, Any]]:
    snapshot = job.selection_snapshot
    notes = snapshot.get("notes") if isinstance(snapshot, dict) else None
    if snapshot.get("schemaVersion") != EXPORT_SCHEMA_VERSION or not isinstance(notes, list) or not notes:
        raise ExportBuildError("export_snapshot_invalid", "导出快照无效")
    note_ids: list[uuid.UUID] = []
    for item in notes:
        try:
            note_ids.append(uuid.UUID(str(item["id"])))
            int(item["version"])
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ExportBuildError("export_snapshot_invalid", "导出快照无效") from exc
    active_ids = set(
        Note.objects.filter(user_id=job.user_id, id__in=note_ids, deleted_at__isnull=True)
        .values_list("id", flat=True)
    )
    if active_ids != set(note_ids):
        raise ExportBuildError("export_snapshot_unavailable", "笔记已删除，无法完成该导出")
    return notes


def _write_archive(job: NoteExportJob, notes: list[dict[str, Any]]) -> tuple[str, int, str]:
    maximum_files = int(settings.A3_NOTES_EXPORT_MAX_FILES)
    maximum_bytes = int(settings.A3_NOTES_EXPORT_MAX_BYTES)
    relative = PurePosixPath("exports", str(job.user_id), str(job.id), f"notes-{job.id}.zip")
    final_path = _safe_export_destination(relative)
    temporary_path: Path | None = None
    used: set[str] = {"manifest.json"}
    manifest_notes: list[dict[str, Any]] = []
    logical_bytes = 0
    file_count = 1

    def account(size: int) -> None:
        nonlocal logical_bytes
        logical_bytes += size
        if logical_bytes > maximum_bytes:
            raise ExportBuildError("export_size_limit", "导出内容超过大小限制")

    def reserve_file() -> None:
        nonlocal file_count
        file_count += 1
        if file_count > maximum_files:
            raise ExportBuildError("export_file_limit", "导出文件数量超过限制")

    try:
        with tempfile.NamedTemporaryFile(dir=final_path.parent, prefix=".export-", suffix=".zip", delete=False) as temp:
            temporary_path = Path(temp.name)
        with zipfile.ZipFile(
            temporary_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False
        ) as archive:
            extension = ".md" if job.format == NoteExportJob.Format.MARKDOWN_ZIP else ".json"
            for note in notes:
                note_name = _safe_name(note.get("title"), f"note-{note['id']}")
                note_path = _dedupe_path(PurePosixPath("notes", note_name + extension), used)
                if job.format == NoteExportJob.Format.MARKDOWN_ZIP:
                    note_bytes = (
                        f"# {note.get('title') or '未命名笔记'}\n\n"
                        f"{note.get('contentText') or ''}\n"
                    ).encode("utf-8")
                else:
                    note_bytes = _json_bytes({
                        "schemaVersion": EXPORT_SCHEMA_VERSION,
                        "id": note["id"],
                        "version": int(note["version"]),
                        "title": note.get("title", ""),
                        "content": note.get("content", {}),
                        "contentText": note.get("contentText", ""),
                    })
                reserve_file()
                account(len(note_bytes))
                archive.writestr(_zip_info(note_path.as_posix()), note_bytes)
                del note_bytes

                manifest_attachments: list[dict[str, Any]] = []
                attachments = note.get("attachments", [])
                if not isinstance(attachments, list):
                    raise ExportBuildError("export_snapshot_invalid", "附件快照无效")
                for attachment in attachments:
                    try:
                        attachment_id = uuid.UUID(str(attachment["id"]))
                        expected_size = int(attachment["sizeBytes"])
                    except (KeyError, TypeError, ValueError, AttributeError) as exc:
                        raise ExportBuildError("export_snapshot_invalid", "附件快照无效") from exc
                    current = NoteAttachment.objects.filter(
                        id=attachment_id,
                        user_id=job.user_id,
                        note_id=note["id"],
                        deleted_at__isnull=True,
                        note__deleted_at__isnull=True,
                        kind__in=[NoteAttachment.Kind.FILE, NoteAttachment.Kind.IMAGE],
                    ).first()
                    if current is None or current.relative_path != attachment.get("relativePath"):
                        raise ExportBuildError("export_snapshot_unavailable", "附件已删除或发生变化")
                    try:
                        source_path = resolve_relative_path(current.relative_path, require_file=True)
                    except AttachmentNotFound as exc:
                        raise ExportBuildError("export_attachment_unsafe", "附件路径无效") from exc
                    attachment_name = _safe_name(
                        attachment.get("displayName"), f"attachment-{attachment_id}"
                    )
                    attachment_path = _dedupe_path(
                        PurePosixPath("attachments", note_path.stem, attachment_name), used
                    )
                    reserve_file()
                    digest = hashlib.sha256()
                    copied = 0
                    with source_path.open("rb") as source, archive.open(
                        _zip_info(attachment_path.as_posix()), "w", force_zip64=False
                    ) as target:
                        while True:
                            chunk = source.read(COPY_CHUNK_SIZE)
                            if not chunk:
                                break
                            copied += len(chunk)
                            account(len(chunk))
                            digest.update(chunk)
                            target.write(chunk)
                    expected_sha = str(attachment.get("sha256") or "")
                    if copied != expected_size or (expected_sha and digest.hexdigest() != expected_sha):
                        raise ExportBuildError("export_snapshot_unavailable", "附件内容发生变化")
                    manifest_attachments.append({
                        "id": str(attachment_id),
                        "name": attachment.get("displayName", ""),
                        "mimeType": attachment.get("mimeType", ""),
                        "sizeBytes": expected_size,
                        "sha256": expected_sha,
                        "file": attachment_path.as_posix(),
                    })
                manifest_notes.append({
                    "id": note["id"],
                    "version": int(note["version"]),
                    "title": note.get("title", ""),
                    "file": note_path.as_posix(),
                    "attachments": manifest_attachments,
                })

            manifest_bytes = _json_bytes({
                "schemaVersion": EXPORT_SCHEMA_VERSION,
                "jobId": str(job.id),
                "createdAt": job.created_at.isoformat(),
                "format": job.format,
                "notes": manifest_notes,
            })
            account(len(manifest_bytes))
            archive.writestr(_zip_info("manifest.json"), manifest_bytes)
        size = temporary_path.stat().st_size
        if size > maximum_bytes:
            raise ExportBuildError("export_size_limit", "导出文件超过大小限制")
        digest = hashlib.sha256()
        with temporary_path.open("rb") as source:
            for chunk in iter(lambda: source.read(COPY_CHUNK_SIZE), b""):
                digest.update(chunk)
        os.replace(temporary_path, final_path)
        temporary_path = None
        return relative.as_posix(), size, digest.hexdigest()
    except (zipfile.LargeZipFile, OverflowError) as exc:
        raise ExportBuildError("export_zip64_disallowed", "导出文件超过 ZIP 格式限制") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _result(job: NoteExportJob) -> dict[str, Any]:
    return {"status": job.status, "jobId": str(job.id)}


def build_note_export(
    job_id: str,
    expected_generation: int | None = None,
    expected_lease_token: str | None = None,
) -> dict[str, Any]:
    job = _claim_job(job_id, expected_generation, expected_lease_token)
    if job is None:
        return {"skipped": True, "jobId": str(job_id)}
    if job.status == NoteExportJob.Status.SUCCEEDED:
        return _result(job)
    generation = job.run_generation
    lease_token = job.run_lease_token
    try:
        notes = _validate_snapshot(job)
        relative_path, size, digest = _write_archive(job, notes)
    except ExportBuildError as exc:
        NoteExportJob.objects.filter(
            pk=job.pk,
            status=NoteExportJob.Status.PROCESSING,
            run_generation=generation,
            run_lease_token=lease_token,
        ).update(
            status=NoteExportJob.Status.FAILED,
            run_lease_token=None,
            run_started_at=None,
            relative_path="",
            output_size_bytes=0,
            output_sha256="",
            error_code=exc.code,
            error_message=str(exc),
            updated_at=timezone.now(),
        )
    except Exception:
        NoteExportJob.objects.filter(
            pk=job.pk,
            status=NoteExportJob.Status.PROCESSING,
            run_generation=generation,
            run_lease_token=lease_token,
        ).update(
            status=NoteExportJob.Status.FAILED,
            run_lease_token=None,
            run_started_at=None,
            relative_path="",
            output_size_bytes=0,
            output_sha256="",
            error_code="export_build_failed",
            error_message="导出生成失败，请稍后重试",
            updated_at=timezone.now(),
        )
    else:
        updated = NoteExportJob.objects.filter(
            pk=job.pk,
            status=NoteExportJob.Status.PROCESSING,
            run_generation=generation,
            run_lease_token=lease_token,
        ).update(
            status=NoteExportJob.Status.SUCCEEDED,
            run_lease_token=None,
            run_started_at=None,
            relative_path=relative_path,
            output_size_bytes=size,
            output_sha256=digest,
            error_code="",
            error_message="",
            updated_at=timezone.now(),
        )
        if not updated:
            final_path = _safe_export_destination(PurePosixPath(relative_path))
            final_path.unlink(missing_ok=True)
    job.refresh_from_db()
    return _result(job)


def open_export_download(job: NoteExportJob) -> ExportDownload:
    if job.expires_at and job.expires_at <= timezone.now():
        raise ExportServiceError("导出文件已过期", code="export_expired", status=410)
    if job.status != NoteExportJob.Status.SUCCEEDED:
        raise ExportServiceError("导出任务尚未完成", code="export_not_ready", status=409)
    expected_prefix = PurePosixPath("exports", str(job.user_id), str(job.id))
    relative = PurePosixPath(job.relative_path)
    if relative.parts[:3] != expected_prefix.parts:
        raise ExportNotFound()
    try:
        path = resolve_relative_path(job.relative_path, require_file=True)
        file_handle = path.open("rb")
    except (AttachmentNotFound, FileNotFoundError, OSError) as exc:
        job.refresh_from_db(fields={"status", "expires_at"})
        if job.expires_at and job.expires_at <= timezone.now():
            raise ExportServiceError("导出文件已过期", code="export_expired", status=410) from exc
        if job.status != NoteExportJob.Status.SUCCEEDED:
            raise ExportServiceError("导出任务尚未完成", code="export_not_ready", status=409) from exc
        raise ExportNotFound() from exc
    return ExportDownload(file=file_handle, filename=f"personal-notes-{job.id}.zip")
