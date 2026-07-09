from __future__ import annotations

from datetime import datetime, time, timedelta
from urllib.parse import quote

from django.db import models, transaction
from django.utils import timezone

from backend.apps.assessments.adaptive import select_adaptive_questions, update_question_mastery
from backend.apps.assessments.models import (
    AssessmentAnswer,
    AssessmentSession,
    Question,
    QuestionEvidence,
    QuestionReviewStatus,
    SessionStatus,
    WrongQuestion,
)
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import KnowledgePoint, LearningPath, LearningPathStatus, PathItemStatus, ResourcePackLog


MOJIBAKE_MARKERS = (
    "鐨",
    "绯荤",
    "棣",
    "鍒",
    "閫",
    "杈",
    "鎺",
    "浼",
    "寰",
    "鍙",
    "绋",
    "锛",
    "�",
)


def _safe_record_learning_event(user, **kwargs):
    try:
        return record_learning_event(user, **kwargs)
    except Exception:
        if transaction.get_connection().in_atomic_block:
            transaction.set_rollback(False)
        return None


def is_valid_assessment_question(question: Question) -> bool:
    stem = str(question.stem or "").strip()
    explanation = str(question.explanation or "").strip()
    if not stem or "Agent workflow demo assessment question" in stem:
        return False
    if any(marker in stem or marker in explanation for marker in MOJIBAKE_MARKERS):
        return False
    options = question.options if isinstance(question.options, list) else []
    if len(options) < 2:
        return False
    keys = set()
    for option in options:
        if not isinstance(option, dict):
            return False
        key = str(option.get("key") or "").strip().upper()
        text = str(option.get("text") or "").strip()
        if not key or not text or any(marker in text for marker in MOJIBAKE_MARKERS):
            return False
        keys.add(key)
    return str(question.correct_answer or "").strip().upper() in keys


def _valid_questions(queryset) -> list[Question]:
    return [question for question in queryset if is_valid_assessment_question(question)]


def _ensure_default_assessment_questions() -> None:
    from backend.apps.assessments.management.commands.repair_assessment_questions import QUESTION_SPECS

    for code, stem, raw_options, answer, explanation, cause, difficulty in QUESTION_SPECS:
        point = KnowledgePoint.objects.filter(code=code).first()
        if not point:
            continue
        Question.objects.update_or_create(
            knowledge_point=point,
            stem=stem,
            defaults={
                "options": [{"key": key, "text": text} for key, text in raw_options],
                "correct_answer": answer,
                "explanation": explanation,
                "error_cause": cause,
                "difficulty": difficulty,
                "is_active": True,
                "review_status": QuestionReviewStatus.APPROVED,
                "scope": "global",
                "quality_score": 1.0,
            },
        )


def _selectable_question_queryset(user, *, mode: str = "assessment"):
    queryset = Question.objects.filter(is_active=True).select_related("knowledge_point__chapter")
    if mode == "practice":
        return queryset.filter(
            models.Q(review_status=QuestionReviewStatus.APPROVED)
            | models.Q(review_status=QuestionReviewStatus.AUTO_VERIFIED, owner=user)
        )
    return queryset.filter(review_status=QuestionReviewStatus.APPROVED)


def _session_can_continue(session: AssessmentSession, path: LearningPath | None = None) -> bool:
    if path and session.learning_path_id and session.learning_path_id != path.id:
        return False
    questions = _questions_by_ids(session.question_ids)
    if len(questions) < 3 or session.current_index >= len(questions):
        return False
    if path:
        return all(question.knowledge_point.chapter.course_id == path.course_id for question in questions)
    return True


def serialize_question(question: Question, include_answer: bool = False) -> dict:
    evidence_items = list(getattr(question, "evidence_items", QuestionEvidence.objects.none()).all()[:3])
    payload = {
        "id": str(question.id),
        "stem": question.stem,
        "options": question.options,
        "difficulty": question.difficulty,
        "knowledgePoint": {
            "id": str(question.knowledge_point_id),
            "title": question.knowledge_point.title,
            "chapter": question.knowledge_point.chapter.title,
        },
        "source": {
            "type": getattr(question, "source_type", "seeded"),
            "reviewStatus": getattr(question, "review_status", "approved"),
            "scope": getattr(question, "scope", "global"),
            "qualityScore": getattr(question, "quality_score", 0),
            "resourceId": str(question.source_resource_id) if getattr(question, "source_resource_id", None) else "",
            "resourceTitle": question.source_resource.original_name if getattr(question, "source_resource_id", None) and question.source_resource else "",
        },
        "evidence": [serialize_question_evidence(item) for item in evidence_items],
    }
    if include_answer:
        payload.update({
            "correctAnswer": question.correct_answer,
            "explanation": question.explanation,
            "errorCause": question.error_cause,
        })
    return payload


def serialize_question_evidence(evidence: QuestionEvidence) -> dict:
    resource = evidence.resource
    return {
        "resourceId": str(evidence.resource_id) if evidence.resource_id else "",
        "resourceTitle": resource.original_name if resource else "",
        "blockId": evidence.block_id,
        "pageNumber": evidence.page_number,
        "previewUrl": evidence.preview_url,
        "quote": evidence.quote,
        "modality": evidence.modality,
        "score": evidence.score,
    }


def serialize_question_bank_item(question: Question) -> dict:
    payload = serialize_question(question, include_answer=True)
    payload.update({
        "sourceType": question.source_type,
        "reviewStatus": question.review_status,
        "scope": question.scope,
        "qualityScore": question.quality_score,
        "ownerId": str(question.owner_id) if question.owner_id else "",
        "sourceResourceId": str(question.source_resource_id) if question.source_resource_id else "",
        "sourceResourceTitle": question.source_resource.original_name if question.source_resource else "",
        "createdAt": question.created_at.isoformat() if question.created_at else None,
        "metadata": question.metadata if isinstance(question.metadata, dict) else {},
    })
    return payload


def _questions_by_ids(question_ids: list[str]) -> list[Question]:
    questions = Question.objects.filter(id__in=question_ids, is_active=True).select_related("knowledge_point__chapter")
    mapping = {str(question.id): question for question in questions}
    return [mapping[question_id] for question_id in question_ids if question_id in mapping and is_valid_assessment_question(mapping[question_id])]


