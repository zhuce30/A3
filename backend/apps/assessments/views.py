from __future__ import annotations

import json

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
        queryset = queryset.exclude(scope="personal")
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
        Question.objects.select_related("knowledge_point__chapter", "source_resource").prefetch_related("evidence_items__resource"),
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
    metadata = question.metadata if isinstance(question.metadata, dict) else {}
    metadata.update({"reviewAction": action, "reviewReason": reason, "reviewerId": str(request.user.id)})
    if action == "approve":
        question.review_status = QuestionReviewStatus.APPROVED
        question.is_active = True
    elif action == "reject":
        question.review_status = QuestionReviewStatus.REJECTED
        question.is_active = False
    else:
        question.review_status = QuestionReviewStatus.DISABLED
        question.is_active = False
    question.metadata = metadata
    question.save(update_fields=["review_status", "is_active", "metadata"])
    return JsonResponse({"success": True, "question": serialize_question_bank_item(question)})
