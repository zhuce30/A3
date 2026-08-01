from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone as datetime_timezone
from urllib.parse import quote

from django.db import models, transaction
from django.db.models.functions import TruncDate
from django.utils import timezone

from backend.apps.assessments.adaptive import select_adaptive_questions, update_question_mastery
from backend.apps.assessments.models import (
    AssessmentAnswer,
    AssessmentSession,
    PersonalQuestionSequence,
    Question,
    QuestionEvidence,
    QuestionReviewStatus,
    QuestionSourceType,
    QuestionType,
    SessionStatus,
    WrongQuestion,
)
from backend.apps.assessments.personal_question_llm import generate_grounded_personal_candidates
from backend.apps.knowledge_base.models import KnowledgeBlock, ResourceScope, ResourceStatus
from backend.apps.learning.algorithm_labs import build_algorithm_lab_report_effect
from backend.apps.learning.effect_events import record_learning_event
from backend.apps.learning.models import KnowledgePoint, LearningPath, LearningPathStatus, PathItemStatus, ResourcePackLog
from backend.apps.system.admin_tutor_cache import (
    schedule_admin_tutor_analytics_invalidation,
)


logger = logging.getLogger(__name__)

PERSONAL_POOL_LOW_WATERMARK = 6
PERSONAL_POOL_TARGET_SIZE = 12
PERSONAL_POOL_MAX_ACTIVE = 40


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


def ensure_default_assessment_questions() -> None:
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
    queryset = Question.objects.filter(is_active=True, archived_at__isnull=True).select_related("knowledge_point__chapter")
    if mode == "practice":
        answered_question_ids = AssessmentAnswer.objects.filter(session__user=user).values("question_id")
        return queryset.filter(
            models.Q(review_status=QuestionReviewStatus.APPROVED)
            | models.Q(review_status=QuestionReviewStatus.AUTO_VERIFIED, owner=user)
        ).exclude(id__in=answered_question_ids)
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
    metadata = question.metadata if isinstance(question.metadata, dict) else {}
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
    personalization = _serialize_question_personalization(metadata)
    if personalization:
        payload["personalization"] = personalization
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


