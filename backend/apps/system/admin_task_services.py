from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from celery import current_app
from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from backend.apps.compat.models import (
    ResourceGenerationJob,
    VideoComposition,
    VideoGenerationJob,
    VideoGenerationSegment,
)
from backend.apps.compat.video_compositions import dispatch_compose, dispatch_narration
from backend.apps.compat.video_jobs import retry_failed_video_segments
from backend.apps.knowledge_base.models import IndexJobStatus, KnowledgeIndexJob
from backend.apps.knowledge_base.services import dispatch_index_job, retry_index_job
from backend.apps.system.admin_audit import record_admin_audit
from backend.apps.system.admin_catalog_services import (
    AdminActionError,
    _error_summary,
    _require_reason,
    _safe_audit_reason,
)
from backend.apps.system.admin_conversation_services import parse_pagination


TASK_KINDS = {
    "resource_generation": ResourceGenerationJob,
    "knowledge_index": KnowledgeIndexJob,
    "video_generation": VideoGenerationJob,
    "video_composition": VideoComposition,
}
TASK_STATUSES = {"queued", "running", "succeeded", "failed", "stale", "cancelled"}
_STATUS_ALIASES = {
    "draft": "queued",
    "pending": "queued",
    "indexing": "running",
    "processing": "running",
    "submitting": "running",
    "polling": "running",
    "retrying": "running",
    "generating": "running",
    "generating_narration": "running",
    "narration_ready": "queued",
    "composing": "running",
    "completed": "succeeded",
    "ready": "succeeded",
    "indexed": "succeeded",
    "indexed_with_warnings": "succeeded",
    "partial": "failed",
    "error": "failed",
}
_CANCELLABLE_RUNTIME_STATES = {
    "knowledge_index": {"queued", "running"},
    "video_composition": {"queued", "generating_narration", "composing"},
}


def _dispatch_index_job_after_commit(job_id) -> None:
    job = KnowledgeIndexJob.objects.filter(pk=job_id).first()
    if job is not None:
        dispatch_index_job(job)


def _normalized_status(status: str) -> str:
    return _STATUS_ALIASES.get(status, status)


def _source_statuses(status: str) -> set[str]:
    source_values = TASK_STATUSES | set(_STATUS_ALIASES)
    return {source for source in source_values if _normalized_status(source) == status}


def _validate_filters(params) -> tuple[int, int, str, str, int | None, str]:
    page, page_size = parse_pagination(params)
    kind = str(params.get("kind", "")).strip()
    if kind and kind not in TASK_KINDS:
        raise ValueError("任务类型无效")
    status = str(params.get("status", "")).strip()
    if status and status not in TASK_STATUSES:
        raise ValueError("任务状态无效")
    user_id_text = str(params.get("userId", "")).strip()
    if user_id_text and not user_id_text.isdigit():
        raise ValueError("用户编号无效")
    search = str(params.get("search", "")).strip()
    if len(search) > 100:
        raise ValueError("搜索内容不能超过 100 个字符")
    return page, page_size, kind, status, int(user_id_text) if user_id_text else None, search


def _resource_queryset(*, status: str, user_id: int | None, search: str):
    queryset = ResourceGenerationJob.objects.select_related("user")
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job_id__icontains=search) | Q(trace_id__icontains=search))
    return queryset.order_by("-created_at", "-id")


def _index_queryset(*, status: str, user_id: int | None, search: str):
    queryset = KnowledgeIndexJob.objects.select_related("owner")
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(owner_id=user_id)
    if search:
        search_filter = Q(owner__display_name__icontains=search)
        try:
            search_filter |= Q(pk=UUID(search))
        except ValueError:
            pass
        queryset = queryset.filter(search_filter)
    return queryset.order_by("-created_at", "-id")


