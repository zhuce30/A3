from __future__ import annotations

from dataclasses import dataclass

from django.utils import timezone

from backend.apps.assessments.models import Question, QuestionReviewStatus, StudentQuestionMastery, WrongQuestion
from backend.apps.learning.models import LearningPath, LearningPathStatus, PathItemStatus


@dataclass(frozen=True)
class AdaptiveSelection:
    questions: list[Question]
    metadata: dict


def select_adaptive_questions(user, questions: list[Question], *, limit: int) -> AdaptiveSelection:
    wrong_by_point = _wrong_counts_by_point(user)
    mastery_by_point = _mastery_by_point(user)
    current_point_id = _current_path_point_id(user)
    scored = [
        (_adaptive_score(question, wrong_by_point, mastery_by_point, current_point_id), question)
        for question in questions
    ]
    scored.sort(key=lambda item: (-item[0], item[1].difficulty, str(item[1].id)))
    selected = [question for _, question in scored[:limit]]
    return AdaptiveSelection(
        questions=selected,
        metadata={
            "strategy": "adaptive",
            "reason": "优先覆盖最近错题、低掌握度知识点和当前学习路径节点",
            "sourceCounts": _source_counts(selected),
        },
    )


def update_question_mastery(user, question: Question, *, is_correct: bool) -> StudentQuestionMastery:
    mastery, _ = StudentQuestionMastery.objects.get_or_create(
        user=user,
        knowledge_point=question.knowledge_point,
        defaults={"mastery_score": 0.5},
    )
    mastery.attempts += 1
    if is_correct:
        mastery.correct += 1
    correctness_rate = mastery.correct / mastery.attempts if mastery.attempts else 0
    mastery.mastery_score = _clamp(0.15, 0.98, mastery.mastery_score * 0.75 + correctness_rate * 0.25)
    mastery.last_practiced_at = timezone.now()
    mastery.save(update_fields=["attempts", "correct", "mastery_score", "last_practiced_at", "updated_at"])
    return mastery


def _adaptive_score(question: Question, wrong_by_point: dict, mastery_by_point: dict, current_point_id: str) -> float:
    point_id = str(question.knowledge_point_id)
    score = 0.0
    score += min(60.0, float(wrong_by_point.get(point_id, 0)) * 18.0)
    mastery = mastery_by_point.get(point_id)
    if mastery is not None:
        score += (1.0 - mastery) * 35.0
    else:
        score += 12.0
    if point_id == current_point_id:
        score += 24.0
    if question.review_status == QuestionReviewStatus.AUTO_VERIFIED and question.owner_id:
        score += 8.0
    score += max(0, 6 - int(question.difficulty or 3)) * 0.5
    return score


def _wrong_counts_by_point(user) -> dict[str, int]:
    rows = (
        WrongQuestion.objects.filter(user=user, mastered=False)
        .values_list("question__knowledge_point_id", "wrong_count")
    )
    counts: dict[str, int] = {}
    for point_id, wrong_count in rows:
        key = str(point_id)
        counts[key] = counts.get(key, 0) + int(wrong_count or 0)
    return counts


def _mastery_by_point(user) -> dict[str, float]:
    return {
        str(point_id): float(score)
        for point_id, score in StudentQuestionMastery.objects.filter(user=user).values_list("knowledge_point_id", "mastery_score")
    }


def _current_path_point_id(user) -> str:
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
    if not path:
        return ""
    current = path.items.filter(status=PathItemStatus.CURRENT).first()
    return str(current.knowledge_point_id) if current else ""


def _source_counts(questions: list[Question]) -> dict:
    counts = {"approved": 0, "autoVerifiedPersonal": 0}
    for question in questions:
        if question.review_status == QuestionReviewStatus.APPROVED:
            counts["approved"] += 1
        elif question.review_status == QuestionReviewStatus.AUTO_VERIFIED and question.owner_id:
            counts["autoVerifiedPersonal"] += 1
    return counts


def _clamp(low: float, high: float, value: float) -> float:
    return round(max(low, min(high, value)), 4)
