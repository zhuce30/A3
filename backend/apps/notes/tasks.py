from __future__ import annotations

import uuid

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import close_old_connections, transaction
from django.utils import timezone

from backend.apps.notes.models import NoteAttachment


PARSE_HARD_LIMIT = max(11, int(settings.A3_NOTES_PARSE_TIMEOUT_SECONDS))
PARSE_SOFT_LIMIT = max(1, PARSE_HARD_LIMIT - 10)
MAX_PARSE_ATTEMPTS = 3


def enqueue_attachment_parse(attachment: NoteAttachment) -> NoteAttachment:
    generation = int(attachment.parse_generation)
    lease_token = uuid.uuid4()
    with transaction.atomic():
        queued = NoteAttachment.objects.select_for_update().filter(
            id=attachment.id,
            deleted_at__isnull=True,
            parse_generation=generation,
            parse_status=NoteAttachment.ParseStatus.PENDING,
        ).first()
        if queued is None:
            attachment.refresh_from_db()
            return attachment
        queued.parse_lease_token = lease_token
        queued.parse_attempts = 0
        queued.save(update_fields={"parse_lease_token", "parse_attempts", "updated_at"})
    try:
        parse_attachment_task.delay(str(attachment.id), generation, str(lease_token))
    except Exception:
        NoteAttachment.objects.filter(
            id=attachment.id,
            deleted_at__isnull=True,
            parse_generation=generation,
            parse_lease_token=lease_token,
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


def _task_was_redelivered(task) -> bool:
    delivery_info = getattr(task.request, "delivery_info", None) or {}
    return bool(delivery_info.get("redelivered"))


def _claim_parse_lease(
    attachment_id: str,
    generation: int,
    lease_token: uuid.UUID,
    *,
    redelivered: bool,
) -> tuple[NoteAttachment | None, bool]:
    with transaction.atomic():
        try:
            attachment = NoteAttachment.objects.select_for_update().filter(
                id=attachment_id,
                deleted_at__isnull=True,
                parse_generation=generation,
                parse_lease_token=lease_token,
            ).first()
        except (ValidationError, ValueError):
            attachment = None
        if attachment is None or attachment.parse_status in {
            NoteAttachment.ParseStatus.SUCCEEDED,
            NoteAttachment.ParseStatus.FAILED,
        }:
            return None, False
        if attachment.parse_status == NoteAttachment.ParseStatus.PROCESSING and not redelivered:
            return None, False
        if attachment.parse_status not in {
            NoteAttachment.ParseStatus.PENDING,
            NoteAttachment.ParseStatus.PROCESSING,
        }:
            return None, False
        if attachment.parse_attempts >= MAX_PARSE_ATTEMPTS:
            attachment.parse_status = NoteAttachment.ParseStatus.FAILED
            attachment.parse_started_at = None
            attachment.extracted_text = ""
            attachment.preview_metadata = {}
            attachment.error_code = "attachment_parse_attempts_exhausted"
            attachment.error_message = "附件解析多次中断，请重新提交解析"
            attachment.save(update_fields={
                "parse_status", "parse_started_at", "extracted_text", "preview_metadata",
                "error_code", "error_message", "updated_at",
            })
            return None, True
        attachment.parse_attempts += 1
        attachment.parse_status = NoteAttachment.ParseStatus.PROCESSING
        attachment.parse_started_at = timezone.now()
        attachment.error_code = ""
        attachment.error_message = ""
        attachment.save(update_fields={
            "parse_attempts", "parse_status", "parse_started_at", "error_code", "error_message", "updated_at",
        })
        return attachment, False


@shared_task(
    bind=True,
    name="notes.parse_attachment",
    soft_time_limit=PARSE_SOFT_LIMIT,
    time_limit=PARSE_HARD_LIMIT,
    acks_late=True,
    reject_on_worker_lost=True,
)
def parse_attachment_task(self, attachment_id: str, expected_generation: int, expected_lease_token: str) -> dict:
    from backend.apps.notes.services.attachment_service import parse_and_persist_attachment

    close_old_connections()
    try:
        try:
            generation = int(expected_generation)
            lease_token = uuid.UUID(str(expected_lease_token))
        except (TypeError, ValueError, AttributeError):
            return {"skipped": True}
        attachment, exhausted = _claim_parse_lease(
            attachment_id,
            generation,
            lease_token,
            redelivered=_task_was_redelivered(self),
        )
        if exhausted:
            return {"status": "failed", "attachmentId": str(attachment_id)}
        if attachment is None:
            return {"skipped": True}
        try:
            return parse_and_persist_attachment(attachment, generation, lease_token)
        except SoftTimeLimitExceeded:
            persisted = _persist_parse_failure(
                attachment.id,
                generation,
                lease_token,
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
                lease_token,
                "attachment_parse_failed",
                "附件解析失败，请稍后重试",
            )
            if not persisted:
                return {"skipped": True, "attachmentId": str(attachment.id)}
            return {"status": "failed", "attachmentId": str(attachment.id)}
    finally:
        close_old_connections()


def _persist_parse_failure(
    attachment_id,
    expected_generation: int,
    expected_lease_token: uuid.UUID,
    code: str,
    message: str,
) -> bool:
    updated = NoteAttachment.objects.filter(
        id=attachment_id,
        deleted_at__isnull=True,
        parse_generation=expected_generation,
        parse_lease_token=expected_lease_token,
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