def _serialize_question_personalization(metadata: dict) -> dict | None:
    profile_signals = metadata.get("profileSignals")
    generation_reason = str(metadata.get("generationReason") or "").strip()
    source_evidence = metadata.get("sourceEvidence")
    question_kind = str(metadata.get("questionKind") or "").strip()
    variant_context = metadata.get("variantContext")
    llm = metadata.get("llm")
    if not isinstance(profile_signals, dict) and not generation_reason and not source_evidence and not question_kind:
        return None
    return {
        "questionKind": question_kind,
        "variantIndex": int(metadata.get("variantIndex") or 0),
        "variantContext": variant_context if isinstance(variant_context, dict) else {},
        "generationMode": str(metadata.get("generationMode") or "rules"),
        "reasoningForm": str(metadata.get("reasoningForm") or ""),
        "llm": llm if isinstance(llm, dict) else {},
        "generationReason": generation_reason,
        "foundationLevel": str((profile_signals or {}).get("foundationLevel") or "") if isinstance(profile_signals, dict) else "",
        "profileSignals": profile_signals if isinstance(profile_signals, dict) else {},
        "sourceEvidence": source_evidence if isinstance(source_evidence, list) else [],
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


def _ensure_personalized_practice_questions(
    user,
    *,
    point: KnowledgePoint | None,
    path: LearningPath | None,
    requested_title: str,
    needed: int,
) -> KnowledgePoint | None:
    if needed <= 0:
        return point
    target = _profile_priority_practice_point(user, point=point, path=path, requested_title=requested_title)
    if not target:
        return None
    distractors = _practice_distractor_points(target, path)
    profile_signals = _assessment_profile_signals(user, target)
    source_evidence = _collect_practice_source_evidence(user, target, requested_title=requested_title)
    variant_indexes = _reserve_personal_variant_indexes(user, target, needed)
    for variant_index in variant_indexes:
        distractor_offset = (variant_index - 1) % max(len(distractors), 1)
        rotated_distractors = distractors[distractor_offset:] + distractors[:distractor_offset]
        evidence_offset = (variant_index - 1) % max(len(source_evidence), 1)
        rotated_evidence = source_evidence[evidence_offset:] + source_evidence[:evidence_offset]
        _upsert_personalized_practice_question(
            user,
            target,
            rotated_distractors,
            requested_title,
            variant_index,
            profile_signals=profile_signals,
            source_evidence=rotated_evidence,
        )
    _archive_excess_personal_questions(user, target)
    return target


def _generate_personal_pool_questions(
    user,
    point: KnowledgePoint,
    *,
    path: LearningPath | None,
    needed: int,
) -> dict:
    if needed <= 0:
        return {"llmGenerated": 0, "ruleGenerated": 0, "llmRejected": 0, "llmFallback": False, "llmError": ""}
    distractors = _practice_distractor_points(point, path)
    profile_signals = _assessment_profile_signals(user, point)
    source_evidence = _collect_practice_source_evidence(user, point, requested_title=point.title)
    variant_indexes = _reserve_personal_variant_indexes(user, point, needed)
    evidence_rows = _source_evidence_metadata(source_evidence, point) if source_evidence else []
    llm_batch = generate_grounded_personal_candidates(
        point_title=point.title,
        variant_indexes=variant_indexes,
        profile_signals=profile_signals,
        evidence_rows=evidence_rows,
    )
    candidates_by_index = {int(item["variantIndex"]): item for item in llm_batch.candidates}
    llm_generated = 0
    rule_generated = 0
    llm_quality_rejected = 0
    for variant_index in variant_indexes:
        candidate = candidates_by_index.get(variant_index)
        if candidate:
            question = _create_grounded_llm_practice_question(
                user,
                point,
                candidate,
                profile_signals=profile_signals,
                source_evidence=source_evidence,
                provider=llm_batch.provider,
                model=llm_batch.model,
            )
            if question.review_status == QuestionReviewStatus.AUTO_VERIFIED and question.is_active:
                llm_generated += 1
            else:
                llm_quality_rejected += 1
            continue
        _create_rule_practice_variant(
            user,
            point,
            distractors,
            variant_index,
            profile_signals=profile_signals,
            source_evidence=source_evidence,
        )
        rule_generated += 1

    remaining = max(0, needed - llm_generated - rule_generated)
    if remaining:
        _ensure_personalized_practice_questions(
            user,
            point=point,
            path=path,
            requested_title=point.title,
            needed=remaining,
        )
        rule_generated += remaining
    return {
        "llmGenerated": llm_generated,
        "ruleGenerated": rule_generated,
        "llmRejected": llm_batch.rejected_count + llm_quality_rejected,
        "llmFallback": llm_batch.fallback,
        "llmError": llm_batch.error,
        "llmProvider": llm_batch.provider,
        "llmModel": llm_batch.model,
    }


def _create_rule_practice_variant(
    user,
    point: KnowledgePoint,
    distractors: list[KnowledgePoint],
    variant_index: int,
    *,
    profile_signals: dict,
    source_evidence: list[KnowledgeBlock],
) -> Question:
    distractor_offset = (variant_index - 1) % max(len(distractors), 1)
    rotated_distractors = distractors[distractor_offset:] + distractors[:distractor_offset]
    evidence_offset = (variant_index - 1) % max(len(source_evidence), 1)
    rotated_evidence = source_evidence[evidence_offset:] + source_evidence[:evidence_offset]
    return _upsert_personalized_practice_question(
        user,
        point,
        rotated_distractors,
        point.title,
        variant_index,
        profile_signals=profile_signals,
        source_evidence=rotated_evidence,
    )


def _create_grounded_llm_practice_question(
    user,
    point: KnowledgePoint,
    candidate: dict,
    *,
    profile_signals: dict,
    source_evidence: list[KnowledgeBlock],
    provider: str,
    model: str,
) -> Question:
    from backend.apps.assessments.verification import verify_question

    block_by_id = {str(block.id): block for block in source_evidence}
    cited_blocks = [block_by_id[block_id] for block_id in candidate["evidenceBlockIds"] if block_id in block_by_id]
    if not cited_blocks:
        raise ValueError("LLM candidate does not cite an allowed evidence block")
    variant_index = int(candidate["variantIndex"])
    evidence_rows = _source_evidence_metadata(cited_blocks, point)
    variant_context = _variant_context(variant_index, cited_blocks)
    variant_context["scenario"] = candidate["questionKind"]
    metadata = {
        "generatedBy": "assessment_practice_supply",
        "generationMode": "grounded_llm",
        "requestedKnowledgePoint": point.title,
        "baseKnowledgePointId": str(point.id),
        "variantIndex": variant_index,
        "variantContext": variant_context,
        "questionKind": candidate["questionKind"],
        "reasoningForm": candidate["reasoningForm"],
        "profileSignals": profile_signals,
        "generationReason": "根据学习画像和已索引资料证据生成，并经过自动质量验证",
        "sourceEvidence": evidence_rows,
        "citedEvidenceBlockIds": candidate["evidenceBlockIds"],
        "llm": {"provider": provider, "model": model, "fallback": False},
    }
    primary_block = cited_blocks[0]
    question = Question.objects.create(
        owner=user,
        knowledge_point=point,
        stem=candidate["stem"],
        options=candidate["options"],
        correct_answer=candidate["correctAnswer"],
        explanation=candidate["explanation"],
        error_cause=candidate["errorCause"][:255],
        difficulty=_foundation_adjusted_difficulty(profile_signals, point, variant_index),
        question_type=QuestionType.SINGLE_CHOICE,
        source_type=QuestionSourceType.PERSONAL_GENERATED,
        review_status=QuestionReviewStatus.DRAFT,
        scope="personal",
        is_active=False,
        source_resource=primary_block.resource,
        source_block_id=str(primary_block.id),
        evidence_summary=str(primary_block.text or primary_block.markdown or "")[:500],
        metadata=metadata,
    )
    for block in cited_blocks:
        QuestionEvidence.objects.create(
            question=question,
            resource=block.resource,
            block_id=str(block.id),
            page_number=block.page.page_number if block.page else None,
            quote=str(block.text or block.markdown or "")[:500],
            modality=block.modality,
            score=float(block.confidence or 0.5),
        )
    verify_question(question, checker="practice_supply")
    return question


def _unseen_personal_pool_queryset(user, point: KnowledgePoint):
    answered_question_ids = AssessmentAnswer.objects.filter(session__user=user).values("question_id")
    return Question.objects.filter(
        owner=user,
        knowledge_point=point,
        is_active=True,
        archived_at__isnull=True,
        review_status=QuestionReviewStatus.AUTO_VERIFIED,
        metadata__generatedBy="assessment_practice_supply",
    ).exclude(id__in=answered_question_ids)


def _archive_excess_personal_questions(
    user,
    point: KnowledgePoint,
    *,
    max_active: int = PERSONAL_POOL_MAX_ACTIVE,
) -> int:
    pool = Question.objects.filter(
        owner=user,
        knowledge_point=point,
        is_active=True,
        archived_at__isnull=True,
        review_status=QuestionReviewStatus.AUTO_VERIFIED,
        metadata__generatedBy="assessment_practice_supply",
    )
    excess = max(0, pool.count() - max(1, int(max_active)))
    if not excess:
        return 0

    protected_ids = set()
    for question_ids in AssessmentSession.objects.filter(
        user=user,
        status=SessionStatus.IN_PROGRESS,
    ).values_list("question_ids", flat=True):
        if isinstance(question_ids, list):
            protected_ids.update(str(question_id) for question_id in question_ids)
    answered = AssessmentAnswer.objects.filter(session__user=user, question_id=models.OuterRef("pk"))
    candidates = list(
        pool.exclude(id__in=protected_ids)
        .annotate(was_answered=models.Exists(answered))
        .order_by("-was_answered", "created_at")[:excess]
    )
    archived_at = timezone.now()
    for question in candidates:
        metadata = dict(question.metadata) if isinstance(question.metadata, dict) else {}
        metadata.update({
            "archiveReason": "personal_pool_capacity",
            "archivedAt": archived_at.isoformat(),
        })
        question.metadata = metadata
        question.archived_at = archived_at
        question.is_active = False
    if candidates:
        Question.objects.bulk_update(candidates, ["metadata", "archived_at", "is_active"])
    return len(candidates)


@transaction.atomic
def refill_personal_question_pool(user, point: KnowledgePoint, *, target_size: int = PERSONAL_POOL_TARGET_SIZE) -> dict:
    target_size = max(1, min(int(target_size), 20))
    sequence, _ = PersonalQuestionSequence.objects.get_or_create(user=user, knowledge_point=point)
    PersonalQuestionSequence.objects.select_for_update().get(pk=sequence.pk)
    supply = Question.objects.filter(
        owner=user,
        knowledge_point=point,
        metadata__generatedBy="assessment_practice_supply",
    )
    existing_ids = set(supply.values_list("id", flat=True))
    archived = _archive_excess_personal_questions(user, point)
    before = _unseen_personal_pool_queryset(user, point).count()
    needed = max(0, target_size - before)
    generation_stats = {
        "llmGenerated": 0,
        "ruleGenerated": 0,
        "llmRejected": 0,
        "llmFallback": False,
        "llmError": "",
        "llmProvider": "",
        "llmModel": "",
    }
    if needed:
        path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
        generation_stats = _generate_personal_pool_questions(
            user,
            point,
            path=path,
            needed=needed,
        )
    archived += _archive_excess_personal_questions(user, point)
    generated_questions = supply.exclude(id__in=existing_ids)
    generated_count = generated_questions.count()
    verified_count = generated_questions.filter(
        review_status=QuestionReviewStatus.AUTO_VERIFIED,
        is_active=True,
        archived_at__isnull=True,
    ).count()
    rejected_count = generated_questions.filter(review_status=QuestionReviewStatus.REJECTED).count()
    after = _unseen_personal_pool_queryset(user, point).count()
    return {
        "before": before,
        "available": after,
        "generated": generated_count,
        "verified": verified_count,
        "rejected": rejected_count,
        "archived": archived,
        "targetSize": target_size,
        **generation_stats,
    }


def _schedule_personal_pool_refill(user, point: KnowledgePoint) -> None:
    if _unseen_personal_pool_queryset(user, point).count() >= PERSONAL_POOL_LOW_WATERMARK:
        return

    user_id = str(user.id)
    point_id = str(point.id)

    def dispatch() -> None:
        from celery import current_app

        try:
            current_app.send_task(
                "assessments.refill_personal_question_pool",
                args=[user_id, point_id],
                kwargs={"target_size": PERSONAL_POOL_TARGET_SIZE},
            )
        except Exception:
            logger.warning(
                "Failed to dispatch personal question pool refill for user=%s point=%s",
                user_id,
                point_id,
                exc_info=True,
            )

    transaction.on_commit(dispatch)


@transaction.atomic
def _reserve_personal_variant_indexes(user, point: KnowledgePoint, count: int) -> list[int]:
    if count <= 0:
        return []
    sequence, _ = PersonalQuestionSequence.objects.get_or_create(user=user, knowledge_point=point)
    sequence = PersonalQuestionSequence.objects.select_for_update().get(pk=sequence.pk)
    existing_indexes = []
    for metadata in Question.objects.filter(owner=user, knowledge_point=point).values_list("metadata", flat=True):
        if not isinstance(metadata, dict):
            continue
        try:
            existing_indexes.append(int(metadata.get("variantIndex") or 0))
        except (TypeError, ValueError):
            continue
    start = max(sequence.next_variant_index, max(existing_indexes, default=0) + 1)
    sequence.next_variant_index = start + count
    sequence.save(update_fields=["next_variant_index", "updated_at"])
    return list(range(start, start + count))


def _profile_priority_practice_point(
    user,
    *,
    point: KnowledgePoint | None,
    path: LearningPath | None,
    requested_title: str,
) -> KnowledgePoint | None:
    if point:
        return point
    profile = getattr(user, "learner_profile", None)
    requested = str(requested_title or "").strip()
    candidates: list[str] = []
    if requested:
        candidates.append(requested)
    if profile and isinstance(profile.weak_points, list):
        candidates.extend(str(item).strip() for item in profile.weak_points if str(item).strip())
    for title in candidates:
        match = _find_knowledge_point_by_title(title, path)
        if match:
            return match
    return _fallback_practice_point(path)


def _find_knowledge_point_by_title(title: str, path: LearningPath | None) -> KnowledgePoint | None:
    if not title:
        return None
    queryset = KnowledgePoint.objects.all()
    if path:
        path_ids = list(path.items.order_by("order").values_list("knowledge_point_id", flat=True))
        exact = queryset.filter(id__in=path_ids, title=title).first()
        if exact:
            return exact
        partial = queryset.filter(id__in=path_ids, title__icontains=title).order_by("chapter__order", "order").first()
        if partial:
            return partial
    exact = queryset.filter(title=title).order_by("chapter__order", "order").first()
    if exact:
        return exact
    return queryset.filter(title__icontains=title).order_by("chapter__order", "order").first()


def _fallback_practice_point(path: LearningPath | None) -> KnowledgePoint | None:
    if not path:
        return KnowledgePoint.objects.order_by("chapter__course__code", "chapter__order", "order").first()
    current = path.items.filter(status=PathItemStatus.CURRENT).select_related("knowledge_point").first()
    if current:
        return current.knowledge_point
    first = path.items.order_by("order").select_related("knowledge_point").first()
    return first.knowledge_point if first else None


def _practice_distractor_points(point: KnowledgePoint, path: LearningPath | None) -> list[KnowledgePoint]:
    queryset = KnowledgePoint.objects.exclude(id=point.id)
    if path:
        path_ids = list(path.items.order_by("order").values_list("knowledge_point_id", flat=True))
        path_points = list(queryset.filter(id__in=path_ids).order_by("chapter__order", "order")[:3])
        if len(path_points) >= 3:
            return path_points
    return list(queryset.filter(chapter__course=point.chapter.course).order_by("chapter__order", "order")[:3])


def _assessment_profile_signals(user, point: KnowledgePoint) -> dict:
    profile = getattr(user, "learner_profile", None)
    recent_wrongs = list(
        WrongQuestion.objects.filter(user=user, mastered=False, question__knowledge_point=point)
        .select_related("question")
        .order_by("-last_wrong_at")[:3]
    )
    recent_error_causes: list[str] = []
    for wrong in recent_wrongs:
        cause = str(wrong.question.error_cause or "").strip()
        if cause and cause not in recent_error_causes:
            recent_error_causes.append(cause)
    return {
        "foundationLevel": str(getattr(profile, "foundation_level", "") or ""),
        "weakPoints": [str(item).strip() for item in (getattr(profile, "weak_points", []) or []) if str(item).strip()] if profile else [],
        "learningGoals": [str(item).strip() for item in (getattr(profile, "learning_goals", []) or []) if str(item).strip()] if profile else [],
        "expectedResources": [str(item).strip() for item in (getattr(profile, "expected_resources", []) or []) if str(item).strip()] if profile else [],
        "recentErrorCauses": recent_error_causes,
        "targetKnowledgePoint": point.title,
    }


def _collect_practice_source_evidence(user, point: KnowledgePoint, *, requested_title: str) -> list[KnowledgeBlock]:
    keywords = [point.title, str(requested_title or "").strip(), point.chapter.title]
    keywords = [item for item in dict.fromkeys(keywords) if item]
    queryset = (
        KnowledgeBlock.objects.filter(
            resource__status__in=[ResourceStatus.INDEXED, ResourceStatus.INDEXED_WITH_WARNINGS],
        )
        .filter(
            models.Q(resource__owner=user)
            | models.Q(resource__resource_scope__in=[ResourceScope.TEACHER, ResourceScope.CLASS, ResourceScope.GLOBAL])
        )
        .select_related("resource", "page", "asset")
        .exclude(text="")
    )
    if point.chapter.course.code:
        queryset = queryset.filter(models.Q(resource__course_key="") | models.Q(resource__course_key=point.chapter.course.code))
    keyword_filter = models.Q()
    for keyword in keywords:
        keyword_filter |= models.Q(text__icontains=keyword) | models.Q(markdown__icontains=keyword)
    if keyword_filter:
        queryset = queryset.filter(keyword_filter)
    return list(queryset.order_by("-confidence", "-resource__created_at", "created_at")[:3])


def _source_evidence_metadata(blocks: list[KnowledgeBlock], point: KnowledgePoint) -> list[dict]:
    if blocks:
        rows = []
        for block in blocks:
            text = str(block.text or block.markdown or "").strip()
            rows.append({
                "resourceId": str(block.resource_id),
                "resourceTitle": block.resource.original_name,
                "blockId": str(block.id),
                "pageNumber": block.page.page_number if block.page else None,
                "quote": text[:240],
                "modality": block.modality,
                "score": float(block.confidence or 0.5),
            })
        return rows
    return [{
        "resourceId": "",
        "resourceTitle": "当前学习路径",
        "blockId": f"learning-path:{point.id}",
        "pageNumber": None,
        "quote": str(point.description or point.title)[:240],
        "modality": "learning_path",
        "score": 0.75,
    }]


def _foundation_adjusted_difficulty(profile_signals: dict, point: KnowledgePoint, variant_index: int) -> int:
    level = str(profile_signals.get("foundationLevel") or "")
    base = int(point.difficulty or 2)
    if any(keyword in level for keyword in ("薄弱", "较弱", "基础弱", "入门")):
        return max(1, min(2, base))
    if any(keyword in level for keyword in ("扎实", "较好", "进阶", "优秀")):
        return max(3, min(5, base + (variant_index % 2)))
    return max(2, min(4, base))


def _explanation_depth(profile_signals: dict) -> str:
    level = str(profile_signals.get("foundationLevel") or "")
    if any(keyword in level for keyword in ("薄弱", "较弱", "基础弱", "入门")):
        return "解析会先说明概念边界，再说明排除干扰项的理由。"
    if any(keyword in level for keyword in ("扎实", "较好", "进阶", "优秀")):
        return "解析会强调适用条件、边界情况和迁移应用。"
    return "解析会连接定义、场景和常见误区。"


def _question_kind(variant_index: int) -> str:
    kinds = ["concept", "scenario", "judgement_correction", "application", "wrong_variant"]
    return kinds[(variant_index - 1) % len(kinds)]


def _variant_context(variant_index: int, source_evidence: list[KnowledgeBlock]) -> dict:
    scenarios = ["课堂案例", "实验调试", "项目评审", "错题复盘", "真实决策", "迁移训练"]
    scenario = scenarios[(variant_index - 1) % len(scenarios)]
    parameter = 10 + ((variant_index * 17) % 89)
    primary_block = source_evidence[0] if source_evidence else None
    return {
        "scenario": scenario,
        "parameter": parameter,
        "distractorOffset": (variant_index - 1) % 3,
        "evidenceBlockId": str(primary_block.id) if primary_block else "",
    }


def _upsert_personalized_practice_question(
    user,
    point: KnowledgePoint,
    distractors: list[KnowledgePoint],
    requested_title: str,
    variant_index: int,
    *,
    profile_signals: dict,
    source_evidence: list[KnowledgeBlock],
) -> Question:
    from backend.apps.assessments.verification import verify_question

    focus = str(requested_title or point.title).strip() or point.title
    description = str(point.description or point.title).strip()
    while len(distractors) < 3:
        distractors.append(point)
    kind = _question_kind(variant_index)
    variant_context = _variant_context(variant_index, source_evidence)
    recent_error = (profile_signals.get("recentErrorCauses") or ["概念边界不清"])[0]
    evidence_rows = _source_evidence_metadata(source_evidence, point)
    evidence_quote = evidence_rows[0]["quote"] or description
    stem, options = _personalized_question_content(
        kind=kind,
        focus=focus,
        point=point,
        distractors=distractors,
        description=description,
        recent_error=recent_error,
        evidence_quote=evidence_quote,
    )
    stem = f"{stem}（场景：{variant_context['scenario']}；参数：{variant_context['parameter']}）"
    difficulty = _foundation_adjusted_difficulty(profile_signals, point, variant_index)
    reason_parts = ["根据学习画像薄弱点出题", f"当前知识点：{point.title}"]
    if profile_signals.get("foundationLevel"):
        reason_parts.append(f"基础水平：{profile_signals['foundationLevel']}")
    if profile_signals.get("recentErrorCauses"):
        reason_parts.append("结合最近错因设计易错干扰项")
    if source_evidence:
        reason_parts.append("引用已上传资料作为证据")
    metadata = {
        "generatedBy": "assessment_practice_supply",
        "requestedKnowledgePoint": focus,
        "baseKnowledgePointId": str(point.id),
        "variantIndex": variant_index,
        "variantContext": variant_context,
        "questionKind": kind,
        "profileSignals": profile_signals,
        "generationReason": "；".join(reason_parts),
        "sourceEvidence": evidence_rows,
    }
    primary_block = source_evidence[0] if source_evidence else None
    question = Question.objects.create(
        owner=user,
        knowledge_point=point,
        stem=stem,
        options=options,
        correct_answer="A",
        explanation=f"本题用于巩固“{focus}”。正确选项围绕“{point.title}”的核心目标，并结合证据“{evidence_quote[:80]}”。{_explanation_depth(profile_signals)}",
        error_cause=f"{recent_error}；需要先抓住“{focus}”的定义、目标和适用范围，再判断相邻知识点是否只是干扰。",
        difficulty=difficulty,
        question_type=QuestionType.SINGLE_CHOICE,
        source_type=QuestionSourceType.VARIANT,
        review_status=QuestionReviewStatus.DRAFT,
        scope="personal",
        is_active=False,
        source_resource=primary_block.resource if primary_block else None,
        source_block_id=str(primary_block.id) if primary_block else f"learning-path:{point.id}",
        evidence_summary=evidence_quote[:500],
        metadata=metadata,
    )
    question.evidence_items.all().delete()
    if source_evidence:
        for block in source_evidence[:3]:
            QuestionEvidence.objects.create(
                question=question,
                resource=block.resource,
                block_id=str(block.id),
                page_number=block.page.page_number if block.page else None,
                quote=str(block.text or block.markdown or "")[:500],
                modality=block.modality,
                score=float(block.confidence or 0.5),
            )
    else:
        QuestionEvidence.objects.create(
            question=question,
            block_id=f"learning-path:{point.id}",
            quote=description,
            modality="learning_path",
            score=0.8,
        )
    verify_question(question, checker="practice_supply")
    return question


def _personalized_question_content(
    *,
    kind: str,
    focus: str,
    point: KnowledgePoint,
    distractors: list[KnowledgePoint],
    description: str,
    recent_error: str,
    evidence_quote: str,
) -> tuple[str, list[dict]]:
    short_desc = description[:56] or point.title
    evidence_hint = evidence_quote[:64] or short_desc
    if kind == "scenario":
        stem = f"场景题：学习“{focus}”时，资料提示“{evidence_hint}”。下列处理方式哪一项最适合？"
        options = [
            {"key": "A", "text": f"先解释{point.title}的目标，再结合场景判断适用条件"},
            {"key": "B", "text": f"直接套用{distractors[0].title}，不检查题目场景"},
            {"key": "C", "text": f"只记住结论，忽略“{recent_error}”这一类错因"},
            {"key": "D", "text": f"把{distractors[1].title}作为唯一判断标准"},
        ]
    elif kind == "judgement_correction":
        stem = f"判断纠错题：关于“{focus}”，哪一项判断和修正最合理？"
        options = [
            {"key": "A", "text": f"若出现“{recent_error}”，应回到{point.title}的定义和适用范围修正"},
            {"key": "B", "text": f"只要出现相似术语，就都归为{distractors[0].title}"},
            {"key": "C", "text": f"遇到不会的题时跳过概念边界，直接背{distractors[1].title}"},
            {"key": "D", "text": f"不需要引用资料证据，只凭印象判断“{focus}”"},
        ]
    elif kind == "application":
        stem = f"应用题：如果要把“{focus}”用于课堂练习或实验复盘，最关键的第一步是什么？"
        options = [
            {"key": "A", "text": f"明确{point.title}要解决的问题，再选择例题或实验验证"},
            {"key": "B", "text": f"优先扩展到{distractors[0].title}，暂时不处理当前薄弱点"},
            {"key": "C", "text": f"只整理资料标题，不检查“{focus}”的理解是否正确"},
            {"key": "D", "text": f"把{distractors[2].title}的结论直接迁移到所有题目"},
        ]
    elif kind == "wrong_variant":
        stem = f"错因变式题：你最近容易出现“{recent_error}”。围绕“{focus}”，哪项能避免这个错误？"
        options = [
            {"key": "A", "text": f"先区分{point.title}与相邻知识点，再根据证据完成判断"},
            {"key": "B", "text": f"继续把{distractors[0].title}和“{focus}”混用"},
            {"key": "C", "text": f"只看关键词相似度，不回到定义和场景"},
            {"key": "D", "text": f"把一次错题答案当作所有{point.title}题目的固定答案"},
        ]
    else:
        stem = f"概念辨析题：围绕“{focus}”的个性化专项练习，以下哪项最符合该知识点的学习目标？"
        options = [
            {"key": "A", "text": f"理解{point.title}：{short_desc}"},
            {"key": "B", "text": f"只关注{distractors[0].title}，不处理“{focus}”的核心目标"},
            {"key": "C", "text": f"跳过概念辨析，直接记忆{distractors[1].title}的结论"},
            {"key": "D", "text": f"把{distractors[2].title}当作“{focus}”的唯一考点"},
        ]
    return stem, options


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
        schedule_admin_tutor_analytics_invalidation()

    practice_point = None
    base_queryset = _selectable_question_queryset(user, mode=mode)
    queryset = base_queryset
    if path:
        queryset = queryset.filter(knowledge_point__chapter__course=path.course)
    if mode == "practice" and knowledge_point:
        practice_point = resolve_practice_knowledge_point(user, knowledge_point)
        queryset = queryset.filter(knowledge_point=practice_point) if practice_point else queryset.none()
    question_limit = max(1, min(int(limit or 12), 20))
    if path:
        point_ids = list(path.items.order_by("order").values_list("knowledge_point_id", flat=True))
        path_questions = _valid_questions(queryset.filter(knowledge_point_id__in=point_ids))
        if not path_questions and mode == "assessment":
            path_questions = _valid_questions(base_queryset)
            if not path_questions:
                ensure_default_assessment_questions()
                queryset = _selectable_question_queryset(user, mode=mode).filter(knowledge_point__chapter__course=path.course)
                path_questions = _valid_questions(queryset.filter(knowledge_point_id__in=point_ids))
        order = {str(point_id): index for index, point_id in enumerate(point_ids)}
        path_questions.sort(key=lambda item: (order.get(str(item.knowledge_point_id), 999), item.difficulty))
        candidate_questions = path_questions
    else:
        candidate_questions = _valid_questions(queryset)
    if not candidate_questions and path:
        fallback_queryset = base_queryset
        if mode == "practice" and knowledge_point:
            practice_point = practice_point or resolve_practice_knowledge_point(user, knowledge_point)
            fallback_queryset = fallback_queryset.filter(knowledge_point=practice_point) if practice_point else fallback_queryset.none()
        candidate_questions = _valid_questions(fallback_queryset)
    if mode == "practice" and strategy == "default" and len(candidate_questions) < question_limit:
        practice_point = _ensure_personalized_practice_questions(
            user,
            point=practice_point,
            path=path,
            requested_title=knowledge_point,
            needed=question_limit - len(candidate_questions),
        ) or practice_point
        queryset = _selectable_question_queryset(user, mode=mode)
        practice_point_outside_path = bool(
            path
            and practice_point
            and practice_point.chapter.course_id != path.course_id
        )
        if path and not practice_point_outside_path:
            queryset = queryset.filter(knowledge_point__chapter__course=path.course)
        if knowledge_point:
            practice_point = practice_point or resolve_practice_knowledge_point(user, knowledge_point)
            queryset = queryset.filter(knowledge_point=practice_point) if practice_point else queryset.none()
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
        schedule_admin_tutor_analytics_invalidation()
    question_metadata = question.metadata if isinstance(question.metadata, dict) else {}
    if question.owner_id == user.id and question_metadata.get("generatedBy") == "assessment_practice_supply":
        _schedule_personal_pool_refill(user, question.knowledge_point)
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
    _ensure_wrong_question_in_plan_review_queue(profile, plan, wrong)
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


def _ensure_wrong_question_in_plan_review_queue(profile, plan: dict, wrong: WrongQuestion) -> None:
    if not isinstance(plan, dict):
        return
    review_queue = plan.get("reviewQueue")
    if not isinstance(review_queue, list):
        review_queue = []
        plan["reviewQueue"] = review_queue
    wrong_id = str(wrong.id)
    if not any(str(item.get("wrongQuestionId") or "") == wrong_id for item in review_queue if isinstance(item, dict)):
        review_after = wrong.review_after or (timezone.now() + timedelta(days=1))
        review_queue.insert(0, {
            "id": wrong_id,
            "wrongQuestionId": wrong_id,
            "questionId": str(wrong.question_id),
            "title": wrong.question.knowledge_point.title,
            "knowledgePoint": wrong.question.knowledge_point.title,
            "errorCause": wrong.question.error_cause or "概念理解不稳",
            "wrongCount": wrong.wrong_count,
            "reviewAfter": review_after.isoformat(),
            "status": "due" if review_after <= timezone.now() else "scheduled",
            "href": "/a3/wrong-notebook",
            "source": "assessment_wrong_answer",
        })
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["studyPlan"] = plan
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])