def serialize_session(session: AssessmentSession, *, mode: str = "assessment", focus: dict | None = None) -> dict:
    questions = _questions_by_ids(session.question_ids)
    answered = session.answers.count()
    current = questions[session.current_index] if session.current_index < len(questions) else None
    return {
        "id": str(session.id),
        "mode": mode,
        "focus": focus,
        "status": session.status,
        "currentIndex": session.current_index,
        "answeredCount": answered,
        "totalQuestions": len(questions),
        "score": session.score,
        "startedAt": session.started_at.isoformat(),
        "completedAt": session.completed_at.isoformat() if session.completed_at else None,
        "currentQuestion": serialize_question(current) if current else None,
        "selection": getattr(session, "selection_metadata", None),
    }


def practice_suggestions(user, *, limit: int = 3) -> list[dict]:
    profile = getattr(user, "learner_profile", None)
    profile_points = profile.weak_points if profile and isinstance(profile.weak_points, list) else []
    wrong_items = list(
        WrongQuestion.objects.filter(user=user, mastered=False)
        .select_related("question__knowledge_point")
        .order_by("-wrong_count", "-last_wrong_at")
    )
    rows: dict[str, dict] = {}
    for index, point in enumerate(profile_points):
        title = str(point).strip()
        if title:
            rows[title] = {
                "knowledgePoint": title,
                "reason": "来自学习画像薄弱点",
                "wrongCount": 0,
                "priority": 50 - index,
                "href": f"/a3/assessment?practice={quote(title)}",
            }
    for wrong in wrong_items:
        title = wrong.question.knowledge_point.title
        current = rows.get(title)
        priority = 100 + wrong.wrong_count * 5
        reason = f"错题本中累计错误 {wrong.wrong_count} 次"
        if current:
            current.update({"wrongCount": wrong.wrong_count, "priority": max(current["priority"], priority), "reason": reason})
        else:
            rows[title] = {
                "knowledgePoint": title,
                "reason": reason,
                "wrongCount": wrong.wrong_count,
                "priority": priority,
                "href": f"/a3/assessment?practice={quote(title)}",
            }
    if not rows:
        path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
        current_item = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point").first() if path else None
        if current_item:
            rows[current_item.knowledge_point.title] = {
                "knowledgePoint": current_item.knowledge_point.title,
                "reason": "来自当前学习路径节点",
                "wrongCount": 0,
                "priority": 30,
                "href": f"/a3/assessment?practice={quote(current_item.knowledge_point.title)}",
            }
    return sorted(rows.values(), key=lambda item: item["priority"], reverse=True)[:limit]


def resolve_practice_knowledge_point(user, knowledge_point: str) -> KnowledgePoint | None:
    title = str(knowledge_point or "").strip()
    if not title:
        return None
    queryset = KnowledgePoint.objects.filter(questions__is_active=True).distinct()
    valid_point_ids = {
        question.knowledge_point_id
        for question in _valid_questions(Question.objects.filter(is_active=True).select_related("knowledge_point"))
    }
    queryset = queryset.filter(id__in=valid_point_ids)
    exact = queryset.filter(title=title).first()
    if exact:
        return exact

    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
    if path:
        point_ids = list(path.items.order_by("order").values_list("knowledge_point_id", flat=True))
        path_match = queryset.filter(id__in=point_ids, title__icontains=title).order_by("chapter__order", "order").first()
        if path_match:
            return path_match
    return queryset.filter(title__icontains=title).order_by("chapter__order", "order").first()


@transaction.atomic
def create_assessment(
    user,
    force: bool = False,
    *,
    mode: str = "assessment",
    knowledge_point: str = "",
    limit: int | None = None,
    strategy: str = "default",
) -> AssessmentSession:
    from backend.apps.learning.services import default_course, generate_learning_path

    course = default_course()
    path = None
    if course:
        path = (
            LearningPath.objects.filter(user=user, course=course, status=LearningPathStatus.ACTIVE)
            .select_related("course")
            .first()
        )
        if path is None:
            path = generate_learning_path(user, course=course, force=True)

    current = AssessmentSession.objects.filter(user=user, status=SessionStatus.IN_PROGRESS).first()
    if current and not force and _session_can_continue(current, path):
        return current
    if current:
        current.status = SessionStatus.COMPLETED
        current.completed_at = timezone.now()
        current.save(update_fields=["status", "completed_at"])

    queryset = _selectable_question_queryset(user, mode=mode)
    if path:
        queryset = queryset.filter(knowledge_point__chapter__course=path.course)
    if mode == "practice" and knowledge_point:
        point = resolve_practice_knowledge_point(user, knowledge_point)
        queryset = queryset.filter(knowledge_point=point) if point else queryset.none()
    question_limit = max(1, min(int(limit or 12), 20))
    if path:
        point_ids = list(path.items.order_by("order").values_list("knowledge_point_id", flat=True))
        path_questions = _valid_questions(queryset.filter(knowledge_point_id__in=point_ids))
        if not path_questions and mode == "assessment":
            _ensure_default_assessment_questions()
            queryset = _selectable_question_queryset(user, mode=mode).filter(knowledge_point__chapter__course=path.course)
            path_questions = _valid_questions(queryset.filter(knowledge_point_id__in=point_ids))
        order = {str(point_id): index for index, point_id in enumerate(point_ids)}
        path_questions.sort(key=lambda item: (order.get(str(item.knowledge_point_id), 999), item.difficulty))
        candidate_questions = path_questions
    else:
        candidate_questions = _valid_questions(queryset)
    selection_metadata = None
    if strategy == "adaptive":
        selection = select_adaptive_questions(user, candidate_questions, limit=question_limit)
        questions = selection.questions
        selection_metadata = selection.metadata
    else:
        questions = candidate_questions[:question_limit]
    if not questions:
        raise ValueError("题库中暂无可用题目")
    session = AssessmentSession.objects.create(
        user=user,
        learning_path=path,
        question_ids=[str(question.id) for question in questions],
    )
    session.selection_metadata = selection_metadata
    return session


