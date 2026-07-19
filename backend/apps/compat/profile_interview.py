from __future__ import annotations

import json
import logging
import re
from typing import Any

from django.utils import timezone

from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent, build_recent_run_circuit_breaker
from backend.apps.compat.safety import check_learning_safety
from backend.apps.accounts.services import public_user
from backend.apps.compat.llm import chat_completion
from backend.apps.profiles.dynamic_profile import append_learning_event, merge_dynamic_profile_signals
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.profile_signals import append_profile_signal


logger = logging.getLogger(__name__)


SESSION_SCHEMA_VERSION = "a3.profile-interview-session.v1"
PROFILE_INTERVIEW_PROFILE_SCHEMA_VERSION = "a3.profile-interview.profile.v2"
PLANNING_DEFERRED_REASON = "awaiting_admission_diagnostic"

EMPTY_PROFILE_INTERVIEW_SESSION = {
    "schemaVersion": SESSION_SCHEMA_VERSION,
    "turnCount": 0,
    "latestTraceId": "",
    "missingDimensions": [],
    "askFields": [],
    "askStrategy": {},
    "nextQuestion": "",
    "interviewComplete": False,
    "profileCommitted": False,
    "confirmedAt": "",
    "generated": {"path": False, "studyPlan": False},
    "planningDeferred": True,
    "planningDeferredReason": PLANNING_DEFERRED_REASON,
    "messages": [],
    "updatedAt": "",
}

ASK_PRIORITY_ORDER = [
    "learningGoals",
    "weakPoints",
    "dailyMinutes",
    "foundationLevel",
    "resourcePreferences",
    "cognitiveStyle",
    "majorDirection",
    "grade",
    "learningHistory",
    "motivationRisk",
]

LEGACY_PROFILE_PLACEHOLDERS = {
    "learning_goals": {"提升课程掌握度"},
    "weak_points": {"当前路径节点"},
    "expected_resources": {"知识卡片", "练习题库"},
}

PROFILE_INTERVIEW_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "ProfileInterviewAgent",
    "LearnerModelAgent",
    "MemoryCommitAgent",
    "PlannerAgent",
]


