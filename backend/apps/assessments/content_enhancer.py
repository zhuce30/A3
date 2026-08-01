from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Callable

import requests

from backend.apps.assessments.content_prompts import (
    REVIEW_HANDOUT_PROMPT_VERSION,
    WRONG_EXPORT_PROMPT_VERSION,
    build_review_handout_messages,
    build_wrong_export_messages,
)
from backend.apps.assessments.content_schemas import (
    ContentValidationError,
    extract_json_object,
    validate_review_handout_payload,
    validate_wrong_export_payload,
)
from backend.apps.compat.llm import LLMUnavailable, chat_completion


RETRY_DELAYS = (1, 3)


class EnhancementCancelled(RuntimeError):
    pass


@dataclass
class EnhancementResult:
    content: dict[str, Any]
    citations: list[dict[str, Any]]
    verified: bool
    degraded: bool
    degraded_reasons: list[str]
    audit: dict[str, Any]


def enhance_wrong_export(
    snapshot: dict[str, Any],
    evidence_by_point: dict[str, list[dict[str, Any]]],
    *,
    cancel_check: Callable[[], bool] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> EnhancementResult:
    questions_by_point = _questions_by_point(snapshot)
    sections = []
    section_results = []
    for point, questions in questions_by_point.items():
        _raise_if_cancelled(cancel_check)
        sources = _normalize_sources(evidence_by_point.get(point) or [])
        messages = build_wrong_export_messages(_profile(snapshot), questions, sources)
        answers = {str(item.get("questionId") or ""): item.get("correctAnswer") for item in questions}

        def validate(payload: Any) -> dict[str, Any]:
            return validate_wrong_export_payload(
                payload,
                question_ids=set(answers),
                source_ids={item["sourceId"] for item in sources},
                answers=answers,
            )

        outcome = _enhance_section(
            messages,
            validate,
            WRONG_EXPORT_PROMPT_VERSION,
            sources,
            fallback=lambda: _wrong_export_fallback(point, questions),
            cancel_check=cancel_check,
            sleep=sleep,
        )
        sections.append(outcome["content"])
        section_results.append(outcome)
    return _aggregate(sections, section_results, WRONG_EXPORT_PROMPT_VERSION)


def enhance_review_handout(
    snapshot: dict[str, Any],
    ranked_weak_points: list[dict[str, Any]],
    evidence_by_point: dict[str, list[dict[str, Any]]],
    *,
    cancel_check: Callable[[], bool] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> EnhancementResult:
    questions_by_point = _questions_by_point(snapshot)
    sections = []
    section_results = []
    for weakness in ranked_weak_points:
        point = str(weakness.get("knowledgePoint") or "未分类").strip() or "未分类"
        questions = questions_by_point.get(point, [])
        _raise_if_cancelled(cancel_check)
        sources = _normalize_sources(evidence_by_point.get(point) or [])
        messages = build_review_handout_messages(_profile(snapshot), weakness, questions, sources)
        answers = {str(item.get("questionId") or ""): item.get("correctAnswer") for item in questions}

        def validate(payload: Any) -> dict[str, Any]:
            return validate_review_handout_payload(
                payload,
                source_ids={item["sourceId"] for item in sources},
                question_ids=set(answers),
                answers=answers,
            )

        outcome = _enhance_section(
            messages,
            validate,
            REVIEW_HANDOUT_PROMPT_VERSION,
            sources,
            fallback=lambda: _review_handout_fallback(point, questions),
            cancel_check=cancel_check,
            sleep=sleep,
        )
        sections.append(outcome["content"])
        section_results.append(outcome)
    return _aggregate(sections, section_results, REVIEW_HANDOUT_PROMPT_VERSION)


def _enhance_section(
    messages: list[dict[str, str]],
    validator: Callable[[Any], dict[str, Any]],
    prompt_version: str,
    sources: list[dict[str, Any]],
    *,
    fallback: Callable[[], dict[str, Any]],
    cancel_check: Callable[[], bool] | None,
    sleep: Callable[[float], None],
) -> dict[str, Any]:
    started = time.monotonic()
    attempts = 0
    categories: list[str] = []
    response_meta: dict[str, Any] = {}
    max_attempts = _max_attempts()
    request_messages = list(messages)
    if not _llm_enabled():
        return {
            "content": fallback(),
            "citations": [],
            "degraded": True,
            "reason": "disabled",
            "attempts": 0,
            "latencyMs": int((time.monotonic() - started) * 1000),
            "meta": {},
            "errorCategories": ["disabled"],
        }
    for attempt in range(max_attempts):
        _raise_if_cancelled(cancel_check)
        attempts += 1
        try:
            response = chat_completion(
                request_messages,
                temperature=0.15,
                max_tokens=_env_int("A3_ASSESSMENT_EXPORT_LLM_MAX_TOKENS", 3000, minimum=256, maximum=8000),
                timeout_seconds=_env_float("A3_ASSESSMENT_EXPORT_LLM_TIMEOUT_SECONDS", 60.0, minimum=1.0, maximum=300.0),
                response_format={"type": "json_object"},
            )
            response_meta = response if isinstance(response, dict) else {}
            content = validator(extract_json_object(str(response_meta.get("content") or "")))
            _raise_if_cancelled(cancel_check)
            return {
                "content": content,
                "citations": _used_sources(content, sources),
                "degraded": False,
                "reason": "",
                "attempts": attempts,
                "latencyMs": int((time.monotonic() - started) * 1000),
                "meta": response_meta,
                "errorCategories": categories,
            }
        except EnhancementCancelled:
            raise
        except Exception as exc:
            _raise_if_cancelled(cancel_check)
            category, retryable = _classify_error(exc)
            categories.append(category)
            if not retryable or attempt + 1 >= max_attempts:
                break
            if isinstance(exc, ContentValidationError):
                request_messages = [
                    *messages,
                    {
                        "role": "user",
                        "content": f"上次输出校验失败（{category}）。请重新输出完整且唯一的 JSON 对象。",
                    },
                ]
            sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])
    return {
        "content": fallback(),
        "citations": [],
        "degraded": True,
        "reason": categories[-1] if categories else "provider_error",
        "attempts": attempts,
        "latencyMs": int((time.monotonic() - started) * 1000),
        "meta": response_meta,
        "errorCategories": categories,
    }


