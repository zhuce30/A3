from __future__ import annotations

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import close_old_connections, transaction
from django.utils import timezone

from backend.apps.notes.models import NoteAttachment


PARSE_HARD_LIMIT = max(11, int(settings.A3_NOTES_PARSE_TIMEOUT_SECONDS))
PARSE_SOFT_LIMIT = max(1, PARSE_HARD_LIMIT - 10)


def enqueue_attachment_parse(attachment: NoteAttachment) -> NoteAttachment:
    generation = int(attachment.parse_generation)
    try:
        parse_attachment_task.delay(str(attachment.id), generation)
    except Exception:
        NoteAttachment.objects.filter(
            id=attachment.id,
            deleted_at__isnull=True,
            parse_generation=generation,
            parse_status=NoteAttachment.ParseStatus.PENDING,
        ).update(
            parse_status=NoteAttachment.ParseStatus.FAILED,
            parse_started_at=None,
            error_code="attachment_enqueue_failed",
            error_message="附件解析任务暂时无法提交，请重试",
            updated_at=timezone.now(),
        )
    attachment.refresh_from_db()
    return attachment


@shared_task(
    name="notes.parse_attachment",
    soft_time_limit=PARSE_SOFT_LIMIT,
    time_limit=PARSE_HARD_LIMIT,
    acks_late=True,
    reject_on_worker_lost=True,
)
def parse_attachment_task(attachment_id: str, expected_generation: int) -> dict:
    from backend.apps.notes.services.attachment_service import parse_and_persist_attachment

    close_old_connections()
    try:
        try:
            generation = int(expected_generation)
        except (TypeError, ValueError):
            return {"skipped": True}
        with transaction.atomic():
            try:
                attachment = NoteAttachment.objects.select_for_update().filter(
                    id=attachment_id,
                    deleted_at__isnull=True,
                    parse_generation=generation,
                ).first()
            except (ValidationError, ValueError):
                attachment = None
            if attachment is None or attachment.parse_status == NoteAttachment.ParseStatus.SUCCEEDED:
                return {"skipped": True}
            attachment.parse_status = NoteAttachment.ParseStatus.PROCESSING
            attachment.parse_started_at = timezone.now()
            attachment.error_code = ""
            attachment.error_message = ""
            attachment.save(update_fields={
                "parse_status", "parse_started_at", "error_code", "error_message", "updated_at"
            })
        try:
            return parse_and_persist_attachment(attachment, generation)
        except SoftTimeLimitExceeded:
            persisted = _persist_parse_failure(
                attachment.id,
                generation,
                "attachment_parse_timeout",
                "附件解析超时，请稍后重试",
            )
            if not persisted:
                return {"skipped": True, "attachmentId": str(attachment.id)}
            return {"status": "failed", "attachmentId": str(attachment.id)}
        except Exception:
            persisted = _persist_parse_failure(
                attachment.id,
                generation,
                "attachment_parse_failed",
                "附件解析失败，请稍后重试",
            )
            if not persisted:
                return {"skipped": True, "attachmentId": str(attachment.id)}
            return {"status": "failed", "attachmentId": str(attachment.id)}
    finally:
        close_old_connections()


def _persist_parse_failure(attachment_id, expected_generation: int, code: str, message: str) -> bool:
    updated = NoteAttachment.objects.filter(
        id=attachment_id,
        deleted_at__isnull=True,
        parse_generation=expected_generation,
        parse_status=NoteAttachment.ParseStatus.PROCESSING,
    ).update(
        parse_status=NoteAttachment.ParseStatus.FAILED,
        parse_started_at=None,
        extracted_text="",
        preview_metadata={},
        error_code=code,
        error_message=message,
        updated_at=timezone.now(),
    )
    return bool(updated)
