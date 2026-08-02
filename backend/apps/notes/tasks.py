from __future__ import annotations

import uuid
from datetime import timedelta

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils import timezone

from backend.apps.notes.models import NoteAiMessage, NoteAttachment, NoteExportJob


PARSE_HARD_LIMIT = max(11, int(settings.A3_NOTES_PARSE_TIMEOUT_SECONDS))
PARSE_SOFT_LIMIT = max(1, PARSE_HARD_LIMIT - 10)
MAX_PARSE_ATTEMPTS = 3
STALE_JOB_MINUTES = 30


def enqueue_assistant_message(message: NoteAiMessage) -> NoteAiMessage:
    if message.status != NoteAiMessage.Status.QUEUED:
        return message
    try:
        generate_assistant_message_task.delay(str(message.id))
        NoteAiMessage.objects.filter(
            id=message.id, status=NoteAiMessage.Status.QUEUED
        ).update(error_code="", error_message="")
    except Exception:
        NoteAiMessage.objects.filter(
            id=message.id, status=NoteAiMessage.Status.QUEUED
        ).update(
            error_code="assistant_enqueue_failed",
            error_message="AI 助手任务暂时无法提交，请重试",
        )
    message.refresh_from_db()
    return message


def _persist_assistant_failure(
    message_id, code: str, error_message: str, *, trace_id: str = ""
) -> bool:
    message = NoteAiMessage.objects.filter(
        id=message_id,
        role=NoteAiMessage.Role.ASSISTANT,
        status=NoteAiMessage.Status.STREAMING,
    ).first()
    if message is None:
        return False
    return bool(
        NoteAiMessage.objects.filter(
            id=message_id,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.STREAMING,
        ).update(
            status=NoteAiMessage.Status.FAILED,
            degraded=True,
            verified=False,
            error_code=code,
            error_message=error_message,
            metadata={**message.metadata, "traceId": trace_id or str(uuid.uuid4())},
        )
    )


@shared_task(name="notes.generate_assistant_message", acks_late=True, reject_on_worker_lost=True)
def generate_assistant_message_task(message_id: str) -> dict:
    from backend.apps.notes.services import assistant_service

    close_old_connections()
    trace_id = ""
    try:
        claimed = NoteAiMessage.objects.filter(
            id=message_id,
            role=NoteAiMessage.Role.ASSISTANT,
            status=NoteAiMessage.Status.QUEUED,
        ).update(
            status=NoteAiMessage.Status.STREAMING,
            content="",
            error_code="",
            error_message="",
        )
        if not claimed:
            return {"skipped": True}
        message = NoteAiMessage.objects.select_related("session", "session__user").get(id=message_id)
        user_message_id = message.metadata.get("userMessageId")
        user_message = NoteAiMessage.objects.filter(
            id=user_message_id,
            session=message.session,
            role=NoteAiMessage.Role.USER,
        ).first()
        if user_message is None:
            _persist_assistant_failure(
                message.id, "assistant_user_message_missing", "用户消息不存在，无法生成回答"
            )
            return {"status": "failed", "messageId": str(message.id)}

        trace_id = str(uuid.uuid4())
        safety = assistant_service.run_safety(message.session.user, user_message.content)
        if safety.get("safe") is not True:
            updated = NoteAiMessage.objects.filter(
                id=message.id, status=NoteAiMessage.Status.STREAMING
            ).update(
                status=NoteAiMessage.Status.SUCCEEDED,
                content="这个请求涉及安全或权限风险，我不能按原请求处理。请改为不包含隐私、越权或危险行为的学习问题。",
                safety=safety,
                verified=False,
                claims=[],
                citations=[],
                metadata={**message.metadata, "traceId": trace_id},
            )
            if not updated:
                return {"skipped": True}
            return {"status": "succeeded", "messageId": str(message.id), "refused": True}

        context = assistant_service.build_context_for_message(message, user_message.content)
        updated = NoteAiMessage.objects.filter(
            id=message.id, status=NoteAiMessage.Status.STREAMING
        ).update(
            safety=safety,
            citations=context.citations,
            metadata={
                **message.metadata,
                "traceId": trace_id,
                "contextCharacters": context.character_count,
                "contextTokens": context.token_count,
            },
        )
        if not updated:
            return {"skipped": True}
        generated = assistant_service.generate_note_answer(
            user_message.content, context_text=context.text, sources=context.sources
        )
        answer = str(generated.get("answer") or "")[: assistant_service.MAX_ANSWER_CHARACTERS]
        if not answer:
            raise RuntimeError("empty assistant answer")
        for end in range(assistant_service.PARTIAL_WRITE_CHARACTERS, len(answer), assistant_service.PARTIAL_WRITE_CHARACTERS):
            updated = NoteAiMessage.objects.filter(
                id=message.id, status=NoteAiMessage.Status.STREAMING
            ).update(content=answer[:end])
            if not updated:
                return {"skipped": True}
        updated = NoteAiMessage.objects.filter(
            id=message.id, status=NoteAiMessage.Status.STREAMING
        ).update(content=answer)
        if not updated:
            return {"skipped": True}

        degraded = bool(generated.get("fallback"))
        error_code = ""
        error_message = ""
        try:
            verification = assistant_service.run_verifier(
                message.session.user, user_message.content, answer, context.sources
            )
        except Exception:
            verification = {"verified": False, "claims": []}
            degraded = True
            error_code = "assistant_verifier_degraded"
            error_message = "回答已生成，但引用验证暂时不可用"
        verified = bool(verification.get("verified")) and bool(context.citations)
        claims = verification.get("claims") if isinstance(verification.get("claims"), list) else []
        final_safety = verification.get("safety") if isinstance(verification.get("safety"), dict) else safety
        updated = NoteAiMessage.objects.filter(
            id=message.id, status=NoteAiMessage.Status.STREAMING
        ).update(
            status=NoteAiMessage.Status.SUCCEEDED,
            content=answer,
            citations=context.citations,
            verified=verified,
            claims=claims,
            safety=final_safety,
            degraded=degraded,
            error_code=error_code,
            error_message=error_message,
            metadata={
                **message.metadata,
                "traceId": trace_id,
                "provider": str(generated.get("provider") or ""),
                "model": str(generated.get("model") or ""),
                "contextCharacters": context.character_count,
                "contextTokens": context.token_count,
            },
        )
        return {
            "status": "succeeded" if updated else "skipped",
            "messageId": str(message.id),
        }
    except Exception:
        _persist_assistant_failure(
            message_id,
            "assistant_generation_failed",
            "AI 回答生成失败，请稍后重试",
            trace_id=trace_id,
        )
        return {"status": "failed", "messageId": str(message_id)}
    finally:
        close_old_connections()


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


