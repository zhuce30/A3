from __future__ import annotations

from typing import Any
from uuid import uuid4

from django.utils import timezone

from backend.apps.profiles.dynamic_profile import build_dynamic_profile
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot


PROFILE_FEED_SCHEMA_VERSION = "a3.dynamic-profile-feed.v1"
PROFILE_UPDATE_SCHEMA_VERSION = "a3.profile-update-candidate.v1"
PROFILE_VERSION_SCHEMA_VERSION = "a3.profile-version.v1"
PROFILE_UPDATE_LIMIT = 20
PROFILE_VERSION_LIMIT = 50


def create_profile_update_candidate(
    profile: LearnerProfile,
    *,
    dimension: str,
    previous_value: Any,
    next_value: Any,
    source: str,
    evidence: dict[str, Any] | None = None,
    confidence: float = 0.5,
    conflict_explanation: str = "",
    save: bool = True,
) -> dict[str, Any]:
    extra = _extra(profile)
    candidate = _build_update_record(
        update_id=f"puc_{uuid4().hex[:12]}",
        dimension=dimension,
        previous_value=previous_value,
        next_value=next_value,
        source=source,
        evidence=evidence,
        confidence=confidence,
        conflict_explanation=conflict_explanation,
        status="pending",
    )
    queue = [item for item in extra.get("profileUpdateCandidates", []) if isinstance(item, dict)]
    queue.insert(0, candidate)
    extra["profileUpdateCandidates"] = queue[:PROFILE_UPDATE_LIMIT]
    profile.extra_profile = extra
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return candidate


def create_profile_update_candidates_from_event(
    profile: LearnerProfile,
    *,
    event_type: str,
    source: str,
    signals: dict[str, Any] | None = None,
    evidence: dict[str, Any] | None = None,
    raw_preview: str = "",
    save: bool = True,
) -> list[dict[str, Any]]:
    signals = signals if isinstance(signals, dict) else {}
    evidence = evidence if isinstance(evidence, dict) else {}
    candidates: list[dict[str, Any]] = []
    event_type = str(event_type or "")
    source = str(source or event_type or "learning_event")

    def add(dimension: str, next_value: Any, previous_value: Any, confidence: float, conflict: str = "") -> None:
        if not _dimension_has_value(next_value):
            return
        if _values_equivalent(previous_value, next_value):
            return
        candidates.append(
            create_profile_update_candidate(
                profile,
                dimension=dimension,
                previous_value=previous_value,
                next_value=next_value,
                source=source,
                evidence={"eventType": event_type, **evidence},
                confidence=confidence,
                conflict_explanation=conflict,
                save=False,
            )
        )

    current_weak_points = profile.weak_points if isinstance(profile.weak_points, list) else []
    current_resources = profile.expected_resources if isinstance(profile.expected_resources, list) else []
    extra = _extra(profile)
    current_mistakes = extra.get("mistakePatterns") if isinstance(extra.get("mistakePatterns"), list) else []

    if event_type == "admission_diagnostic":
        level = signals.get("level") if isinstance(signals.get("level"), dict) else {}
        add("foundationLevel", signals.get("foundationLevel") or signals.get("foundation_level") or level.get("foundationLevel"), profile.foundation_level, 0.82)
        weak_points = _merge_unique(current_weak_points, signals.get("weakPoints") or signals.get("weak_points"))
        add("weakPoints", weak_points, current_weak_points, 0.86, "入学诊断给出了新的薄弱点，需要学生确认是否纳入长期画像。")

    if event_type in {"assessment_wrong_answer", "wrong_question_added", "wrong_question_reviewed"}:
        weak_points = _merge_unique(current_weak_points, signals.get("weakPoints"))
        add("weakPoints", weak_points, current_weak_points, 0.88, "错题记录显示该知识点需要进入后续复习和推荐排序。")
        mistake_patterns = _merge_unique(current_mistakes, signals.get("errorCauses") or signals.get("mistakePatterns"))
        add("mistakePatterns", mistake_patterns, current_mistakes, 0.8)

    if event_type in {"classroom_qa", "coaching_qa"} or event_type.startswith("openmaic_"):
        style = _infer_cognitive_style(raw_preview, signals)
        add("cognitiveStyle", style, _current_cognitive_style(profile), 0.62)
        if int(_safe_int(signals.get("questionCount"), 0)) >= 3:
            add("motivationRisk", "短时间内多次追问，建议安排更多分步讲解和即时反馈。", extra.get("motivationRisk", ""), 0.58)

    if event_type == "resource_feedback":
        resource_type = str(signals.get("resourceType") or signals.get("resource") or "").strip()
        action = str(signals.get("action") or "").strip()
        score = _safe_int(signals.get("score"), 0)
        if action in {"completed", "favorited"} or score >= 4:
            resources = _merge_unique(current_resources, [_resource_type_label(resource_type)])
            add("resourcePreferences", resources, current_resources, 0.74)
        if action == "skipped" or score in {1, 2}:
            add("motivationRisk", "最近资源反馈偏低，建议降低单次学习负荷并提供更短资源。", extra.get("motivationRisk", ""), 0.68)

    if not candidates:
        return []
    extra = _extra(profile)
    queue = [item for item in extra.get("profileUpdateCandidates", []) if isinstance(item, dict)]
    extra["profileUpdateCandidates"] = queue[:PROFILE_UPDATE_LIMIT]
    profile.extra_profile = extra
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return candidates


