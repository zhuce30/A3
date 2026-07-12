from __future__ import annotations

import json
from uuid import UUID

from django.db import models, transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods

from backend.apps.assessments.generation import (
    QuestionGenerationRequestError,
    create_question_generation_job,
    serialize_question_generation_job,
)
from backend.apps.assessments.models import AssessmentSession, Question, QuestionReviewStatus, WrongQuestion
from backend.apps.assessments.services import answer_assessment_question, build_learning_report, create_assessment, practice_suggestions, resolve_practice_knowledge_point, retry_wrong, serialize_question_bank_item, serialize_session, serialize_wrong_question, wrong_retry_feedback, wrong_review_summary
from backend.apps.compat.agent_kernel import run_question_generation_workflow


def _require_login(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "请先登录"}, status=401)
    return None


def _body(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError("请求数据不是有效 JSON") from exc

def _is_teacher_or_admin(user) -> bool:
    return getattr(user, "role", "") in {"teacher", "admin"}


def _teacher_question_queryset():
    return Question.objects.filter(
        ~models.Q(scope="personal")
        | models.Q(
            scope="personal",
            archived_at__isnull=True,
            review_status=QuestionReviewStatus.AUTO_VERIFIED,
            source_type__in=["personal_generated", "variant", "kb_generated"],
        )
    )


def _apply_question_review(question, *, action: str, reason: str, reviewer):
    metadata = dict(question.metadata) if isinstance(question.metadata, dict) else {}
    metadata.update({"reviewAction": action, "reviewReason": reason, "reviewerId": str(reviewer.id)})
    if action == "approve":
        if question.scope == "personal":
            metadata.setdefault("originalScope", "personal")
            metadata.setdefault("originalOwnerId", str(question.owner_id) if question.owner_id else "")
            question.scope = "teacher"
        question.review_status = QuestionReviewStatus.APPROVED
        question.is_active = True
    elif action == "reject":
        question.review_status = QuestionReviewStatus.REJECTED
        question.is_active = False
    else:
        question.review_status = QuestionReviewStatus.DISABLED
        question.is_active = False
    question.metadata = metadata
    question.save(update_fields=["review_status", "scope", "is_active", "metadata"])
    return question


@require_http_methods(["GET"])
def current_assessment(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        session = create_assessment(request.user)
        return JsonResponse({"success": True, "session": serialize_session(session), "practiceSuggestions": practice_suggestions(request.user)})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def start_assessment(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        mode = str(payload.get("mode") or "assessment").strip()
        if mode not in {"assessment", "practice"}:
            raise ValueError("mode 不支持")
        knowledge_point = str(payload.get("knowledgePoint") or "").strip()
        resolved_point = resolve_practice_knowledge_point(request.user, knowledge_point) if mode == "practice" and knowledge_point else None
        focus_title = resolved_point.title if resolved_point else knowledge_point
        focus = {"knowledgePoint": focus_title} if mode == "practice" and focus_title else None
        session = create_assessment(
            request.user,
            force=True,
            mode=mode,
            knowledge_point=knowledge_point,
            limit=payload.get("limit"),
            strategy=str(payload.get("strategy") or "default").strip() or "default",
        )
        return JsonResponse({
            "success": True,
            "session": serialize_session(session, mode=mode, focus=focus),
            "practiceSuggestions": practice_suggestions(request.user),
        }, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def submit_answer(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    session = get_object_or_404(AssessmentSession, id=session_id, user=request.user)
    try:
        payload = _body(request)
        result = answer_assessment_question(
            request.user, session, payload.get("selectedAnswer", ""), bool(payload.get("skipped", False))
        )
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def wrong_questions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    queryset = WrongQuestion.objects.filter(user=request.user).select_related("question__knowledge_point__chapter")
    if request.GET.get("mastered") != "all":
        queryset = queryset.filter(mastered=False)
    items = list(queryset)
    return JsonResponse({
        "success": True,
        "wrongQuestions": [serialize_wrong_question(item) for item in items],
        "reviewSummary": wrong_review_summary(items),
    })


@require_http_methods(["POST"])
def retry_wrong_question(request, wrong_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    wrong = get_object_or_404(WrongQuestion.objects.select_related("question__knowledge_point__chapter"), id=wrong_id, user=request.user)
    try:
        result = retry_wrong(request.user, wrong, _body(request).get("selectedAnswer", ""))
        result.update(wrong_retry_feedback(request.user, wrong))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def learning_report(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    period = request.GET.get("period", "term")
    return JsonResponse({"success": True, "report": build_learning_report(request.user, period=period)})


@require_http_methods(["POST"])
def generate_questions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        job = create_question_generation_job(request.user, _body(request))
        run = run_question_generation_workflow(request.user, {"job": job})
        job.refresh_from_db()
        payload = {"success": job.status != "failed", "job": serialize_question_generation_job(job), "traceId": run.trace.get("traceId") or run.output.get("traceId")}
        if job.status == "failed":
            payload["error"] = job.error
            status = 503 if "API Key" in job.error or "模型调用失败" in job.error else 409
        else:
            status = 202
        return JsonResponse(payload, status=status)
    except QuestionGenerationRequestError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=exc.status_code)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def questions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    queryset = (
        Question.objects.all()
        .select_related("knowledge_point__chapter", "owner", "source_resource")
        .prefetch_related("evidence_items__resource")
        .order_by("-created_at")
    )
    if _is_teacher_or_admin(request.user):
        queryset = queryset.filter(id__in=_teacher_question_queryset().values("id"))
    else:
        queryset = queryset.filter(owner=request.user, scope="personal", is_active=True)
    base_queryset = queryset
    status = str(request.GET.get("status") or "").strip()
    if status:
        queryset = queryset.filter(review_status=status)
    scope = str(request.GET.get("scope") or "").strip()
    if scope:
        queryset = queryset.filter(scope=scope)
    source_type = str(request.GET.get("sourceType") or "").strip()
    if source_type:
        queryset = queryset.filter(source_type=source_type)
    question_kind = str(request.GET.get("questionKind") or "").strip()
    if question_kind:
        queryset = queryset.filter(metadata__questionKind=question_kind)
    try:
        limit = max(1, min(int(request.GET.get("limit") or 50), 100))
    except ValueError:
        limit = 50
    rows = list(queryset[:limit])
    summary_queryset = base_queryset
    if scope:
        summary_queryset = summary_queryset.filter(scope=scope)
    if source_type:
        summary_queryset = summary_queryset.filter(source_type=source_type)
    if question_kind:
        summary_queryset = summary_queryset.filter(metadata__questionKind=question_kind)
    return JsonResponse({
        "success": True,
        "questions": [serialize_question_bank_item(question) for question in rows],
        "summary": {
            "count": summary_queryset.count(),
            "autoVerified": summary_queryset.filter(review_status=QuestionReviewStatus.AUTO_VERIFIED).count(),
            "approved": summary_queryset.filter(review_status=QuestionReviewStatus.APPROVED).count(),
            "rejected": summary_queryset.filter(review_status=QuestionReviewStatus.REJECTED).count(),
        },
    })


@require_http_methods(["POST"])
def review_question(request, question_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if not _is_teacher_or_admin(request.user):
        return JsonResponse({"success": False, "error": "只有教师或管理员可以审核题库"}, status=403)
    question = get_object_or_404(
        _teacher_question_queryset().select_related("knowledge_point__chapter", "source_resource").prefetch_related("evidence_items__resource"),
        id=question_id,
    )
    try:
        payload = _body(request)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    action = str(payload.get("action") or "").strip()
    reason = str(payload.get("reason") or "").strip()
    if action not in {"approve", "reject", "disable"}:
        return JsonResponse({"success": False, "error": "审核动作必须是 approve、reject 或 disable"}, status=400)
    if len(reason) > 500:
        return JsonResponse({"success": False, "error": "审核理由不能超过 500 个字符"}, status=400)
    _apply_question_review(question, action=action, reason=reason, reviewer=request.user)
    return JsonResponse({"success": True, "question": serialize_question_bank_item(question)})


@require_http_methods(["POST"])
def batch_review_questions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if not _is_teacher_or_admin(request.user):
        return JsonResponse({"success": False, "error": "只有教师或管理员可以审核题库"}, status=403)
    try:
        payload = _body(request)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)

    raw_ids = payload.get("questionIds")
    action = str(payload.get("action") or "").strip()
    reason = str(payload.get("reason") or "").strip()
    if action not in {"approve", "reject"}:
        return JsonResponse({"success": False, "error": "批量审核动作必须是 approve 或 reject"}, status=400)
    if not isinstance(raw_ids, list) or not raw_ids:
        return JsonResponse({"success": False, "error": "请至少选择一道待审核题目"}, status=400)
    if len(raw_ids) > 100:
        return JsonResponse({"success": False, "error": "单次最多审核 100 道题"}, status=400)
    if not reason:
        return JsonResponse({"success": False, "error": "请填写审核理由"}, status=400)
    if len(reason) > 500:
        return JsonResponse({"success": False, "error": "审核理由不能超过 500 个字符"}, status=400)

    valid_ids = []
    failures = []
    seen_ids = set()
    for raw_id in raw_ids:
        try:
            normalized_id = str(UUID(str(raw_id)))
        except (TypeError, ValueError, AttributeError):
            failures.append({"id": str(raw_id), "error": "题目 ID 无效"})
            continue
        if normalized_id in seen_ids:
            continue
        seen_ids.add(normalized_id)
        valid_ids.append(normalized_id)

    reviewed = []
    if valid_ids:
        with transaction.atomic():
            candidates = {
                str(question.id): question
                for question in _teacher_question_queryset()
                .select_for_update()
                .select_related("knowledge_point__chapter", "source_resource")
                .prefetch_related("evidence_items__resource")
                .filter(id__in=valid_ids)
            }
            for question_id in valid_ids:
                question = candidates.get(question_id)
                if question is None:
                    failures.append({"id": question_id, "error": "题目不存在或不在教师审核范围内"})
                    continue
                if question.review_status != QuestionReviewStatus.AUTO_VERIFIED:
                    failures.append({"id": question_id, "error": "题目已不处于待审核状态"})
                    continue
                reviewed.append(_apply_question_review(
                    question,
                    action=action,
                    reason=reason,
                    reviewer=request.user,
                ))

    return JsonResponse({
        "success": bool(reviewed),
        "action": action,
        "processedCount": len(reviewed),
        "failedCount": len(failures),
        "questions": [serialize_question_bank_item(question) for question in reviewed],
        "failures": failures,
        **({"error": "没有可审核的题目"} if not reviewed else {}),
    }, status=200 if reviewed else 409)
