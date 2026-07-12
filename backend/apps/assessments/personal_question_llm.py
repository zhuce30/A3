from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

from backend.apps.compat.llm import chat_completion


ALLOWED_QUESTION_KINDS = {"concept", "scenario", "judgement_correction", "application", "wrong_variant"}


@dataclass(frozen=True)
class GroundedCandidateBatch:
    candidates: list[dict]
    provider: str
    model: str
    fallback: bool
    error: str
    rejected_count: int


def generate_grounded_personal_candidates(
    *,
    point_title: str,
    variant_indexes: list[int],
    profile_signals: dict,
    evidence_rows: list[dict],
) -> GroundedCandidateBatch:
    if not _llm_configured():
        return GroundedCandidateBatch([], "rules", "", True, "llm_not_configured", 0)
    allowed_evidence = [
        {
            "blockId": str(item.get("blockId") or ""),
            "resourceTitle": str(item.get("resourceTitle") or ""),
            "pageNumber": item.get("pageNumber"),
            "modality": str(item.get("modality") or "text"),
            "quote": str(item.get("quote") or "")[:500],
        }
        for item in evidence_rows[:8]
        if str(item.get("blockId") or "") and str(item.get("quote") or "").strip()
    ]
    if not allowed_evidence or not variant_indexes:
        return GroundedCandidateBatch([], "rules", "", True, "missing_evidence", 0)
    prompt = {
        "knowledgePoint": point_title,
        "variantIndexes": variant_indexes,
        "profileSignals": profile_signals,
        "allowedEvidence": allowed_evidence,
        "requirements": {
            "questionKinds": sorted(ALLOWED_QUESTION_KINDS),
            "reasoningForms": [
                "concept_boundary", "parameter_change", "scenario_transfer",
                "judgement_and_correction", "error_diagnosis", "evidence_application",
            ],
            "options": "exactly four unique options with keys A, B, C, D",
            "evidence": "evidenceBlockIds must contain only blockId values from allowedEvidence",
            "grounding": "stem, answer and explanation must be supported by cited evidence; do not invent facts",
            "output": {"questions": [
                "variantIndex", "questionKind", "stem", "options", "correctAnswer",
                "explanation", "errorCause", "evidenceBlockIds", "reasoningForm",
            ]},
        },
        "outputSchema": {
            "questions": [{
                "variantIndex": variant_indexes[0],
                "questionKind": "scenario",
                "stem": "至少 12 个字的题干",
                "options": [
                    {"key": "A", "text": "选项文本"},
                    {"key": "B", "text": "选项文本"},
                    {"key": "C", "text": "选项文本"},
                    {"key": "D", "text": "选项文本"},
                ],
                "correctAnswer": "A",
                "explanation": "至少 12 个字，并说明所引用证据如何支持答案",
                "errorCause": "学生选择错误选项时暴露的具体错因",
                "evidenceBlockIds": [allowed_evidence[0]["blockId"]],
                "reasoningForm": "scenario_transfer",
            }],
        },
    }
    try:
        result = chat_completion(
            [
                {
                    "role": "system",
                    "content": (
                        "你是智学引擎的个性化题目生成器。只能使用用户提供的证据块出题。"
                        "不得编造教材、页码、公式、实验结果或事实。只输出合法 JSON。"
                    ),
                },
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
            ],
            temperature=0.35,
            max_tokens=min(3600, 900 + len(variant_indexes) * 420),
            timeout_seconds=float(os.getenv("A3_PERSONAL_QUESTION_LLM_TIMEOUT_SECONDS", "35")),
            response_format={"type": "json_object"},
        )
        raw_candidates = _parse_candidates(str(result.get("content") or ""))
        allowed_ids = {item["blockId"] for item in allowed_evidence}
        requested_indexes = set(variant_indexes)
        candidates = []
        seen_indexes = set()
        rejected = 0
        for candidate in raw_candidates:
            normalized = _normalize_candidate(candidate, requested_indexes, allowed_ids)
            if not normalized or normalized["variantIndex"] in seen_indexes:
                rejected += 1
                continue
            seen_indexes.add(normalized["variantIndex"])
            candidates.append(normalized)
        return GroundedCandidateBatch(
            candidates=candidates,
            provider=str(result.get("provider") or "dashscope"),
            model=str(result.get("model") or ""),
            fallback=False,
            error="",
            rejected_count=rejected,
        )
    except Exception as exc:
        return GroundedCandidateBatch([], "rules", "", True, str(exc)[:240], 0)


def _llm_configured() -> bool:
    return bool((os.getenv("A3_LLM_API_KEY") or os.getenv("DASHSCOPE_API_KEY") or os.getenv("OPENAI_API_KEY") or "").strip())


def _parse_candidates(content: str) -> list[dict]:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    payload = json.loads(text)
    rows = payload.get("questions") if isinstance(payload, dict) else payload
    return [item for item in rows if isinstance(item, dict)] if isinstance(rows, list) else []


def _normalize_candidate(candidate: dict, requested_indexes: set[int], allowed_ids: set[str]) -> dict | None:
    try:
        variant_index = int(candidate.get("variantIndex"))
    except (TypeError, ValueError):
        return None
    question_kind = str(candidate.get("questionKind") or "").strip()
    stem = str(candidate.get("stem") or "").strip()
    explanation = str(candidate.get("explanation") or "").strip()
    error_cause = str(candidate.get("errorCause") or "").strip()
    correct_answer = str(candidate.get("correctAnswer") or "").strip().upper()
    evidence_ids = candidate.get("evidenceBlockIds")
    options = candidate.get("options")
    if variant_index not in requested_indexes or question_kind not in ALLOWED_QUESTION_KINDS:
        return None
    if len(stem) < 12 or len(explanation) < 12 or not error_cause:
        return None
    if not isinstance(evidence_ids, list) or not evidence_ids:
        return None
    normalized_evidence_ids = list(dict.fromkeys(str(item) for item in evidence_ids if str(item)))
    if not normalized_evidence_ids or any(item not in allowed_ids for item in normalized_evidence_ids):
        return None
    if not isinstance(options, list) or len(options) != 4:
        return None
    normalized_options = []
    option_keys = set()
    option_texts = set()
    for option in options:
        if not isinstance(option, dict):
            return None
        key = str(option.get("key") or "").strip().upper()
        text = str(option.get("text") or "").strip()
        if key not in {"A", "B", "C", "D"} or not text or key in option_keys or text in option_texts:
            return None
        option_keys.add(key)
        option_texts.add(text)
        normalized_options.append({"key": key, "text": text})
    if option_keys != {"A", "B", "C", "D"} or correct_answer not in option_keys:
        return None
    return {
        "variantIndex": variant_index,
        "questionKind": question_kind,
        "stem": stem,
        "options": normalized_options,
        "correctAnswer": correct_answer,
        "explanation": explanation,
        "errorCause": error_cause,
        "evidenceBlockIds": normalized_evidence_ids,
        "reasoningForm": str(candidate.get("reasoningForm") or "evidence_application").strip()[:64],
    }
