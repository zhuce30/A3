from __future__ import annotations

import math
import json
from collections import Counter, defaultdict
from typing import Any

from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_signals import profile_signals


PROFILE_SNAPSHOT_SCHEMA_VERSION = "a3.profile-snapshot.v1"

PROFILE_SNAPSHOT_DIMENSIONS = [
    "grade",
    "majorDirection",
    "foundationLevel",
    "dailyStudyTime",
    "pace",
    "learningGoals",
    "weakPoints",
    "resourcePreferences",
    "cognitiveStyle",
    "learningHistory",
    "mistakePatterns",
    "motivationRisk",
    "learningPace",
    "resourceEffectiveness",
]

PROFILE_SNAPSHOT_REQUIRED_DIMENSIONS = [
    "grade",
    "majorDirection",
    "foundationLevel",
    "dailyStudyTime",
    "learningGoals",
    "weakPoints",
    "resourcePreferences",
]

_DIMENSION_ALIASES = {
    "grade": "grade",
    "gradelevel": "grade",
    "majordirection": "majorDirection",
    "major_direction": "majorDirection",
    "major": "majorDirection",
    "foundationlevel": "foundationLevel",
    "foundation_level": "foundationLevel",
    "dailystudytime": "dailyStudyTime",
    "daily_study_time": "dailyStudyTime",
    "studytime": "dailyStudyTime",
    "pace": "pace",
    "learninggoals": "learningGoals",
    "learning_goals": "learningGoals",
    "goal": "learningGoals",
    "goals": "learningGoals",
    "weakpoints": "weakPoints",
    "weak_points": "weakPoints",
    "weakpoint": "weakPoints",
    "weak_point": "weakPoints",
    "resourcepreferences": "resourcePreferences",
    "resource_preferences": "resourcePreferences",
    "learningpreferences": "resourcePreferences",
    "learning_preferences": "resourcePreferences",
    "expectedresources": "resourcePreferences",
    "expected_resources": "resourcePreferences",
    "preference": "resourcePreferences",
    "preferences": "resourcePreferences",
    "cognitivestyle": "cognitiveStyle",
    "cognitive_style": "cognitiveStyle",
    "learninghistory": "learningHistory",
    "learning_history": "learningHistory",
    "mistakepatterns": "mistakePatterns",
    "mistake_patterns": "mistakePatterns",
    "mistakepattern": "mistakePatterns",
    "errorcause": "mistakePatterns",
    "errorcauses": "mistakePatterns",
    "motivationrisk": "motivationRisk",
    "motivation_risk": "motivationRisk",
    "learningpace": "learningPace",
    "learning_pace": "learningPace",
    "resourceeffectiveness": "resourceEffectiveness",
    "resource_effectiveness": "resourceEffectiveness",
}

_STABLE_FIELD_DIMENSIONS = {"grade", "majorDirection", "dailyStudyTime", "pace"}
_LIST_DIMENSIONS = {"learningGoals", "weakPoints", "resourcePreferences", "mistakePatterns", "resourceEffectiveness"}


def aggregate_profile_snapshot(profile: LearnerProfile, *, save: bool = True) -> dict:
    signals = _ranked_signals(profile_signals(profile))
    grouped = _group_signals(signals)
    dimensions = {
        dimension: _build_dimension(profile, dimension, grouped.get(dimension, []))
        for dimension in PROFILE_SNAPSHOT_DIMENSIONS
    }
    snapshot = {
        "schemaVersion": PROFILE_SNAPSHOT_SCHEMA_VERSION,
        "dimensions": dimensions,
        "signalSummary": _signal_summary(signals),
        "readiness": _readiness(dimensions),
    }
    if save:
        extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        extra = {**extra, "profileSnapshot": snapshot, "dynamicProfileV2": snapshot}
        profile.extra_profile = extra
        profile.save(update_fields=["extra_profile", "updated_at"])
    return snapshot


def _build_dimension(profile: LearnerProfile, dimension: str, signals: list[dict]) -> dict:
    stable_value = _stable_profile_value(profile, dimension)
    signal_value = _dimension_signal_value(dimension, signals)
    has_stable_value = _has_value(stable_value)
    has_signal_value = _has_value(signal_value)

    if dimension == "weakPoints":
        value = _merge_unique(_as_list(stable_value), _as_list(signal_value), limit=12)
        basis = "stable_field+signals" if _has_value(stable_value) and _has_value(signal_value) else _basis(has_stable_value, has_signal_value)
        confidence = _dimension_confidence(signals, stable=has_stable_value, value=value)
    elif has_stable_value:
        value = stable_value
        basis = "stable_field"
        confidence = 1.0 if dimension in _STABLE_FIELD_DIMENSIONS else max(0.85, _top_confidence(signals))
    elif has_signal_value:
        value = signal_value
        basis = "signals"
        confidence = _dimension_confidence(signals, stable=False, value=value)
    else:
        value = [] if dimension in _LIST_DIMENSIONS else ""
        basis = "missing"
        confidence = 0.0

    return {
        "dimension": dimension,
        "value": value,
        "confidence": _bounded_float(confidence),
        "basis": basis,
        "sources": _source_evidence(signals),
        "missing": not _has_value(value),
    }