def dynamic_profile_feed(profile: LearnerProfile) -> dict[str, Any]:
    extra = _extra(profile)
    dynamic_profile = build_dynamic_profile(profile, extra=extra)
    snapshot = extra.get("profileSnapshot") if isinstance(extra.get("profileSnapshot"), dict) else None
    if snapshot is None:
        snapshot = aggregate_profile_snapshot(profile, save=True)
        extra = _extra(profile)
    candidates = [item for item in extra.get("profileUpdateCandidates", []) if isinstance(item, dict)]
    versions = [item for item in extra.get("profileVersions", []) if isinstance(item, dict)]
    confirmation_queue = [item for item in candidates if item.get("status") == "pending"]
    timeline = sorted(candidates + versions, key=lambda item: str(item.get("createdAt") or ""), reverse=True)
    return {
        "schemaVersion": PROFILE_FEED_SCHEMA_VERSION,
        "dynamicProfile": dynamic_profile,
        "profileSnapshot": snapshot,
        "confirmationQueue": [_public_update(item) for item in confirmation_queue],
        "timeline": [_public_update(item) for item in timeline[:PROFILE_VERSION_LIMIT]],
    }


def confirm_profile_update(profile: LearnerProfile, update_id: str) -> dict[str, Any]:
    extra = _extra(profile)
    candidate = _find_candidate(extra, update_id)
    if candidate is None:
        raise ValueError("画像更新不存在或已处理")
    version_number = _next_version_number(extra)
    confirmed = {**candidate, "status": "confirmed", "resolvedAt": timezone.now().isoformat(), "versionNumber": version_number}
    _apply_dimension(profile, str(candidate.get("changedDimensions", [""])[0]), candidate.get("nextValue"))
    extra = _extra(profile)
    _replace_candidate(extra, update_id, confirmed)
    _prepend_version(extra, confirmed, version_number=version_number)
    extra["dynamicProfile"] = build_dynamic_profile(profile, extra=extra)
    profile.extra_profile = extra
    profile.save(update_fields=_profile_save_fields(confirmed))
    snapshot = aggregate_profile_snapshot(profile, save=True)
    return {
        "update": _public_update(confirmed),
        "dynamicProfile": profile.extra_profile.get("dynamicProfile") or build_dynamic_profile(profile),
        "profileSnapshot": snapshot,
    }