def assessment_next_action(user, session: AssessmentSession) -> dict:
    active_wrong = WrongQuestion.objects.filter(user=user, mastered=False).count()
    if active_wrong:
        return {
            "label": "先复盘错题",
            "href": "/a3/wrong-notebook",
            "reason": f"本次测评后还有 {active_wrong} 道错题待巩固。",
        }
    if session.score < 70:
        suggestion = practice_suggestions(user, limit=1)
        if suggestion:
            point = suggestion[0]["knowledgePoint"]
            return {
                "label": "开始专项练习",
                "href": f"/a3/assessment?practice={quote(point)}",
                "reason": f"得分 {session.score}，建议先练习 {point}。",
            }
    return {
        "label": "继续今日任务",
        "href": "/a3/today",
        "reason": "测评已完成，可以回到今日任务推进学习计划。",
    }


@transaction.atomic
def answer_assessment_question(user, session: AssessmentSession, selected_answer: str, skipped: bool = False) -> dict:
    if session.user_id != user.id or session.status != SessionStatus.IN_PROGRESS:
        raise ValueError("测评会话无效或已结束")
    questions = _questions_by_ids(session.question_ids)
    if session.current_index >= len(questions):
        raise ValueError("本次测评已完成")
    question = questions[session.current_index]
    if session.answers.filter(question=question).exists():
        raise ValueError("该题已提交")
    selected_answer = str(selected_answer).strip().upper()
    is_correct = not skipped and selected_answer == question.correct_answer.upper()
    answer = AssessmentAnswer.objects.create(
        session=session,
        question=question,
        selected_answer=selected_answer,
        is_correct=is_correct,
        is_skipped=skipped,
    )
    _safe_record_learning_event(
        user,
        event_type="question_answered",
        target_type="assessment_question",
        target_id=str(question.id),
        knowledge_point_id=str(question.knowledge_point_id),
        score=100 if is_correct else 0,
        quality={
            "isCorrect": is_correct,
            "isSkipped": skipped,
            "difficulty": question.difficulty,
        },
        metadata={
            "assessmentSessionId": str(session.id),
            "answerId": answer.id,
            "selectedAnswer": selected_answer,
            "correctAnswer": question.correct_answer,
            "questionType": question.question_type,
            "sourceType": question.source_type,
        },
    )
    update_question_mastery(user, question, is_correct=is_correct)
    if not is_correct:
        wrong, created = WrongQuestion.objects.get_or_create(
            user=user,
            question=question,
            defaults={"last_wrong_answer": selected_answer, "review_after": timezone.now() + timedelta(days=3)},
        )
        if created:
            _safe_record_learning_event(
                user,
                event_type="wrong_question_added",
                target_type="wrong_question",
                target_id=str(wrong.id),
                knowledge_point_id=str(question.knowledge_point_id),
                score=0,
                metadata={
                    "questionId": str(question.id),
                    "assessmentSessionId": str(session.id),
                    "selectedAnswer": selected_answer,
                    "correctAnswer": question.correct_answer,
                    "wrongCount": wrong.wrong_count,
                },
            )
        if not created:
            wrong.wrong_count += 1
            wrong.consecutive_correct = 0
            wrong.mastered = False
            wrong.last_wrong_answer = selected_answer
            wrong.review_after = timezone.now() + timedelta(days=3)
            wrong.save()
        _sync_wrong_question_learning_state(user, wrong)

    session.current_index += 1
    correct_count = session.answers.filter(is_correct=True).count()
    answered_count = session.answers.count()
    session.score = round(correct_count * 100 / answered_count) if answered_count else 0
    if session.current_index >= len(questions):
        session.status = SessionStatus.COMPLETED
        session.completed_at = timezone.now()
    session.save(update_fields=["current_index", "score", "status", "completed_at"])
    if session.status == SessionStatus.COMPLETED:
        _safe_record_learning_event(
            user,
            event_type="assessment_submitted",
            target_type="assessment_session",
            target_id=str(session.id),
            score=session.score,
            quality={
                "answeredCount": answered_count,
                "correctCount": correct_count,
                "totalQuestions": len(questions),
            },
            metadata={
                "completedAt": session.completed_at.isoformat() if session.completed_at else "",
                "learningPathId": str(session.learning_path_id or ""),
            },
        )
    return {
        "isCorrect": is_correct,
        "selectedAnswer": selected_answer,
        "correctAnswer": question.correct_answer,
        "explanation": question.explanation,
        "errorCause": question.error_cause if not is_correct else "",
        "session": serialize_session(session),
        "nextAction": assessment_next_action(user, session) if session.status == SessionStatus.COMPLETED else None,
    }


def _sync_wrong_question_learning_state(user, wrong: WrongQuestion) -> None:
    from backend.apps.engagement.models import NotificationType, UserNotification
    from backend.apps.engagement.services import ensure_learning_reminders
    from backend.apps.learning.services import generate_study_plan
    from backend.apps.profiles.dynamic_profile import append_learning_event, merge_dynamic_profile_signals
    from backend.apps.profiles.models import LearnerProfile

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    point_title = wrong.question.knowledge_point.title
    error_cause = str(wrong.question.error_cause or "").strip()
    current_weak_points = profile.weak_points if isinstance(profile.weak_points, list) else []
    weak_points = []
    for value in [point_title, *current_weak_points]:
        text = str(value).strip()
        if text and text not in weak_points:
            weak_points.append(text)
    if weak_points != current_weak_points:
        profile.weak_points = weak_points[:8]
        profile.save(update_fields=["weak_points", "updated_at"])
    merge_dynamic_profile_signals(
        profile,
        mistake_patterns=[error_cause] if error_cause else [],
        save=True,
    )
    append_learning_event(
        profile,
        event_type="assessment_wrong_answer",
        summary=f"测评错题暴露薄弱点：{point_title}",
        source="assessment",
        importance=0.9,
        signals={
            "weakPoints": [point_title],
            "errorCauses": [error_cause] if error_cause else [],
            "wrongQuestionId": str(wrong.id),
            "wrongCount": wrong.wrong_count,
        },
        raw_preview=wrong.question.stem,
        save=True,
    )

    plan = generate_study_plan(user, force=True)
    ensure_learning_reminders(user, plan=plan, motivation={})
    reminder_key = f"wrong-question-added:{wrong.id}"
    if not UserNotification.objects.filter(user=user, payload__reminderKey=reminder_key).exists():
        UserNotification.objects.create(
            user=user,
            title=f"错题已加入复习队列：{point_title}",
            detail="系统已更新你的薄弱点和学习计划，建议按错题本里的复习节奏完成巩固。",
            notification_type=NotificationType.ASSESSMENT,
            action_url="/a3/wrong-notebook",
            payload={
                "reminderKey": reminder_key,
                "wrongQuestionId": str(wrong.id),
                "knowledgePoint": point_title,
                "dueReviews": 1,
                "actionKind": "review",
                "generatedBy": "assessment_wrong_answer",
            },
        )