def merge_active_wrong_questions_into_review_queue(user, plan: dict) -> dict:
    if not isinstance(plan, dict):
        return plan
    review_queue = plan.get("reviewQueue")
    if not isinstance(review_queue, list):
        review_queue = []
    merged = [item for item in review_queue if isinstance(item, dict)]
    existing_ids = {str(item.get("wrongQuestionId") or "") for item in merged}
    active_wrongs = (
        WrongQuestion.objects.filter(user=user, mastered=False)
        .select_related("question__knowledge_point")
        .order_by("-wrong_count", "-last_wrong_at")[:20]
    )
    for wrong in active_wrongs:
        wrong_id = str(wrong.id)
        if wrong_id in existing_ids:
            continue
        review_after = wrong.review_after or (timezone.now() + timedelta(days=1))
        merged.append({
            "id": wrong_id,
            "wrongQuestionId": wrong_id,
            "questionId": str(wrong.question_id),
            "title": wrong.question.knowledge_point.title,
            "knowledgePoint": wrong.question.knowledge_point.title,
            "errorCause": wrong.question.error_cause or "概念理解不稳",
            "wrongCount": wrong.wrong_count,
            "reviewAfter": review_after.isoformat(),
            "status": "due" if review_after <= timezone.now() else "scheduled",
            "href": "/a3/wrong-notebook",
            "source": "assessment_wrong_answer",
        })
        existing_ids.add(wrong_id)
    plan["reviewQueue"] = merged

    from backend.apps.profiles.models import LearnerProfile

    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    extra_profile = dict(profile.extra_profile) if isinstance(profile.extra_profile, dict) else {}
    extra_profile["studyPlan"] = plan
    profile.extra_profile = extra_profile
    profile.save(update_fields=["extra_profile", "updated_at"])
    return plan


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
    today = timezone.localdate(now)
    report_end_at = timezone.make_aware(datetime.combine(today + timedelta(days=1), time.min))
    period_key, period_start = _report_period_start(period, today)
    period_start_at = timezone.make_aware(datetime.combine(period_start, time.min)) if period_start else None
    all_answers = AssessmentAnswer.objects.filter(session__user=user)
    answers = all_answers.filter(answered_at__lt=report_end_at)
    if period_start_at:
        answers = answers.filter(answered_at__gte=period_start_at)
    answer_stats = _report_answer_stats(
        all_answers,
        period_key=period_key,
        period_start_at=period_start_at,
        period_start=period_start,
        today=today,
        report_end_at=report_end_at,
    )
    total_answers = answer_stats["period_total"]
    correct_answers = answer_stats["period_correct"]
    accuracy = round(correct_answers * 100 / total_answers, 1) if total_answers else 0
    path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).first()
    path_items = list(path.items.all()) if path else []
    total_path_items = len(path_items)
    completed_items = [
        item
        for item in path_items
        if item.status == PathItemStatus.COMPLETED
        and item.completed_at
        and item.completed_at < report_end_at
        and (not period_start_at or item.completed_at >= period_start_at)
    ]
    study_minutes = sum(item.estimated_minutes for item in completed_items)
    wrong_items = list(
        WrongQuestion.objects.filter(user=user, last_wrong_at__lt=report_end_at).select_related(
            "question__knowledge_point"
        )
    )
    wrong_active = [wrong for wrong in wrong_items if not wrong.mastered]
    mastered_wrong = sum(1 for wrong in wrong_items if wrong.mastered)
    daily_answers = _report_daily_answers(answers, now)
    study_dates = {row["day"] for row in daily_answers}
    if path:
        study_dates.update(timezone.localdate(item.completed_at) for item in completed_items if item.completed_at)

    trends = _report_trends(daily_answers, today, period_key, period_start)

    knowledge_score = accuracy
    progress_score = round(len(completed_items) * 100 / total_path_items) if total_path_items else 0
    focus_score = min(100, len(study_dates) * 12)
    capability_axes = [
        {"label": "知识掌握", "value": knowledge_score},
        {"label": "学习进度", "value": progress_score},
        {"label": "答题稳定性", "value": max(0, accuracy - len(wrong_active) * 3)},
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

    first_answer_at = answer_stats["first_answer_at"]
    report_start = period_start or (timezone.localdate(first_answer_at) if first_answer_at else today)
    weekly_summary = _weekly_learning_summary(user, now)
    metrics = {
        "studyMinutes": study_minutes,
        "studyDays": len(study_dates),
        "masteredKnowledgePoints": len(completed_items),
        "totalKnowledgePoints": total_path_items,
        "answeredQuestions": total_answers,
        "accuracy": accuracy,
        "activeWrongQuestions": len(wrong_active),
        "masteredWrongQuestions": mastered_wrong,
        "pathProgress": progress_score,
    }
    period_payload = {
        "key": period_key,
        "label": _report_period_label(period_key),
        "start": report_start.isoformat(),
        "end": today.isoformat(),
    }
    weekly_prescription = _weekly_prescription(weekly_summary, metrics)
    action_loop = _report_action_loop(weekly_summary, metrics)
    wrong_review_insight = _wrong_review_insight(wrong_active, mastered_wrong)
    comparisons = _report_comparisons(
        period_key=period_key,
        start=period_start or report_start,
        end=today,
        answer_stats=answer_stats,
    )
    knowledge_point_insights = _knowledge_point_insights(user, start=period_start_at, end=report_end_at)
    algorithm_lab_effect = build_algorithm_lab_report_effect(
        user,
        start_at=period_start_at,
        end_at=report_end_at,
    )
    updated_at = now.isoformat()
    return {
        "period": period_payload,
        "metrics": metrics,
        "trends": trends,
        "capabilityAxes": capability_axes,
        "suggestions": suggestions,
        "weeklySummary": weekly_summary,
        "weeklyPrescription": weekly_prescription,
        "actionLoop": action_loop,
        "wrongReviewInsight": wrong_review_insight,
        "resourcePackEffect": _resource_pack_effect(user),
        "algorithmLabEffect": algorithm_lab_effect,
        "updatedAt": updated_at,
        "studentSummary": _student_report_summary(
            user=user,
            period=period_payload,
            metrics=metrics,
            comparisons=comparisons,
            knowledge_points=knowledge_point_insights,
            weekly_prescription=weekly_prescription,
            wrong_review_insight=wrong_review_insight,
        ),
        "comparisons": comparisons,
        "knowledgePointInsights": knowledge_point_insights,
        "dataQuality": _report_data_quality(
            answered_questions=total_answers,
            comparisons=comparisons,
            knowledge_points=knowledge_point_insights,
            updated_at=updated_at,
        ),
    }


def _report_answer_stats(
    all_answers,
    *,
    period_key: str,
    period_start_at,
    period_start,
    today,
    report_end_at,
) -> dict:
    period_filter = models.Q(answered_at__lt=report_end_at)
    if period_start_at:
        period_filter &= models.Q(answered_at__gte=period_start_at)
    aggregates = {
        "period_total": models.Count("id", filter=period_filter),
        "period_correct": models.Count("id", filter=period_filter & models.Q(is_correct=True)),
        "first_answer_at": models.Min(
            "answered_at",
            filter=models.Q(answered_at__lt=report_end_at),
        ),
    }
    if period_key != "term":
        current_start_at = timezone.make_aware(datetime.combine(period_start, time.min))
        window_days = (today - period_start).days + 1
        previous_end = period_start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=window_days - 1)
        previous_start_at = timezone.make_aware(datetime.combine(previous_start, time.min))
        current_filter = models.Q(answered_at__gte=current_start_at, answered_at__lt=report_end_at)
        previous_filter = models.Q(answered_at__gte=previous_start_at, answered_at__lt=current_start_at)
        aggregates.update(
            {
                "current_total": models.Count("id", filter=current_filter),
                "current_correct": models.Count("id", filter=current_filter & models.Q(is_correct=True)),
                "previous_total": models.Count("id", filter=previous_filter),
                "previous_correct": models.Count("id", filter=previous_filter & models.Q(is_correct=True)),
            }
        )
    return all_answers.aggregate(**aggregates)


