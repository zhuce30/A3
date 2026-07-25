from __future__ import annotations

from datetime import datetime
from typing import Any

from django.db.models import CharField, DateTimeField, F, Q, TextField, Value
from django.db.models.functions import Cast

from backend.apps.compat.models import ResourceGenerationJob, VideoComposition, VideoGenerationJob
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
    "completed": "succeeded",
    "ready": "succeeded",
    "indexed": "succeeded",
    "indexed_with_warnings": "succeeded",
    "error": "failed",
}


def _normalized_status(status: str) -> str:
    return _STATUS_ALIASES.get(status, status)


def _source_statuses(status: str) -> set[str]:
    return {source for source in TASK_STATUSES | set(_STATUS_ALIASES) if _normalized_status(source) == status}


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


def _resource_query(*, status: str, user_id: int | None, search: str):
    queryset = ResourceGenerationJob.objects.all()
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job_id__icontains=search) | Q(trace_id__icontains=search))
    return (
        queryset.order_by()
        .annotate(
            admin_id=Cast("pk", TextField()),
            admin_kind=Value("resource_generation", output_field=CharField()),
            admin_job_id=F("job_id"),
            admin_user_id=Cast("user_id", TextField()),
            admin_user_name=F("user__display_name"),
            admin_status=F("status"),
            admin_stage=F("stage"),
            admin_progress=F("progress"),
            admin_created=F("created_at"),
            admin_updated=F("updated_at"),
            admin_started=F("started_at"),
            admin_finished=F("finished_at"),
            admin_error=F("error_message"),
            admin_trace=F("trace_id"),
            admin_celery=Value("", output_field=CharField()),
        )
        .values(*_TASK_VALUE_FIELDS)
    )


def _index_query(*, status: str, user_id: int | None, search: str):
    queryset = KnowledgeIndexJob.objects.all()
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(owner_id=user_id)
    if search:
        queryset = queryset.filter(Q(id__icontains=search) | Q(owner__display_name__icontains=search))
    return (
        queryset.order_by()
        .annotate(
            admin_id=Cast("pk", TextField()),
            admin_kind=Value("knowledge_index", output_field=CharField()),
            admin_job_id=Cast("pk", TextField()),
            admin_user_id=Cast("owner_id", TextField()),
            admin_user_name=F("owner__display_name"),
            admin_status=F("status"),
            admin_stage=F("job_type"),
            admin_progress=F("progress"),
            admin_created=F("created_at"),
            admin_updated=F("updated_at"),
            admin_started=F("started_at"),
            admin_finished=F("finished_at"),
            admin_error=F("error_message"),
            admin_trace=Value("", output_field=CharField()),
            admin_celery=F("celery_task_id"),
        )
        .values(*_TASK_VALUE_FIELDS)
    )


def _video_query(*, status: str, user_id: int | None, search: str):
    queryset = VideoGenerationJob.objects.all()
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job_id__icontains=search) | Q(trace_id__icontains=search))
    return (
        queryset.order_by()
        .annotate(
            admin_id=Cast("pk", TextField()),
            admin_kind=Value("video_generation", output_field=CharField()),
            admin_job_id=F("job_id"),
            admin_user_id=Cast("user_id", TextField()),
            admin_user_name=F("user__display_name"),
            admin_status=F("status"),
            admin_stage=F("stage"),
            admin_progress=F("progress"),
            admin_created=F("created_at"),
            admin_updated=F("updated_at"),
            admin_started=F("started_at"),
            admin_finished=F("finished_at"),
            admin_error=F("error_message"),
            admin_trace=F("trace_id"),
            admin_celery=F("celery_task_id"),
        )
        .values(*_TASK_VALUE_FIELDS)
    )


