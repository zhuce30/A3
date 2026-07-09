from __future__ import annotations

from collections import Counter
from typing import Any

from django.utils import timezone

from backend.apps.profiles.models import LearnerProfile


DYNAMIC_PROFILE_SCHEMA_VERSION = "a3.dynamic-learner-profile.v1"
LEARNING_EVENT_LIMIT = 100


def append_learning_event(
    profile: LearnerProfile,
    *,
    event_type: str,
    summary: str,
    source: str,
    importance: float = 0.5,
    signals: dict[str, Any] | None = None,
    raw_preview: str = "",
    save: bool = True,
) -> dict:
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    events = [item for item in extra.get("learningEvents", []) if isinstance(item, dict)]
    event = {
        "eventType": str(event_type or "learning_event")[:64],
        "summary": str(summary or "")[:240],
        "source": str(source or "")[:64],
        "importance": max(0.0, min(float(importance), 1.0)),
        "signals": signals if isinstance(signals, dict) else {},
        "rawPreview": str(raw_preview or "")[:160],
        "createdAt": timezone.now().isoformat(),
    }
    events.insert(0, event)
    extra["learningEvents"] = events[:LEARNING_EVENT_LIMIT]
    extra["dynamicProfile"] = build_dynamic_profile(profile, extra=extra)
    profile.extra_profile = extra
    try:
        from backend.apps.profiles.profile_updates import create_profile_update_candidates_from_event

        create_profile_update_candidates_from_event(
            profile,
            event_type=event["eventType"],
            source=event["source"],
            signals=event["signals"],
            evidence={"summary": event["summary"], "createdAt": event["createdAt"]},
            raw_preview=event["rawPreview"],
            save=False,
        )
    except Exception:
        pass
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return event


def merge_dynamic_profile_signals(
    profile: LearnerProfile,
    *,
    cognitive_style: str = "",
    learning_history: str = "",
    motivation_risk: str = "",
    mistake_patterns: list[str] | None = None,
    resource_preferences: list[str] | None = None,
    llm: dict[str, Any] | None = None,
    save: bool = True,
) -> dict:
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    existing = extra.get("dynamicProfile") if isinstance(extra.get("dynamicProfile"), dict) else {}
    if cognitive_style:
        extra["cognitiveStyle"] = str(cognitive_style)[:120]
    if learning_history:
        extra["learningHistory"] = str(learning_history)[:240]
    if motivation_risk:
        extra["motivationRisk"] = str(motivation_risk)[:160]
    if mistake_patterns:
        extra["mistakePatterns"] = _merge_strings(mistake_patterns, existing.get("mistakePatterns"), limit=12)
    if resource_preferences:
        extra["resourcePreferenceEvidence"] = _resource_evidence(resource_preferences)
    if llm:
        extra["profileLlm"] = {
            "provider": str(llm.get("provider") or "")[:64],
            "model": str(llm.get("model") or "")[:96],
            "fallback": bool(llm.get("fallback")),
            "updatedAt": timezone.now().isoformat(),
        }
    extra["dynamicProfile"] = build_dynamic_profile(profile, extra=extra)
    profile.extra_profile = extra
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return extra["dynamicProfile"]


def build_dynamic_profile(profile: LearnerProfile, *, extra: dict | None = None) -> dict:
    extra = extra if isinstance(extra, dict) else (profile.extra_profile if isinstance(profile.extra_profile, dict) else {})
    learning_preferences = profile.learning_preferences if isinstance(profile.learning_preferences, dict) else {}
    events = [item for item in extra.get("learningEvents", []) if isinstance(item, dict)]
    mistake_patterns = _merge_strings(
        extra.get("mistakePatterns"),
        _mistake_patterns_from_events(events),
        limit=12,
    )
    resource_preferences = profile.expected_resources if isinstance(profile.expected_resources, list) else []
    if not resource_preferences and isinstance(learning_preferences.get("preferredFormats"), list):
        resource_preferences = learning_preferences.get("preferredFormats")
    if not resource_preferences:
        for key in ("style", "format", "cognitiveStyle"):
            value = str(learning_preferences.get(key) or "").strip()
            if value:
                resource_preferences = [value]
                break
    resource_evidence = extra.get("resourcePreferenceEvidence")
    if not isinstance(resource_evidence, list):
        resource_evidence = _resource_evidence(resource_preferences)
    llm = extra.get("profileLlm") if isinstance(extra.get("profileLlm"), dict) else {}
    return {
        "schemaVersion": DYNAMIC_PROFILE_SCHEMA_VERSION,
        "cognitiveStyle": str(
            extra.get("cognitiveStyle")
            or learning_preferences.get("cognitiveStyle")
            or learning_preferences.get("style")
            or ""
        ),
        "learningHistory": str(extra.get("learningHistory") or ""),
        "mistakePatterns": mistake_patterns,
        "motivationRisk": str(extra.get("motivationRisk") or ""),
        "resourcePreferenceEvidence": resource_evidence,
        "learningEventsSummary": _events_summary(events),
        "recentEvents": _recent_events(events),
        "dimensionCoverage": _dimension_coverage(profile, extra, mistake_patterns, resource_evidence, events),
        "llm": {
            "provider": str(llm.get("provider") or ""),
            "model": str(llm.get("model") or ""),
            "fallback": bool(llm.get("fallback", True)),
        },
        "updatedAt": timezone.now().isoformat(),
    }


