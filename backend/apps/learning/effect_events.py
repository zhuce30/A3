from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
from typing import Any

from django.db import IntegrityError, transaction
from django.utils.dateparse import parse_datetime
from django.utils import timezone

from backend.apps.learning.models import LearningEvent


LEARNING_EVENT_SCHEMA_V1 = "a3.learning-event.v1"
LEARNING_EVENT_SCHEMA_V2 = "a3.learning-event.v2"

ALLOWED_CLIENT_EVENT_TYPES = {
    "page_viewed",
    "resource_clicked",
    "resource_opened",
    "resource_completed",
    "resource_skipped",
    "resource_favorited",
    "practice_started",
    "practice_submitted",
    "question_answered",
    "assessment_submitted",
    "task_started",
    "task_completed",
    "coach_message_sent",
    "classroom_opened",
    "video_opened",
    "video_completed",
    "algorithm_lab_started",
    "algorithm_lab_checkpoint_submitted",
    "algorithm_lab_completed",
}

SERVER_VERIFIED_EVENT_TYPES = {"algorithm_lab_completed"}

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
        schema_version=LEARNING_EVENT_SCHEMA_V1,
        ingest_status="accepted",
    )


def ingest_learning_event_v2(user, payload: dict, *, trusted: bool = False) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("事件数据必须是对象")
    normalized = _normalize_client_event_payload(payload, trusted=trusted)
    event_id = normalized["event_id"]
    existing = LearningEvent.objects.filter(user=user, event_id=event_id).first()
    if existing:
        return {"status": "duplicate", "event": existing, "created": False}
    try:
        with transaction.atomic():
            event = LearningEvent.objects.create(user=user, ingest_status="accepted", **normalized)
    except IntegrityError:
        existing = LearningEvent.objects.filter(user=user, event_id=event_id).first()
        if existing:
            return {"status": "duplicate", "event": existing, "created": False}
        raise
    return {"status": "accepted", "event": event, "created": True}


def ingest_learning_events_batch_v2(user, events: list[Any]) -> dict:
    if not isinstance(events, list):
        raise ValueError("events 必须是数组")
    if len(events) > 50:
        raise ValueError("单次最多提交 50 条事件")
    results = []
    accepted = duplicates = rejected = 0
    for index, payload in enumerate(events):
        try:
            result = ingest_learning_event_v2(user, payload)
        except ValueError as exc:
            rejected += 1
            results.append({"index": index, "status": "rejected", "error": str(exc)})
            continue
        if result["status"] == "duplicate":
            duplicates += 1
        else:
            accepted += 1
        results.append({"index": index, "status": result["status"], "event": serialize_learning_event(result["event"])})
    return {
        "schemaVersion": LEARNING_EVENT_SCHEMA_V2,
        "accepted": accepted,
        "duplicates": duplicates,
        "rejected": rejected,
        "results": results,
    }


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
        "eventStream": _event_stream_stats(events),
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
        "eventId": event.event_id,
        "sourcePage": event.source_page,
        "clientTimestamp": event.client_timestamp.isoformat() if event.client_timestamp else "",
        "schemaVersion": event.schema_version,
        "ingestStatus": event.ingest_status,
        "createdAt": event.created_at.isoformat(),
    }


def _normalize_client_event_payload(payload: dict, *, trusted: bool = False) -> dict:
    schema_version = str(payload.get("schemaVersion") or LEARNING_EVENT_SCHEMA_V2).strip()
    if schema_version != LEARNING_EVENT_SCHEMA_V2:
        raise ValueError("事件 schemaVersion 必须是 a3.learning-event.v2")
    event_id = str(payload.get("eventId") or "").strip()
    if not event_id or len(event_id) > 128:
        raise ValueError("事件 ID 不能为空且不能超过 128 个字符")
    event_type = str(payload.get("eventType") or "").strip()
    if not event_type or len(event_type) > 64 or event_type not in ALLOWED_CLIENT_EVENT_TYPES:
        raise ValueError("事件类型无效")
    if event_type in SERVER_VERIFIED_EVENT_TYPES and not trusted:
        raise ValueError("该完成事件只能由实验完成接口写入")
    source_page = str(payload.get("sourcePage") or "").strip()
    if len(source_page) > 255:
        raise ValueError("来源页面不能超过 255 个字符")
    quality = payload.get("quality") if isinstance(payload.get("quality"), dict) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    client_timestamp = _parse_client_timestamp(payload.get("clientTimestamp"))
    return {
        "event_id": event_id,
        "event_type": event_type,
        "target_type": str(payload.get("targetType") or "").strip()[:64],
        "target_id": str(payload.get("targetId") or "").strip()[:128],
        "knowledge_point_id": str(payload.get("knowledgePointId") or "").strip()[:128],
        "resource_type": str(payload.get("resourceType") or "").strip()[:64],
        "duration_sec": max(0, _safe_int(payload.get("durationSec"), 0)),
        "score": _safe_float_or_none(payload.get("score")),
        "quality": quality,
        "metadata": metadata,
        "trace_id": str(payload.get("traceId") or "").strip()[:128],
        "source_page": source_page,
        "client_timestamp": client_timestamp,
        "schema_version": schema_version,
    }


def _parse_client_timestamp(value: Any):
    if not value:
        return None
    parsed = parse_datetime(str(value))
    if parsed is None:
        raise ValueError("客户端时间格式无效")
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _event_stream_stats(events: list[LearningEvent]) -> dict:
    v2_events = [event for event in events if event.schema_version == LEARNING_EVENT_SCHEMA_V2]
    source_pages = Counter(event.source_page for event in v2_events if event.source_page)
    return {
        "schemaVersion": LEARNING_EVENT_SCHEMA_V2,
        "v2EventCount": len(v2_events),
        "acceptedCount": sum(1 for event in v2_events if event.ingest_status == "accepted"),
        "sourcePages": [{"sourcePage": page, "count": count} for page, count in source_pages.most_common(10)],
        "batchApi": "/api/learning/events/batch/",
        "singleApi": "/api/learning/events/",
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