def _composition_query(*, status: str, user_id: int | None, search: str):
    queryset = VideoComposition.objects.all()
    if status:
        queryset = queryset.filter(status__in=_source_statuses(status))
    if user_id is not None:
        queryset = queryset.filter(job__user_id=user_id)
    if search:
        queryset = queryset.filter(Q(job__job_id__icontains=search) | Q(job__trace_id__icontains=search))
    return (
        queryset.order_by()
        .annotate(
            admin_id=Cast("pk", TextField()),
            admin_kind=Value("video_composition", output_field=CharField()),
            admin_job_id=F("job__job_id"),
            admin_user_id=Cast("job__user_id", TextField()),
            admin_user_name=F("job__user__display_name"),
            admin_status=F("status"),
            admin_stage=F("stage"),
            admin_progress=F("progress"),
            admin_created=F("created_at"),
            admin_updated=F("updated_at"),
            admin_started=F("started_at"),
            admin_finished=F("finished_at"),
            admin_error=F("error_message"),
            admin_trace=F("job__trace_id"),
            admin_celery=F("celery_task_id"),
        )
        .values(*_TASK_VALUE_FIELDS)
    )


_TASK_VALUE_FIELDS = (
    "admin_id",
    "admin_kind",
    "admin_job_id",
    "admin_user_id",
    "admin_user_name",
    "admin_status",
    "admin_stage",
    "admin_progress",
    "admin_created",
    "admin_updated",
    "admin_started",
    "admin_finished",
    "admin_error",
    "admin_trace",
    "admin_celery",
)
_QUERY_BUILDERS = {
    "resource_generation": _resource_query,
    "knowledge_index": _index_query,
    "video_generation": _video_query,
    "video_composition": _composition_query,
}


def _duration_ms(started_at: datetime | None, finished_at: datetime | None) -> int | None:
    if not started_at:
        return None
    end = finished_at or None
    return max(0, int((end - started_at).total_seconds() * 1000)) if end else None


def _eligibility(kind: str, status: str, celery_task_id: str) -> dict[str, bool]:
    normalized = _normalized_status(status)
    retry = normalized == "failed" and kind in TASK_KINDS
    cancel = (
        normalized in {"queued", "running"}
        and bool(celery_task_id)
        and kind in {"knowledge_index", "video_generation", "video_composition"}
    )
    return {"retry": retry, "cancel": cancel}


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["admin_id"]),
        "kind": row["admin_kind"],
        "jobId": str(row["admin_job_id"]),
        "user": {"id": str(row["admin_user_id"]), "displayName": row["admin_user_name"]},
        "status": _normalized_status(row["admin_status"]),
        "stage": row["admin_stage"],
        "progress": row["admin_progress"],
        "createdAt": row["admin_created"].isoformat(),
        "updatedAt": row["admin_updated"].isoformat(),
        "startedAt": row["admin_started"].isoformat() if row["admin_started"] else None,
        "finishedAt": row["admin_finished"].isoformat() if row["admin_finished"] else None,
        "durationMs": _duration_ms(row["admin_started"], row["admin_finished"]),
        "errorSummary": _error_summary(row["admin_error"]),
        "traceId": row["admin_trace"],
        "eligibility": _eligibility(row["admin_kind"], row["admin_status"], row["admin_celery"]),
    }


def _combined_queryset(*, kind: str, status: str, user_id: int | None, search: str):
    kinds = (kind,) if kind else tuple(TASK_KINDS)
    querysets = [_QUERY_BUILDERS[item](status=status, user_id=user_id, search=search) for item in kinds]
    combined = querysets[0]
    for queryset in querysets[1:]:
        combined = combined.union(queryset, all=True)
    return combined.order_by("-admin_created", "-admin_kind", "-admin_id")


def list_tasks(params) -> dict[str, Any]:
    page, page_size, kind, status, user_id, search = _validate_filters(params)
    queryset = _combined_queryset(kind=kind, status=status, user_id=user_id, search=search)
    total = queryset.count()
    start = (page - 1) * page_size
    items = [_serialize_row(row) for row in queryset[start : start + page_size]]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def _row_for_task(kind: str, item_id: str) -> dict[str, Any] | None:
    if kind not in TASK_KINDS:
        raise ValueError("任务类型无效")
    queryset = _QUERY_BUILDERS[kind](status="", user_id=None, search="").filter(admin_id=str(item_id))
    return queryset.first()


def get_task(kind: str, item_id: str) -> dict[str, Any] | None:
    row = _row_for_task(kind, item_id)
    return _serialize_row(row) if row else None
