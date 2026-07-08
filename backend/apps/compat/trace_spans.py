from __future__ import annotations

from datetime import datetime
from typing import Any

from django.utils import timezone


SPAN_METADATA_DEFAULTS = {
    "provider": "",
    "model": "",
    "tokenUsage": {},
    "fallbackReason": "",
    "promptHash": "",
}


def normalize_span_metadata(metadata: dict | None, *, latency_ms: int) -> dict:
    payload = dict(metadata or {})
    for key, value in SPAN_METADATA_DEFAULTS.items():
        payload.setdefault(key, value.copy() if isinstance(value, dict) else value)
    payload["latencyMs"] = max(1, int(payload.get("latencyMs") or latency_ms or 1))
    return payload


def normalize_span_latency(latency_ms: int | None, metadata: dict | None = None) -> int:
    if latency_ms is not None:
        return max(1, int(latency_ms))
    if isinstance(metadata, dict) and metadata.get("latencyMs") is not None:
        return max(1, int(metadata.get("latencyMs") or 1))
    return 1


def serialize_span(
    *,
    name: str,
    kind: str,
    parent_step: str,
    status: str,
    latency_ms: int,
    started_at: datetime,
    completed_at: datetime | None,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    return {
        "name": name,
        "kind": kind,
        "parentStep": parent_step,
        "status": status,
        "latencyMs": max(1, int(latency_ms or 1)),
        "startedAt": started_at.isoformat(),
        "completedAt": completed_at.isoformat() if completed_at else None,
        "metadata": metadata,
    }


def now_for_span() -> datetime:
    return timezone.now()