def _report_comparisons(*, period_key: str, start, end, answer_stats: dict) -> dict:
    def window_stats(window_start, window_end, prefix: str) -> dict:
        answered_count = answer_stats[f"{prefix}_total"]
        correct_count = answer_stats[f"{prefix}_correct"]
        return {
            "start": window_start.isoformat(),
            "end": window_end.isoformat(),
            "answeredCount": answered_count,
            "correctCount": correct_count,
            "accuracy": round(correct_count * 100 / answered_count, 1) if answered_count else None,
        }

    if period_key == "term":
        current_count = answer_stats["period_total"]
        current_correct = answer_stats["period_correct"]
        current_window = {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "answeredCount": current_count,
            "correctCount": current_correct,
            "accuracy": round(current_correct * 100 / current_count, 1) if current_count else None,
        }
        return {
            "periodKey": period_key,
            "currentWindow": current_window,
            "previousWindow": None,
            "accuracy": {
                "availability": "unavailable",
                "comparable": False,
                "currentValue": current_window["accuracy"],
                "previousValue": None,
                "percentagePointChange": None,
                "reason": "本学期暂无真实上一学期窗口，暂不进行趋势比较。",
            },
        }

    window_days = (end - start).days + 1
    previous_end = start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=window_days - 1)
    current_window = window_stats(start, end, "current")
    previous_window = window_stats(previous_start, previous_end, "previous")
    current_count = current_window["answeredCount"]
    previous_count = previous_window["answeredCount"]
    comparable = current_count >= 3 and previous_count >= 3
    if comparable:
        reason = "当前周期与上一等长周期均达到至少 3 次作答，可以比较正确率。"
        percentage_point_change = round(current_window["accuracy"] - previous_window["accuracy"], 1)
    elif previous_count == 0:
        reason = "上一周期暂无作答，两个周期均至少 3 次作答后才能比较。"
        percentage_point_change = None
    else:
        reason = "当前周期和上一周期都至少 3 次作答后才能比较。"
        percentage_point_change = None
    return {
        "periodKey": period_key,
        "currentWindow": current_window,
        "previousWindow": previous_window,
        "accuracy": {
            "availability": "available" if comparable else "insufficient_sample",
            "comparable": comparable,
            "currentValue": current_window["accuracy"],
            "previousValue": previous_window["accuracy"],
            "percentagePointChange": percentage_point_change,
            "reason": reason,
        },
    }


