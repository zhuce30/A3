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


@shared_task(name="notes.parse_attachment", soft_time_limit=PARSE_SOFT_LIMIT, time_limit=PARSE_HARD_LIMIT)
def parse_attachment_task(attachment_id: str) -> dict:
    from backend.apps.notes.services.attachment_service import parse_and_persist_attachment

    close_old_connections()
    try:
        with transaction.atomic():
            try:
                attachment = NoteAttachment.objects.select_for_update().filter(
                    id=attachment_id, deleted_at__isnull=True
                ).first()
            except (ValidationError, ValueError):
                attachment = None
            if attachment is None or attachment.parse_status in {
                NoteAttachment.ParseStatus.SUCCEEDED,
                NoteAttachment.ParseStatus.PROCESSING,
            }:
                return {"skipped": True}
            attachment.parse_status = NoteAttachment.ParseStatus.PROCESSING
            attachment.error_code = ""
            attachment.error_message = ""
            attachment.save(update_fields={"parse_status", "error_code", "error_message", "updated_at"})
        try:
            return parse_and_persist_attachment(attachment)
        except SoftTimeLimitExceeded:
            _persist_parse_failure(attachment.id, "attachment_parse_timeout", "附件解析超时，请稍后重试")
            return {"status": "failed", "attachmentId": str(attachment.id)}
        except Exception:
            _persist_parse_failure(attachment.id, "attachment_parse_failed", "附件解析失败，请稍后重试")
            return {"status": "failed", "attachmentId": str(attachment.id)}
    finally:
        close_old_connections()


def _persist_parse_failure(attachment_id, code: str, message: str) -> None:
    NoteAttachment.objects.filter(
        id=attachment_id,
        deleted_at__isnull=True,
        parse_status=NoteAttachment.ParseStatus.PROCESSING,
    ).update(
        parse_status=NoteAttachment.ParseStatus.FAILED,
        extracted_text="",
        preview_metadata={},
        error_code=code,
        error_message=message,
        updated_at=timezone.now(),
    )
