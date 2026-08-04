from __future__ import annotations

import os
import uuid
from datetime import timedelta
from functools import partial
from pathlib import Path, PurePosixPath

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from backend.apps.notes.models import Note, NoteAttachment, NoteExportJob, NotePhysicalCleanup
from backend.apps.notes.services.attachment_service import (
    AttachmentNotFound,
    resolve_relative_path,
    storage_root,
)


class UnsafeCleanupPath(OSError):
    pass


def _contained_path(relative_path: str) -> Path | None:
    try:
        return resolve_relative_path(relative_path)
    except AttachmentNotFound:
        return None


def _delete_export_file(relative_path: str, user_id, job_id) -> None:
    pure = PurePosixPath(str(relative_path))
    if pure.parts[:3] != ("exports", str(user_id), str(job_id)):
        raise UnsafeCleanupPath("unexpected export path")
    path = _contained_path(relative_path)
    if path is None:
        raise UnsafeCleanupPath("unsafe export path")
    path.unlink(missing_ok=True)
    parent = path.parent
    root = storage_root()
    while parent != root and parent.name in {str(job_id), str(user_id)}:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _attachment_directory(
    relative_path: str, owner_ref: str, note_ref: str, reference_id: str
) -> Path | None:
    pure = PurePosixPath(relative_path)
    expected_user = str(uuid.uuid5(uuid.NAMESPACE_URL, f"urn:a3:personal-notes:user:{owner_ref}"))
    if len(pure.parts) != 3 or pure.parts != (
        expected_user,
        note_ref,
        reference_id,
    ):
        return None
    path = _contained_path(pure.as_posix())
    if path is None or path.is_symlink():
        return None
    return path


def _delete_cleanup_target(cleanup: NotePhysicalCleanup) -> None:
    if cleanup.kind != NotePhysicalCleanup.Kind.ATTACHMENT_DIRECTORY:
        raise UnsafeCleanupPath("unsupported cleanup kind")
    directory = _attachment_directory(
        cleanup.relative_path,
        cleanup.owner_ref,
        str(cleanup.note_ref),
        str(cleanup.reference_id),
    )
    if directory is None:
        raise UnsafeCleanupPath("unsafe attachment cleanup path")
    if not directory.exists() or not directory.is_dir():
        return
    for child in directory.iterdir():
        if bool(getattr(child, "is_junction", lambda: False)()):
            os.rmdir(child)
        elif child.is_symlink() or child.is_file():
            child.unlink()
        else:
            raise UnsafeCleanupPath("nested cleanup directory")
    directory.rmdir()


def process_physical_cleanup(cleanup_id) -> bool:
    with transaction.atomic():
        cleanup = NotePhysicalCleanup.objects.select_for_update().filter(pk=cleanup_id).first()
        if cleanup is None:
            return True
        try:
            _delete_cleanup_target(cleanup)
        except OSError:
            cleanup.status = NotePhysicalCleanup.Status.FAILED
            cleanup.attempts = min(65535, cleanup.attempts + 1)
            cleanup.last_attempt_at = timezone.now()
            cleanup.error_code = "physical_cleanup_failed"
            cleanup.error_message = "物理文件清理失败，将自动重试"
            cleanup.save(update_fields={
                "status", "attempts", "last_attempt_at", "error_code", "error_message", "updated_at",
            })
            return False
        cleanup.delete()
        return True


def cleanup_pending_physical(*, limit: int | None = None) -> int:
    limit = limit or int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    cleanup_ids = list(
        NotePhysicalCleanup.objects.filter(
            status__in=[NotePhysicalCleanup.Status.PENDING, NotePhysicalCleanup.Status.FAILED]
        ).order_by("updated_at").values_list("id", flat=True)[:limit]
    )
    for cleanup_id in cleanup_ids:
        process_physical_cleanup(cleanup_id)
    return len(cleanup_ids)


def register_attachment_cleanup(attachments: list[NoteAttachment]) -> None:
    cleanup_ids = [
        NotePhysicalCleanup.objects.create(
            kind=NotePhysicalCleanup.Kind.ATTACHMENT_DIRECTORY,
            owner_ref=str(item.user_id),
            reference_id=item.id,
            note_ref=item.note_id,
            relative_path=PurePosixPath(item.relative_path).parent.as_posix(),
        ).id
        for item in attachments
        if item.kind in {NoteAttachment.Kind.FILE, NoteAttachment.Kind.IMAGE}
    ]

    def cleanup() -> None:
        for cleanup_id in cleanup_ids:
            process_physical_cleanup(cleanup_id)

    transaction.on_commit(cleanup)


def cleanup_expired_exports(*, now=None, limit: int | None = None) -> dict[str, int]:
    now = now or timezone.now()
    limit = limit or int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    ids = list(
        NoteExportJob.objects.filter(expires_at__lte=now)
        .exclude(status=NoteExportJob.Status.EXPIRED)
        .exclude(status=NoteExportJob.Status.PROCESSING)
        .order_by("updated_at", "expires_at")
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
                    partial(_delete_and_finalize_export, job.id, job.user_id, relative, now)
                )
            else:
                job.status = NoteExportJob.Status.EXPIRED
                job.output_size_bytes = 0
                job.output_sha256 = ""
                job.error_code = "export_expired"
                job.error_message = "导出文件已过期"
                job.save(update_fields={
                    "status", "output_size_bytes", "output_sha256",
                    "error_code", "error_message", "updated_at",
                })
            cleaned += 1
    return {"exportsCleaned": cleaned}


def _delete_and_finalize_export(job_id, user_id, relative_path: str, cutoff) -> None:
    with transaction.atomic():
        job = (
            NoteExportJob.objects.select_for_update()
            .filter(
                pk=job_id,
                user_id=user_id,
                relative_path=relative_path,
                expires_at__lte=cutoff,
            )
            .exclude(status__in=[
                NoteExportJob.Status.EXPIRED,
                NoteExportJob.Status.PROCESSING,
            ])
            .first()
        )
        if job is None:
            return
        try:
            _delete_export_file(relative_path, user_id, job_id)
        except OSError:
            NoteExportJob.objects.filter(pk=job.pk, relative_path=relative_path).update(
                error_code="export_cleanup_failed",
                error_message="导出文件清理失败，将自动重试",
                updated_at=timezone.now(),
            )
            return
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


def cleanup_trashed_notes(*, now=None, limit: int | None = None) -> dict[str, int]:
    now = now or timezone.now()
    limit = limit or int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    physical_retried = cleanup_pending_physical(limit=limit)
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
    return {
        "notesPurged": notes_purged,
        "attachmentsPurged": attachments_purged,
        "physicalRetried": physical_retried,
    }