def _knowledge_point_insights(user, *, start, end=None, limit: int = 3) -> list[dict]:
    if limit <= 0:
        return []

    candidate_limit = max(12, limit * 4)
    answers = AssessmentAnswer.objects.filter(session__user=user)
    if start:
        answers = answers.filter(answered_at__gte=start)
    if end:
        answers = answers.filter(answered_at__lt=end)

    latest_answers = AssessmentAnswer.objects.filter(
        session__user=user,
        question__knowledge_point_id=models.OuterRef("question__knowledge_point_id"),
    )
    if start:
        latest_answers = latest_answers.filter(answered_at__gte=start)
    if end:
        latest_answers = latest_answers.filter(answered_at__lt=end)
    latest_answers = latest_answers.order_by("-answered_at", "-pk")

    answer_rows = (
        answers.values("question__knowledge_point_id", "question__knowledge_point__title")
        .annotate(
            answered_count=models.Count("id"),
            wrong_count=models.Count("id", filter=models.Q(is_correct=False)),
            latest_is_correct=models.Subquery(
                latest_answers.values("is_correct")[:1],
                output_field=models.BooleanField(),
            ),
        )
        .order_by("-wrong_count", "-answered_count", "question__knowledge_point__title")[:candidate_limit]
    )

    points: dict[str, dict] = {}
    for row in answer_rows:
        key = str(row["question__knowledge_point_id"])
        points[key] = {
            "knowledgePoint": row["question__knowledge_point__title"],
            "answeredCount": row["answered_count"],
            "wrongCount": row["wrong_count"],
            "latestResult": "correct" if row["latest_is_correct"] else "incorrect",
            "activeWrongQuestions": 0,
        }

    active_wrong = WrongQuestion.objects.filter(user=user, mastered=False)
    if end:
        active_wrong = active_wrong.filter(last_wrong_at__lt=end)
    active_wrong_rows = (
        active_wrong
        .values("question__knowledge_point_id", "question__knowledge_point__title")
        .annotate(active_wrong_count=models.Count("id"))
        .order_by("-active_wrong_count", "question__knowledge_point__title")[:candidate_limit]
    )
    for row in active_wrong_rows:
        key = str(row["question__knowledge_point_id"])
        insight = points.setdefault(
            key,
            {
                "knowledgePoint": row["question__knowledge_point__title"],
                "answeredCount": 0,
                "wrongCount": 0,
                "latestResult": None,
                "activeWrongQuestions": 0,
            },
        )
        insight["activeWrongQuestions"] = row["active_wrong_count"]

    results = []
    for insight in points.values():
        answered_count = insight["answeredCount"]
        wrong_count = insight["wrongCount"]
        active_count = insight["activeWrongQuestions"]
        latest_result = insight["latestResult"]
        if active_count or latest_result == "incorrect":
            status = "needs_review"
            reason = f"当前有 {active_count or wrong_count} 道相关错题待巩固。"
            action = {
                "label": "复习相关错题",
                "href": "/a3/wrong-notebook",
                "estimatedMinutes": 12,
            }
        elif wrong_count and latest_result == "correct":
            status = "improving"
            reason = "最近一次作答正确，但仍需通过新题确认掌握稳定性。"
            action = {
                "label": "进行专项练习",
                "href": f"/a3/assessment?practice={quote(insight['knowledgePoint'])}",
                "estimatedMinutes": 10,
            }
        elif answered_count >= 3:
            status = "stable"
            reason = f"本周期 {answered_count} 次作答均未形成待巩固错题。"
            action = {"label": "继续今日任务", "href": "/a3/today", "estimatedMinutes": 10}
        else:
            status = "insufficient_evidence"
            reason = "作答证据不足，至少完成 3 次相关作答后再判断趋势。"
            action = {
                "label": "完成一次专项测评",
                "href": f"/a3/assessment?practice={quote(insight['knowledgePoint'])}",
                "estimatedMinutes": 10,
            }
        results.append({**insight, "status": status, "reason": reason, "action": action})

    results.sort(
        key=lambda item: (
            -item["activeWrongQuestions"],
            -item["wrongCount"],
            -item["answeredCount"],
            item["knowledgePoint"],
        )
    )
    return results[: max(0, limit)]