def _dimension_coverage(
    profile: LearnerProfile,
    extra: dict,
    mistake_patterns: list[str],
    resource_evidence: list[dict],
    events: list[dict],
) -> dict:
    learning_preferences = profile.learning_preferences if isinstance(profile.learning_preferences, dict) else {}
    checks = [
        ("grade", "年级", profile.grade),
        ("majorDirection", "专业方向", profile.major_direction),
        ("foundationLevel", "基础水平", profile.foundation_level),
        ("dailyStudyTime", "每日时间", profile.daily_study_time),
        ("learningGoals", "学习目标", profile.learning_goals),
        ("weakPoints", "薄弱点", profile.weak_points),
        ("resourcePreferences", "资源偏好", profile.expected_resources or resource_evidence),
        ("cognitiveStyle", "认知风格", extra.get("cognitiveStyle") or learning_preferences.get("cognitiveStyle") or learning_preferences.get("style")),
        ("learningHistory", "学习历史", extra.get("learningHistory")),
        ("motivationRisk", "动机风险", extra.get("motivationRisk")),
        ("mistakePatterns", "错因模式", mistake_patterns),
        ("learningEvents", "事件来源", events),
    ]
    ready = [(field, label) for field, label, value in checks if _dimension_ready(value)]
    missing = [{"field": field, "label": label} for field, label, value in checks if not _dimension_ready(value)]
    return {
        "ready": len(ready),
        "total": len(checks),
        "labels": [label for _field, label in ready],
        "missing": missing,
        "score": round(len(ready) * 100 / len(checks)) if checks else 0,
    }


def _dimension_ready(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return bool(value)


def _events_summary(events: list[dict]) -> dict:
    counts = Counter(str(item.get("eventType") or "learning_event") for item in events)
    return {
        "total": len(events),
        "byType": dict(counts),
        "latestAt": str(events[0].get("createdAt") or "") if events else "",
    }


def _recent_events(events: list[dict]) -> list[dict]:
    return [
        {
            "eventType": str(item.get("eventType") or "")[:64],
            "summary": str(item.get("summary") or "")[:160],
            "source": str(item.get("source") or "")[:64],
            "createdAt": str(item.get("createdAt") or ""),
        }
        for item in events[:5]
    ]


def _mistake_patterns_from_events(events: list[dict]) -> list[str]:
    patterns: list[str] = []
    for event in events:
        signals = event.get("signals") if isinstance(event.get("signals"), dict) else {}
        candidates = signals.get("mistakePatterns") or signals.get("errorCauses") or []
        if isinstance(candidates, str):
            candidates = [candidates]
        if isinstance(candidates, list):
            patterns.extend(str(item) for item in candidates)
    return patterns


def _resource_evidence(resources: list[str] | Any) -> list[dict]:
    if not isinstance(resources, list):
        return []
    return [
        {"resource": str(item)[:80], "source": "profile_signal", "weight": 1.0}
        for item in resources
        if str(item).strip()
    ][:12]


def _merge_strings(primary: Any, secondary: Any = None, *, limit: int) -> list[str]:
    merged: list[str] = []
    for value in _as_list(primary) + _as_list(secondary):
        text = str(value).strip()
        if text and text not in merged:
            merged.append(text)
    return merged[:limit]


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        return [value]
    return []
