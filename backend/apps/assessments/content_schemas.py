import copy
import json
import re
from typing import Any, Iterable


MAX_PROSE_LENGTH = 2_000
MAX_LIST_LENGTH = 12
MAX_EXERCISES = 6
EVIDENCE_STATUSES = {"verified", "partial", "unverified"}


class ContentValidationError(ValueError):
    pass


def extract_json_object(content: str) -> dict[str, Any]:
    if not isinstance(content, str):
        raise ContentValidationError("模型响应必须是 JSON 文本")
    try:
        value = json.loads(content.strip())
    except (json.JSONDecodeError, TypeError) as exc:
        raise ContentValidationError("模型响应不是单个 JSON 对象") from exc
    if not isinstance(value, dict):
        raise ContentValidationError("模型响应必须是单个 JSON 对象")
    return value


def _require_object(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContentValidationError(f"{field} 必须是对象")
    return value


def _require_exact_fields(value: dict[str, Any], required: set[str], field: str) -> None:
    missing = sorted(required - set(value))
    if missing:
        raise ContentValidationError(f"{field} 缺少字段 {missing[0]}")
    extra = sorted(set(value) - required)
    if extra:
        raise ContentValidationError(f"{field} 包含额外字段 {extra[0]}")


def _prose(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ContentValidationError(f"{field} 必须是文本")
    normalized = value.strip()
    if not normalized and not allow_empty:
        raise ContentValidationError(f"{field} 不能为空")
    if len(normalized) > MAX_PROSE_LENGTH:
        raise ContentValidationError(f"{field} 超过 {MAX_PROSE_LENGTH} 字")
    return normalized


def _list(value: Any, field: str, *, maximum: int = MAX_LIST_LENGTH) -> list[Any]:
    if not isinstance(value, list):
        raise ContentValidationError(f"{field} 必须是列表")
    if len(value) > maximum:
        raise ContentValidationError(f"{field} 最多 {maximum} 项")
    return value


def _prose_list(value: Any, field: str, *, maximum: int = MAX_LIST_LENGTH) -> list[str]:
    return [_prose(item, f"{field}[{index}]") for index, item in enumerate(_list(value, field, maximum=maximum))]


def _citation_ids(value: Any, field: str, source_ids: set[str]) -> list[str]:
    citations = _prose_list(value, field)
    seen: set[str] = set()
    for citation_id in citations:
        if citation_id not in source_ids:
            raise ContentValidationError(f"未知引用 {citation_id}")
        if citation_id in seen:
            raise ContentValidationError(f"重复引用 {citation_id}")
        seen.add(citation_id)
    return citations


def _evidence_status(value: Any) -> str:
    status = _prose(value, "evidenceStatus")
    if status not in EVIDENCE_STATUSES:
        raise ContentValidationError("非法 evidenceStatus")
    return status


_ANSWER_ASSERTION = re.compile(
    r"(?:本题|原题)?\s*(?:正确答案|正确选项|答案)\s*(?:应当|应该|应|是|为)\s*[：:]?\s*([^，。；;、\s]+)",
    re.IGNORECASE,
)


def _answer_token(value: Any) -> str:
    return re.sub(r"[\s。．.，,；;：:]", "", str(value)).casefold()


def _reject_answer_conflict(texts: Iterable[str], correct_answers: Iterable[Any]) -> None:
    expected = {_answer_token(answer) for answer in correct_answers if _answer_token(answer)}
    if not expected:
        return
    for text in texts:
        for match in _ANSWER_ASSERTION.finditer(text):
            if _answer_token(match.group(1)) not in expected:
                raise ContentValidationError("正确答案冲突")


def validate_wrong_export_payload(
    payload: Any,
    *,
    question_ids: set[str],
    source_ids: set[str],
    answers: dict[str, Any],
) -> dict[str, Any]:
    result = copy.deepcopy(_require_object(payload, "payload"))
    required = {
        "knowledgePoint", "groupDiagnosis", "prerequisiteGaps", "confusions",
        "questionAnalyses", "transferPractice", "evidenceStatus",
    }
    _require_exact_fields(result, required, "payload")
    normalized: dict[str, Any] = {
        "knowledgePoint": _prose(result["knowledgePoint"], "knowledgePoint"),
        "groupDiagnosis": _prose(result["groupDiagnosis"], "groupDiagnosis"),
        "prerequisiteGaps": _prose_list(result["prerequisiteGaps"], "prerequisiteGaps"),
    }

    normalized_confusions = []
    for index, raw in enumerate(_list(result["confusions"], "confusions")):
        item = _require_object(raw, f"confusions[{index}]")
        _require_exact_fields(item, {"conceptA", "conceptB", "difference"}, f"confusions[{index}]")
        normalized_confusions.append({key: _prose(item[key], f"confusions[{index}].{key}") for key in ("conceptA", "conceptB", "difference")})
    normalized["confusions"] = normalized_confusions

    analyses = []
    seen_questions: set[str] = set()
    analysis_fields = {"questionId", "deepErrorDiagnosis", "solutionSteps", "selfCheck", "reviewAdvice", "citationIds"}
    for index, raw in enumerate(_list(result["questionAnalyses"], "questionAnalyses")):
        item = _require_object(raw, f"questionAnalyses[{index}]")
        _require_exact_fields(item, analysis_fields, f"questionAnalyses[{index}]")
        question_id = _prose(item["questionId"], f"questionAnalyses[{index}].questionId")
        if question_id not in question_ids:
            raise ContentValidationError(f"未知题目 {question_id}")
        if question_id in seen_questions:
            raise ContentValidationError(f"重复题目 {question_id}")
        seen_questions.add(question_id)
        diagnosis = _prose(item["deepErrorDiagnosis"], f"questionAnalyses[{index}].deepErrorDiagnosis")
        steps = _prose_list(item["solutionSteps"], f"questionAnalyses[{index}].solutionSteps")
        self_check = _prose(item["selfCheck"], f"questionAnalyses[{index}].selfCheck")
        review_advice = _prose(item["reviewAdvice"], f"questionAnalyses[{index}].reviewAdvice")
        _reject_answer_conflict([diagnosis, *steps, self_check, review_advice], [answers.get(question_id)])
        analyses.append({
            "questionId": question_id,
            "deepErrorDiagnosis": diagnosis,
            "solutionSteps": steps,
            "selfCheck": self_check,
            "reviewAdvice": review_advice,
            "citationIds": _citation_ids(item["citationIds"], f"questionAnalyses[{index}].citationIds", source_ids),
        })
    normalized["questionAnalyses"] = analyses

    practices = []
    practice_fields = {"prompt", "answer", "explanation", "difficulty", "citationIds"}
    for index, raw in enumerate(_list(result["transferPractice"], "transferPractice", maximum=MAX_EXERCISES)):
        item = _require_object(raw, f"transferPractice[{index}]")
        _require_exact_fields(item, practice_fields, f"transferPractice[{index}]")
        difficulty = _prose(item["difficulty"], f"transferPractice[{index}].difficulty")
        if difficulty not in {"基础", "进阶"}:
            raise ContentValidationError("非法 transferPractice difficulty")
        practices.append({
            "prompt": _prose(item["prompt"], f"transferPractice[{index}].prompt"),
            "answer": _prose(item["answer"], f"transferPractice[{index}].answer"),
            "explanation": _prose(item["explanation"], f"transferPractice[{index}].explanation"),
            "difficulty": difficulty,
            "citationIds": _citation_ids(item["citationIds"], f"transferPractice[{index}].citationIds", source_ids),
        })
    normalized["transferPractice"] = practices
    normalized["evidenceStatus"] = _evidence_status(result["evidenceStatus"])
    all_answers = answers.values()
    global_texts = [
        normalized["knowledgePoint"],
        normalized["groupDiagnosis"],
        *normalized["prerequisiteGaps"],
        *(text for item in normalized["confusions"] for text in item.values()),
        *(
            text
            for item in normalized["questionAnalyses"]
            for text in (
                item["deepErrorDiagnosis"],
                *item["solutionSteps"],
                item["selfCheck"],
                item["reviewAdvice"],
            )
        ),
        *(
            text
            for item in normalized["transferPractice"]
            for text in (item["prompt"], item["explanation"])
        ),
    ]
    _reject_answer_conflict(global_texts, all_answers)
    return normalized


def validate_review_handout_payload(
    payload: Any,
    *,
    source_ids: set[str],
    answers: dict[str, Any] | None = None,
    question_ids: set[str] | None = None,
) -> dict[str, Any]:
    result = copy.deepcopy(_require_object(payload, "payload"))
    required = {
        "knowledgePoint", "learningDiagnosis", "coreConcept", "prerequisites",
        "commonErrorPatterns", "method", "workedExample", "tieredPractice",
        "reviewActions", "citationIds", "evidenceStatus",
    }
    _require_exact_fields(result, required, "payload")
    normalized: dict[str, Any] = {
        "knowledgePoint": _prose(result["knowledgePoint"], "knowledgePoint"),
        "learningDiagnosis": _prose(result["learningDiagnosis"], "learningDiagnosis"),
        "coreConcept": _prose(result["coreConcept"], "coreConcept"),
        "prerequisites": _prose_list(result["prerequisites"], "prerequisites"),
        "commonErrorPatterns": _prose_list(result["commonErrorPatterns"], "commonErrorPatterns"),
        "method": _prose_list(result["method"], "method"),
    }

    example = _require_object(result["workedExample"], "workedExample")
    _require_exact_fields(example, {"prompt", "steps", "answer"}, "workedExample")
    normalized["workedExample"] = {
        "prompt": _prose(example["prompt"], "workedExample.prompt"),
        "steps": _prose_list(example["steps"], "workedExample.steps"),
        "answer": _prose(example["answer"], "workedExample.answer"),
    }

    practices = []
    levels: set[str] = set()
    practice_fields = {"level", "prompt", "answer", "explanation"}
    for index, raw in enumerate(_list(result["tieredPractice"], "tieredPractice", maximum=MAX_EXERCISES)):
        item = _require_object(raw, f"tieredPractice[{index}]")
        _require_exact_fields(item, practice_fields, f"tieredPractice[{index}]")
        level = _prose(item["level"], f"tieredPractice[{index}].level")
        if level not in {"基础", "巩固", "迁移"}:
            raise ContentValidationError("非法 tieredPractice level")
        levels.add(level)
        practices.append({
            "level": level,
            "prompt": _prose(item["prompt"], f"tieredPractice[{index}].prompt"),
            "answer": _prose(item["answer"], f"tieredPractice[{index}].answer"),
            "explanation": _prose(item["explanation"], f"tieredPractice[{index}].explanation"),
        })
    if levels != {"基础", "巩固", "迁移"}:
        raise ContentValidationError("tieredPractice 必须包含基础、巩固、迁移")
    normalized["tieredPractice"] = practices
    normalized["reviewActions"] = _prose_list(result["reviewActions"], "reviewActions")
    normalized["citationIds"] = _citation_ids(result["citationIds"], "citationIds", source_ids)
    normalized["evidenceStatus"] = _evidence_status(result["evidenceStatus"])
    immutable_answers = answers or {}
    if question_ids is not None:
        unknown_answers = sorted(set(immutable_answers) - question_ids)
        if unknown_answers:
            raise ContentValidationError(f"未知题目 {unknown_answers[0]}")
    generated_texts = [
        normalized["knowledgePoint"],
        normalized["learningDiagnosis"],
        normalized["coreConcept"],
        *normalized["prerequisites"],
        *normalized["commonErrorPatterns"],
        *normalized["method"],
        normalized["workedExample"]["prompt"],
        *normalized["workedExample"]["steps"],
        normalized["workedExample"]["answer"],
        *(
            text
            for item in normalized["tieredPractice"]
            for text in (item["prompt"], item["answer"], item["explanation"])
        ),
        *normalized["reviewActions"],
    ]
    _reject_answer_conflict(generated_texts, immutable_answers.values())
    return normalized