def _student_report_summary(
    *,
    user,
    period: dict,
    metrics: dict,
    comparisons: dict,
    knowledge_points: list[dict],
    weekly_prescription: dict,
    wrong_review_insight: dict,
) -> dict:
    answered = int(metrics.get("answeredQuestions") or 0)
    accuracy = float(metrics.get("accuracy") or 0)
    active_wrong = int(metrics.get("activeWrongQuestions") or 0)
    accuracy_comparison = comparisons.get("accuracy", {})
    change = accuracy_comparison.get("percentagePointChange")
    if answered == 0:
        headline = "暂无足够作答数据，先完成一次测评"
        progress_signal = "本周期暂无作答"
    elif accuracy_comparison.get("comparable") and change is not None:
        if change > 0:
            headline = "答题表现正在改善"
        elif change < 0:
            headline = "答题表现有所回落，需要优先巩固薄弱点"
        else:
            headline = "答题表现保持稳定"
        progress_signal = f"正确率较上一周期变化 {change:+.1f} 个百分点"
    else:
        headline = "已记录本周期表现，暂缺可靠趋势比较"
        progress_signal = f"本周期完成 {answered} 次作答"

    if active_wrong:
        primary_risk = f"{active_wrong} 道错题尚未巩固"
        primary_action = {
            "label": f"复盘 {active_wrong} 道错题",
            "href": "/a3/wrong-notebook",
            "estimatedMinutes": min(20, max(8, active_wrong * 4)),
            "expectedOutcome": "完成复盘后重新测评，报告会更新掌握状态。",
        }
    else:
        plan_action = _current_study_plan_action(user)
        if plan_action:
            primary_action = plan_action
        elif answered < 3 or any(item.get("status") != "stable" for item in knowledge_points):
            primary_action = {
                "label": "完成一次阶段测评",
                "href": "/a3/assessment",
                "estimatedMinutes": 10,
                "expectedOutcome": "新增真实作答证据后更新薄弱点和趋势判断。",
            }
        else:
            primary_action = {
                "label": "继续今日任务",
                "href": "/a3/today",
                "estimatedMinutes": 10,
                "expectedOutcome": "完成任务后更新学习进度和计划完成度。",
            }
        primary_risk = knowledge_points[0]["reason"] if knowledge_points else "当前缺少可定位的知识点证据"

    summary = (
        f"{period.get('label', '本周期')}完成 {answered} 次作答，正确率 {accuracy:.1f}%；"
        f"当前有 {active_wrong} 道待巩固错题。"
        if answered
        else f"{period.get('label', '本周期')}暂无作答记录，暂时不能判断进步趋势。"
    )
    return {
        "schemaVersion": "a3.student-report-summary.v1",
        "headline": headline,
        "summary": summary,
        "progressSignal": progress_signal,
        "primaryRisk": primary_risk,
        "primaryAction": primary_action,
        "evidence": [
            {"label": "作答", "value": f"{answered} 次", "source": "assessment"},
            {"label": "正确率", "value": f"{accuracy:.1f}%" if answered else "暂无", "source": "assessment"},
            {"label": "待巩固", "value": f"{active_wrong} 道", "source": "wrong_notebook"},
        ],
    }