@shared_task(name="notes.build_export", acks_late=True, reject_on_worker_lost=True)
def build_export_task(job_id: str, expected_generation: int, expected_lease_token: str) -> dict:
    from backend.apps.notes.services.export_service import build_note_export

    close_old_connections()
    try:
        return build_note_export(job_id, expected_generation, expected_lease_token)
    finally:
        close_old_connections()


def enqueue_export(job: NoteExportJob) -> NoteExportJob:
    with transaction.atomic():
        queued = NoteExportJob.objects.select_for_update().filter(
            pk=job.pk, status=NoteExportJob.Status.QUEUED
        ).first()
        if queued is None:
            job.refresh_from_db()
            return job
        queued.run_generation += 1
        queued.run_lease_token = uuid.uuid4()
        queued.run_started_at = None
        queued.enqueue_attempts = min(65535, queued.enqueue_attempts + 1)
        queued.save(update_fields={
            "run_generation", "run_lease_token", "run_started_at",
            "enqueue_attempts", "updated_at",
        })
        generation = queued.run_generation
        lease_token = queued.run_lease_token
    try:
        build_export_task.delay(str(job.id), generation, str(lease_token))
        NoteExportJob.objects.filter(
            pk=job.pk,
            status=NoteExportJob.Status.QUEUED,
            run_generation=generation,
            run_lease_token=lease_token,
        ).update(
            error_code="",
            error_message="",
            updated_at=timezone.now(),
        )
    except Exception:
        NoteExportJob.objects.filter(
            pk=job.pk,
            status=NoteExportJob.Status.QUEUED,
            run_generation=generation,
            run_lease_token=lease_token,
        ).update(
            error_code="export_enqueue_failed",
            error_message="导出任务暂时无法提交，请稍后重试",
            updated_at=timezone.now(),
        )
    job.refresh_from_db()
    return job


@shared_task(name="notes.cleanup_expired_exports")
def cleanup_expired_exports_task() -> dict:
    from backend.apps.notes.services.cleanup_service import cleanup_expired_exports

    return cleanup_expired_exports()


@shared_task(name="notes.cleanup_trashed_notes")
def cleanup_trashed_notes_task() -> dict:
    from backend.apps.notes.services.cleanup_service import cleanup_trashed_notes

    return cleanup_trashed_notes()