def _aggregate(
    sections: list[dict[str, Any]],
    outcomes: list[dict[str, Any]],
    prompt_version: str,
) -> EnhancementResult:
    citations: list[dict[str, Any]] = []
    seen_citations: set[tuple[str, str]] = set()
    for outcome in outcomes:
        for citation in outcome["citations"]:
            key = (str(citation.get("sourceId") or ""), str(citation.get("knowledgePoint") or ""))
            if key not in seen_citations:
                citations.append(citation)
                seen_citations.add(key)
    reasons = list(dict.fromkeys(outcome["reason"] for outcome in outcomes if outcome["reason"]))
    error_categories = list(
        dict.fromkeys(category for outcome in outcomes for category in outcome["errorCategories"])
    )
    last_meta = next((outcome["meta"] for outcome in reversed(outcomes) if outcome["meta"]), {})
    usage: dict[str, int | float] = {}
    for outcome in outcomes:
        raw_usage = outcome["meta"].get("usage") if isinstance(outcome["meta"], dict) else None
        if isinstance(raw_usage, dict):
            for key, value in raw_usage.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    usage[key] = usage.get(key, 0) + value
    degraded = any(outcome["degraded"] for outcome in outcomes) or not sections
    verified = bool(sections) and not degraded and all(
        section.get("evidenceStatus") == "verified" for section in sections
    )
    return EnhancementResult(
        content={"sections": sections},
        citations=citations,
        verified=verified,
        degraded=degraded,
        degraded_reasons=reasons or (["empty_content"] if not sections else []),
        audit={
            "promptVersion": prompt_version,
            "provider": str(last_meta.get("provider") or ""),
            "model": str(last_meta.get("model") or ""),
            "attempts": sum(outcome["attempts"] for outcome in outcomes),
            "latencyMs": sum(outcome["latencyMs"] for outcome in outcomes),
            "finishReason": str(last_meta.get("finishReason") or ""),
            "usage": usage,
            "errorCategories": error_categories,
        },
    )