class ProfileInterviewSafetyAgent(BaseAgent):
    name = "SafetyAgent"
    role = "learning safety"
    detail = "Check profile interview input safety."
    output_schema = {
        "type": "object",
        "properties": {"safety": {"type": "object"}},
        "required": ["safety"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        action = str(context.payload.get("action") or "message")
        text = str(context.payload.get("message") or "")
        if action == "confirm":
            safety_payload = {"safe": True, "category": "profile_commit", "reason": ""}
        else:
            safety = check_learning_safety(text)
            safety_payload = {"safe": safety.safe, "category": safety.category, "reason": safety.reason}
        return AgentResult(
            output={"safety": safety_payload},
            state_patch={"safety": safety_payload},
            input_summary={"action": action, "messageLength": len(text)},
            output_summary={"safe": safety_payload["safe"], "category": safety_payload["category"]},
            evidence={"safe": safety_payload["safe"], "category": safety_payload["category"]},
            quality={"safe": safety_payload["safe"]},
        )


class ProfileInterviewAgent(BaseAgent):
    name = "ProfileInterviewAgent"
    role = "profile interview"
    detail = "Extract or validate learner profile dimensions from the interview."
    output_schema = {
        "type": "object",
        "properties": {"profile": {"type": "object"}, "profileReadiness": {"type": "object"}},
        "required": ["profile", "profileReadiness"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        action = str(context.payload.get("action") or "message")
        safety = context.state.get("safety") if isinstance(context.state.get("safety"), dict) else {"safe": True}
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        extracted: dict = {}
        if action != "confirm" and safety.get("safe"):
            text = str(context.payload.get("message") or "")
            extracted = _extract_profile_dimensions(text, profile)
            _commit_profile(profile, extracted, text)
            profile.refresh_from_db()
        missing_dimensions = _missing_dimensions(profile)
        readiness = {
            "dimensionCount": _dimension_count(profile),
            "status": "ready" if not missing_dimensions else "partial",
            "missingDimensions": missing_dimensions,
            "interviewComplete": not missing_dimensions,
        }
        return AgentResult(
            output={"profile": _public_interview_profile(profile), "profileReadiness": readiness},
            state_patch={
                "profileReadiness": readiness,
                "missingDimensions": missing_dimensions,
                "extractedProfile": extracted,
            },
            input_summary={"action": action, "messageLength": len(str(context.payload.get("message") or ""))},
            output_summary={"dimensionCount": readiness["dimensionCount"], "missingDimensions": len(missing_dimensions)},
            evidence={"fields": sorted(extracted.keys()) if extracted else [], "missingDimensions": len(missing_dimensions)},
            quality={"interviewComplete": not missing_dimensions},
        )


class LearnerModelAgent(BaseAgent):
    name = "LearnerModelAgent"
    role = "learner modeling"
    detail = "Update learner profile readiness and commitment state."
    output_schema = {
        "type": "object",
        "properties": {"profileCommitted": {"type": "boolean"}},
        "required": ["profileCommitted"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        action = str(context.payload.get("action") or "message")
        missing_dimensions = context.state.get("missingDimensions") if isinstance(context.state.get("missingDimensions"), list) else []
        committed = action == "confirm" and not missing_dimensions
        if committed:
            context.user.profile_completed = True
            context.user.onboarding_step = "complete"
            context.user.save(update_fields=["profile_completed", "onboarding_step", "updated_at"])
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        return AgentResult(
            output={"profileCommitted": committed, "profile": _public_interview_profile(profile)},
            state_patch={"profileCommitted": committed},
            state_diff={"User.profile_completed": "true", "User.onboarding_step": "complete"} if committed else {},
            evidence={"dimensionCount": _dimension_count(profile), "profileCommitted": committed},
            quality={"ready": not missing_dimensions, "profileCommitted": committed},
        )


class ProfileInterviewMemoryCommitAgent(BaseAgent):
    name = "MemoryCommitAgent"
    role = "memory commit"
    detail = "Commit interview memory and incomplete-confirmation state."
    output_schema = {
        "type": "object",
        "properties": {"memoryCommitted": {"type": "boolean"}},
        "required": ["memoryCommitted"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        action = str(context.payload.get("action") or "message")
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        missing_dimensions = context.state.get("missingDimensions") if isinstance(context.state.get("missingDimensions"), list) else []
        session = None
        if action == "confirm" and missing_dimensions:
            ask_fields = _ask_fields(missing_dimensions)
            session = _update_interview_session_commit_state(
                profile,
                trace_id=str(context.state.get("traceId") or ""),
                missing_dimensions=missing_dimensions,
                ask_fields=ask_fields,
                ask_strategy=_ask_strategy(),
                next_question=_next_question(ask_fields),
                committed=False,
                generated={"path": False, "studyPlan": False},
            )
        return AgentResult(
            output={"memoryCommitted": True, **({"interviewSession": session} if session else {})},
            state_patch={"memoryCommitted": True, **({"interviewSession": session} if session else {})},
            state_diff={"profileInterviewSession": "updated"} if session else {"LearnerProfile": "updated"},
            evidence={"profileCommitted": bool(context.state.get("profileCommitted")), "traceId": context.state.get("traceId")},
            quality={"schemaVersion": SESSION_SCHEMA_VERSION},
        )


class ProfileInterviewPlannerAgent(BaseAgent):
    name = "PlannerAgent"
    role = "path planning"
    detail = "Defer learning path and study plan generation until admission diagnostic."
    output_schema = {
        "type": "object",
        "properties": {
            "interviewSession": {"type": "object"},
            "generated": {"type": "object"},
            "planningDeferred": {"type": "boolean"},
            "planningDeferredReason": {"type": "string"},
        },
        "required": ["interviewSession", "generated", "planningDeferred", "planningDeferredReason"],
    }

    def run(self, context: AgentContext) -> AgentResult:
        action = str(context.payload.get("action") or "message")
        text = str(context.payload.get("message") or "")
        profile, _ = LearnerProfile.objects.get_or_create(user=context.user)
        missing_dimensions = context.state.get("missingDimensions") if isinstance(context.state.get("missingDimensions"), list) else []
        ask_fields = _ask_fields(missing_dimensions)
        ask_strategy = _ask_strategy()
        generated = {"path": False, "studyPlan": False}
        profile_committed = bool(context.state.get("profileCommitted"))
        if action == "confirm":
            if missing_dimensions:
                session = context.state.get("interviewSession") if isinstance(context.state.get("interviewSession"), dict) else _update_interview_session_commit_state(
                    profile,
                    trace_id=str(context.state.get("traceId") or ""),
                    missing_dimensions=missing_dimensions,
                    ask_fields=ask_fields,
                    ask_strategy=ask_strategy,
                    next_question=_next_question(ask_fields),
                    committed=False,
                    generated=generated,
                )
                success = False
                error = "画像信息尚不完整，请先回答本轮追问后再确认。"
                next_question = session["nextQuestion"]
            else:
                profile.refresh_from_db()
                next_question = "画像已确认，下一步进入入学诊断校准路径和计划。"
                session = _update_interview_session_commit_state(
                    profile,
                    trace_id=str(context.state.get("traceId") or ""),
                    missing_dimensions=[],
                    ask_fields=[],
                    ask_strategy=ask_strategy,
                    next_question=next_question,
                    committed=profile_committed,
                    generated=generated,
                )
                success = True
                error = ""
        else:
            interview_complete = not missing_dimensions
            session = _commit_interview_session(
                profile,
                raw_text=text,
                trace_id=str(context.state.get("traceId") or ""),
                missing_dimensions=missing_dimensions,
                ask_fields=ask_fields,
                ask_strategy=ask_strategy,
                next_question=_next_question(ask_fields),
                interview_complete=interview_complete,
                generated=generated,
            )
            success = True
            error = ""
            next_question = session["nextQuestion"]
        planning_state = _restore_interview_planning_state(session)
        generated = planning_state["generated"]
        planning_deferred = planning_state["planningDeferred"]
        planning_deferred_reason = planning_state["planningDeferredReason"]
        readiness = {
            "dimensionCount": _dimension_count(profile),
            "status": "ready" if not missing_dimensions else "partial",
            "missingDimensions": missing_dimensions,
            "interviewComplete": not missing_dimensions,
        }
        return AgentResult(
            output={
                "success": success,
                "error": error,
                "profile": _public_interview_profile(profile),
                "profileReadiness": readiness,
                "missingDimensions": missing_dimensions,
                "askFields": ask_fields,
                "askStrategy": ask_strategy,
                "nextQuestion": next_question,
                "interviewComplete": not missing_dimensions,
                "profileCommitted": profile_committed,
                "interviewSession": session,
                "generated": generated,
                "planningDeferred": planning_deferred,
                "planningDeferredReason": planning_deferred_reason,
            },
            state_patch={
                "interviewSession": session,
                "generated": generated,
                "planningDeferred": planning_deferred,
                "planningDeferredReason": planning_deferred_reason,
            },
            output_summary={
                "pathGenerated": bool(generated.get("path")),
                "planGenerated": bool(generated.get("studyPlan")),
                "success": success,
            },
            state_diff={"profileInterviewSession": "updated"},
            evidence={
                "pathGenerated": bool(generated.get("path")),
                "planGenerated": bool(generated.get("studyPlan")),
                "planningDeferred": planning_deferred,
                "planningDeferredReason": planning_deferred_reason,
            },
            quality={
                "profileComplete": not missing_dimensions,
                "readyForDiagnostic": profile_committed,
            },
        )


def build_profile_interview_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (
        ProfileInterviewSafetyAgent(),
        ProfileInterviewAgent(),
        LearnerModelAgent(),
        ProfileInterviewMemoryCommitAgent(),
        ProfileInterviewPlannerAgent(),
    ):
        kernel.register(agent)
    return kernel


def run_profile_interview_workflow(user, payload: dict, *, kernel: AgentKernel | None = None):
    kernel = kernel or build_profile_interview_kernel()
    if kernel._circuit_breaker is None:
        kernel._circuit_breaker = build_recent_run_circuit_breaker(user)
    action = str(payload.get("action") or "message")
    return kernel.run(
        AgentContext(user=user, workflow="profile_interview", goal=f"profile interview {action}", payload=payload),
        PROFILE_INTERVIEW_WORKFLOW_SEQUENCE,
    )


def get_profile_interview_session(user) -> dict:
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    session = extra.get("profileInterviewSession")
    if not isinstance(session, dict):
        return dict(EMPTY_PROFILE_INTERVIEW_SESSION)
    planning_state = _restore_interview_planning_state(session)
    merged = {
        **EMPTY_PROFILE_INTERVIEW_SESSION,
        **session,
        "messages": _valid_messages(session.get("messages")),
        **planning_state,
    }
    if int(merged.get("turnCount") or 0) > 0:
        missing_dimensions = _missing_dimensions(profile)
        ask_fields = _ask_fields(missing_dimensions)
        merged["profileSnapshot"] = _public_interview_profile(profile)
        merged["profileReadiness"] = {
            "dimensionCount": _dimension_count(profile),
            "status": "ready" if not missing_dimensions else "partial",
            "missingDimensions": missing_dimensions,
            "interviewComplete": not missing_dimensions,
        }
        merged["missingDimensions"] = missing_dimensions
        merged["askFields"] = ask_fields
        merged["nextQuestion"] = _next_question(ask_fields)
        merged["interviewComplete"] = not missing_dimensions
    return {
        **merged,
    }


def _restore_interview_planning_state(session: dict) -> dict:
    stored_generated = session.get("generated")
    generated = dict(stored_generated) if isinstance(stored_generated, dict) else {}
    has_historical_generation = bool(generated.get("path") or generated.get("studyPlan"))
    if not has_historical_generation:
        generated.setdefault("path", False)
        generated.setdefault("studyPlan", False)

    if "planningDeferred" in session:
        planning_deferred = session["planningDeferred"]
    else:
        planning_deferred = not has_historical_generation
    if "planningDeferredReason" in session:
        planning_deferred_reason = session["planningDeferredReason"]
    else:
        planning_deferred_reason = PLANNING_DEFERRED_REASON if planning_deferred else ""

    return {
        "generated": generated,
        "planningDeferred": planning_deferred,
        "planningDeferredReason": planning_deferred_reason,
    }


def run_profile_interview(user, message: str) -> dict:
    text = _latest_student_interview_text(str(message or ""))
    if not text:
        raise ValueError("message 不能为空")
    result = run_profile_interview_workflow(user, {"action": "message", "message": text})
    output = dict(result.output)
    output["traceId"] = result.trace["traceId"]
    return output


def _latest_student_interview_text(message: str) -> str:
    text = str(message or "").strip()
    if not text:
        return ""
    matches = re.findall(r"(?:^|\n)\s*(?:学生|student)\s*[：:]\s*(.*?)(?=\n\s*(?:学生|student|画像访谈Agent|图像访谈Agent|agent)\s*[：:]|\Z)", text, flags=re.IGNORECASE | re.DOTALL)
    cleaned = [item.strip() for item in matches if item.strip()]
    return cleaned[-1] if cleaned else text


def confirm_profile_interview(user) -> dict:
    result = run_profile_interview_workflow(user, {"action": "confirm"})
    output = dict(result.output)
    output["traceId"] = result.trace["traceId"]
    if output.get("success"):
        output["user"] = public_user(user)
    return output


def _extract_profile_dimensions(text: str, profile: LearnerProfile | None = None) -> dict:
    rule_based = _rule_extract_profile_dimensions(text)
    try:
        return _merge_extracted_profiles(
            rule_based,
            _llm_extract_profile_dimensions(
                text,
                profile_context=_public_interview_profile(profile) if profile is not None else {},
                recent_messages=_recent_interview_messages(profile),
            ),
        )
    except Exception as exc:
        logger.warning("Profile interview LLM extraction failed; using rule fallback: %s", exc)
        rule_based["_llm"] = {
            "provider": "rules",
            "model": "",
            "fallback": True,
            "error": str(exc)[:500],
        }
        return rule_based


def _llm_extract_profile_dimensions(
    text: str,
    *,
    profile_context: dict | None = None,
    recent_messages: list[dict] | None = None,
) -> dict:
    context_payload = {
        "currentProfile": profile_context or {},
        "recentConversation": recent_messages or [],
        "currentMessage": text[:3000],
    }
    result = chat_completion(
        [
            {
                "role": "system",
                "content": (
                    "你是学习画像访谈智能体。请从学生自然语言中抽取结构化画像，只返回 JSON。"
                    "字段包括 grade, major_direction, foundation_level, daily_study_time, pace, "
                    "learning_goals, weak_points, expected_resources, learning_preferences, "
                    "cognitiveStyle, motivationRisk, learningHistory, mistakePatterns。"
                    "历史画像和对话只用于理解本轮消息中的指代。"
                    "当 currentMessage 是对 recentConversation 最后一条追问的直接回答时，"
                    "即使学生没有重复字段名称，也必须按该追问对应的画像字段抽取。"
                    "例如，最后一条追问询问坚持学习时遇到的困难，学生回答‘对基础知识的深入掌握’，"
                    "应返回 motivationRisk 为‘对基础知识的深入掌握’。"
                    "只抽取学生本轮明确新增或修正的信息，"
                    "不要重复输出未变化的历史字段，不要使用默认占位补齐；无法判断的字段返回空字符串、空数组或空对象。"
                ),
            },
            {"role": "user", "content": json.dumps(context_payload, ensure_ascii=False)},
        ],
        temperature=0.1,
        max_tokens=900,
    )
    raw = str(result.get("content") or "").strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        raw = "\n".join(lines[1:-1] if lines and lines[-1].strip() == "```" else lines[1:])
    extracted = json.loads(raw)
    if not isinstance(extracted, dict):
        raise ValueError("profile extraction must return object")
    extracted["_llm"] = {
        "provider": result.get("provider") or "dashscope",
        "model": result.get("model") or "",
        "fallback": bool(result.get("fallback")),
    }
    return _normalize_extracted_profile(extracted)


def _recent_interview_messages(profile: LearnerProfile | None) -> list[dict]:
    if profile is None:
        return []
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    session = extra.get("profileInterviewSession")
    if not isinstance(session, dict):
        return []
    return _valid_messages(session.get("messages"))[-8:]


def _rule_extract_profile_dimensions(text: str) -> dict:
    normalized = text.lower()
    grade = _extract_grade(text, normalized)
    resources = _extract_resource_preferences(text, normalized)
    weak_points = _extract_weak_points(text, normalized)
    learning_goals = _extract_learning_goals(text, normalized)
    daily_minutes = _extract_daily_minutes(text)
    major = _extract_major(text, normalized)
    foundation = _extract_foundation(text, normalized)
    cognitive_style = _extract_cognitive_style(text, normalized)
    learning_preferences = {}
    if cognitive_style:
        learning_preferences["cognitiveStyle"] = cognitive_style
    if resources:
        learning_preferences["preferredFormats"] = resources
    mistake_patterns = _extract_mistake_patterns(text, normalized)
    return {
        "grade": grade,
        "major_direction": major,
        "foundation_level": foundation,
        "daily_study_time": daily_minutes,
        "learning_goals": learning_goals,
        "weak_points": weak_points,
        "expected_resources": resources,
        "learning_preferences": learning_preferences,
        "cognitiveStyle": cognitive_style,
        "motivationRisk": _extract_motivation_risk(text, normalized),
        "learningHistory": _learning_history_hint(normalized),
        "mistakePatterns": mistake_patterns,
        "_llm": {"provider": "rules", "model": "", "fallback": True},
    }


def _normalize_extracted_profile(extracted: dict) -> dict:
    normalized = dict(extracted)
    normalized["grade"] = str(extracted.get("grade") or "").strip()
    normalized["major_direction"] = str(extracted.get("major_direction") or "").strip()
    normalized["foundation_level"] = str(extracted.get("foundation_level") or "").strip()
    daily = extracted.get("daily_study_time")
    normalized["daily_study_time"] = int(daily) if isinstance(daily, int) and 10 <= daily <= 480 else 0
    pace = str(extracted.get("pace") or "").strip()
    normalized["pace"] = pace if pace in {"relaxed", "standard", "intensive"} else ""
    normalized["learning_goals"] = _clean_text_list(extracted.get("learning_goals"), limit=8)
    normalized["weak_points"] = _clean_text_list(extracted.get("weak_points"), limit=8)
    normalized["expected_resources"] = _clean_text_list(extracted.get("expected_resources"), limit=8)
    prefs = extracted.get("learning_preferences")
    normalized["learning_preferences"] = prefs if isinstance(prefs, dict) else {}
    cognitive_style = str(extracted.get("cognitiveStyle") or "").strip()
    if cognitive_style:
        normalized["learning_preferences"] = {**normalized["learning_preferences"], "cognitiveStyle": cognitive_style}
    normalized["motivationRisk"] = str(extracted.get("motivationRisk") or "").strip()
    normalized["learningHistory"] = str(extracted.get("learningHistory") or "").strip()
    normalized["mistakePatterns"] = _clean_text_list(extracted.get("mistakePatterns"), limit=12)
    normalized["_llm"] = extracted.get("_llm") if isinstance(extracted.get("_llm"), dict) else {}
    return normalized


def _merge_extracted_profiles(rule_based: dict, llm_based: dict) -> dict:
    merged = dict(rule_based)
    for key, value in llm_based.items():
        if key == "_llm":
            merged[key] = value
        elif _has_profile_value(value):
            merged[key] = value
    return merged


def _has_profile_value(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    if isinstance(value, int):
        return value > 0
    return value is not None


def _commit_profile(profile: LearnerProfile, extracted: dict, raw_text: str) -> None:
    updated_fields: set[str] = set()
    for field in (
        "grade",
        "major_direction",
        "foundation_level",
        "daily_study_time",
    ):
        value = extracted.get(field)
        if value:
            setattr(profile, field, value)
            updated_fields.add(field)

    for field in ("learning_goals", "weak_points", "expected_resources"):
        incoming = extracted.get(field)
        if incoming:
            current = getattr(profile, field, [])
            setattr(profile, field, _merge_profile_list(field, current, incoming))
            updated_fields.add(field)

    incoming_preferences = extracted.get("learning_preferences")
    if isinstance(incoming_preferences, dict) and incoming_preferences:
        current_preferences = profile.learning_preferences if isinstance(profile.learning_preferences, dict) else {}
        merged_preferences = {**current_preferences, **incoming_preferences}
        incoming_formats = incoming_preferences.get("preferredFormats")
        if incoming_formats:
            merged_preferences["preferredFormats"] = _merge_profile_list(
                "expected_resources",
                current_preferences.get("preferredFormats", []),
                incoming_formats,
            )
        profile.learning_preferences = merged_preferences
        updated_fields.add("learning_preferences")

    extra = dict(profile.extra_profile or {})
    if extracted.get("motivationRisk"):
        extra["motivationRisk"] = extracted["motivationRisk"]
    if extracted.get("learningHistory"):
        extra["learningHistory"] = extracted["learningHistory"]
    profile.extra_profile = extra
    merge_dynamic_profile_signals(
        profile,
        cognitive_style=(profile.learning_preferences or {}).get("cognitiveStyle", "") if isinstance(profile.learning_preferences, dict) else "",
        learning_history=str(extracted.get("learningHistory") or ""),
        motivation_risk=str(extracted.get("motivationRisk") or ""),
        mistake_patterns=extracted.get("mistakePatterns") if isinstance(extracted.get("mistakePatterns"), list) else [],
        resource_preferences=extracted.get("expected_resources") if isinstance(extracted.get("expected_resources"), list) else [],
        llm=extracted.get("_llm") if isinstance(extracted.get("_llm"), dict) else {},
        save=False,
    )
    append_learning_event(
        profile,
        event_type="profile_interview",
        summary="通过自然语言对话生成学习画像",
        source="profile_interview",
        importance=0.8,
        signals={
            "weakPoints": extracted.get("weak_points", []),
            "resourcePreferences": extracted.get("expected_resources", []),
            "motivation": extracted.get("motivationRisk", ""),
            "mistakePatterns": extracted.get("mistakePatterns", []),
        },
        raw_preview=raw_text,
        save=False,
    )
    llm = extracted.get("_llm") if isinstance(extracted.get("_llm"), dict) else {}
    evidence = {"rawPreview": str(raw_text or "")[:120]}
    if llm.get("provider"):
        evidence["provider"] = llm.get("provider")
    confidence = 0.75 if llm.get("fallback") else 0.9
    for dimension, extracted_key in (
        ("learningGoals", "learning_goals"),
        ("weakPoints", "weak_points"),
        ("resourcePreferences", "expected_resources"),
        ("cognitiveStyle", "cognitiveStyle"),
        ("learningHistory", "learningHistory"),
        ("motivationRisk", "motivationRisk"),
        ("mistakePatterns", "mistakePatterns"),
    ):
        value = extracted.get(extracted_key)
        if _has_profile_value(value):
            append_profile_signal(
                profile,
                dimension=dimension,
                value=value,
                source="profile_interview",
                confidence=confidence,
                evidence=evidence,
                save=False,
            )
    snapshot = aggregate_profile_snapshot(profile, save=False)
    extra = dict(profile.extra_profile or {})
    extra["profileSnapshot"] = snapshot
    extra["dynamicProfileV2"] = snapshot
    profile.extra_profile = extra
    profile.save(update_fields=[*sorted(updated_fields), "extra_profile", "updated_at"])


def _merge_profile_list(field: str, current: Any, incoming: Any) -> list[str]:
    existing_values = _clean_text_list(current, limit=8)
    incoming_values = _clean_text_list(incoming, limit=8)
    legacy_placeholders = LEGACY_PROFILE_PLACEHOLDERS.get(field, set())
    if incoming_values:
        existing_values = [item for item in existing_values if item not in legacy_placeholders]
    return _clean_text_list([*existing_values, *incoming_values], limit=8)


def _commit_interview_session(
    profile: LearnerProfile,
    raw_text: str,
    trace_id: str,
    missing_dimensions: list[dict],
    ask_fields: list[dict],
    ask_strategy: dict,
    next_question: str,
    interview_complete: bool,
    generated: dict | None = None,
) -> dict:
    extra = dict(profile.extra_profile or {})
    previous_session = extra.get("profileInterviewSession")
    session = dict(previous_session) if isinstance(previous_session, dict) else {}
    planning_source = session if session else {"generated": generated or {}}
    planning_state = _restore_interview_planning_state(planning_source)
    messages = _valid_messages(session.get("messages"))
    now = timezone.now().isoformat()
    messages.append({"role": "user", "content": str(raw_text or "")[:500], "createdAt": now})
    if next_question:
        messages.append({"role": "agent", "content": str(next_question)[:500], "createdAt": now})
    interview_session = {
        **EMPTY_PROFILE_INTERVIEW_SESSION,
        **session,
        "schemaVersion": SESSION_SCHEMA_VERSION,
        "turnCount": int(session.get("turnCount") or 0) + 1,
        "latestTraceId": trace_id,
        "profileSnapshot": _public_interview_profile(profile),
        "profileReadiness": {
            "dimensionCount": _dimension_count(profile),
            "status": "ready" if not missing_dimensions else "partial",
            "missingDimensions": missing_dimensions,
            "interviewComplete": bool(interview_complete),
        },
        "missingDimensions": missing_dimensions,
        "askFields": ask_fields,
        "askStrategy": ask_strategy,
        "nextQuestion": next_question,
        "interviewComplete": bool(interview_complete),
        **planning_state,
        "messages": messages[-12:],
        "updatedAt": now,
    }
    extra["profileInterviewSession"] = interview_session
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return interview_session


def _update_interview_session_commit_state(
    profile: LearnerProfile,
    *,
    trace_id: str,
    missing_dimensions: list[dict],
    ask_fields: list[dict],
    ask_strategy: dict,
    next_question: str,
    committed: bool,
    generated: dict | None = None,
) -> dict:
    extra = dict(profile.extra_profile or {})
    previous_session = extra.get("profileInterviewSession")
    session = dict(previous_session) if isinstance(previous_session, dict) else {}
    planning_source = session if session else {"generated": generated or {}}
    planning_state = _restore_interview_planning_state(planning_source)
    messages = _valid_messages(session.get("messages"))
    now = timezone.now().isoformat()
    if next_question:
        messages.append({"role": "agent", "content": str(next_question)[:500], "createdAt": now})
    interview_session = {
        **EMPTY_PROFILE_INTERVIEW_SESSION,
        **session,
        "latestTraceId": trace_id,
        "profileSnapshot": _public_interview_profile(profile),
        "profileReadiness": {
            "dimensionCount": _dimension_count(profile),
            "status": "ready" if not missing_dimensions else "partial",
            "missingDimensions": missing_dimensions,
            "interviewComplete": not missing_dimensions,
        },
        "missingDimensions": missing_dimensions,
        "askFields": ask_fields,
        "askStrategy": ask_strategy,
        "nextQuestion": next_question,
        "interviewComplete": not missing_dimensions,
        "profileCommitted": bool(committed),
        "confirmedAt": now if committed else str(session.get("confirmedAt") or ""),
        **planning_state,
        "messages": messages[-12:],
        "updatedAt": now,
    }
    extra["profileInterviewSession"] = interview_session
    profile.extra_profile = extra
    profile.save(update_fields=["extra_profile", "updated_at"])
    return interview_session


def _public_interview_profile(profile: LearnerProfile) -> dict:
    extra = profile.extra_profile or {}
    learning_preferences = profile.learning_preferences if isinstance(profile.learning_preferences, dict) else {}
    return {
        "schemaVersion": PROFILE_INTERVIEW_PROFILE_SCHEMA_VERSION,
        "grade": profile.grade,
        "majorDirection": profile.major_direction,
        "foundationLevel": profile.foundation_level,
        "dailyMinutes": profile.daily_study_time,
        "learningGoals": profile.learning_goals or [],
        "weakPoints": profile.weak_points or [],
        "resourcePreferences": profile.expected_resources or [],
        "cognitiveStyle": learning_preferences.get("cognitiveStyle", ""),
        "learningHistory": extra.get("learningHistory", ""),
        "motivationRisk": extra.get("motivationRisk", ""),
    }


def _dimension_count(profile: LearnerProfile) -> int:
    return sum(
        not _profile_dimension_missing(field, value)
        for field, _, value in _profile_dimension_checks(profile)
    )


def _missing_dimensions(profile: LearnerProfile) -> list[dict]:
    return [
        {"field": field, "label": label}
        for field, label, value in _profile_dimension_checks(profile)
        if _profile_dimension_missing(field, value)
    ]


def _profile_dimension_checks(profile: LearnerProfile) -> tuple[tuple[str, str, Any], ...]:
    public = _public_interview_profile(profile)
    return (
        ("grade", "年级阶段", public.get("grade")),
        ("majorDirection", "专业方向", public.get("majorDirection")),
        ("foundationLevel", "当前基础", public.get("foundationLevel")),
        ("dailyMinutes", "每天可用时间", public.get("dailyMinutes")),
        ("learningGoals", "学习目标", public.get("learningGoals")),
        ("weakPoints", "容易卡住的内容", public.get("weakPoints")),
        ("resourcePreferences", "希望获得的资料", public.get("resourcePreferences")),
        ("cognitiveStyle", "更容易理解的讲解方式", public.get("cognitiveStyle")),
        ("learningHistory", "学习经历", public.get("learningHistory")),
        ("motivationRisk", "坚持学习时的困难", public.get("motivationRisk")),
    )


def _profile_dimension_missing(field: str, value: Any) -> bool:
    if not value:
        return True
    placeholder_fields = {
        "learningGoals": LEGACY_PROFILE_PLACEHOLDERS["learning_goals"],
        "weakPoints": LEGACY_PROFILE_PLACEHOLDERS["weak_points"],
        "resourcePreferences": LEGACY_PROFILE_PLACEHOLDERS["expected_resources"],
    }
    if field in placeholder_fields and isinstance(value, list):
        cleaned = _clean_text_list(value, limit=8)
        return bool(cleaned) and all(item in placeholder_fields[field] for item in cleaned)
    return False


def _ask_strategy() -> dict:
    return {
        "name": "plan_critical_priority",
        "priorityOrder": ASK_PRIORITY_ORDER,
        "reason": "优先追问最影响入学诊断准备度的画像信息。",
    }


def _ask_fields(missing_dimensions: list[dict]) -> list[dict]:
    priority = {field: index for index, field in enumerate(ASK_PRIORITY_ORDER)}
    return sorted(
        missing_dimensions,
        key=lambda item: (priority.get(str(item.get("field") or ""), 999), str(item.get("field") or "")),
    )[:1]


def _next_question(ask_fields: list[dict]) -> str:
    if not ask_fields:
        return "画像信息已经完整，请确认画像并开始入学诊断。"
    questions = {
        "learningGoals": "你学习这门课最想解决什么问题？",
        "weakPoints": "哪些内容或哪类题最容易卡住？",
        "dailyMinutes": "每天通常能安排多少分钟学习？",
        "foundationLevel": "以前学到什么程度，独立做题时感觉怎样？",
        "resourcePreferences": "希望优先获得视频、讲义、例题还是练习？",
        "cognitiveStyle": "看概念、跟例题还是动手操作，哪种更容易理解？",
        "majorDirection": "你的专业或学习方向是什么？",
        "grade": "你目前处于哪个年级或学习阶段？",
        "learningHistory": "以前学过哪些相关课程或内容？",
        "motivationRisk": "最近坚持学习时最容易遇到什么困难？",
    }
    field = str(ask_fields[0].get("field") or "")
    return questions.get(field, "请再补充一项学习画像信息。")


def _valid_messages(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    messages = []
    for item in value:
        if not isinstance(item, dict):
            continue
        message = dict(item)
        if message.get("role") == "user":
            message["content"] = _latest_student_interview_text(str(message.get("content") or ""))[:500]
        elif message.get("content"):
            message["content"] = str(message.get("content") or "")[:500]
        messages.append(message)
    return messages


def _extract_grade(text: str, normalized: str) -> str:
    grade_tokens = (
        ("大一", "大一"),
        ("大二", "大二"),
        ("sophomore", "大二"),
        ("大三", "大三"),
        ("junior", "大三"),
        ("大四", "大四"),
        ("senior", "大四"),
        ("研究生", "研究生"),
    )
    return _first_label_match(text, normalized, grade_tokens)


def _extract_major(text: str, normalized: str) -> str:
    if _contains_any(text, normalized, ["软件工程", "software engineering"]):
        return "软件工程"
    if _contains_any(text, normalized, ["计算机", "computer science", "computer"]):
        return "计算机科学与技术"
    if _contains_any(text, normalized, ["自动化", "automation", "控制工程", "control engineering", "control theory"]):
        return "自动化与控制工程"
    return ""


def _extract_foundation(text: str, normalized: str) -> str:
    if _contains_any(text, normalized, ["基础弱", "基础较弱", "薄弱", "weak"]):
        return "基础较弱"
    if _contains_any(text, normalized, ["基础好", "基础扎实", "solid"]):
        return "基础扎实"
    if _contains_any(text, normalized, ["基础一般", "一般", "中等", "average"]):
        return "基础一般"
    return ""


def _extract_daily_minutes(text: str) -> int:
    minute_match = re.search(r"(\d{2,3})\s*(?:分钟|分|mins?|minutes?)", text, flags=re.I)
    return int(minute_match.group(1)) if minute_match else 0


def _extract_weak_points(text: str, normalized: str) -> list[str]:
    weak_tokens = (
        ("处理机调度", "处理机调度算法"),
        ("cpu scheduling", "处理机调度算法"),
        ("进程调度", "处理机调度算法"),
        ("进程", "进程与 PCB"),
        ("process", "进程与 PCB"),
        ("线程", "线程与并发执行"),
        ("thread", "线程与并发执行"),
        ("信号量", "同步互斥与信号量"),
        ("semaphore", "同步互斥与信号量"),
        ("死锁", "死锁条件与处理"),
        ("deadlock", "死锁条件与处理"),
        ("虚拟内存", "虚拟内存与页面置换"),
        ("virtual memory", "虚拟内存与页面置换"),
        ("页面置换", "虚拟内存与页面置换"),
        ("文件系统", "文件系统与目录"),
        ("file system", "文件系统与目录"),
        ("根轨迹", "根轨迹"),
        ("root locus", "根轨迹"),
        ("频率响应", "频率响应"),
        ("frequency response", "频率响应"),
    )
    weak_points = _all_label_matches(text, normalized, weak_tokens)
    has_weak_context = _contains_any(text, normalized, ["薄弱点", "薄弱", "不确定", "不熟", "不理解", "weak"])
    has_concept_context = _contains_any(text, normalized, ["概念基础", "基础知识", "关键概念", "concept foundation"])
    if has_weak_context and has_concept_context and "基础概念与知识边界" not in weak_points:
        weak_points.append("基础概念与知识边界")
    return weak_points


def _extract_motivation_risk(text: str, normalized: str) -> str:
    explicit_patterns = (
        r"(?:最近)?(?:坚持)?学习时(?:最容易)?遇到的?困难(?:是|在于|主要是|为|[：:])?\s*(.+)",
        r"(?:遇到的)?困难(?:是|在于|主要是|为|[：:])\s*(.+)",
    )
    for pattern in explicit_patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            answer = match.group(1).strip(" \t\r\n，。！？；;,.!?")
            if answer:
                return answer[:120]

    if _contains_any(
        text,
        normalized,
        ["容易分心", "容易拖延", "坚持不下去", "时间不够", "临时任务", "容易被打断", "缺乏动力", "没有反馈"],
    ):
        return text.strip(" \t\r\n，。！？；;,.!?")[:120]
    return ""


def _extract_mistake_patterns(text: str, normalized: str) -> list[str]:
    pattern_tokens = (
        ("符号", "符号方向混淆"),
        ("sign", "符号方向混淆"),
        ("正负号", "符号方向混淆"),
        ("公式", "公式套用不稳"),
        ("formula", "公式套用不稳"),
        ("概念", "概念边界不清"),
        ("concept", "概念边界不清"),
        ("不会迁移", "迁移应用困难"),
        ("迁移", "迁移应用困难"),
        ("transfer", "迁移应用困难"),
        ("看懂不会做", "例题到练习迁移慢"),
        ("计算", "计算步骤易漏"),
        ("calculation", "计算步骤易漏"),
        ("粗心", "审题与细节检查不足"),
        ("careless", "审题与细节检查不足"),
        ("混淆", "相近概念混淆"),
        ("confuse", "相近概念混淆"),
    )
    return _all_label_matches(text, normalized, pattern_tokens)


def _extract_learning_goals(text: str, normalized: str) -> list[str]:
    goals = []
    if _contains_any(text, normalized, ["考研", "graduate exam", "postgraduate"]):
        goals.append("考研复习")
    if _contains_any(text, normalized, ["考试", "期末", "exam"]):
        goals.append("课程考试")
    if _contains_any(text, normalized, ["操作系统", "operating system", "operating systems"]):
        goals.append("掌握操作系统")
    return goals


def _extract_resource_preferences(text: str, normalized: str) -> list[str]:
    resource_tokens = (
        ("课程导学", "课程导学"),
        ("优质课程", "课程导学"),
        ("图解", "图解流程"),
        ("动画演示", "动画演示"),
        ("animation", "动画演示"),
        ("例题", "例题推导"),
        ("例题推导", "例题推导"),
        ("examples", "例题推导"),
        ("代码案例", "代码案例"),
        ("代码示例", "代码案例"),
        ("code examples", "代码案例"),
        ("实验", "代码实验"),
        ("工程案例", "工程案例"),
        ("engineering cases", "工程案例"),
        ("错题复盘", "错题复盘"),
        ("练习题库", "练习题库"),
        ("知识卡片", "知识卡片"),
        ("短视频", "视频讲解"),
        ("视频", "视频讲解"),
    )
    return _all_label_matches(text, normalized, resource_tokens)


def _likes_visual_examples(text: str, normalized: str) -> bool:
    return _contains_any(text, normalized, ["动画", "图", "例题", "animation", "examples", "visual"])


def _extract_cognitive_style(text: str, normalized: str) -> str:
    if _contains_any(text, normalized, ["由浅入深", "循序渐进", "从基础到进阶", "step by step"]):
        return "由浅入深"
    if _contains_any(text, normalized, ["先框架后细节", "先整体后细节", "先看框架"]):
        return "先框架后细节"
    if _contains_any(text, normalized, ["动手实践", "边做边学", "实践驱动", "learn by doing"]):
        return "实践驱动"
    if _likes_visual_examples(text, normalized):
        return "图解与例题驱动"
    return ""


def _learning_history_hint(normalized: str) -> str:
    if "学过" in normalized or "learned" in normalized:
        return "有相关学习经历"
    if "正在学习" in normalized or "studying" in normalized:
        return "正在学习相关课程"
    if any(token in normalized for token in ("基础", "foundation", "control theory average")):
        return "具备相关课程学习基础"
    return ""


def _contains_any(text: str, normalized: str, needles: list[str]) -> bool:
    return any(needle in text or needle.lower() in normalized for needle in needles)


def _first_label_match(text: str, normalized: str, tokens: tuple[tuple[str, str], ...]) -> str:
    for token, label in tokens:
        if token in text or token.lower() in normalized:
            return label
    return ""


def _all_label_matches(text: str, normalized: str, tokens: tuple[tuple[str, str], ...]) -> list[str]:
    labels = []
    for token, label in tokens:
        if token in text or token.lower() in normalized:
            if label not in labels:
                labels.append(label)
    return labels


def _clean_text_list(value: Any, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned = []
    for item in value:
        text = str(item).strip()
        if text and text not in cleaned:
            cleaned.append(text[:120])
    return cleaned[:limit]