def _recover_stale_parse_jobs(cutoff, limit: int) -> tuple[int, int]:
    stale_ids = list(
        NoteAttachment.objects.filter(
            parse_status=NoteAttachment.ParseStatus.PROCESSING,
            parse_started_at__lt=cutoff,
            deleted_at__isnull=True,
        ).order_by("parse_started_at").values_list("id", flat=True)[:limit]
    )
    recovered = 0
    failed = 0
    for attachment_id in stale_ids:
        with transaction.atomic():
            attachment = NoteAttachment.objects.select_for_update().filter(
                pk=attachment_id,
                parse_status=NoteAttachment.ParseStatus.PROCESSING,
                parse_started_at__lt=cutoff,
                deleted_at__isnull=True,
            ).first()
            if attachment is None:
                continue
            if attachment.parse_attempts >= MAX_PARSE_ATTEMPTS:
                attachment.parse_status = NoteAttachment.ParseStatus.FAILED
                attachment.parse_started_at = None
                attachment.error_code = "attachment_parse_attempts_exhausted"
                attachment.error_message = "附件解析多次中断，请重新提交解析"
                attachment.save(update_fields={
                    "parse_status", "parse_started_at", "error_code", "error_message", "updated_at",
                })
                failed += 1
                continue
            lease_token = uuid.uuid4()
            attachment.parse_status = NoteAttachment.ParseStatus.PENDING
            attachment.parse_started_at = None
            attachment.parse_lease_token = lease_token
            attachment.error_code = ""
            attachment.error_message = ""
            attachment.save(update_fields={
                "parse_status", "parse_started_at", "parse_lease_token",
                "error_code", "error_message", "updated_at",
            })
        try:
            parse_attachment_task.delay(
                str(attachment.id), int(attachment.parse_generation), str(lease_token)
            )
            recovered += 1
        except Exception:
            NoteAttachment.objects.filter(
                pk=attachment.id,
                parse_status=NoteAttachment.ParseStatus.PENDING,
                parse_lease_token=lease_token,
            ).update(
                parse_status=NoteAttachment.ParseStatus.FAILED,
                error_code="attachment_enqueue_failed",
                error_message="附件解析任务暂时无法提交，请重试",
                updated_at=timezone.now(),
            )
            failed += 1
    return recovered, failed


def _fail_stale_export_job(job_id, observed_started_at, observed_generation, observed_lease) -> bool:
    updated = NoteExportJob.objects.filter(
        pk=job_id,
        status=NoteExportJob.Status.PROCESSING,
        run_started_at=observed_started_at,
        run_generation=observed_generation,
        run_lease_token=observed_lease,
    ).update(
        status=NoteExportJob.Status.FAILED,
        run_lease_token=None,
        run_started_at=None,
        relative_path="",
        output_size_bytes=0,
        output_sha256="",
        error_code="export_stale",
        error_message="导出任务处理超时，请重新创建导出",
        updated_at=timezone.now(),
    )
    return bool(updated)


def _recover_stale_export_jobs(
    cutoff, limit: int, *, enqueue_failure_cutoff=None
) -> tuple[int, int]:
    stale_processing = list(
        NoteExportJob.objects.filter(
            status=NoteExportJob.Status.PROCESSING,
            run_started_at__lt=cutoff,
        ).order_by("run_started_at").values_list(
            "id", "run_started_at", "run_generation", "run_lease_token"
        )[:limit]
    )
    failed = sum(
        _fail_stale_export_job(job_id, started_at, generation, lease)
        for job_id, started_at, generation, lease in stale_processing
    )
    remaining = max(0, limit - len(stale_processing))
    enqueue_failure_cutoff = enqueue_failure_cutoff or cutoff
    queued_due = (
        Q(error_code="export_enqueue_failed", updated_at__lt=enqueue_failure_cutoff)
        | (~Q(error_code="export_enqueue_failed") & Q(updated_at__lt=cutoff))
    )
    queued_ids = list(
        NoteExportJob.objects.filter(status=NoteExportJob.Status.QUEUED)
        .filter(queued_due)
        .order_by("updated_at").values_list("id", flat=True)[:remaining]
    )
    recovered = 0
    for job_id in queued_ids:
        job = NoteExportJob.objects.filter(pk=job_id, status=NoteExportJob.Status.QUEUED).first()
        if job is None:
            continue
        enqueue_export(job)
        if job.status == NoteExportJob.Status.QUEUED and not job.error_code:
            recovered += 1
        else:
            failed += 1
    return recovered, failed


@shared_task(name="notes.cleanup_stale_jobs")
def cleanup_stale_jobs_task() -> dict:
    limit = int(settings.A3_NOTES_CLEANUP_BATCH_SIZE)
    now = timezone.now()
    parse_stale_minutes = max(
        STALE_JOB_MINUTES, (int(settings.A3_NOTES_PARSE_TIMEOUT_SECONDS) * 2 + 59) // 60
    )
    parse_cutoff = now - timedelta(minutes=parse_stale_minutes)
    export_cutoff = now - timedelta(minutes=int(settings.A3_NOTES_EXPORT_STALE_MINUTES))
    parse_recovered, parse_failed = _recover_stale_parse_jobs(parse_cutoff, limit)
    export_recovered, export_failed = _recover_stale_export_jobs(
        export_cutoff,
        limit,
        enqueue_failure_cutoff=now - timedelta(minutes=15),
    )
    return {
        "parseRecovered": parse_recovered,
        "parseFailed": parse_failed,
        "exportRecovered": export_recovered,
        "exportFailed": export_failed,
    }