def _questions_by_point(snapshot: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    raw_questions = snapshot.get("questions") if isinstance(snapshot, dict) else []
    for raw in raw_questions if isinstance(raw_questions, list) else []:
        if not isinstance(raw, dict):
            continue
        point = str(raw.get("knowledgePoint") or "未分类").strip() or "未分类"
        question = dict(raw)
        question["questionId"] = str(raw.get("questionId") or raw.get("wrongQuestionId") or "")
        question["studentAnswer"] = raw.get("studentAnswer", raw.get("lastWrongAnswer", ""))
        grouped.setdefault(point, []).append(question)
    return grouped


def _profile(snapshot: dict[str, Any]) -> dict[str, Any]:
    profile = snapshot.get("profile") if isinstance(snapshot, dict) else None
    return profile if isinstance(profile, dict) else {}


def _normalize_sources(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for index, raw in enumerate(sources[:12], start=1):
        if not isinstance(raw, dict):
            continue
        source = dict(raw)
        source["sourceId"] = str(source.get("sourceId") or f"S{index}")
        normalized.append(source)
    return normalized


def _used_sources(content: dict[str, Any], sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    used_ids: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "citationIds" and isinstance(item, list):
                    used_ids.update(str(citation_id) for citation_id in item)
                else:
                    visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)

    visit(content)
    point = str(content.get("knowledgePoint") or "")
    return [
        {
            "sourceId": str(source.get("sourceId") or ""),
            "knowledgePoint": point,
            "title": str(source.get("title") or "")[:255],
            "location": str(source.get("location") or "")[:500],
            "snippet": str(source.get("snippet") or "")[:600],
            "score": source.get("score") if isinstance(source.get("score"), (int, float)) else None,
        }
        for source in sources
        if source.get("sourceId") in used_ids
    ]


def _wrong_export_fallback(point: str, questions: list[dict[str, Any]]) -> dict[str, Any]:
    analyses = []
    for question in questions:
        error_cause = str(question.get("errorCause") or "现有信息不足以判断具体错因").strip()
        explanation = str(question.get("explanation") or "请依据原题解析核对关键条件").strip()
        analyses.append({
            "questionId": str(question.get("questionId") or ""),
            "deepErrorDiagnosis": f"基础版沿用原始错因：{error_cause}",
            "solutionSteps": [explanation],
            "selfCheck": "重新作答后，逐项核对题干条件与原始解析。",
            "reviewAdvice": "先复习原始解析，再完成一次不看答案的重练。",
            "citationIds": [],
        })
    return {
        "knowledgePoint": point,
        "groupDiagnosis": "模型增强暂不可用，当前仅展示可信原始错因与解析。",
        "prerequisiteGaps": [],
        "confusions": [],
        "questionAnalyses": analyses,
        "transferPractice": [],
        "evidenceStatus": "unverified",
    }


def _review_handout_fallback(point: str, questions: list[dict[str, Any]]) -> dict[str, Any]:
    first = questions[0] if questions else {}
    explanation = str(first.get("explanation") or "现有资料不足，请复习原题解析。")
    return {
        "knowledgePoint": point,
        "learningDiagnosis": "模型增强暂不可用，本节根据可信原题解析生成基础内容。",
        "coreConcept": explanation,
        "prerequisites": [],
        "commonErrorPatterns": [
            str(item.get("errorCause") or "待进一步分析") for item in questions[:5]
        ],
        "method": ["阅读原题解析", "遮住答案重新作答", "核对关键条件"],
        "workedExample": {
            "prompt": str(first.get("stem") or "暂无可用原题"),
            "steps": [explanation],
            "answer": str(first.get("correctAnswer") or "请参照原题解析"),
        },
        "tieredPractice": [],
        "reviewActions": ["复习原题解析后完成一次重练"],
        "citationIds": [],
        "evidenceStatus": "unverified",
    }


def _classify_error(exc: Exception) -> tuple[str, bool]:
    if isinstance(exc, ContentValidationError):
        return "invalid_response", True
    if isinstance(exc, LLMUnavailable):
        return "configuration", False
    if isinstance(exc, (requests.Timeout, TimeoutError)):
        return "timeout", True
    if isinstance(exc, requests.HTTPError):
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        if status in {401, 403}:
            return "authentication", False
        if status == 429:
            return "rate_limit", True
        if isinstance(status, int) and status >= 500:
            return "provider_error", True
        return "provider_error", False
    return "provider_error", True


def _raise_if_cancelled(cancel_check: Callable[[], bool] | None) -> None:
    if cancel_check and cancel_check():
        raise EnhancementCancelled("assessment enhancement cancelled")


def _max_attempts() -> int:
    return _env_int("A3_ASSESSMENT_EXPORT_LLM_MAX_ATTEMPTS", 3, minimum=1, maximum=3)


def _llm_enabled() -> bool:
    value = os.getenv("A3_ASSESSMENT_EXPORT_LLM_ENABLED", "auto").strip().lower()
    return value not in {"0", "false", "no", "off", "disabled"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _env_float(name: str, default: float, *, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))