def reject_profile_update(profile: LearnerProfile, update_id: str, *, reason: str = "") -> dict[str, Any]:
    extra = _extra(profile)
    candidate = _find_candidate(extra, update_id)
    if candidate is None:
        raise ValueError("画像更新不存在或已处理")
    version_number = _next_version_number(extra)
    rejected = {
        **candidate,
        "status": "rejected",
        "resolvedAt": timezone.now().isoformat(),
        "rejectionReason": str(reason or "")[:160],
        "versionNumber": version_number,
    }
    _replace_candidate(extra, update_id, rejected)
    _prepend_version(extra, rejected, version_number=version_number)
    extra["dynamicProfile"] = build_dynamic_profile(profile, extra=extra)
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return {
        "update": _public_update(rejected),
        "dynamicProfile": extra["dynamicProfile"],
        "profileSnapshot": extra.get("profileSnapshot"),
    }


def _build_update_record(
    *,
    update_id: str,
    dimension: str,
    previous_value: Any,
    next_value: Any,
    source: str,
    evidence: dict[str, Any] | None,
    confidence: float,
    conflict_explanation: str,
    status: str,
) -> dict[str, Any]:
    now = timezone.now().isoformat()
    safe_evidence = evidence if isinstance(evidence, dict) else {}
    safe_dimension = str(dimension or "")[:80]
    safe_source = str(source or "profile_update_engine")[:80]
    safe_previous = _safe_value(previous_value)
    safe_next = _safe_value(next_value)
    safe_conflict = str(conflict_explanation or "")[:240]
    return {
        "schemaVersion": PROFILE_UPDATE_SCHEMA_VERSION,
        "id": update_id,
        "changedDimensions": [safe_dimension],
        "previousValue": safe_previous,
        "nextValue": safe_next,
        "source": safe_source,
        "evidence": safe_evidence,
        "evidenceSummary": _evidence_summary(safe_evidence),
        "confidence": _confidence(confidence),
        "conflictType": _conflict_type(safe_previous, safe_next, safe_source, safe_conflict),
        "conflictExplanation": safe_conflict,
        "impactSummary": _impact_summary(safe_dimension),
        "status": status,
        "createdAt": now,
        "updatedAt": now,
    }


def _find_candidate(extra: dict[str, Any], update_id: str) -> dict[str, Any] | None:
    for item in extra.get("profileUpdateCandidates", []):
        if isinstance(item, dict) and item.get("id") == update_id and item.get("status") == "pending":
            return item
    return None


def _replace_candidate(extra: dict[str, Any], update_id: str, replacement: dict[str, Any]) -> None:
    candidates = []
    for item in extra.get("profileUpdateCandidates", []):
        if isinstance(item, dict) and item.get("id") == update_id:
            candidates.append(replacement)
        elif isinstance(item, dict):
            candidates.append(item)
    extra["profileUpdateCandidates"] = candidates[:PROFILE_UPDATE_LIMIT]


def _prepend_version(extra: dict[str, Any], update: dict[str, Any], *, version_number: int) -> None:
    versions = [item for item in extra.get("profileVersions", []) if isinstance(item, dict)]
    versions.insert(
        0,
        {
            **update,
            "schemaVersion": PROFILE_VERSION_SCHEMA_VERSION,
            "versionId": f"pv_{uuid4().hex[:12]}",
            "versionNumber": version_number,
            "createdAt": timezone.now().isoformat(),
        },
    )
    extra["profileVersions"] = versions[:PROFILE_VERSION_LIMIT]


def _next_version_number(extra: dict[str, Any]) -> int:
    versions = [item for item in extra.get("profileVersions", []) if isinstance(item, dict)]
    numbers = []
    for item in versions:
        try:
            numbers.append(int(item.get("versionNumber") or 0))
        except (TypeError, ValueError):
            continue
    return (max(numbers) if numbers else 0) + 1