def serialize_wrong_question(wrong: WrongQuestion) -> dict:
    return {
        "id": str(wrong.id),
        "wrongCount": wrong.wrong_count,
        "consecutiveCorrect": wrong.consecutive_correct,
        "mastered": wrong.mastered,
        "lastWrongAnswer": wrong.last_wrong_answer,
        "lastWrongAt": wrong.last_wrong_at.isoformat(),
        "reviewAfter": wrong.review_after.isoformat() if wrong.review_after else None,
        "question": serialize_question(wrong.question, include_answer=False),
        "errorCause": wrong.question.error_cause,
    }


def wrong_review_summary(wrong_items: list[WrongQuestion]) -> dict:
    now = timezone.now()
    today = timezone.localdate()
    active = [item for item in wrong_items if not item.mastered]
    overdue = [
        item for item in active
        if item.review_after and item.review_after <= now and timezone.localtime(item.review_after).date() < today
    ]
    due_today = [
        item for item in active
        if not item.review_after or item.review_after <= now or timezone.localtime(item.review_after).date() == today
    ]
    upcoming = [item for item in active if item.review_after and item.review_after > now and item not in due_today]
    if due_today:
        next_action = {
            "label": "开始今日错题复习",
            "href": "/a3/wrong-notebook",
            "reason": f"当前有 {len(due_today)} 道错题到达复习时间。",
        }
    else:
        next_action = {
            "label": "进入阶段测评",
            "href": "/a3/assessment",
            "reason": "暂无到期错题，可通过测评继续发现薄弱点。",
        }
    return {
        "activeCount": len(active),
        "masteredCount": len([item for item in wrong_items if item.mastered]),
        "overdueCount": len(overdue),
        "todayCount": len(due_today),
        "upcomingCount": len(upcoming),
        "nextAction": next_action,
    }


@transaction.atomic
def retry_wrong(user, wrong: WrongQuestion, selected_answer: str) -> dict:
    if wrong.user_id != user.id:
        raise PermissionError("无权操作该错题")
    selected_answer = str(selected_answer).strip().upper()
    is_correct = selected_answer == wrong.question.correct_answer.upper()
    if is_correct:
        wrong.consecutive_correct += 1
        wrong.mastered = wrong.consecutive_correct >= 2
    else:
        wrong.wrong_count += 1
        wrong.consecutive_correct = 0
        wrong.mastered = False
        wrong.last_wrong_answer = selected_answer
    wrong.review_after = timezone.now() + timedelta(days=7 if is_correct else 3)
    wrong.save()
    _safe_record_learning_event(
        user,
        event_type="wrong_question_reviewed",
        target_type="wrong_question",
        target_id=str(wrong.id),
        knowledge_point_id=str(wrong.question.knowledge_point_id),
        score=100 if is_correct else 0,
        quality={
            "isCorrect": is_correct,
            "mastered": wrong.mastered,
            "consecutiveCorrect": wrong.consecutive_correct,
        },
        metadata={
            "questionId": str(wrong.question_id),
            "selectedAnswer": selected_answer,
            "correctAnswer": wrong.question.correct_answer,
            "wrongCount": wrong.wrong_count,
            "reviewAfter": wrong.review_after.isoformat() if wrong.review_after else "",
        },
    )
    from backend.apps.profiles.dynamic_profile import append_learning_event
    from backend.apps.profiles.models import LearnerProfile

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    point_title = wrong.question.knowledge_point.title
    error_cause = str(wrong.question.error_cause or "").strip()
    append_learning_event(
        profile,
        event_type="wrong_question_reviewed",
        summary=f"错题重练已回写画像候选：{point_title}",
        source="assessment",
        importance=0.82,
        signals={
            "weakPoints": [point_title],
            "errorCauses": [error_cause] if error_cause else [],
            "wrongQuestionId": str(wrong.id),
            "wrongCount": wrong.wrong_count,
            "isCorrect": is_correct,
            "mastered": wrong.mastered,
        },
        raw_preview=wrong.question.stem,
        save=True,
    )
    return {
        "isCorrect": is_correct,
        "correctAnswer": wrong.question.correct_answer,
        "explanation": wrong.question.explanation,
        "wrongQuestion": serialize_wrong_question(wrong),
    }


def wrong_retry_feedback(user, wrong: WrongQuestion) -> dict:
    from backend.apps.engagement.models import NotificationType, UserNotification
    from backend.apps.learning.services import generate_study_plan

    study_plan = generate_study_plan(user, force=True)
    report = build_learning_report(user)
    active_wrong = WrongQuestion.objects.filter(user=user, mastered=False).count()
    retry_feedback = _wrong_retry_feedback_payload(wrong, active_wrong)
    if wrong.mastered:
        title = f"已掌握：{wrong.question.knowledge_point.title}"
        detail = "连续答对两次，系统已刷新学习计划。建议进入专项练习或今日任务继续巩固。"
        action = {"label": "进入专项练习", "href": "/a3/assessment", "reason": "错题已掌握，适合用新练习验证迁移能力。"}
    else:
        title = f"继续复习：{wrong.question.knowledge_point.title}"
        detail = f"该错题还未掌握，当前仍有 {active_wrong} 道错题待巩固。"
        action = {"label": "继续错题复习", "href": "/a3/wrong-notebook", "reason": "错题尚未连续答对两次。"}
    UserNotification.objects.create(
        user=user,
        title=title,
        detail=detail,
        notification_type=NotificationType.ASSESSMENT,
        action_url=action["href"],
        payload={
            "wrongQuestionId": str(wrong.id),
            "mastered": wrong.mastered,
            "activeWrong": active_wrong,
            "retryFeedback": retry_feedback,
        },
    )
    retry_feedback["nextAction"] = action
    return {"studyPlan": study_plan, "report": report, "nextAction": action, "retryFeedback": retry_feedback}


