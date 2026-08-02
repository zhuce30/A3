from __future__ import annotations

import os
import uuid
from datetime import timedelta
from pathlib import Path, PurePosixPath

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteExportJob
from backend.apps.notes.services.attachment_service import storage_root


def _contained_path(relative_path: str) -> Path | None:
    pure = PurePosixPath(str(relative_path))
    if pure.is_absolute() or not pure.parts or any(part in {"", ".", ".."} for part in pure.parts):
        return None
    root = storage_root()
    lexical = root
    for part in pure.parts:
        lexical = lexical / part
        if lexical.is_symlink() or bool(getattr(lexical, "is_junction", lambda: False)()):
            return None
    resolved = lexical.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def _delete_export_file(relative_path: str, user_id, job_id) -> None:
    pure = PurePosixPath(str(relative_path))
    if pure.parts[:3] != ("exports", str(user_id), str(job_id)):
        return
    path = _contained_path(relative_path)
    if path is None:
        return
    path.unlink(missing_ok=True)
    parent = path.parent
    root = storage_root()
    while parent != root and parent.name in {str(job_id), str(user_id)}:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _attachment_directory(snapshot: tuple[str, str, str, str, str]) -> Path | None:
    kind, relative_path, user_id, note_id, attachment_id = snapshot
    if kind not in {NoteAttachment.Kind.FILE, NoteAttachment.Kind.IMAGE}:
        return None
    pure = PurePosixPath(relative_path)
    expected_user = str(uuid.uuid5(uuid.NAMESPACE_URL, f"urn:a3:personal-notes:user:{user_id}"))
    if len(pure.parts) != 4 or pure.parts[:3] != (
        expected_user,
        note_id,
        attachment_id,
    ):
        return None
    path = _contained_path(PurePosixPath(*pure.parts[:3]).as_posix())
    if path is None or path.is_symlink():
        return None
    return path


def _delete_attachment_directory(snapshot: tuple[str, str, str, str, str]) -> None:
    directory = _attachment_directory(snapshot)
    if directory is None:
        return
    if not directory.exists() or not directory.is_dir():
        return
    try:
        for child in directory.iterdir():
            if bool(getattr(child, "is_junction", lambda: False)()):
                os.rmdir(child)
            elif child.is_symlink() or child.is_file():
                child.unlink()
            else:
                return
        directory.rmdir()
    except OSError:
        return


def register_attachment_cleanup(attachments: list[NoteAttachment]) -> None:
    snapshots = [
        (
            item.kind,
            item.relative_path,
            str(item.user_id),
            str(item.note_id),
            str(item.id),
        )
        for item in attachments
    ]

    def cleanup() -> None:
        for item in snapshots:
            _delete_attachment_directory(item)

    transaction.on_commit(cleanup)


def cleanup_expired_exports(*, now=None, limit: int | None = None) -> dict[str, int]:
    now = now or timezone.now()
    limit = limit or int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    ids = list(
        NoteExportJob.objects.filter(expires_at__lte=now)
        .exclude(status=NoteExportJob.Status.PROCESSING)
        .order_by("expires_at")
        .values_list("id", flat=True)[:limit]
    )
    cleaned = 0
    for job_id in ids:
        with transaction.atomic():
            job = NoteExportJob.objects.select_for_update().filter(pk=job_id).first()
            if job is None or not job.expires_at or job.expires_at > now:
                continue
            relative = job.relative_path
            if relative:
                transaction.on_commit(
                    lambda path=relative, user_id=job.user_id, identifier=job.id: _delete_export_file(
                        path, user_id, identifier
                    )
                )
            job.status = NoteExportJob.Status.EXPIRED
            job.relative_path = ""
            job.output_size_bytes = 0
            job.output_sha256 = ""
            job.error_code = "export_expired"
            job.error_message = "导出文件已过期"
            job.save(update_fields={
                "status", "relative_path", "output_size_bytes", "output_sha256",
                "error_code", "error_message", "updated_at",
            })
            cleaned += 1
    return {"exportsCleaned": cleaned}


def cleanup_trashed_notes(*, now=None, limit: int | None = None) -> dict[str, int]:
    now = now or timezone.now()
    limit = limit or int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    note_cutoff = now - timedelta(days=int(settings.A3_NOTES_TRASH_RETENTION_DAYS))
    attachment_cutoff = now - timedelta(hours=int(settings.A3_NOTES_DELETED_ATTACHMENT_RETENTION_HOURS))
    note_ids = list(
        Note.objects.filter(deleted_at__lte=note_cutoff)
        .order_by("deleted_at").values_list("id", flat=True)[:limit]
    )
    notes_purged = 0
    attachments_purged = 0
    for note_id in note_ids:
        with transaction.atomic():
            note = Note.objects.select_for_update().filter(pk=note_id, deleted_at__lte=note_cutoff).first()
            if note is None:
                continue
            attachments = list(note.attachments.all())
            register_attachment_cleanup(attachments)
            attachments_purged += len(attachments)
            note.delete()
            notes_purged += 1
    remaining = max(0, limit - attachments_purged)
    attachment_ids = list(
        NoteAttachment.objects.filter(deleted_at__lte=attachment_cutoff)
        .order_by("deleted_at").values_list("id", flat=True)[:remaining]
    )
    for attachment_id in attachment_ids:
        with transaction.atomic():
            attachment = NoteAttachment.objects.select_for_update().filter(
                pk=attachment_id, deleted_at__lte=attachment_cutoff
            ).first()
            if attachment is None:
                continue
            register_attachment_cleanup([attachment])
            attachment.delete()
            attachments_purged += 1
    return {"notesPurged": notes_purged, "attachmentsPurged": attachments_purged}
