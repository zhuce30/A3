from __future__ import annotations

import json

from django.db import DatabaseError
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.http import require_http_methods

from backend.apps.learning.algorithm_labs import AlgorithmLabCompletionConflict, complete_algorithm_lab, list_algorithm_labs
from backend.apps.learning.effect_events import aggregate_learning_events, ingest_learning_event_v2, ingest_learning_events_batch_v2, list_recent_learning_events, serialize_learning_event
from backend.apps.learning.report_summaries import create_learning_summary_document, get_learning_summary_document, list_learning_summary_documents
from backend.apps.learning.resource_attribution import build_resource_effect_attribution
from backend.apps.learning.models import Course, CourseEnrollment, LearningPath, LearningPathItem, LearningPathStatus
from backend.apps.accounts.permissions import require_teacher_role
from backend.apps.compat.agent_kernel import run_admission_diagnostic_workflow, run_path_generate_workflow, run_teacher_task_workflow
from backend.apps.learning.services import admission_diagnostic_blueprint, append_classroom_chat_messages, append_coaching_messages, assign_resource_pack_to_today, classroom_chat_history, classroom_context, clear_classroom_chat_messages, coaching_session, coaching_session_detail, complete_study_plan_task, course_materials, current_study_plan, dashboard_summary, end_coaching_session, generate_learning_path, generate_study_plan, knowledge_graph, list_coaching_sessions, serialize_course, serialize_path, submit_daily_reflection, summarize_coaching_session, teacher_workbench, update_path_item_progress
from backend.apps.learning.tutor_feedback import TutorFeedbackError, get_tutor_feedback, upsert_tutor_feedback
from backend.apps.learning.tutor_personas import TutorPersonaUnavailableError


def _require_login(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "请先登录"}, status=401)
    return None


def _body(request) -> dict:
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError("请求数据不是有效 JSON") from exc