def _wrong_retry_feedback_payload(wrong: WrongQuestion, active_wrong: int) -> dict:
    point_title = wrong.question.knowledge_point.title
    next_review_at = None if wrong.mastered else wrong.review_after.isoformat() if wrong.review_after else None
    if wrong.mastered:
        mastery_status = "mastered"
        headline = f"{point_title} 已完成错题巩固。"
        review_plan = "连续答对两次，当前错题从复习队列移出。建议通过专项练习验证迁移能力。"
        error_change = "错因已被连续正确作答覆盖，后续重点从纠错转为变式迁移。"
        reward = {"label": "错题掌握", "value": "+1", "earned": True}
    else:
        mastery_status = "needs_review"
        headline = f"{point_title} 仍需继续复习。"
        review_plan = f"下次复习：{wrong.review_after.isoformat() if wrong.review_after else '立即复习'}。建议先复述解析，再做同类题。"
        error_change = f"错因仍未消除：{wrong.question.error_cause or '需要继续定位概念误区'}。"
        reward = {"label": "复习记录", "value": "+1", "earned": True}
    motivators = [
        {
            "label": "掌握状态",
            "detail": "已掌握" if wrong.mastered else f"连续答对 {wrong.consecutive_correct}/2 次",
            "tone": "green" if wrong.mastered else "orange",
        },
        {
            "label": "错题压力",
            "detail": f"当前还有 {active_wrong} 道待巩固错题",
            "tone": "blue",
        },
        {
            "label": "错因处理",
            "detail": error_change,
            "tone": "violet",
        },
    ]
    return {
        "masteryStatus": mastery_status,
        "headline": headline,
        "knowledgePoint": point_title,
        "nextReviewAt": next_review_at,
        "reviewPlan": review_plan,
        "errorCauseChange": error_change,
        "reward": reward,
        "motivators": motivators,
    }


def build_learning_report(user, period: str = "term") -> dict:
    now = timezone.now()
    period_key, period_start = _report_period_start(period, now)
    period_start_at = timezone.make_aware(datetime.combine(period_start, time.min)) if period_start else None
    all_answers = AssessmentAnswer.objects.filter(session__user=user)
    answers = all_answers
    if period_start_at:
        answers = answers.filter(answered_at__gte=period_start_at)
    total_answers = answers.count()
    correct_answers = answers.filter(is_correct=True).count()
    accuracy = round(correct_answers * 100 / total_answers, 1) if total_answers else 0
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
    path_items = path.items.all() if path else []
    completed_items = [
        item
        for item in path_items
        if item.status == PathItemStatus.COMPLETED and (not period_start_at or (item.completed_at and item.completed_at >= period_start_at))
    ]
    study_minutes = sum(item.estimated_minutes for item in completed_items)
    wrong_active = WrongQuestion.objects.filter(user=user, mastered=False).select_related("question__knowledge_point")
    mastered_wrong = WrongQuestion.objects.filter(user=user, mastered=True).count()
    study_dates = set(answers.values_list("answered_at__date", flat=True))
    if path:
        study_dates.update(item.completed_at.date() for item in completed_items if item.completed_at)

    trends = _report_trends(answers, now, period_key, period_start)

    knowledge_score = accuracy
    progress_score = path and path.items.count() and round(len(completed_items) * 100 / path.items.count()) or 0
    focus_score = min(100, len(study_dates) * 12)
    capability_axes = [
        {"label": "知识掌握", "value": knowledge_score},
        {"label": "学习进度", "value": progress_score},
        {"label": "答题稳定性", "value": max(0, accuracy - wrong_active.count() * 3)},
        {"label": "持续学习", "value": focus_score},
    ]
    suggestions = []
    for wrong in wrong_active[:3]:
        suggestions.append({
            "title": f"复习{wrong.question.knowledge_point.title}",
            "detail": wrong.question.error_cause or "完成错题变式并复盘解析。",
        })
    if not suggestions:
        suggestions.append({"title": "继续当前学习路径", "detail": "完成当前节点后再进行一次阶段测评。"})

    first_answer = all_answers.order_by("answered_at").first()
    first_period_answer = answers.order_by("answered_at").first()
    report_start = period_start or (first_answer.answered_at.date() if first_answer else now.date())
    if first_period_answer and not period_start:
        report_start = first_period_answer.answered_at.date()
    weekly_summary = _weekly_learning_summary(user, now)
    metrics = {
        "studyMinutes": study_minutes,
        "studyDays": len(study_dates),
        "masteredKnowledgePoints": len(completed_items),
        "totalKnowledgePoints": path.items.count() if path else 0,
        "answeredQuestions": total_answers,
        "accuracy": accuracy,
        "activeWrongQuestions": wrong_active.count(),
        "masteredWrongQuestions": mastered_wrong,
        "pathProgress": progress_score,
    }
    return {
        "period": {
            "key": period_key,
            "label": _report_period_label(period_key),
            "start": report_start.isoformat(),
            "end": now.date().isoformat(),
        },
        "metrics": metrics,
        "trends": trends,
        "capabilityAxes": capability_axes,
        "suggestions": suggestions,
        "weeklySummary": weekly_summary,
        "weeklyPrescription": _weekly_prescription(weekly_summary, metrics),
        "actionLoop": _report_action_loop(weekly_summary, metrics),
        "wrongReviewInsight": _wrong_review_insight(wrong_active, mastered_wrong),
        "resourcePackEffect": _resource_pack_effect(user),
        "updatedAt": now.isoformat(),
    }


def _report_period_start(period: str, now) -> tuple[str, object | None]:
    period_key = period if period in {"7d", "30d", "term"} else "term"
    if period_key == "7d":
        return period_key, now.date() - timedelta(days=6)
    if period_key == "30d":
        return period_key, now.date() - timedelta(days=29)
    return period_key, None


def _report_period_label(period: str) -> str:
    if period == "7d":
        return "近 7 天"
    if period == "30d":
        return "近 30 天"
    return "本学期"