def _video_queryset(*, status: str, user_id: int | None, search: str):
    queryset = VideoGenerationJob.objects.select_related("user").annotate(
        has_failed_segment=Exists(
            VideoGenerationSegment.objects.filter(job_id=OuterRef("pk"), status="failed")
        )
    )
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job_id__icontains=search) | Q(trace_id__icontains=search))
    return queryset.order_by("-created_at", "-id")


def _composition_queryset(*, status: str, user_id: int | None, search: str):
    queryset = VideoComposition.objects.select_related("job__user")
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(job__user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job__job_id__icontains=search) | Q(job__trace_id__icontains=search))
    return queryset.order_by("-created_at", "-id")


_QUERY_BUILDERS = {
    "resource_generation": _resource_queryset,
    "knowledge_index": _index_queryset,
    "video_generation": _video_queryset,
    "video_composition": _composition_queryset,
}


def _duration_ms(started_at: datetime | None, finished_at: datetime | None) -> int | None:
    if not started_at:
        return None
    return max(0, int((finished_at - started_at).total_seconds() * 1000)) if finished_at else None


def _task_identity(kind: str, task) -> tuple[str, str]:
    if kind == "resource_generation":
        return str(task.pk), task.job_id
    if kind == "knowledge_index":
        return str(task.pk), str(task.pk)
    if kind == "video_generation":
        return str(task.pk), task.job_id
    return str(task.pk), task.job.job_id


def _task_user(kind: str, task):
    return task.owner if kind == "knowledge_index" else task.job.user if kind == "video_composition" else task.user


def _task_trace(kind: str, task) -> str:
    if kind == "knowledge_index":
        return ""
    return task.job.trace_id if kind == "video_composition" else task.trace_id


def _task_stage(kind: str, task) -> str:
    return task.job_type if kind == "knowledge_index" else task.stage


def _task_celery_id(kind: str, task) -> str:
    return "" if kind == "resource_generation" else task.celery_task_id


def _retry_evidence(kind: str, task) -> tuple[bool, str, dict[str, bool]]:
    normalized = _normalized_status(task.status)
    if kind == "resource_generation":
        return False, "retry_transition_not_supported", {"supportedTransition": False}
    if normalized != "failed":
        return False, "status_not_failed", {"supportedTransition": True}
    if kind == "video_generation":
        has_failed_segment = bool(task.has_failed_segment)
        reason = "failed_segments_available" if has_failed_segment else "no_failed_segments"
        return has_failed_segment, reason, {"failedSegmentExists": has_failed_segment}
    return True, "failed_state_retry_supported", {"supportedTransition": True}


def _eligibility(kind: str, task) -> dict[str, Any]:
    retry, retry_reason, retry_evidence = _retry_evidence(kind, task)
    cancel = (
        task.status in _CANCELLABLE_RUNTIME_STATES.get(kind, set())
        and bool(_task_celery_id(kind, task))
    )
    return {
        "retry": retry,
        "retryReason": retry_reason,
        "retryEvidence": retry_evidence,
        "cancel": cancel,
    }


def _serialize_task(kind: str, task) -> dict[str, Any]:
    item_id, job_id = _task_identity(kind, task)
    user = _task_user(kind, task)
    return {
        "id": item_id,
        "kind": kind,
        "jobId": job_id,
        "user": {"id": str(user.pk), "displayName": user.display_name},
        "status": _normalized_status(task.status),
        "stage": _task_stage(kind, task),
        "progress": task.progress,
        "createdAt": task.created_at.isoformat(),
        "updatedAt": task.updated_at.isoformat(),
        "startedAt": task.started_at.isoformat() if task.started_at else None,
        "finishedAt": task.finished_at.isoformat() if task.finished_at else None,
        "durationMs": _duration_ms(task.started_at, task.finished_at),
        "errorSummary": _error_summary(task.error_message),
        "traceId": _task_trace(kind, task),
        "eligibility": _eligibility(kind, task),
    }


