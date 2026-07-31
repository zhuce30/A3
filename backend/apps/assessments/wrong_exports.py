from __future__ import annotations

from collections.abc import Iterable

from django.utils import timezone

from backend.apps.assessments.models import WrongQuestion


WRONG_EXPORT_SCOPES = {"active", "due", "mastered", "all"}
MAX_EXPORT_QUESTIONS = 500
MAX_TEXT_LENGTH = 12_000


class WrongExportRequestError(ValueError):
    pass


def select_wrong_questions(user, scope: str):
    normalized_scope = str(scope or "active").strip().lower()
    if normalized_scope not in WRONG_EXPORT_SCOPES:
        raise WrongExportRequestError("导出范围必须是 active、due、mastered 或 all")

    queryset = (
        WrongQuestion.objects.filter(user=user)
        .select_related("question__knowledge_point__chapter__course")
        .order_by("mastered", "review_after", "-wrong_count", "-last_wrong_at")
    )
    if normalized_scope == "active":
        queryset = queryset.filter(mastered=False)
    elif normalized_scope == "due":
        queryset = queryset.filter(mastered=False, review_after__lte=timezone.now())
    elif normalized_scope == "mastered":
        queryset = queryset.filter(mastered=True)
    return queryset[:MAX_EXPORT_QUESTIONS]


def build_wrong_question_snapshot(user, scope: str, wrong_items: Iterable[WrongQuestion]) -> dict:
    normalized_scope = str(scope or "active").strip().lower()
    if normalized_scope not in WRONG_EXPORT_SCOPES:
        raise WrongExportRequestError("导出范围必须是 active、due、mastered 或 all")

    rows = [_snapshot_row(item) for item in list(wrong_items)[:MAX_EXPORT_QUESTIONS]]
    points = sorted({row["knowledgePoint"] for row in rows if row["knowledgePoint"]})
    return {
        "schemaVersion": "1.0",
        "scope": normalized_scope,
        "studentName": _bounded_text(getattr(user, "display_name", "") or "同学", 64),
        "generatedAt": timezone.now().isoformat(),
        "summary": {
            "totalCount": len(rows),
            "activeCount": sum(1 for row in rows if not row["mastered"]),
            "masteredCount": sum(1 for row in rows if row["mastered"]),
            "knowledgePoints": points,
        },
        "questions": rows,
    }


def _snapshot_row(wrong: WrongQuestion) -> dict:
    question = wrong.question
    point = question.knowledge_point
    chapter = point.chapter
    course = chapter.course
    options = []
    for index, option in enumerate(question.options if isinstance(question.options, list) else []):
        if isinstance(option, dict):
            key = _bounded_text(option.get("key") or chr(65 + index), 16)
            text = _bounded_text(option.get("text"), 2_000)
        else:
            key = chr(65 + index)
            text = _bounded_text(option, 2_000)
        options.append({"key": key, "text": text})
    return {
        "wrongQuestionId": str(wrong.id),
        "questionId": str(question.id),
        "course": _bounded_text(course.title, 128),
        "chapter": _bounded_text(chapter.title, 128),
        "knowledgePoint": _bounded_text(point.title, 128),
        "stem": _bounded_text(question.stem),
        "options": options,
        "lastWrongAnswer": _bounded_text(wrong.last_wrong_answer, 16),
        "correctAnswer": _bounded_text(question.correct_answer, 16),
        "errorCause": _bounded_text(question.error_cause or "待进一步分析", 500),
        "explanation": _bounded_text(question.explanation),
        "wrongCount": wrong.wrong_count,
        "consecutiveCorrect": wrong.consecutive_correct,
        "mastered": wrong.mastered,
        "lastWrongAt": wrong.last_wrong_at.isoformat(),
        "reviewAfter": wrong.review_after.isoformat() if wrong.review_after else None,
        "source": _question_source(question),
    }


def _question_source(question) -> str:
    resource = getattr(question, "source_resource", None)
    if resource is not None:
        return _bounded_text(getattr(resource, "title", "课程资料"), 255)
    return "智学引擎测评题库"


def _bounded_text(value, limit: int = MAX_TEXT_LENGTH) -> str:
    return str(value or "").strip()[:limit]