def _report_trends(answers, now, period: str, period_start) -> list[dict]:
    trends = []
    if period == "7d":
        for offset in range(6, -1, -1):
            day = (now - timedelta(days=offset)).date()
            day_answers = answers.filter(answered_at__date=day)
            count = day_answers.count()
            correct = day_answers.filter(is_correct=True).count()
            trends.append({
                "label": day.strftime("%m.%d"),
                "questions": count,
                "accuracy": round(correct * 100 / count, 1) if count else 0,
                "start": day.isoformat(),
                "end": day.isoformat(),
            })
        return trends

    if period == "30d":
        bucket_end = now.date()
        for offset in range(4, -1, -1):
            end = bucket_end - timedelta(days=offset * 6)
            start = max(end - timedelta(days=5), period_start or end - timedelta(days=5))
            bucket_answers = answers.filter(answered_at__date__range=(start, end))
            count = bucket_answers.count()
            correct = bucket_answers.filter(is_correct=True).count()
            trends.append({
                "label": f"{start.strftime('%m.%d')}-{end.strftime('%m.%d')}",
                "questions": count,
                "accuracy": round(correct * 100 / count, 1) if count else 0,
                "start": start.isoformat(),
                "end": end.isoformat(),
            })
        return trends

    for offset in range(4, -1, -1):
        end = (now - timedelta(days=offset * 7)).date()
        start = end - timedelta(days=6)
        week_answers = answers.filter(answered_at__date__range=(start, end))
        count = week_answers.count()
        correct = week_answers.filter(is_correct=True).count()
        trends.append({
            "label": f"{start.strftime('%m.%d')}-{end.strftime('%m.%d')}",
            "questions": count,
            "accuracy": round(correct * 100 / count, 1) if count else 0,
            "start": start.isoformat(),
            "end": end.isoformat(),
        })
    return trends


def _wrong_review_insight(wrong_active, mastered_wrong: int) -> dict:
    active_count = wrong_active.count()
    recent_points = []
    for wrong in wrong_active[:3]:
        title = wrong.question.knowledge_point.title
        if title not in recent_points:
            recent_points.append(title)
    if active_count:
        headline = "错题复盘仍是当前优先项"
        summary = f"当前还有 {active_count} 道待巩固错题，已掌握 {mastered_wrong} 道。建议先处理错因，再进入新内容。"
        next_action = {
            "label": "进入错题本",
            "href": "/a3/wrong-notebook",
            "reason": "待巩固错题会影响后续知识吸收，复盘结果会更新报告和学习计划。",
        }
    else:
        headline = "错题压力已清空"
        summary = f"当前没有待巩固错题，已掌握 {mastered_wrong} 道错题。可以回看错题本解析，或进入测评做迁移练习。"
        next_action = {
            "label": "进入综合测评",
            "href": "/a3/assessment",
            "reason": "错题压力较低，适合用新题验证迁移能力。",
        }
    return {
        "schemaVersion": "a3.wrong-review-insight.v1",
        "headline": headline,
        "summary": summary,
        "activeWrongQuestions": active_count,
        "masteredWrongQuestions": mastered_wrong,
        "recentKnowledgePoints": recent_points,
        "nextAction": next_action,
    }