def _apply_dimension(profile: LearnerProfile, dimension: str, value: Any) -> None:
    extra = _extra(profile)
    if dimension == "foundationLevel":
        profile.foundation_level = str(value or "")[:64]
    elif dimension == "dailyStudyTime":
        try:
            profile.daily_study_time = max(5, min(int(value), 600))
        except (TypeError, ValueError):
            profile.daily_study_time = profile.daily_study_time
    elif dimension == "pace":
        profile.pace = str(value or profile.pace)[:32]
    elif dimension == "weakPoints":
        profile.weak_points = _as_list(value)
    elif dimension == "learningGoals":
        profile.learning_goals = _as_list(value)
    elif dimension == "resourcePreferences":
        profile.expected_resources = _as_list(value)
    elif dimension == "cognitiveStyle":
        extra["cognitiveStyle"] = str(value or "")[:120]
    elif dimension == "learningHistory":
        extra["learningHistory"] = str(value or "")[:240]
    elif dimension == "motivationRisk":
        extra["motivationRisk"] = str(value or "")[:160]
    elif dimension == "mistakePatterns":
        extra["mistakePatterns"] = _as_list(value)
    else:
        extra.setdefault("profileDimensionOverrides", {})[dimension] = _safe_value(value)
    profile.extra_profile = extra


def _profile_save_fields(update: dict[str, Any]) -> list[str]:
    fields = {"extra_profile", "updated_at"}
    dimension = str((update.get("changedDimensions") or [""])[0])
    if dimension == "foundationLevel":
        fields.add("foundation_level")
    elif dimension == "dailyStudyTime":
        fields.add("daily_study_time")
    elif dimension == "pace":
        fields.add("pace")
    elif dimension == "weakPoints":
        fields.add("weak_points")
    elif dimension == "learningGoals":
        fields.add("learning_goals")
    elif dimension == "resourcePreferences":
        fields.add("expected_resources")
    return sorted(fields)


def _public_update(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or item.get("versionId") or ""),
        "versionId": str(item.get("versionId") or ""),
        "versionNumber": _safe_public_int(item.get("versionNumber")),
        "schemaVersion": str(item.get("schemaVersion") or ""),
        "changedDimensions": item.get("changedDimensions") if isinstance(item.get("changedDimensions"), list) else [],
        "previousValue": item.get("previousValue"),
        "nextValue": item.get("nextValue"),
        "source": str(item.get("source") or ""),
        "evidence": item.get("evidence") if isinstance(item.get("evidence"), dict) else {},
        "evidenceSummary": str(item.get("evidenceSummary") or ""),
        "confidence": _confidence(item.get("confidence", 0.5)),
        "conflictType": str(item.get("conflictType") or "none"),
        "conflictExplanation": str(item.get("conflictExplanation") or ""),
        "impactSummary": str(item.get("impactSummary") or ""),
        "status": str(item.get("status") or "pending"),
        "rejectionReason": str(item.get("rejectionReason") or ""),
        "createdAt": str(item.get("createdAt") or ""),
        "resolvedAt": str(item.get("resolvedAt") or ""),
    }


def _safe_value(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [_safe_value(item) for item in value[:20]]
    if isinstance(value, dict):
        return {str(key)[:80]: _safe_value(next_value) for key, next_value in list(value.items())[:20]}
    return str(value)[:160]


def _confidence(value: Any) -> float:
    try:
        return round(max(0.0, min(float(value), 1.0)), 2)
    except (TypeError, ValueError):
        return 0.5


def _safe_public_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip()[:80] for item in value if str(item).strip()][:20]
    if isinstance(value, str) and value.strip():
        return [value.strip()[:80]]
    return []


def _extra(profile: LearnerProfile) -> dict[str, Any]:
    if isinstance(profile.extra_profile, dict):
        return dict(profile.extra_profile)
    return {}


def _merge_unique(current: Any, incoming: Any) -> list[str]:
    merged: list[str] = []
    for value in _as_list(current) + _as_list(incoming):
        text = str(value).strip()
        if text and text not in merged:
            merged.append(text)
    return merged[:12]