def list_tasks(params) -> dict[str, Any]:
    page, page_size, kind, status, user_id, search = _validate_filters(params)
    kinds = (kind,) if kind else tuple(TASK_KINDS)
    start = (page - 1) * page_size
    end = start + page_size
    total = 0
    candidates: list[tuple[str, Any]] = []
    for item_kind in kinds:
        queryset = _QUERY_BUILDERS[item_kind](status=status, user_id=user_id, search=search)
        total += queryset.count()
        candidates.extend((item_kind, task) for task in queryset[:end])
    candidates.sort(
        key=lambda item: (item[1].created_at, item[0], _task_identity(item[0], item[1])[0]),
        reverse=True,
    )
    items = [_serialize_task(item_kind, task) for item_kind, task in candidates[start:end]]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def _native_task_lookup(kind: str, item_id: str) -> dict[str, Any]:
    if kind not in TASK_KINDS:
        raise ValueError("任务类型无效")
    if kind == "knowledge_index":
        try:
            return {"pk": UUID(item_id)}
        except (TypeError, ValueError, AttributeError) as exc:
            raise ValueError("任务编号无效") from exc
    try:
        primary_key = int(item_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("任务编号无效") from exc
    if primary_key < 1:
        raise ValueError("任务编号无效")
    return {"pk": primary_key}


def get_task(kind: str, item_id: str) -> dict[str, Any] | None:
    lookup = _native_task_lookup(kind, item_id)
    task = _QUERY_BUILDERS[kind](status="", user_id=None, search="").filter(**lookup).first()
    return _serialize_task(kind, task) if task else None


def _locked_task(kind: str, item_id: str):
    lookup = _native_task_lookup(kind, item_id)
    queryset = TASK_KINDS[kind].objects.select_for_update()
    if kind == "knowledge_index":
        queryset = queryset.select_related("owner")
    elif kind == "video_composition":
        queryset = queryset.select_related("job__user")
    else:
        queryset = queryset.select_related("user")
    task = queryset.filter(**lookup).first()
    if task is None:
        raise AdminActionError("任务不存在", status_code=404, error_code="not_found")
    if kind == "video_generation":
        task.has_failed_segment = task.segments.filter(status="failed").exists()
    return task


def _task_failure_audit(
    *,
    actor,
    action: str,
    kind: str,
    item_id: str,
    reason: str,
    error: AdminActionError,
    actor_ip: str | None,
) -> None:
    record_admin_audit(
        actor=actor,
        action=action,
        target_type=str(kind)[:64],
        target_id=str(item_id)[:128],
        summary=str(error),
        reason=reason,
        metadata={"errorCode": error.error_code, "kind": str(kind)[:64]},
        metadata_allowlist=("errorCode", "kind"),
        actor_ip=actor_ip,
        success=False,
    )


def retry_task(
    *,
    actor,
    kind: str,
    item_id: str,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    try:
        normalized_reason = _require_reason(reason)
        with transaction.atomic():
            task = _locked_task(kind, item_id)
            eligible, eligibility_reason, _ = _retry_evidence(kind, task)
            if not eligible:
                raise AdminActionError(
                    "当前任务不支持重试",
                    status_code=409,
                    error_code=eligibility_reason,
                )
            before = {"status": task.status, "stage": _task_stage(kind, task), "progress": task.progress}
            try:
                if kind == "knowledge_index":
                    retry_index_job(task, dispatch=False)
                    transaction.on_commit(
                        lambda job_id=task.pk: _dispatch_index_job_after_commit(job_id)
                    )
                elif kind == "video_generation":
                    retry_failed_video_segments(task)
                elif kind == "video_composition":
                    if task.stage == "compose":
                        dispatch_compose(task.job)
                    else:
                        dispatch_narration(task.job)
                else:
                    raise AdminActionError(
                        "当前任务不支持重试",
                        status_code=409,
                        error_code="retry_transition_not_supported",
                    )
            except AdminActionError:
                raise
            except ValueError as exc:
                raise AdminActionError(str(exc), status_code=409, error_code="retry_rejected") from exc
            task.refresh_from_db()
            record_admin_audit(
                actor=actor,
                action="task.retry",
                target_type=kind,
                target_id=item_id,
                summary="重试后台任务",
                reason=normalized_reason,
                before=before,
                after={"status": task.status, "stage": _task_stage(kind, task), "progress": task.progress},
                metadata={"kind": kind},
                before_allowlist=("status", "stage", "progress"),
                after_allowlist=("status", "stage", "progress"),
                metadata_allowlist=("kind",),
                actor_ip=actor_ip,
            )
        return {"task": get_task(kind, item_id)}
    except (TypeError, ValueError) as exc:
        error = exc if isinstance(exc, AdminActionError) else AdminActionError(str(exc), error_code="invalid_identifier")
        _task_failure_audit(
            actor=actor,
            action="task.retry",
            kind=kind,
            item_id=item_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error
    except Exception as exc:
        error = AdminActionError("任务重试失败，请稍后重试", status_code=500, error_code="operation_failed")
        _task_failure_audit(
            actor=actor,
            action="task.retry",
            kind=kind,
            item_id=item_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error from exc


def _mark_task_cancelled(kind: str, task) -> None:
    now = timezone.now()
    if kind == "knowledge_index":
        detail = dict(task.progress_detail) if isinstance(task.progress_detail, dict) else {}
        detail.update({"phase": "cancelled", "phaseLabel": "任务已取消"})
        task.status = IndexJobStatus.CANCELLED
        task.finished_at = now
        task.current_file = ""
        task.progress_detail = detail
        task.save(update_fields=["status", "finished_at", "current_file", "progress_detail", "updated_at"])
        return
    task.status = "cancelled"
    task.stage = "cancelled"
    task.finished_at = now
    task.message = "任务已由管理员取消"
    update_fields = ["status", "stage", "finished_at", "message", "updated_at"]
    task.save(update_fields=update_fields)


def cancel_task(
    *,
    actor,
    kind: str,
    item_id: str,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    try:
        normalized_reason = _require_reason(reason)
        with transaction.atomic():
            task = _locked_task(kind, item_id)
            if not _eligibility(kind, task)["cancel"]:
                raise AdminActionError(
                    "当前任务不支持取消，或缺少可撤销的任务编号",
                    status_code=409,
                    error_code="cancel_not_supported",
                )
            task_id = _task_celery_id(kind, task)
            before = {"status": task.status, "stage": _task_stage(kind, task), "progress": task.progress}
            try:
                current_app.control.revoke(task_id, terminate=True)
            except Exception as exc:
                raise AdminActionError(
                    "任务撤销请求失败，请稍后重试",
                    status_code=503,
                    error_code="revoke_failed",
                ) from exc
            _mark_task_cancelled(kind, task)
            record_admin_audit(
                actor=actor,
                action="task.cancel",
                target_type=kind,
                target_id=item_id,
                summary="取消后台任务",
                reason=normalized_reason,
                before=before,
                after={"status": "cancelled", "stage": "cancelled", "progress": task.progress},
                metadata={"kind": kind},
                before_allowlist=("status", "stage", "progress"),
                after_allowlist=("status", "stage", "progress"),
                metadata_allowlist=("kind",),
                actor_ip=actor_ip,
            )
        return {"task": get_task(kind, item_id)}
    except (TypeError, ValueError) as exc:
        error = exc if isinstance(exc, AdminActionError) else AdminActionError(str(exc), error_code="invalid_identifier")
        _task_failure_audit(
            actor=actor,
            action="task.cancel",
            kind=kind,
            item_id=item_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error
    except Exception as exc:
        error = AdminActionError("任务取消失败，请稍后重试", status_code=500, error_code="operation_failed")
        _task_failure_audit(
            actor=actor,
            action="task.cancel",
            kind=kind,
            item_id=item_id,
            reason=_safe_audit_reason(normalized_reason),
            error=error,
            actor_ip=actor_ip,
        )
        raise error from exc