def _resource_pack_effect(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    runs = _resource_pack_log_payloads(user)
    if not runs:
        runs = [item for item in extra_profile.get("resourcePackRuns", []) if isinstance(item, dict)]
    recent_runs = runs[:5]
    total_runs = len(runs)
    verified_source_count = sum(_safe_report_int(item.get("verifiedSourceCount"), 0) for item in runs)
    practice_runs = [item for item in runs if str(item.get("practiceHref") or "").startswith("/a3/assessment")]
    latest = recent_runs[0] if recent_runs else None
    if latest:
        next_action = {
            "label": "继续专项练习",
            "href": str(latest.get("practiceHref") or "/a3/assessment"),
            "reason": str(latest.get("nextStepReason") or "资源包已完成，继续练习能把推荐内容转化为测评和错题信号。"),
        }
        message = f"已完成 {total_runs} 个推荐资源包，累计使用 {verified_source_count} 个已验证来源。"
    else:
        next_action = {
            "label": "去获取推荐资源包",
            "href": "/a3/recommendations",
            "reason": "还没有完成推荐资源包，先从个性化推荐选择一个资源包加入今日任务。",
        }
        message = "暂无资源包学习记录。建议从推荐页加入一个资源包，形成推荐到练习的闭环。"
    return {
        "schemaVersion": "a3.resource-pack-effect.v1",
        "totalRuns": total_runs,
        "verifiedSourceCount": verified_source_count,
        "practiceStartedCount": len(practice_runs),
        "conversionRate": round(len(practice_runs) * 100 / total_runs) if total_runs else 0,
        "latestRun": latest,
        "recentRuns": recent_runs,
        "conversionMessage": message,
        "nextAction": next_action,
    }


def _resource_pack_log_payloads(user) -> list[dict]:
    return [
        _serialize_resource_pack_log(log)
        for log in ResourcePackLog.objects.filter(user=user).order_by("-completed_at", "-created_at")[:30]
    ]


def _serialize_resource_pack_log(log: ResourcePackLog) -> dict:
    payload = log.payload if isinstance(log.payload, dict) else {}
    return {
        "schemaVersion": payload.get("schemaVersion") or "a3.resource-pack-run.v1",
        "runId": payload.get("runId") or str(log.id),
        "taskId": log.task_id,
        "taskTitle": log.task_title,
        "learningGoal": log.learning_goal,
        "verifiedSourceCount": log.verified_source_count,
        "confidence": log.confidence,
        "practiceHref": log.practice_href,
        "source": log.source,
        "completedAt": log.completed_at.isoformat(),
        "nextStepReason": log.next_step_reason,
    }


def _safe_report_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _weekly_learning_summary(user, now) -> dict:
    profile = getattr(user, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    reflections = [item for item in extra_profile.get("dailyReflections", []) if isinstance(item, dict)]
    week_start = (now.date() - timedelta(days=6)).isoformat()
    weekly_reflections = [item for item in reflections if str(item.get("date", "")) >= week_start]
    confidence_values = []
    for item in weekly_reflections:
        try:
            confidence_values.append(int(item.get("confidence") or 0))
        except (TypeError, ValueError):
            continue
    plan = extra_profile.get("studyPlan") if isinstance(extra_profile.get("studyPlan"), dict) else {}
    days = plan.get("days", []) if isinstance(plan, dict) else []
    tasks = [task for day in days if isinstance(day, dict) for task in day.get("tasks", []) if isinstance(task, dict)]
    completed_tasks = [task for task in tasks if task.get("status") == "completed"]
    rollover_count = sum(1 for task in tasks if task.get("rolledOverFrom"))
    last_feedback = plan.get("lastTaskFeedback") if isinstance(plan, dict) and isinstance(plan.get("lastTaskFeedback"), dict) else None
    plan_change = _report_plan_change(plan)
    avg_confidence = round(sum(confidence_values) / len(confidence_values), 1) if confidence_values else 0
    plan_completion = round(len(completed_tasks) * 100 / len(tasks)) if tasks else 0
    if avg_confidence and avg_confidence <= 2.5:
        recommendation = "本周信心偏低，建议减少新内容，优先复习错题和复盘中的困惑。"
    elif rollover_count >= 2:
        recommendation = "本周有任务顺延，建议把每日计划控制在可完成范围内。"
    elif plan_completion >= 80:
        recommendation = "本周计划完成度较高，可以进入更高阶练习或综合题。"
    else:
        recommendation = "保持当前节奏，优先完成今日任务并记录复盘。"
    return {
        "reflectionCount": len(weekly_reflections),
        "averageConfidence": avg_confidence,
        "planCompletion": plan_completion,
        "completedTasks": len(completed_tasks),
        "totalTasks": len(tasks),
        "rolloverTasks": rollover_count,
        "latestReflection": weekly_reflections[0] if weekly_reflections else None,
        "lastTaskFeedback": last_feedback,
        "planChange": plan_change,
        "recommendation": recommendation,
    }


def _report_plan_change(plan: dict) -> dict:
    explanation = plan.get("explanation") if isinstance(plan.get("explanation"), dict) else {}
    current_change = explanation.get("currentChange") if isinstance(explanation.get("currentChange"), dict) else {}
    adjustments = explanation.get("adjustments") if isinstance(explanation.get("adjustments"), list) else []
    next_action = explanation.get("nextAction") if isinstance(explanation.get("nextAction"), dict) else {}
    recent_adjustments = [item for item in adjustments if isinstance(item, dict)][:5]
    if not current_change and recent_adjustments:
        current_change = recent_adjustments[0]
    if not next_action:
        next_action = {
            "label": "查看学习计划",
            "href": "/a3/study-plan",
            "reason": "报告会把最近的计划调整、任务完成和复习压力汇总到下一步学习动作。",
        }
    return {
        "schemaVersion": "a3.report-plan-change.v1",
        "currentChange": current_change,
        "recentAdjustments": recent_adjustments,
        "nextAction": next_action,
        "hasChange": bool(current_change or recent_adjustments),
    }


def _weekly_prescription(summary: dict, metrics: dict) -> dict:
    completed = int(summary.get("completedTasks") or 0)
    total = int(summary.get("totalTasks") or 0)
    active_wrong = int(metrics.get("activeWrongQuestions") or 0)
    accuracy = float(metrics.get("accuracy") or 0)
    plan_completion = int(summary.get("planCompletion") or 0)
    rollover = int(summary.get("rolloverTasks") or 0)
    target = max(3, min(7, completed + 2))
    actions = []
    if active_wrong:
        actions.append(
            {
                "title": "优先完成错题复盘",
                "detail": f"当前还有 {active_wrong} 道待巩固错题，先处理错因再进入新内容。",
                "href": "/a3/wrong-notebook",
                "type": "review",
            }
        )
    if rollover:
        actions.append(
            {
                "title": "压缩顺延任务",
                "detail": f"本周有 {rollover} 个任务顺延，下周先完成最小闭环任务。",
                "href": "/a3/study-plan",
                "type": "plan",
            }
        )
    if accuracy < 70:
        actions.append(
            {
                "title": "安排一次基础测评",
                "detail": "正确率偏低，建议用阶段测评重新定位薄弱知识点。",
                "href": "/a3/assessment",
                "type": "assessment",
            }
        )
    actions.append(
        {
            "title": "保持今日任务节奏",
            "detail": "每天完成讲解、练习和复盘中的至少一个任务，保证学习连续性。",
            "href": "/a3/today",
            "type": "today",
        }
    )
    if plan_completion >= 80 and active_wrong == 0:
        primary = {
            "label": "进入综合练习",
            "href": "/a3/assessment",
            "reason": "本周完成度较高且错题压力低，可以提升练习难度。",
        }
    elif active_wrong:
        primary = {
            "label": "先复盘错题",
            "href": "/a3/wrong-notebook",
            "reason": "待巩固错题会直接影响下周新知识吸收。",
        }
    else:
        primary = {
            "label": "继续今日任务",
            "href": "/a3/today",
            "reason": "当前最有效的动作是保持每日计划推进。",
        }
    return {
        "weeklyTarget": {
            "label": "下周完成学习任务",
            "current": completed,
            "target": target if total == 0 else min(max(target, completed), max(total, target)),
            "progress": round(completed * 100 / max(1, total or target)),
            "reason": _weekly_target_reason(plan_completion, rollover, active_wrong),
        },
        "diagnosis": _weekly_diagnosis(plan_completion, rollover, active_wrong, accuracy, completed, total),
        "focusAreas": _weekly_focus_areas(active_wrong, accuracy, rollover, plan_completion),
        "completionCriteria": _weekly_completion_criteria(active_wrong, accuracy, rollover),
        "primaryAction": primary,
        "nextWeekActions": actions[:4],
    }


def _report_action_loop(summary: dict, metrics: dict) -> dict:
    active_wrong = int(metrics.get("activeWrongQuestions") or 0)
    plan_completion = int(summary.get("planCompletion") or 0)
    rollover = int(summary.get("rolloverTasks") or 0)
    accuracy = float(metrics.get("accuracy") or 0)
    if active_wrong:
        primary = {
            "label": "先复盘错题",
            "href": "/a3/wrong-notebook",
            "kind": "review",
        }
        primary_reason = f"仍有 {active_wrong} 道待巩固错题，先处理错因比继续堆新任务更有效。"
    elif plan_completion < 60 or rollover:
        primary = {
            "label": "先调整计划",
            "href": "/a3/study-plan",
            "kind": "plan",
        }
        primary_reason = "计划完成率或顺延任务提示当前负荷偏高，需要先把下周任务调到可完成。"
    elif accuracy < 70:
        primary = {
            "label": "重新测评定位",
            "href": "/a3/assessment",
            "kind": "assessment",
        }
        primary_reason = "测评正确率偏低，需要用阶段测评重新定位薄弱知识点。"
    else:
        primary = {
            "label": "继续今日任务",
            "href": "/a3/today",
            "kind": "today",
        }
        primary_reason = "当前风险较低，保持每日任务闭环能稳定提升路径进度。"
    steps = [
        {
            "kind": "today",
            "title": "今日任务",
            "href": "/a3/today",
            "reason": "先完成一个最小学习闭环，保证报告结论当天被执行。",
            "expectedFeedback": "完成后今日任务页会给出即时反馈和下一步建议。",
        },
        {
            "kind": "review",
            "title": "错题复盘",
            "href": "/a3/wrong-notebook",
            "reason": f"当前待巩固错题 {active_wrong} 道，复盘结果会回写画像薄弱点。",
            "expectedFeedback": "重练后错题掌握状态和下次复习时间会更新。",
        },
        {
            "kind": "plan",
            "title": "计划调整",
            "href": "/a3/study-plan",
            "reason": f"本周计划完成率 {plan_completion}%，顺延任务 {rollover} 个，需要和下周节奏衔接。",
            "expectedFeedback": "学习计划会显示延期任务、复习队列和调整说明。",
        },
    ]
    return {
        "schemaVersion": "a3.report-action-loop.v1",
        "continuityMessage": "报告不是终点，下一步按今日任务、错题复盘、计划调整的顺序继续推进。",
        "primaryReason": primary_reason,
        "primaryAction": primary,
        "steps": steps,
    }


def _weekly_target_reason(plan_completion: int, rollover: int, active_wrong: int) -> str:
    if active_wrong:
        return "下周目标优先围绕错题复盘和薄弱点修复，避免继续堆积新内容。"
    if rollover:
        return "本周存在顺延任务，下周目标应控制任务量并优先清理延期项。"
    if plan_completion >= 80:
        return "本周完成度较高，下周可以增加综合练习和讲解复述。"
    return "目标以可完成为主，先建立稳定学习节奏。"


def _weekly_diagnosis(plan_completion: int, rollover: int, active_wrong: int, accuracy: float, completed: int, total: int) -> dict:
    if active_wrong:
        headline = "错题压力是下周优先风险"
        summary = "当前待巩固错题会影响新知识吸收，建议先做错因复盘，再进入新内容。"
    elif rollover:
        headline = "计划负荷需要下调"
        summary = "本周出现顺延任务，说明每日任务量或任务顺序需要更贴合可用时间。"
    elif accuracy < 70:
        headline = "测评正确率需要重新定位"
        summary = "正确率偏低，建议用阶段测评重新确认薄弱点，再安排专项练习。"
    elif plan_completion >= 80:
        headline = "学习节奏稳定，可以提高练习层级"
        summary = "计划完成度较高，下周可以增加综合题和讲解复述。"
    else:
        headline = "需要先建立稳定完成节奏"
        summary = "当前最重要的是保证每天完成最小学习闭环，而不是增加任务数量。"
    return {
        "headline": headline,
        "summary": summary,
        "evidence": [
            f"计划完成率 {plan_completion}%",
            f"任务完成 {completed}/{total or 0}",
            f"待巩固错题 {active_wrong} 道",
            f"测评正确率 {accuracy}%",
        ],
    }


def _weekly_focus_areas(active_wrong: int, accuracy: float, rollover: int, plan_completion: int) -> list[dict]:
    areas = []
    if active_wrong:
        areas.append({
            "title": "错题复盘",
            "reason": f"仍有 {active_wrong} 道错题未掌握，需要先处理错因。",
            "href": "/a3/wrong-notebook",
            "priority": "high",
        })
    if accuracy < 70:
        areas.append({
            "title": "基础测评",
            "reason": "正确率低于 70%，需要重新定位薄弱知识点。",
            "href": "/a3/assessment",
            "priority": "high",
        })
    if rollover:
        areas.append({
            "title": "计划减负",
            "reason": f"存在 {rollover} 个顺延任务，下周需要先清理延期项。",
            "href": "/a3/study-plan",
            "priority": "medium",
        })
    if plan_completion < 60:
        areas.append({
            "title": "今日任务闭环",
            "reason": "计划完成率不足 60%，优先建立每天可完成的最小闭环。",
            "href": "/a3/today",
            "priority": "medium",
        })
    if not areas:
        areas.append({
            "title": "综合应用练习",
            "reason": "当前风险较低，可以用综合题提升迁移能力。",
            "href": "/a3/assessment",
            "priority": "medium",
        })
    return areas[:4]


def _weekly_completion_criteria(active_wrong: int, accuracy: float, rollover: int) -> list[dict]:
    criteria = [
        {
            "label": "每日最小闭环",
            "target": "至少完成 1 个今日任务",
            "check": "今日任务页出现完成反馈和下一步建议",
        },
        {
            "label": "周复盘",
            "target": "至少提交 2 次每日复盘",
            "check": "报告页复盘次数增加，信心分进入周总结",
        },
    ]
    if active_wrong:
        criteria.insert(0, {
            "label": "错题清理",
            "target": f"处理 {min(active_wrong, 3)} 道高优先级错题",
            "check": "错题本显示掌握状态或下次复习时间",
        })
    if accuracy < 70:
        criteria.append({
            "label": "重新测评",
            "target": "完成 1 次基础测评",
            "check": "报告正确率和薄弱点建议刷新",
        })
    if rollover:
        criteria.append({
            "label": "顺延任务",
            "target": "清理或调整顺延任务",
            "check": "学习计划中的顺延提示减少",
        })
    return criteria[:5]