@require_http_methods(["GET"])
def courses(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    data = [serialize_course(course, request.user) for course in Course.objects.filter(is_active=True)]
    return JsonResponse({"success": True, "courses": data})


@require_http_methods(["GET"])
def course_detail(request, course_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    course = get_object_or_404(Course.objects.prefetch_related("chapters__knowledge_points"), id=course_id, is_active=True)
    return JsonResponse({"success": True, "course": serialize_course(course, request.user, include_content=True)})


@require_http_methods(["GET"])
def course_materials_view(request, course_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    course = get_object_or_404(Course.objects.prefetch_related("chapters"), id=course_id, is_active=True)
    return JsonResponse({"success": True, "materials": course_materials(course, request.user)})


@require_http_methods(["POST"])
def enroll(request, course_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    course = get_object_or_404(Course, id=course_id, is_active=True)
    enrollment, created = CourseEnrollment.objects.get_or_create(user=request.user, course=course)
    return JsonResponse({"success": True, "created": created, "progress": enrollment.progress})


@require_http_methods(["GET"])
def current_path(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    queryset = LearningPath.objects.filter(user=request.user, status=LearningPathStatus.ACTIVE).select_related("course")
    course_id = str(request.GET.get("course_id", "")).strip()
    if course_id:
        queryset = queryset.filter(course_id=course_id)
    path = queryset.first()
    return JsonResponse({"success": True, "path": serialize_path(path) if path else None})


@require_http_methods(["POST"])
def generate_path(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        course_id = payload.get("courseId")
        course = get_object_or_404(Course, id=course_id, is_active=True) if course_id else None
        kernel_result = run_path_generate_workflow(
            request.user,
            {"course": course, "force": bool(payload.get("force", False))},
        )
        path_payload = kernel_result.output.get("path") if isinstance(kernel_result.output.get("path"), dict) else None
        return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace.get("traceId"), "path": path_payload}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["PATCH"])
def path_item_progress(request, item_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    item = get_object_or_404(LearningPathItem.objects.select_related("path__course"), id=item_id, path__user=request.user)
    try:
        path = update_path_item_progress(request.user, item, int(_body(request).get("progress", 0)))
        return JsonResponse({"success": True, "path": serialize_path(path)})
    except (TypeError, ValueError) as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def dashboard(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **dashboard_summary(request.user)})


@require_http_methods(["GET"])
def algorithm_labs(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse(
        {
            "success": True,
            **list_algorithm_labs(request.user),
        }
    )


@require_http_methods(["POST"])
def complete_algorithm_lab_view(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        result = complete_algorithm_lab(request.user, _body(request))
        status_code = 201 if result["status"] == "accepted" else 200
        return JsonResponse({"success": True, **result}, status=status_code)
    except AlgorithmLabCompletionConflict as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=409)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def recent_events(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        limit = int(request.GET.get("limit") or 100)
    except (TypeError, ValueError):
        limit = 100
    return JsonResponse({"success": True, "events": list_recent_learning_events(request.user, limit=limit)})


@require_http_methods(["POST"])
def ingest_event(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        result = ingest_learning_event_v2(request.user, _body(request))
        status_code = 201 if result["status"] == "accepted" else 200
        return JsonResponse(
            {
                "success": True,
                "schemaVersion": "a3.learning-event.v2",
                "status": result["status"],
                "event": serialize_learning_event(result["event"]),
            },
            status=status_code,
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    except DatabaseError as exc:
        return JsonResponse(
            {
                "success": True,
                "schemaVersion": "a3.learning-event.v2",
                "status": "degraded",
                "degraded": True,
                "degradedReason": str(exc)[:240],
            },
            status=202,
        )


@require_http_methods(["POST"])
def ingest_events_batch(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        result = ingest_learning_events_batch_v2(request.user, payload.get("events"))
        status_code = 207 if result["rejected"] else 201
        return JsonResponse({"success": True, **result}, status=status_code)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    except DatabaseError as exc:
        return JsonResponse(
            {
                "success": True,
                "schemaVersion": "a3.learning-event.v2",
                "accepted": 0,
                "duplicates": 0,
                "rejected": 0,
                "status": "degraded",
                "degraded": True,
                "degradedReason": str(exc)[:240],
                "results": [],
            },
            status=202,
        )


@require_http_methods(["GET"])
def events_summary(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        days = int(request.GET.get("days") or 30)
    except (TypeError, ValueError):
        days = 30
    return JsonResponse({"success": True, "summary": aggregate_learning_events(request.user, days=days)})


@require_http_methods(["GET"])
def resource_attribution(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        days = int(request.GET.get("days") or 30)
    except (TypeError, ValueError):
        days = 30
    return JsonResponse({"success": True, "attribution": build_resource_effect_attribution(request.user, days=days)})


@require_http_methods(["GET", "POST"])
def report_summaries(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if request.method == "GET":
        try:
            limit = int(request.GET.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20
        return JsonResponse({"success": True, "documents": list_learning_summary_documents(request.user, limit=limit)})
    try:
        payload = _body(request)
        document = create_learning_summary_document(request.user, prompt=str(payload.get("prompt") or ""))
        return JsonResponse(
            {
                "success": True,
                "document": document,
                "documents": list_learning_summary_documents(request.user, limit=20),
            },
            status=201,
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def report_summary_detail(request, document_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    document = get_learning_summary_document(request.user, document_id)
    if not document:
        return JsonResponse({"success": False, "error": "总结文档不存在"}, status=404)
    return JsonResponse({"success": True, "document": document})


@require_http_methods(["GET", "POST"])
def admission_diagnostic(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if request.method == "GET":
        return JsonResponse({"success": True, **admission_diagnostic_blueprint(request.user)})
    try:
        kernel_result = run_admission_diagnostic_workflow(request.user, _body(request))
        result = kernel_result.output.get("diagnosticResult") if isinstance(kernel_result.output.get("diagnosticResult"), dict) else {}
        return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace.get("traceId"), **result}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def study_plan(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    plan = current_study_plan(request.user)
    if plan is None or request.GET.get("auto") == "1":
        plan = generate_study_plan(request.user)
    return JsonResponse({"success": True, "plan": plan})


@require_http_methods(["POST"])
def generate_plan(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        plan = generate_study_plan(
            request.user,
            duration_days=int(payload.get("durationDays") or 14),
            force=bool(payload.get("force", True)),
        )
        return JsonResponse({"success": True, "plan": plan}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def complete_plan_task(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        result = complete_study_plan_task(
            request.user,
            day_index=int(payload.get("dayIndex") or 0),
            task_id=str(payload.get("taskId") or ""),
        )
        if isinstance(result, dict) and "plan" in result:
            return JsonResponse({"success": True, **result})
        return JsonResponse({"success": True, "plan": result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def assign_resource_pack(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        result = assign_resource_pack_to_today(request.user, payload.get("resourcePack"))
        return JsonResponse({"success": True, **result}, status=201 if result.get("created") else 200)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def daily_reflection(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        return JsonResponse({"success": True, **submit_daily_reflection(request.user, _body(request))}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def graph(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    course_id = str(request.GET.get("course_id", "")).strip()
    course = get_object_or_404(Course, id=course_id, is_active=True) if course_id else None
    return JsonResponse({"success": True, "graph": knowledge_graph(request.user, course=course)})


@require_http_methods(["GET"])
def classroom(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "classroom": classroom_context(request.user)})


@require_http_methods(["GET", "POST"])
def classroom_history(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if request.method == "GET":
        return JsonResponse({"success": True, **classroom_chat_history(request.user)})
    try:
        payload = _body(request)
        if payload.get("startNew") is True or payload.get("clear") is True:
            return JsonResponse({"success": True, **clear_classroom_chat_messages(request.user)})
        return JsonResponse({"success": True, **append_classroom_chat_messages(request.user, payload.get("messages"))}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET", "POST"])
def coaching_history(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if request.method == "GET":
        return JsonResponse({"success": True, **coaching_session(request.user)})
    try:
        payload = _body(request)
        return JsonResponse(
            {
                "success": True,
                **append_coaching_messages(
                    request.user,
                    payload.get("messages"),
                    summary=str(payload.get("summary") or ""),
                    tutor_persona_id=payload.get("tutorPersonaId", ""),
                ),
            },
            status=201,
        )
    except TutorPersonaUnavailableError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=503)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def coaching_sessions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        limit = int(request.GET.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    return JsonResponse({"success": True, **list_coaching_sessions(request.user, limit=limit)})


@require_http_methods(["GET"])
def coaching_session_by_id(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **coaching_session_detail(request.user, session_id)})


@require_http_methods(["POST"])
def coaching_session_summary(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse(
        {"success": True, **summarize_coaching_session(request.user, session_id)},
        status=201,
    )


@require_http_methods(["GET", "POST"])
def coaching_session_tutor_feedback(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        if request.method == "GET":
            return JsonResponse(
                {"success": True, "feedback": get_tutor_feedback(request.user, session_id)}
            )
        feedback, created = upsert_tutor_feedback(request.user, session_id, _body(request))
        return JsonResponse(
            {"success": True, "feedback": feedback},
            status=201 if created else 200,
        )
    except TutorFeedbackError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=exc.status_code)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def coaching_end(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **end_coaching_session(request.user)})


@require_http_methods(["GET"])
def teacher(request):
    rejected = require_teacher_role(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "workbench": teacher_workbench(request.user)})


@require_http_methods(["POST"])
def teacher_task_execute(request):
    rejected = require_teacher_role(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        kernel_result = run_teacher_task_workflow(
            request.user,
            {
                "type": str(payload.get("type", "")).strip(),
                "studentId": str(payload.get("studentId", "")).strip(),
                "message": str(payload.get("message", "")).strip(),
            },
        )
        result = kernel_result.output.get("teacherTaskResult") if isinstance(kernel_result.output.get("teacherTaskResult"), dict) else {}
        if not kernel_result.success:
            return JsonResponse(
                {
                    "success": False,
                    "traceId": kernel_result.trace.get("traceId"),
                    "error": str(kernel_result.output.get("error") or "教师任务执行失败"),
                    "result": result,
                },
                status=400,
            )
        return JsonResponse({"success": True, "traceId": kernel_result.trace.get("traceId"), "result": result}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