def _stable_profile_value(profile: LearnerProfile, dimension: str) -> Any:
    if dimension == "grade":
        return _clean_text(getattr(profile, "grade", ""))
    if dimension == "majorDirection":
        return _clean_text(getattr(profile, "major_direction", ""))
    if dimension == "foundationLevel":
        return _clean_text(getattr(profile, "foundation_level", ""))
    if dimension == "dailyStudyTime":
        return getattr(profile, "daily_study_time", None)
    if dimension == "pace":
        return _clean_text(getattr(profile, "pace", ""))
    if dimension == "learningGoals":
        return _clean_list(getattr(profile, "learning_goals", []), limit=12)
    if dimension == "weakPoints":
        return _clean_list(getattr(profile, "weak_points", []), limit=12)
    if dimension == "resourcePreferences":
        expected = _clean_list(getattr(profile, "expected_resources", []), limit=12)
        preferences = getattr(profile, "learning_preferences", {})
        if isinstance(preferences, dict):
            preferred_formats = _clean_list(preferences.get("preferredFormats"), limit=12)
            if not preferred_formats:
                preferred_formats = _clean_list(preferences.get("resources") or preferences.get("formats"), limit=12)
            return _merge_unique(expected, preferred_formats, limit=12)
        return expected or _clean_list(preferences, limit=12)
    extra = profile.extra_profile if isinstance(getattr(profile, "extra_profile", None), dict) else {}
    preferences = getattr(profile, "learning_preferences", {})
    if dimension == "cognitiveStyle":
        if isinstance(preferences, dict):
            return _clean_text(extra.get("cognitiveStyle") or preferences.get("cognitiveStyle") or preferences.get("style") or "")
        return _clean_text(extra.get("cognitiveStyle", ""))
    if dimension == "learningHistory":
        return _clean_text(extra.get("learningHistory", ""))
    if dimension == "mistakePatterns":
        return _clean_list(extra.get("mistakePatterns"), limit=12)
    if dimension == "motivationRisk":
        return _clean_text(extra.get("motivationRisk", ""))
    if dimension == "learningPace":
        return _clean_text(extra.get("learningPace", ""))
    if dimension == "resourceEffectiveness":
        return _clean_resource_effectiveness_list(extra.get("resourceEffectiveness"), limit=12)
    return ""


def _dimension_signal_value(dimension: str, signals: list[dict]) -> Any:
    if not signals:
        return [] if dimension in _LIST_DIMENSIONS else ""
    if dimension in _LIST_DIMENSIONS:
        values: list[Any] = []
        for signal in signals:
            if dimension == "resourceEffectiveness":
                values.extend(_as_resource_effectiveness_list(signal.get("value")))
            else:
                values.extend(_as_list(signal.get("value")))
        if dimension == "resourceEffectiveness":
            return _merge_unique_json(values, limit=12)
        return _merge_unique([], values, limit=12)
    return _clean_scalar(signals[0].get("value"))


def _ranked_signals(signals: list[dict]) -> list[dict]:
    cleaned = []
    for index, signal in enumerate(signals):
        dimension = _canonical_dimension(signal.get("dimension"))
        if not dimension:
            continue
        item = {
            **signal,
            "dimension": dimension,
            "_rank": _bounded_float(signal.get("confidence")) * _bounded_float(signal.get("weight", 1.0)),
            "_index": index,
        }
        cleaned.append(item)
    return sorted(
        cleaned,
        key=lambda item: (-item["_rank"], _reverse_sort_text(item.get("observedAt")), item["_index"]),
    )


