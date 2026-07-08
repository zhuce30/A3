from __future__ import annotations

from dataclasses import dataclass

from django.db import transaction

from backend.apps.assessments.models import (
    Question,
    QuestionQualityCheck,
    QuestionReviewStatus,
    QuestionSourceType,
    QuestionType,
)


MOJIBAKE_MARKERS = (
    "锟",
    "�",
    "閻",
    "缁",
    "妫",
    "闁",
    "鏉",
    "閹",
    "瀵",
    "娴",
    "鐐",
)

GENERATED_SOURCE_TYPES = {
    QuestionSourceType.KB_GENERATED,
    QuestionSourceType.PERSONAL_GENERATED,
    QuestionSourceType.VARIANT,
}


@dataclass(frozen=True)
class QuestionVerificationResult:
    passed: bool
    score: float
    issues: list[dict]
    next_status: str


def verify_question(question: Question, *, checker: str = "rule_based") -> QuestionVerificationResult:
    issues = _question_issues(question)
    score = _quality_score(issues)
    passed = not issues
    next_status = QuestionReviewStatus.AUTO_VERIFIED if passed else QuestionReviewStatus.REJECTED
    evidence = {
        "evidenceCount": question.evidence_items.count(),
        "sourceType": question.source_type,
        "questionType": question.question_type,
    }
    with transaction.atomic():
        QuestionQualityCheck.objects.create(
            question=question,
            checker=checker,
            passed=passed,
            score=score,
            issues=issues,
            evidence=evidence,
        )
        question.review_status = next_status
        question.quality_score = score
        question.is_active = passed
        question.save(update_fields=["review_status", "quality_score", "is_active"])
    return QuestionVerificationResult(passed=passed, score=score, issues=issues, next_status=next_status)


def _question_issues(question: Question) -> list[dict]:
    issues: list[dict] = []
    stem = str(question.stem or "").strip()
    explanation = str(question.explanation or "").strip()
    if len(stem) < 8:
        issues.append({"code": "weak_stem", "message": "题干过短或为空"})
    if _has_mojibake(stem) or _has_mojibake(explanation):
        issues.append({"code": "mojibake", "message": "题干或解析包含乱码"})
    if not 1 <= int(question.difficulty or 0) <= 5:
        issues.append({"code": "invalid_difficulty", "message": "难度必须在 1 到 5 之间"})
    if question.question_type == QuestionType.SINGLE_CHOICE:
        issues.extend(_single_choice_issues(question))
    if len(explanation) < 12:
        issues.append({"code": "weak_explanation", "message": "解析过短，无法支撑学习反馈"})
    if question.source_type in GENERATED_SOURCE_TYPES and question.evidence_items.count() < 1:
        issues.append({"code": "missing_evidence", "message": "生成题缺少知识库证据"})
    return issues


def _single_choice_issues(question: Question) -> list[dict]:
    issues: list[dict] = []
    options = question.options if isinstance(question.options, list) else []
    if len(options) != 4:
        issues.append({"code": "invalid_options", "message": "单选题必须提供 4 个选项"})
        return issues
    keys: list[str] = []
    texts: list[str] = []
    for option in options:
        if not isinstance(option, dict):
            issues.append({"code": "invalid_options", "message": "选项必须是对象列表"})
            return issues
        key = str(option.get("key") or "").strip().upper()
        text = str(option.get("text") or "").strip()
        if not key or not text:
            issues.append({"code": "invalid_options", "message": "选项 key 和 text 不能为空"})
        if _has_mojibake(text):
            issues.append({"code": "mojibake", "message": "选项包含乱码"})
        keys.append(key)
        texts.append(text)
    if len(set(keys)) != len(keys):
        issues.append({"code": "duplicate_option_key", "message": "选项 key 不能重复"})
    if len(set(texts)) != len(texts):
        issues.append({"code": "duplicate_option_text", "message": "选项文本不能重复"})
    answer = str(question.correct_answer or "").strip().upper()
    if answer not in set(keys):
        issues.append({"code": "invalid_answer", "message": "正确答案必须对应一个选项 key"})
    return issues


def _has_mojibake(text: str) -> bool:
    return any(marker in text for marker in MOJIBAKE_MARKERS)


def _quality_score(issues: list[dict]) -> float:
    if not issues:
        return 0.9
    penalty = min(0.8, len({issue["code"] for issue in issues}) * 0.18)
    return round(max(0.0, 0.9 - penalty), 2)
