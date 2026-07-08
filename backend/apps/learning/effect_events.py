from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any

from django.utils import timezone

from backend.apps.learning.models import LearningEvent


RESOURCE_EVENT_ACTIONS = {
    "resource_opened": "opened",
    "resource_completed": "completed",
    "resource_skipped": "skipped",
    "resource_favorited": "favorited",
}


def record_learning_event(
    user,
    *,
    event_type: str,
    target_type: str = "",
    target_id: str = "",
    knowledge_point_id: str = "",
    resource_type: str = "",
    duration_sec: int = 0,
    score: float | str | int | None = None,
    quality: dict | None = None,
    metadata: dict | None = None,
    trace_id: str = "",
) -> LearningEvent:
    normalized_event_type = str(event_type or "").strip()
    if not normalized_event_type:
        raise ValueError("event_type is required")
    return LearningEvent.objects.create(
        user=user,
        event_type=normalized_event_type[:64],
        target_type=str(target_type or "").strip()[:64],
        target_id=str(target_id or "").strip()[:128],
        knowledge_point_id=str(knowledge_point_id or "").strip()[:128],
        resource_type=str(resource_type or "").strip()[:64],
        duration_sec=max(0, _safe_int(duration_sec, 0)),
        score=_safe_float_or_none(score),
        quality=quality if isinstance(quality, dict) else {},
        metadata=metadata if isinstance(metadata, dict) else {},
        trace_id=str(trace_id or "").strip()[:128],
    )


def list_recent_learning_events(user, *, limit: int = 100) -> list[dict]:
    safe_limit = max(1, min(_safe_int(limit, 100), 200))
    events = LearningEvent.objects.filter(user=user).order_by("-created_at", "-id")[:safe_limit]
    return [serialize_learning_event(event) for event in events]


def aggregate_learning_events(user, *, days: int = 30) -> dict:
    safe_days = max(1, min(_safe_int(days, 30), 365))
    started_at = timezone.now() - timedelta(days=safe_days)
    events = list(LearningEvent.objects.filter(user=user, created_at__gte=started_at).order_by("-created_at", "-id"))
    event_counts = Counter(event.event_type for event in events)
    resource_usage = _resource_usage(events)
    scores = [event.score for event in events if event.score is not None]
    return {
        "schemaVersion": "a3.learning-events.summary.v1",
        "timeWindow": {
            "days": safe_days,
            "startedAt": started_at.isoformat(),
            "endedAt": timezone.now().isoformat(),
        },
        "totalEvents": len(events),
        "eventCounts": dict(event_counts),
        "resourceUsage": resource_usage,
        "totalDurationSec": sum(max(0, int(event.duration_sec or 0)) for event in events),
        "averageScore": round(sum(scores) / len(scores), 1) if scores else 0,
        "recentEvents": [serialize_learning_event(event) for event in events[:10]],
    }


def serialize_learning_event(event: LearningEvent) -> dict:
    return {
        "id": str(event.id),
        "eventType": event.event_type,
        "targetType": event.target_type,
        "targetId": event.target_id,
        "knowledgePointId": event.knowledge_point_id,
        "resourceType": event.resource_type,
        "durationSec": event.duration_sec,
        "score": event.score,
        "quality": event.quality if isinstance(event.quality, dict) else {},
        "metadata": event.metadata if isinstance(event.metadata, dict) else {},
        "traceId": event.trace_id,
        "createdAt": event.created_at.isoformat(),
    }


def _resource_usage(events: list[LearningEvent]) -> dict:
    totals = {"opened": 0, "completed": 0, "skipped": 0, "favorited": 0}
    by_type: dict[str, dict[str, int]] = defaultdict(lambda: {"opened": 0, "completed": 0, "skipped": 0, "favorited": 0})
    for event in events:
        action = RESOURCE_EVENT_ACTIONS.get(event.event_type)
        if not action:
            continue
        totals[action] += 1
        resource_type = event.resource_type or "unknown"
        by_type[resource_type][action] += 1
    return {**totals, "byType": dict(by_type)}


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float_or_none(value: float | str | int | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