def _dimension_has_value(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return bool([item for item in value if str(item).strip()])
    if isinstance(value, dict):
        return bool(value)
    return value is not None


def _values_equivalent(previous: Any, next_value: Any) -> bool:
    if isinstance(previous, list) or isinstance(next_value, list):
        return _as_list(previous) == _as_list(next_value)
    return str(previous or "").strip() == str(next_value or "").strip()


def _current_cognitive_style(profile: LearnerProfile) -> str:
    prefs = profile.learning_preferences if isinstance(profile.learning_preferences, dict) else {}
    extra = _extra(profile)
    return str(extra.get("cognitiveStyle") or prefs.get("cognitiveStyle") or prefs.get("style") or "").strip()


def _infer_cognitive_style(raw_preview: str, signals: dict[str, Any]) -> str:
    text = f"{raw_preview} {signals}".lower()
    if any(token in text for token in ("图", "动画", "画", "visual", "example", "例题", "演示")):
        return "偏好图解、动画或例题驱动的讲解。"
    if any(token in text for token in ("步骤", "一步", "流程", "step")):
        return "偏好分步骤拆解和即时反馈。"
    if any(token in text for token in ("为什么", "原理", "推导", "证明")):
        return "偏好先理解原理再进入练习。"
    return ""


def _resource_type_label(resource_type: str) -> str:
    labels = {
        "lecture_doc": "讲义文档",
        "knowledge_card": "知识卡片",
        "mind_map": "思维导图",
        "practice_set": "专项练习",
        "case_study": "案例拆解",
        "code_lab": "代码实验",
        "micro_video_script": "短视频讲解",
    }
    return labels.get(resource_type, resource_type or "资源反馈")


def _evidence_summary(evidence: dict[str, Any]) -> str:
    parts: list[str] = []
    event_types = evidence.get("eventTypes")
    if isinstance(event_types, list) and event_types:
        parts.append(f"学习事件：{'、'.join(str(item) for item in event_types[:4])}")
    elif evidence.get("eventType"):
        parts.append(f"学习事件：{evidence.get('eventType')}")
    if evidence.get("score") is not None:
        parts.append(f"得分 {evidence.get('score')}")
    if evidence.get("correctCount") is not None and evidence.get("totalCount") is not None:
        parts.append(f"答对 {evidence.get('correctCount')}/{evidence.get('totalCount')}")
    if evidence.get("windowDays"):
        parts.append(f"观察窗口 {evidence.get('windowDays')} 天")
    if evidence.get("diagnosticId"):
        parts.append(f"诊断 {evidence.get('diagnosticId')}")
    if evidence.get("wrongQuestionId"):
        parts.append(f"错题 {evidence.get('wrongQuestionId')}")
    if evidence.get("sessionId"):
        parts.append(f"课堂 {evidence.get('sessionId')}")
    if evidence.get("packId") or evidence.get("resourcePackId"):
        parts.append(f"资源包 {evidence.get('packId') or evidence.get('resourcePackId')}")
    return "；".join(parts[:4]) or "来自学习行为和画像证据"


def _conflict_type(previous_value: Any, next_value: Any, source: str, conflict_explanation: str) -> str:
    if conflict_explanation:
        return "behavior_conflict"
    if _dimension_has_value(previous_value) and not _values_equivalent(previous_value, next_value):
        if source in {"learning_event_stream", "assessment", "classroom", "resource_feedback", "admission_diagnostic"}:
            return "profile_drift"
        return "manual_conflict"
    return "none"


def _impact_summary(dimension: str) -> str:
    impacts = {
        "foundationLevel": "确认后会影响入学诊断后的路径难度、今日任务和课程讲解深度。",
        "weakPoints": "确认后会影响今日任务、学习计划和推荐排序，薄弱点相关练习会被提前。",
        "mistakePatterns": "确认后会影响错题复习节奏、讲解方式和练习反馈。",
        "resourcePreferences": "确认后会影响推荐排序和资源生成类型。",
        "cognitiveStyle": "确认后会影响 AI 课堂讲解方式、推荐理由和资源呈现形态。",
        "learningHistory": "确认后会影响学习路径起点和计划强度。",
        "motivationRisk": "确认后会影响今日任务、学习计划和推荐排序，系统会调整任务负荷。",
        "learningGoals": "确认后会影响学习路径、阶段计划和资源筛选。",
        "dailyStudyTime": "确认后会影响每日任务数量和复习节奏。",
        "pace": "确认后会影响学习计划节奏和任务拆分。",
    }
    return impacts.get(dimension, "确认后会影响后续画像、学习计划和资源推荐。")


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