def _group_signals(signals: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for signal in signals:
        grouped[signal["dimension"]].append(signal)
    return dict(grouped)


def _source_evidence(signals: list[dict]) -> list[dict]:
    return [
        {
            "source": str(signal.get("source") or "")[:80],
            "confidence": _bounded_float(signal.get("confidence")),
            "traceId": str(signal.get("traceId") or "")[:120],
            "evidence": _json_safe_mapping(signal.get("evidence")) if isinstance(signal.get("evidence"), dict) else {},
            "observedAt": str(signal.get("observedAt") or ""),
        }
        for signal in signals[:5]
    ]


def _signal_summary(signals: list[dict]) -> dict:
    sources = Counter(str(signal.get("source") or "unknown")[:80] for signal in signals)
    observed = [str(signal.get("observedAt") or "") for signal in signals if str(signal.get("observedAt") or "")]
    return {
        "total": len(signals),
        "bySource": dict(sorted(sources.items())),
        "latestAt": max(observed) if observed else "",
    }


def _readiness(dimensions: dict[str, dict]) -> dict:
    ready = [
        dimension
        for dimension in PROFILE_SNAPSHOT_REQUIRED_DIMENSIONS
        if not dimensions.get(dimension, {}).get("missing", True)
    ]
    missing = [dimension for dimension in PROFILE_SNAPSHOT_REQUIRED_DIMENSIONS if dimension not in ready]
    score = round(len(ready) * 100 / len(PROFILE_SNAPSHOT_REQUIRED_DIMENSIONS))
    if score >= 90:
        status = "ready"
    elif score >= 60:
        status = "partial"
    else:
        status = "incomplete"
    return {
        "score": score,
        "readyDimensions": ready,
        "missingDimensions": missing,
        "status": status,
    }


def _canonical_dimension(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = text.replace("-", "_")
    compact = normalized.replace("_", "").lower()
    return _DIMENSION_ALIASES.get(normalized.lower()) or _DIMENSION_ALIASES.get(compact, "")


def _basis(has_stable_value: bool, has_signal_value: bool) -> str:
    if has_stable_value:
        return "stable_field"
    if has_signal_value:
        return "signals"
    return "missing"


def _dimension_confidence(signals: list[dict], *, stable: bool, value: Any) -> float:
    if not _has_value(value):
        return 0.0
    if stable and signals:
        return max(0.85, _top_confidence(signals))
    if stable:
        return 0.95
    return _top_confidence(signals)


def _top_confidence(signals: list[dict]) -> float:
    if not signals:
        return 0.0
    return max(_bounded_float(signal.get("confidence")) for signal in signals)


def _bounded_float(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(max(0.0, min(number, 1.0)), 3)


def _has_value(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return value is not None and value != ""


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _clean_scalar(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else ""
    if isinstance(value, dict):
        for key in ("value", "label", "name", "title", "topic"):
            if _has_value(value.get(key)):
                return _clean_scalar(value.get(key))
        return ""


def _clean_list(value: Any, *, limit: int) -> list[Any]:
    return _merge_unique([], _as_list(value), limit=limit)


def _clean_resource_effectiveness_list(value: Any, *, limit: int) -> list[Any]:
    return _merge_unique_json(_as_resource_effectiveness_list(value), limit=limit)


def _as_resource_effectiveness_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, dict):
        cleaned = _json_safe_mapping(value)
        return [cleaned] if cleaned else []
    if isinstance(value, (list, tuple, set)):
        items: list[Any] = []
        for item in list(value)[:24]:
            if isinstance(item, dict):
                cleaned = _json_safe_mapping(item)
                if cleaned:
                    items.append(cleaned)
            else:
                scalar = _clean_scalar(item)
                if _has_value(scalar):
                    items.append(scalar)
        return items
    scalar = _clean_scalar(value)
    return [scalar] if _has_value(scalar) else []


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, dict):
        for key in ("items", "values", "weakPoints", "resources", "patterns", "topics"):
            nested = value.get(key)
            if isinstance(nested, list):
                return _as_list(nested)
        scalar = _clean_scalar(value)
        return [scalar] if _has_value(scalar) else []
    if isinstance(value, (list, tuple, set)):
        cleaned = []
        for item in list(value)[:24]:
            scalar = _clean_scalar(item)
            if _has_value(scalar):
                cleaned.append(scalar)
        return cleaned
    scalar = _clean_scalar(value)
    return [scalar] if _has_value(scalar) else []


def _reverse_sort_text(value: Any) -> tuple[int, ...]:
    return tuple(-ord(char) for char in str(value or ""))


def _merge_unique(primary: list[Any], secondary: list[Any], *, limit: int) -> list[Any]:
    merged: list[Any] = []
    seen = set()
    for value in [*primary, *secondary]:
        cleaned = _clean_scalar(value)
        key = str(cleaned).strip()
        if key and key not in seen:
            seen.add(key)
            merged.append(cleaned)
        if len(merged) >= limit:
            break
    return merged


def _merge_unique_json(values: list[Any], *, limit: int) -> list[Any]:
    merged: list[Any] = []
    seen = set()
    for value in values:
        cleaned = _json_safe_value(value)
        if not _has_value(cleaned):
            continue
        key = _dedupe_key(cleaned)
        if key in seen:
            continue
        seen.add(key)
        merged.append(cleaned)
        if len(merged) >= limit:
            break
    return merged


def _dedupe_key(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _json_safe_mapping(value: dict) -> dict:
    cleaned = {}
    for key, item in list(value.items())[:12]:
        clean_key = str(key or "").strip()[:80]
        if clean_key:
            cleaned[clean_key] = _json_safe_value(item)
    return cleaned


def _json_safe_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, dict):
        return _json_safe_mapping(value)
    if isinstance(value, (list, tuple, set)):
        return [_json_safe_value(item) for item in list(value)[:12]]
    return str(value)


__all__ = [
    "PROFILE_SNAPSHOT_SCHEMA_VERSION",
    "aggregate_profile_snapshot",
]