def _current_study_plan_action(user) -> dict | None:
    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return None
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan")
    if not isinstance(plan, dict):
        return None

    raw_days = plan.get("days")
    days = [day for day in raw_days if isinstance(day, dict)] if isinstance(raw_days, list) else []
    today = timezone.localdate().isoformat()

    def day_sort_key(day: dict) -> tuple[bool, int]:
        try:
            day_index = int(day.get("dayIndex"))
        except (TypeError, ValueError):
            day_index = 10_000
        return str(day.get("date") or "") != today, day_index

    days.sort(key=day_sort_key)
    for day in days:
        tasks = day.get("tasks") if isinstance(day.get("tasks"), list) else []
        for task in tasks:
            if not isinstance(task, dict) or task.get("status") == "completed":
                continue
            label = str(task.get("label") or task.get("title") or "").strip()
            href = str(task.get("href") or "").strip()
            expected_outcome = str(task.get("expectedOutcome") or task.get("subtitle") or "").strip()
            try:
                estimated_minutes = int(task.get("estimatedMinutes"))
            except (TypeError, ValueError):
                continue
            if label and href.startswith("/a3/") and estimated_minutes > 0 and expected_outcome:
                return {
                    "label": label,
                    "href": href,
                    "estimatedMinutes": estimated_minutes,
                    "expectedOutcome": expected_outcome,
                }
    return None


