from __future__ import annotations

from typing import Any

from django.db.models import Count, Q

from backend.apps.compat.models import AgentRun, AgentSpan, AgentStep
from backend.apps.system.admin_conversation_services import parse_pagination


RUN_STATUSES = {"queued", "running", "succeeded", "failed", "degraded", "cancelled", "stale"}


def _integer(value: Any, *, minimum: int = 0) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    return result if result >= minimum else None


def _boolean(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _safe_policy(value: Any, keys: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, Any] = {}
    for key in keys:
        item = value.get(key)
        if key in {"maxRetries", "timeoutMs", "attempts", "failureCount", "threshold"}:
            normalized = _integer(item)
        elif key in {"timedOut", "valid", "degraded", "open"}:
            normalized = _boolean(item)
        elif isinstance(item, str) and len(item) <= 120 and "/" not in item and "\\" not in item:
            normalized = item
        else:
            normalized = None
        if normalized is not None:
            result[key] = normalized
    return result


def safe_run_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    result = {}
    retry_policy = _safe_policy(metadata.get("retryPolicy"), ("maxRetries", "timeoutMs"))
    circuit_breaker = _safe_policy(
        metadata.get("circuitBreaker"),
        ("status", "open", "failureCount", "threshold"),
    )
    if retry_policy:
        result["retryPolicy"] = retry_policy
    if circuit_breaker:
        result["circuitBreaker"] = circuit_breaker
    return result


def safe_step_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    result: dict[str, Any] = {}
    policies = {
        "runtimePolicy": ("maxRetries", "timeoutMs", "attempts", "timedOut"),
        "outputSchema": ("schemaVersion", "valid"),
        "degradation": ("status", "degraded", "fallbackStrategy"),
    }
    for key, fields in policies.items():
        sanitized = _safe_policy(metadata.get(key), fields)
        if sanitized:
            result[key] = sanitized
    for key in ("topK", "attempts", "timeoutMs"):
        value = _integer(metadata.get(key))
        if value is not None:
            result[key] = value
    if isinstance(metadata.get("timedOut"), bool):
        result["timedOut"] = metadata["timedOut"]
    schema_version = metadata.get("a3EvidenceSchemaVersion")
    if isinstance(schema_version, str) and len(schema_version) <= 80:
        result["a3EvidenceSchemaVersion"] = schema_version
    return result


def safe_span_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("provider", "model", "promptHash", "errorType"):
        value = metadata.get(key)
        if isinstance(value, str) and len(value) <= 120 and "/" not in value and "\\" not in value:
            result[key] = value
    latency = _integer(metadata.get("latencyMs"), minimum=0)
    if latency is not None:
        result["latencyMs"] = latency
    token_usage = _safe_policy(metadata.get("tokenUsage"), ("inputTokens", "outputTokens", "totalTokens"))
    if token_usage:
        result["tokenUsage"] = token_usage
    return result


def agent_run_queryset():
    return (
        AgentRun.objects.select_related("user")
        .annotate(step_count=Count("steps", distinct=True), span_count=Count("spans", distinct=True))
        .order_by("-started_at", "-id")
    )


def _apply_filters(queryset, params):
    status = str(params.get("status", "")).strip()
    if status:
        if status not in RUN_STATUSES:
            raise ValueError("Agent 运行状态无效")
        queryset = queryset.filter(status=status)
    workflow = str(params.get("workflow", "")).strip()
    if len(workflow) > 80:
        raise ValueError("工作流筛选不能超过 80 个字符")
    if workflow:
        queryset = queryset.filter(workflow=workflow)
    user_id = str(params.get("userId", "")).strip()
    if user_id:
        if not user_id.isdigit():
            raise ValueError("用户编号无效")
        queryset = queryset.filter(user_id=int(user_id))
    search = str(params.get("search", "")).strip()
    if len(search) > 100:
        raise ValueError("搜索内容不能超过 100 个字符")
    if search:
        queryset = queryset.filter(Q(trace_id__icontains=search) | Q(workflow__icontains=search))
    return queryset


def _serialize_run(run: AgentRun) -> dict[str, Any]:
    return {
        "traceId": run.trace_id,
        "user": {"id": str(run.user_id), "displayName": run.user.display_name},
        "schemaVersion": run.schema_version,
        "workflow": run.workflow,
        "status": run.status,
        "fallbackStrategy": run.fallback_strategy,
        "latencyMs": run.latency_ms,
        "stepCount": run.step_count,
        "spanCount": run.span_count,
        "startedAt": run.started_at.isoformat(),
        "completedAt": run.completed_at.isoformat() if run.completed_at else None,
        "createdAt": run.created_at.isoformat(),
        "updatedAt": run.updated_at.isoformat(),
        "metadata": safe_run_metadata(run.metadata),
    }


def list_agent_runs(params) -> dict[str, Any]:
    page, page_size = parse_pagination(params)
    queryset = _apply_filters(agent_run_queryset(), params)
    total = queryset.count()
    start = (page - 1) * page_size
    items = [_serialize_run(run) for run in queryset[start : start + page_size]]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}


def get_agent_run(trace_id: str) -> dict[str, Any] | None:
    run = agent_run_queryset().filter(trace_id=trace_id).first()
    if not run:
        return None
    steps = list(AgentStep.objects.filter(run=run).order_by("order", "id")[:100])
    spans = list(AgentSpan.objects.filter(run=run).order_by("started_at", "id")[:100])
    payload = _serialize_run(run)
    payload["steps"] = [
        {
            "order": step.order,
            "name": step.name,
            "role": step.role,
            "status": step.status,
            "latencyMs": step.latency_ms,
            "createdAt": step.created_at.isoformat(),
            "metadata": safe_step_metadata(step.metadata),
        }
        for step in steps
    ]
    payload["spans"] = [
        {
            "id": str(span.pk),
            "parentStep": span.parent_step,
            "name": span.name,
            "kind": span.kind,
            "status": span.status,
            "latencyMs": span.latency_ms,
            "startedAt": span.started_at.isoformat(),
            "completedAt": span.completed_at.isoformat() if span.completed_at else None,
            "metadata": safe_span_metadata(span.metadata),
        }
        for span in spans
    ]
    payload["stepsTruncated"] = run.step_count > len(steps)
    payload["spansTruncated"] = run.span_count > len(spans)
    return payload
