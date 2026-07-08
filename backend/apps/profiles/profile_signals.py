from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

from django.utils import timezone

from backend.apps.profiles.models import LearnerProfile


PROFILE_SIGNAL_SCHEMA_VERSION = "a3.profile-signal.v1"
PROFILE_SIGNAL_LIMIT = 120


def profile_signals(profile: LearnerProfile) -> list[dict]:
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    signals = extra.get("profileSignals")
    if not isinstance(signals, list):
        return []
    return [item for item in signals if isinstance(item, dict)]


def append_profile_signal(
    profile: LearnerProfile,
    *,
    dimension: str,
    value: Any,
    source: str,
    confidence: float,
    evidence: dict | None = None,
    trace_id: str = "",
    weight: float = 1.0,
    observed_at: str = "",
    save: bool = True,
) -> dict:
    now = timezone.now().isoformat()
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    signals = profile_signals(profile)
    signal = {
        "schemaVersion": PROFILE_SIGNAL_SCHEMA_VERSION,
        "dimension": str(dimension or "")[:64],
        "value": _json_safe_value(value),
        "source": str(source or "")[:80],
        "confidence": _bounded_float(confidence),
        "weight": _bounded_float(weight),
        "evidence": _json_safe_value(evidence) if isinstance(evidence, dict) else {},
        "traceId": str(trace_id or "")[:120],
        "observedAt": str(observed_at or now),
        "createdAt": now,
    }
    extra["profileSignals"] = [signal, *signals][:PROFILE_SIGNAL_LIMIT]
    profile.extra_profile = extra
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return signal


def _bounded_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(max(0.0, min(number, 1.0)), 3)


def _json_safe_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, Mapping):
        return {str(key)[:80]: _json_safe_value(item) for key, item in value.items()}
    if isinstance(value, set):
        return [_json_safe_value(item) for item in list(value)[:20]]
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_safe_value(item) for item in value[:20]]
    return str(value)


__all__ = [
    "PROFILE_SIGNAL_LIMIT",
    "PROFILE_SIGNAL_SCHEMA_VERSION",
    "append_profile_signal",
    "profile_signals",
]