def _report_data_quality(
    *, answered_questions: int, comparisons: dict, knowledge_points: list[dict], updated_at: str
) -> dict:
    missing_reasons = []
    if answered_questions == 0:
        missing_reasons.append("当前周期暂无作答数据。")
    elif answered_questions < 3:
        missing_reasons.append("当前周期少于 3 次作答，趋势证据不足。")
    if not comparisons.get("accuracy", {}).get("comparable"):
        missing_reasons.append(str(comparisons.get("accuracy", {}).get("reason") or "暂无可比周期。"))
    if not knowledge_points:
        missing_reasons.append("暂无知识点级作答或错题证据。")

    if answered_questions >= 3 and comparisons.get("accuracy", {}).get("comparable") and knowledge_points:
        evidence_state = "ready"
    elif answered_questions or knowledge_points:
        evidence_state = "partial"
    else:
        evidence_state = "insufficient"
    return {
        "evidenceState": evidence_state,
        "answeredQuestions": answered_questions,
        "knowledgePointCount": len(knowledge_points),
        "comparisonAvailable": bool(comparisons.get("accuracy", {}).get("comparable")),
        "missingReasons": missing_reasons,
        "lastUpdatedAt": updated_at,
    }


def _report_period_start(period: str, today) -> tuple[str, object | None]:
    period_key = period if period in {"7d", "30d", "term"} else "term"
    if period_key == "7d":
        return period_key, today - timedelta(days=6)
    if period_key == "30d":
        return period_key, today - timedelta(days=29)
    return period_key, None


def _report_period_label(period: str) -> str:
    if period == "7d":
        return "近 7 天"
    if period == "30d":
        return "近 30 天"
    return "本学期"


def _report_daily_answers(answers, now) -> list[dict]:
    local_offset = timezone.localtime(now).utcoffset() or timedelta(0)
    shifted_answered_at = models.ExpressionWrapper(
        models.F("answered_at") + local_offset,
        output_field=models.DateTimeField(),
    )
    return list(
        answers.annotate(day=TruncDate(shifted_answered_at, tzinfo=datetime_timezone.utc))
        .values("day")
        .annotate(
            questions=models.Count("id"),
            correct=models.Count("id", filter=models.Q(is_correct=True)),
        )
        .order_by("day")
    )


def _report_trends(daily_answers, today, period: str, period_start) -> list[dict]:
    counts_by_day = {
        row["day"]: (row["questions"], row["correct"])
        for row in daily_answers
        if row["day"] is not None
    }

    def bucket(start, end, label) -> dict:
        questions = 0
        correct = 0
        day = start
        while day <= end:
            day_questions, day_correct = counts_by_day.get(day, (0, 0))
            questions += day_questions
            correct += day_correct
            day += timedelta(days=1)
        return {
            "label": label,
            "questions": questions,
            "accuracy": round(correct * 100 / questions, 1) if questions else 0,
            "start": start.isoformat(),
            "end": end.isoformat(),
        }

    if period == "7d":
        return [
            bucket(day, day, day.strftime("%m.%d"))
            for offset in range(6, -1, -1)
            for day in [today - timedelta(days=offset)]
        ]

    if period == "30d":
        trends = []
        for offset in range(4, -1, -1):
            end = today - timedelta(days=offset * 6)
            start = max(end - timedelta(days=5), period_start or end - timedelta(days=5))
            trends.append(bucket(start, end, f"{start.strftime('%m.%d')}-{end.strftime('%m.%d')}"))
        return trends

    trends = []
    for offset in range(4, -1, -1):
        end = today - timedelta(days=offset * 7)
        start = end - timedelta(days=6)
        trends.append(bucket(start, end, f"{start.strftime('%m.%d')}-{end.strftime('%m.%d')}"))
    return trends


def _wrong_review_insight(wrong_active, mastered_wrong: int) -> dict:
    active_count = len(wrong_active)
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
