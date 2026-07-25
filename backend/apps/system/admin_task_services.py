from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from django.db.models import Exists, OuterRef, Q

from backend.apps.compat.models import (
    ResourceGenerationJob,
    VideoComposition,
    VideoGenerationJob,
    VideoGenerationSegment,
)
from backend.apps.knowledge_base.models import KnowledgeIndexJob
from backend.apps.system.admin_catalog_services import _error_summary
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
    "video_generation": {"queued", "running"},
    "video_composition": {"generating_narration", "composing"},
}


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
