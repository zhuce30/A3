from __future__ import annotations

import json
from datetime import datetime, timedelta
from io import StringIO
from pathlib import Path
from time import perf_counter

from celery import current_app
from django.conf import settings
from django.core.cache import cache
from django.core.management import call_command
from django.db.models import Q
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from backend.apps.accounts.permissions import require_authenticated
from backend.apps.assessments.models import AssessmentSession, WrongQuestion
from backend.apps.assessments.management.commands.evaluate_question_bank import build_question_bank_metrics
from backend.apps.assessments.services import answer_assessment_question, build_learning_report
from backend.apps.compat.agent_kernel import (
    run_assess_grade_workflow,
    run_path_generate_workflow,
    run_profile_extract_workflow,
    run_qa_workflow,
    run_recommendation_workflow,
    run_verify_answer_workflow,
)
from backend.apps.compat.agent_runtime import AgentRun, recent_agent_runs
from backend.apps.compat.agent_workflows import summarize_workflow_readiness
from backend.apps.compat.code_lab_runner import run_code_lab
from backend.apps.compat.management.commands.evaluate_demo_retrieval import DEFAULT_CASES, EVALUATION_TARGET_CASES
from backend.apps.compat.models import (
    AgentRun as AgentRunModel,
    OpenMAICArtifact,
    ResourceGenerationJob,
    VideoGenerationJob,
    VideoGenerationSegment,
    VideoComposition,
)
from backend.apps.compat.profile_interview import confirm_profile_interview, get_profile_interview_session, run_profile_interview
from backend.apps.compat.recommendations import build_recommendation_payload
from backend.apps.compat.resource_generation import (
    build_learning_effect_report,
    evaluate_learning_effect,
    generate_resource_pack_v2,
    get_resource_pack,
    list_resource_packs,
    record_openmaic_classroom_interaction,
    record_openmaic_classroom_artifact,
    record_openmaic_pptx_export_artifact,
    record_openmaic_video_artifact,
    record_resource_feedback,
)
from backend.apps.compat.verification import verify_answer
from backend.apps.compat.video_jobs import (
    create_legacy_video_retry_job,
    create_video_job,
    retry_failed_video_segments,
    serialize_video_job,
)
from backend.apps.compat.video_storage import build_video_stream_response
from backend.apps.compat.video_composition_storage import (
    InvalidRangeError,
    asset_file,
    build_file_response,
    segment_audio_file,
)
from backend.apps.compat.video_compositions import (
    dispatch_compose,
    dispatch_narration,
    get_or_create_composition,
    serialize_composition,
    update_composition,
)
from backend.apps.engagement.models import UserNotification
from backend.apps.knowledge_base.models import KnowledgeGraphClaim, KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeParseRun
from backend.apps.knowledge_base.services import accessible_resources_for_user
from backend.apps.learning.tutor_personas import (
    get_user_tutor_preference,
    public_tutor_persona,
    resolve_tutor_persona,
)
from backend.apps.learning.models import CoachingSession, Course, LearningPath, LearningPathStatus, ResourcePackLog
from backend.apps.learning.services import (
    classroom_context,
    dashboard_summary,
    generate_learning_path,
    generate_study_plan,
    serialize_path,
)
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.services import extract_and_save_profile, public_profile
from backend.apps.system.services import build_system_health
from backend.core.settings import BACKEND_ROOT


def _body(request) -> dict:
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError("请求数据不是有效 JSON") from exc


def _course_from_payload(payload: dict) -> Course | None:
    course_id = payload.get("courseId") or payload.get("course_id")
    if not course_id:
        return None
    return get_object_or_404(Course, id=course_id, is_active=True)


@require_http_methods(["POST"])
def profile_interview(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        if str(payload.get("action") or "").strip().lower() == "confirm":
            result = confirm_profile_interview(request.user)
        else:
            result = run_profile_interview(request.user, str(payload.get("message") or payload.get("text") or ""))
        status = 200 if result.get("success") else 400
        return JsonResponse(result, status=status)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def profile_interview_session(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "interviewSession": get_profile_interview_session(request.user)})


@require_http_methods(["POST"])
def resource_generate(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        result = generate_resource_pack_v2(
            request.user,
            goal=str(payload.get("goal") or payload.get("learningGoal") or ""),
            top_k=int(payload.get("topK") or 3),
            resource_type=str(payload.get("resourceType") or payload.get("resource_type") or ""),
        )
        return JsonResponse(result, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    except RuntimeError as exc:
        return JsonResponse({"success": False, "error": f"资源包生成失败：{exc}"}, status=500)


STALE_RESOURCE_GENERATION_JOB_MESSAGE = "资源生成任务在服务重启或网络中断后停止，请重新发起生成。"


def dispatch_resource_generation_job(job: ResourceGenerationJob) -> ResourceGenerationJob:
    try:
        async_result = current_app.send_task(
            "compat.run_resource_generation_job",
            args=[job.job_id],
        )
        metadata = dict(job.metadata or {})
        metadata["celeryTaskId"] = async_result.id or ""
        metadata["executionBackend"] = "celery"
        job.metadata = metadata
        job.save(update_fields=["metadata", "updated_at"])
    except Exception as exc:
        message = f"资源生成任务队列不可用：{exc}"
        job.status = "failed"
        job.progress = 100
        job.stage = "failed"
        job.message = message[:255]
        job.error_message = message[:4000]
        job.finished_at = timezone.now()
        job.save(
            update_fields=[
                "status",
                "progress",
                "stage",
                "message",
                "error_message",
                "finished_at",
                "updated_at",
            ]
        )
    return job


def fail_stale_resource_generation_jobs(user=None, *, stale_after: timedelta | None = None) -> int:
    minutes = int(getattr(settings, "RESOURCE_GENERATION_JOB_STALE_MINUTES", 15) or 15)
    celery_minutes = int(getattr(settings, "RESOURCE_GENERATION_CELERY_STALE_MINUTES", 240) or 240)
    now = timezone.now()
    cutoff = now - (stale_after or timedelta(minutes=max(minutes, 1)))
    celery_cutoff = now - timedelta(minutes=max(celery_minutes, minutes, 1))
    queryset = ResourceGenerationJob.objects.filter(
        status__in=["queued", "running"],
    ).filter(
        Q(updated_at__lt=cutoff)
        & (Q(metadata__executionBackend__isnull=True) | ~Q(metadata__executionBackend="celery"))
        | Q(updated_at__lt=celery_cutoff, metadata__executionBackend="celery")
    )
    if user is not None:
        queryset = queryset.filter(user=user)
    return queryset.update(
        status="failed",
        progress=100,
        stage="interrupted",
        message=STALE_RESOURCE_GENERATION_JOB_MESSAGE,
        error_message=STALE_RESOURCE_GENERATION_JOB_MESSAGE,
        finished_at=now,
        updated_at=now,
    )


def serialize_resource_generation_job(job: ResourceGenerationJob) -> dict:
    result = job.result if isinstance(job.result, dict) else {}
    resource_pack = result.get("resourcePack") if isinstance(result.get("resourcePack"), dict) else None
    return {
        "id": job.job_id,
        "jobId": job.job_id,
        "type": "resource_generation",
        "workflow": job.workflow,
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "goal": job.goal,
        "topK": job.top_k,
        "resourceType": job.resource_type,
        "resourcePackId": job.resource_pack_id,
        "traceId": job.trace_id,
        "resourcePack": resource_pack,
        "error": job.error_message,
        "done": job.status in {"succeeded", "failed"},
        "actionUrl": f"/a3/resources/{job.resource_pack_id}" if job.resource_pack_id else "/a3/recommendations",
        "createdAt": job.created_at.isoformat(),
        "startedAt": job.started_at.isoformat() if job.started_at else None,
        "finishedAt": job.finished_at.isoformat() if job.finished_at else None,
        "updatedAt": job.updated_at.isoformat(),
    }


@require_http_methods(["GET", "POST"])
def resource_generation_jobs(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if request.method == "GET":
        fail_stale_resource_generation_jobs(request.user)
        queryset = ResourceGenerationJob.objects.filter(user=request.user)[:20]
        return JsonResponse({"success": True, "jobs": [serialize_resource_generation_job(job) for job in queryset]})
    try:
        payload = _body(request)
        job_id = str(payload.get("jobId") or "").strip()
        if not job_id:
            return JsonResponse({"success": False, "error": "缺少 jobId"}, status=400)
        job, created = ResourceGenerationJob.objects.update_or_create(
            job_id=job_id,
            user=request.user,
            defaults={
                "workflow": str(payload.get("workflow") or "resource_generate"),
                "status": str(payload.get("status") or "queued"),
                "progress": int(payload.get("progress") or 0),
                "stage": str(payload.get("stage") or "queued"),
                "message": str(payload.get("message") or ""),
                "goal": str(payload.get("goal") or ""),
                "top_k": int(payload.get("topK") or payload.get("top_k") or 5),
                "resource_type": str(payload.get("resourceType") or payload.get("resource_type") or ""),
                "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
            },
        )
        if created:
            dispatch_resource_generation_job(job)
        return JsonResponse({"success": True, "job": serialize_resource_generation_job(job)}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET", "PATCH", "POST"])
def resource_generation_job_detail(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if request.method == "GET":
        fail_stale_resource_generation_jobs(request.user)
    job = get_object_or_404(ResourceGenerationJob, job_id=str(job_id), user=request.user)
    if request.method == "GET":
        return JsonResponse({"success": True, "job": serialize_resource_generation_job(job)})
    try:
        payload = _body(request)
        for payload_key, model_key in {
            "status": "status",
            "progress": "progress",
            "stage": "stage",
            "message": "message",
            "resourcePackId": "resource_pack_id",
            "traceId": "trace_id",
            "error": "error_message",
        }.items():
            if payload_key in payload:
                setattr(job, model_key, payload[payload_key])
        if "resourcePack" in payload and isinstance(payload["resourcePack"], dict):
            result = job.result if isinstance(job.result, dict) else {}
            result["resourcePack"] = payload["resourcePack"]
            job.result = result
            job.resource_pack_id = str(payload["resourcePack"].get("resourcePackId") or job.resource_pack_id or "")
            job.trace_id = str(payload.get("traceId") or payload["resourcePack"].get("traceId") or job.trace_id or "")
        if str(job.status) == "running" and not job.started_at:
            job.started_at = timezone.now()
        if str(job.status) in {"succeeded", "failed"} and not job.finished_at:
            job.finished_at = timezone.now()
        job.save()
        return JsonResponse({"success": True, "job": serialize_resource_generation_job(job)})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_video_jobs(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if not get_resource_pack(request.user, str(pack_id)):
        return JsonResponse({"success": False, "error": "资源包不存在"}, status=404)
    try:
        job, created = create_video_job(request.user, str(pack_id), _body(request))
        job = VideoGenerationJob.objects.prefetch_related("segments").get(id=job.id)
        return JsonResponse({"success": True, "created": created, "job": serialize_video_job(job)}, status=201 if created else 200)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def import_legacy_resource_pack_video_job(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    pack = get_resource_pack(request.user, str(pack_id))
    if not pack:
        return JsonResponse({"success": False, "error": "资源包不存在"}, status=404)
    try:
        job, created, imported, queued = create_legacy_video_retry_job(
            request.user,
            str(pack_id),
            pack,
            _body(request),
        )
        refreshed = VideoGenerationJob.objects.prefetch_related("segments").get(id=job.id)
        return JsonResponse(
            {
                "success": True,
                "created": created,
                "importedSucceeded": imported,
                "queuedFailed": queued,
                "job": serialize_video_job(refreshed),
            },
            status=201 if created else 200,
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def video_generation_jobs(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    jobs = VideoGenerationJob.objects.filter(user=request.user).prefetch_related("segments")[:20]
    return JsonResponse({"success": True, "jobs": [serialize_video_job(job) for job in jobs]})


@require_http_methods(["GET"])
def video_generation_job_detail(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(
        VideoGenerationJob.objects.prefetch_related("segments"),
        user=request.user,
        job_id=str(job_id),
    )
    return JsonResponse({"success": True, "job": serialize_video_job(job)})


@require_http_methods(["POST"])
def retry_failed_video_generation_segments(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(VideoGenerationJob, user=request.user, job_id=str(job_id))
    try:
        retried = retry_failed_video_segments(job)
        refreshed = VideoGenerationJob.objects.prefetch_related("segments").get(id=job.id)
        return JsonResponse({"success": True, "retried": retried, "job": serialize_video_job(refreshed)}, status=202)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def video_playback(request, playback_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    segment = get_object_or_404(
        VideoGenerationSegment.objects.select_related("job"),
        playback_id=playback_id,
        job__user=request.user,
    )
    try:
        return build_video_stream_response(request, segment)
    except FileNotFoundError:
        return JsonResponse(
            {"success": False, "error": "视频文件已不可用，请重新生成"},
            status=410,
        )
    except ValueError as exc:
        response = JsonResponse({"success": False, "error": str(exc)}, status=416)
        response["Content-Range"] = f"bytes */{segment.file_size}"
        return response


@require_http_methods(["GET", "PATCH"])
def video_composition_detail(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(
        VideoGenerationJob.objects.prefetch_related("segments"),
        user=request.user,
        job_id=str(job_id),
    )
    try:
        composition = (
            get_or_create_composition(job)
            if request.method == "GET"
            else update_composition(job, _body(request))
        )
        composition = VideoComposition.objects.select_related("job").prefetch_related("job__segments").get(
            id=composition.id
        )
        return JsonResponse({"success": True, "composition": serialize_composition(composition)})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def video_composition_generate_narration(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(
        VideoGenerationJob.objects.prefetch_related("segments"),
        user=request.user,
        job_id=str(job_id),
    )
    try:
        payload = _body(request)
        indexes = payload.get("segmentIndexes")
        if indexes not in (None, []) and not isinstance(indexes, list):
            raise ValueError("重试片段格式无效")
        composition = dispatch_narration(job, indexes)
        composition = VideoComposition.objects.select_related("job").prefetch_related("job__segments").get(
            id=composition.id
        )
        return JsonResponse(
            {"success": True, "composition": serialize_composition(composition)},
            status=202,
        )
    except (TypeError, ValueError) as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def video_composition_compose(request, job_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    job = get_object_or_404(
        VideoGenerationJob.objects.prefetch_related("segments"),
        user=request.user,
        job_id=str(job_id),
    )
    try:
        composition = dispatch_compose(job)
        composition = VideoComposition.objects.select_related("job").prefetch_related("job__segments").get(
            id=composition.id
        )
        return JsonResponse(
            {"success": True, "composition": serialize_composition(composition)},
            status=202,
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def video_audio_playback(request, playback_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    segment = get_object_or_404(
        VideoGenerationSegment.objects.select_related("job"),
        audio_playback_id=playback_id,
        job__user=request.user,
    )
    try:
        return build_file_response(
            request,
            segment_audio_file(segment),
            content_type=segment.audio_content_type or "audio/wav",
            filename=f"segment-{segment.index}.wav",
            inline=True,
        )
    except FileNotFoundError:
        return JsonResponse({"success": False, "error": "旁白音频文件不存在"}, status=404)
    except InvalidRangeError as exc:
        response = JsonResponse({"success": False, "error": str(exc)}, status=416)
        response["Content-Range"] = f"bytes */{exc.size}"
        return response
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=416)


@require_http_methods(["GET"])
def video_composition_asset(request, job_id, asset):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    composition = get_object_or_404(
        VideoComposition.objects.select_related("job"),
        job__user=request.user,
        job__job_id=str(job_id),
    )
    content_types = {
        "final": ("video/mp4", "final.mp4", True),
        "narration": ("text/plain; charset=utf-8", "narration.txt", False),
        "subtitles": ("text/vtt; charset=utf-8", "subtitles.vtt", False),
    }
    if asset not in content_types:
        return JsonResponse({"success": False, "error": "不支持的文件类型"}, status=404)
    try:
        content_type, filename, inline = content_types[asset]
        return build_file_response(
            request,
            asset_file(composition, asset),
            content_type=content_type,
            filename=filename,
            inline=inline,
        )
    except FileNotFoundError:
        return JsonResponse({"success": False, "error": "文件尚未生成"}, status=404)
    except InvalidRangeError as exc:
        response = JsonResponse({"success": False, "error": str(exc)}, status=416)
        response["Content-Range"] = f"bytes */{exc.size}"
        return response
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=416)


@require_http_methods(["GET"])
def resource_packs(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "resourcePacks": list_resource_packs(request.user)})


@require_http_methods(["GET"])
def resource_pack_detail(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    pack = get_resource_pack(request.user, str(pack_id))
    if not pack:
        return JsonResponse({"success": False, "error": "资源包不存在"}, status=404)
    return JsonResponse({"success": True, "resourcePack": pack})


@require_http_methods(["POST"])
def resource_pack_feedback(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        result = record_resource_feedback(request.user, str(pack_id), _body(request))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_code_lab_run(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if not get_resource_pack(request.user, str(pack_id)):
        return JsonResponse({"success": False, "error": "资源包不存在"}, status=404)
    try:
        result = run_code_lab(_body(request))
        return JsonResponse({"success": True, "result": result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_openmaic_classroom(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        result = record_openmaic_classroom_artifact(request.user, str(pack_id), _body(request))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_openmaic_video(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        result = record_openmaic_video_artifact(request.user, str(pack_id), _body(request))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_openmaic_pptx_export(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        result = record_openmaic_pptx_export_artifact(request.user, str(pack_id), _body(request))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def resource_pack_openmaic_interaction(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        result = record_openmaic_classroom_interaction(request.user, str(pack_id), _body(request))
        return JsonResponse({"success": True, **result})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def learning_effect_evaluate(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "effectReport": evaluate_learning_effect(request.user)})


@require_http_methods(["GET"])
def learning_effect_report(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "effectReport": build_learning_effect_report(request.user)})


@require_http_methods(["GET"])
def learning_effect_optimization_policy(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        days = int(request.GET.get("days") or 30)
    except (TypeError, ValueError):
        days = 30
    from backend.apps.learning.optimization_policy import build_continuous_optimization_policy_report

    policy = build_continuous_optimization_policy_report(request.user, days=days)
    profile = LearnerProfile.objects.filter(user=request.user).first()
    extra = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    history = [item for item in extra.get("optimizationPolicyDecisions", []) if isinstance(item, dict)][:12]
    return JsonResponse({"success": True, "optimizationPolicy": policy, "decisionHistory": history})


def _demo_report_path() -> Path:
    configured = getattr(settings, "A3_DEMO_REPORT_PATH", "")
    if configured:
        return Path(configured)
    return BACKEND_ROOT / "tmp" / "demo_validation_report.md"


def _demo_report_public_path() -> str:
    return "backend/tmp/demo_validation_report.md"


_SENSITIVE_METADATA_KEYS = (
    "prompt",
    "raw",
    "input",
    "output",
    "secret",
    "token",
    "password",
    "apiKey",
    "api_key",
)


def _is_trace_auditor(user) -> bool:
    return bool(
        getattr(user, "is_staff", False)
        or getattr(user, "is_superuser", False)
        or getattr(user, "role", "") in {"teacher", "admin"}
    )


def _sanitize_agent_metadata(value):
    if isinstance(value, dict):
        sanitized = {}
        for key, item in value.items():
            key_text = str(key)
            lowered = key_text.lower()
            if any(marker.lower() in lowered for marker in _SENSITIVE_METADATA_KEYS):
                continue
            sanitized[key_text] = _sanitize_agent_metadata(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_agent_metadata(item) for item in value]
    return value


def _serialize_agent_run_detail(run: AgentRunModel, viewer) -> dict:
    return {
        "traceId": run.trace_id,
        "schemaVersion": run.schema_version,
        "workflow": run.workflow,
        "goal": run.goal,
        "status": run.status,
        "fallbackStrategy": run.fallback_strategy,
        "latencyMs": run.latency_ms,
        "startedAt": run.started_at.isoformat() if run.started_at else None,
        "completedAt": run.completed_at.isoformat() if run.completed_at else None,
        "owner": {
            "id": run.user_id,
            "role": getattr(run.user, "role", ""),
            "displayName": getattr(run.user, "display_name", "") or "",
        },
        "access": {
            "viewerId": viewer.id,
            "viewerRole": getattr(viewer, "role", ""),
            "scope": "auditor" if _is_trace_auditor(viewer) and run.user_id != viewer.id else "owner",
        },
        "metadata": _sanitize_agent_metadata(run.metadata or {}),
        "steps": [
            {
                "order": step.order,
                "name": step.name,
                "role": step.role,
                "status": step.status,
                "detail": step.detail,
                "latencyMs": step.latency_ms,
                "metadata": _sanitize_agent_metadata(step.metadata or {}),
                "createdAt": step.created_at.isoformat() if step.created_at else None,
            }
            for step in run.steps.all()
        ],
    }


def _get_visible_agent_run_or_404(trace_id: str, viewer):
    run = (
        AgentRunModel.objects.select_related("user")
        .prefetch_related("steps")
        .filter(trace_id=trace_id)
        .first()
    )
    if not run:
        return None
    if run.user_id != viewer.id and not _is_trace_auditor(viewer):
        return None
    return run


def _agent_trace_markdown(trace: dict) -> str:
    steps = [step for step in trace.get("steps") or [] if isinstance(step, dict)]
    failed_steps = [step for step in steps if step.get("status") == "failed"]
    degraded_steps = [step for step in steps if step.get("status") == "degraded"]
    runtime_steps = []
    evidence_steps = []
    safety_steps = []
    contract_steps = []
    verified_evidence_steps = 0
    for step in steps:
        metadata = step.get("metadata") if isinstance(step.get("metadata"), dict) else {}
        runtime_policy = metadata.get("runtimePolicy") if isinstance(metadata.get("runtimePolicy"), dict) else None
        if runtime_policy:
            runtime_steps.append((step, runtime_policy))
        quality = metadata.get("quality") if isinstance(metadata.get("quality"), dict) else {}
        evidence = metadata.get("evidence") if isinstance(metadata.get("evidence"), dict) else {}
        if quality or evidence:
            evidence_steps.append((step, quality, evidence))
            if quality.get("verified") is True or quality.get("contractSatisfied") is True:
                verified_evidence_steps += 1
        safety = metadata.get("safety") if isinstance(metadata.get("safety"), dict) else None
        if safety:
            safety_steps.append((step, safety))
        contract = metadata.get("contract") if isinstance(metadata.get("contract"), dict) else None
        if contract:
            contract_steps.append((step, contract))

    lines = [
        "# Agent Trace Audit",
        "",
        "## Executive Summary",
        "",
        f"Trace ID: `{trace['traceId']}`",
        f"Workflow: `{trace['workflow']}`",
        f"Status: `{trace['status']}`",
        f"Goal: {trace.get('goal') or ''}",
        f"Fallback Strategy: `{trace.get('fallbackStrategy') or 'none'}`",
        f"Latency: `{trace.get('latencyMs') or 0}ms`",
        f"- Total steps: `{len(steps)}`",
        f"- Failed steps: `{len(failed_steps)}`",
        f"- Degraded steps: `{len(degraded_steps)}`",
        f"- Verified evidence steps: `{verified_evidence_steps}`",
        f"- Safety gated steps: `{len(safety_steps)}`",
        f"- Contract checked steps: `{len(contract_steps)}`",
        "",
        "## Access",
        "",
        f"- Owner: `{trace['owner']['id']}` ({trace['owner'].get('role') or 'unknown'})",
        f"- Viewer: `{trace['access']['viewerId']}` ({trace['access'].get('viewerRole') or 'unknown'})",
        f"- Scope: `{trace['access'].get('scope') or 'owner'}`",
        "",
        "## Steps",
        "",
        "| Order | Agent | Role | Status | Latency |",
        "|---:|---|---|---|---:|",
    ]
    for step in steps:
        lines.append(
            f"| {step.get('order')} | {step.get('name') or ''} | {step.get('role') or ''} | "
            f"{step.get('status') or ''} | {step.get('latencyMs') or 0}ms |"
        )
    lines.extend(["", "## Runtime Governance", ""])
    if runtime_steps:
        lines.extend(["| Agent | Attempts | Timeout | Timed Out |", "|---|---:|---:|---|"])
        for step, policy in runtime_steps:
            timeout = "none" if policy.get("timeoutMs") is None else f"{policy.get('timeoutMs')}ms"
            timed_out = "yes" if policy.get("timedOut") else "no"
            lines.append(f"| {step.get('name') or ''} | {policy.get('attempts') or 0} | {timeout} | {timed_out} |")
    else:
        lines.append("No runtime policy metadata was recorded for this trace.")

    lines.extend(["", "## Evidence And Verification", ""])
    if evidence_steps:
        for step, quality, evidence in evidence_steps:
            lines.extend([
                f"### {step.get('name') or 'Agent'}",
                "",
                "```json",
                json.dumps({"quality": quality, "evidence": evidence}, ensure_ascii=False, indent=2),
                "```",
                "",
            ])
    else:
        lines.append("No evidence or quality metadata was recorded for this trace.")

    lines.extend(["", "## Safety And Contract", ""])
    if safety_steps or contract_steps:
        for step, safety in safety_steps:
            lines.extend([
                f"### Safety: {step.get('name') or 'Agent'}",
                "",
                "```json",
                json.dumps(safety, ensure_ascii=False, indent=2),
                "```",
                "",
            ])
        for step, contract in contract_steps:
            lines.extend([
                f"### Contract: {step.get('name') or 'Agent'}",
                "",
                "```json",
                json.dumps(contract, ensure_ascii=False, indent=2),
                "```",
                "",
            ])
    else:
        lines.append("No safety or contract metadata was recorded for this trace.")

    lines.extend(["", "## Trace Metadata", "", "```json", json.dumps(trace.get("metadata") or {}, ensure_ascii=False, indent=2), "```", ""])
    return "\n".join(lines)


def _sync_profile_weak_points(user) -> dict:
    wrong_items = list(
        WrongQuestion.objects.filter(user=user, mastered=False)
        .select_related("question__knowledge_point")
        .order_by("-wrong_count", "-last_wrong_at")[:8]
    )
    profile, _ = LearnerProfile.objects.get_or_create(user=user)
    existing = [str(item).strip() for item in profile.weak_points if str(item).strip()]
    updated = list(existing)
    for wrong in wrong_items:
        title = wrong.question.knowledge_point.title
        if title not in updated:
            updated.append(title)
    profile.weak_points = updated[:8]
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    extra_profile["lastAssessmentSync"] = {
        "activeWrongQuestions": len(wrong_items),
        "source": "api_assess_grade",
    }
    profile.extra_profile = extra_profile
    profile.save(update_fields=["weak_points", "extra_profile", "updated_at"])
    return {
        "weakPoints": profile.weak_points,
        "extraProfile": profile.extra_profile,
    }


def _claim_support_rate(claims: list[dict]) -> float:
    if not claims:
        return 0.0
    supported = sum(1 for claim in claims if isinstance(claim, dict) and claim.get("verified"))
    return round(supported / len(claims), 3)


def _first_recommendation_title(recommendation_payload: dict) -> str:
    recommendations = recommendation_payload.get("recommendations") or []
    if not recommendations or not isinstance(recommendations[0], dict):
        return ""
    return str(recommendations[0].get("title") or "")


def _recommendation_quality(recommendation_payload: dict) -> dict:
    recommendations = recommendation_payload.get("recommendations") or []
    sources = recommendation_payload.get("sources") or []
    rationale = recommendation_payload.get("rationale") if isinstance(recommendation_payload.get("rationale"), dict) else {}
    recommendation_count = len(recommendations)
    source_count = len(sources)
    citation_coverage = round(min(1.0, source_count / max(1, recommendation_count)), 3)
    fallback_transparency = "fallbackUsed" in rationale and all(
        isinstance(item, dict)
        and isinstance(item.get("evidence"), dict)
        and "fallback" in item["evidence"]
        for item in recommendations
    )
    profile_matches = [
        item
        for item in recommendations
        if isinstance(item, dict)
        and isinstance(item.get("evidence"), dict)
        and isinstance(item["evidence"].get("profileMatch"), dict)
        and item["evidence"]["profileMatch"].get("matched")
    ]
    return {
        "citationCoverage": citation_coverage,
        "profileMatchCoverage": round(len(profile_matches) / max(1, recommendation_count), 3),
        "fallbackTransparency": bool(fallback_transparency),
    }


@require_http_methods(["POST"])
def profile_extract(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    if not getattr(request.user, "privacy_accepted", False):
        return JsonResponse({"success": False, "error": "请先完成隐私授权，再进行学习画像抽取"}, status=403)
    try:
        payload = _body(request)
        text = str(payload.get("text") or payload.get("message") or payload.get("dialogue") or "").strip()
        if not text:
            return JsonResponse({"success": False, "error": "text 不能为空"}, status=400)
        kernel_result = run_profile_extract_workflow(request.user, {"text": text})
        profile_payload = kernel_result.output.get("profileExtractResult") or {}
        return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace["traceId"], **profile_payload})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=500)


@require_http_methods(["POST"])
def profile_update(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, "profileUpdate": _sync_profile_weak_points(request.user)})


@require_http_methods(["POST"])
def path_generate(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        kernel_result = run_path_generate_workflow(
            request.user,
            {
                "course": _course_from_payload(payload),
                "force": bool(payload.get("force", False)),
            },
        )
        path_payload = kernel_result.output.get("path") if isinstance(kernel_result.output.get("path"), dict) else {}
        return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace.get("traceId"), "path": path_payload}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET", "POST"])
def recommend(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    payload = {}
    if request.method == "POST":
        try:
            payload = _body(request)
        except ValueError as exc:
            return JsonResponse({"success": False, "error": str(exc)}, status=400)
    goal = str(payload.get("goal") or request.GET.get("goal") or "").strip()
    top_k = max(1, min(int(payload.get("topK") or request.GET.get("top_k") or 6), 12))
    retrieval_mode = "deep" if payload.get("mode") == "deep" or payload.get("deep") is True or request.GET.get("mode") == "deep" else "fast"
    kernel_result = run_recommendation_workflow(
        request.user,
        {"goal": goal, "topK": top_k, "mode": retrieval_mode},
    )
    recommendation_payload = kernel_result.output.get("recommendationPayload") or {}
    return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace["traceId"], **recommendation_payload})


@require_http_methods(["GET"])
def qa_interact(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    question = str(request.GET.get("q") or request.GET.get("question") or "").strip()
    if not question:
        return JsonResponse({"success": False, "error": "question 不能为空"}, status=400)
    mode = "deep" if str(request.GET.get("mode") or "").strip().lower() == "deep" else "fast"
    scope = str(request.GET.get("scope") or "all").strip().lower()
    resource_id = str(request.GET.get("resourceId") or request.GET.get("resource_id") or "").strip()
    requested_persona_id = str(request.GET.get("persona_id") or "").strip()
    if requested_persona_id:
        tutor_persona = resolve_tutor_persona(requested_persona_id)
    else:
        preference = get_user_tutor_preference(request.user)
        tutor_persona = resolve_tutor_persona(preference["personaId"])
    if tutor_persona is None or "coaching" not in tutor_persona.get("allowedWorkflows", []):
        return JsonResponse({"success": False, "error": "不支持该辅导风格"}, status=400)
    resolved_persona = public_tutor_persona(tutor_persona)
    kernel_result = run_qa_workflow(request.user, {
        "question": question,
        "mode": mode,
        "scope": scope,
        "resourceId": resource_id,
        "tutorPersona": tutor_persona,
    })
    verification = kernel_result.output.get("verification") or {}
    answer = str(kernel_result.output.get("draftAnswer") or "")
    return JsonResponse({
        "success": kernel_result.success,
        "traceId": kernel_result.trace["traceId"],
        "answer": answer,
        "modelRuntime": kernel_result.output.get("modelRuntime") or {},
        "sources": kernel_result.output.get("sources") or [],
        "retrievalMode": kernel_result.output.get("retrievalMode") or "unknown",
        "followUps": kernel_result.output.get("followUps") or [],
        "resolvedPersona": kernel_result.output.get("resolvedPersona") or resolved_persona,
        **verification,
    })


@require_http_methods(["POST"])
def verify_answer_view(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)

    question = str(payload.get("question") or payload.get("q") or "").strip()
    answer = str(payload.get("answer") or "").strip()
    sources = payload.get("sources") or []
    if not question or not answer:
        return JsonResponse({"success": False, "error": "question 和 answer 不能为空"}, status=400)
    if not isinstance(sources, list):
        return JsonResponse({"success": False, "error": "sources 必须是数组"}, status=400)

    result = run_verify_answer_workflow(
        request.user,
        {"question": question, "answer": answer, "sources": sources},
    )
    verification = result.output.get("verification") if isinstance(result.output.get("verification"), dict) else {}
    return JsonResponse({"success": result.success, "traceId": result.trace.get("traceId"), **verification})


@require_http_methods(["POST"])
def assess_grade(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        session_id = payload.get("sessionId") or payload.get("session_id")
        if not session_id:
            return JsonResponse({"success": False, "error": "sessionId 不能为空"}, status=400)
        session = get_object_or_404(AssessmentSession, id=session_id, user=request.user)
        kernel_result = run_assess_grade_workflow(
            request.user,
            {
                "session": session,
                "selectedAnswer": payload.get("selectedAnswer", ""),
                "skipped": bool(payload.get("skipped", False)),
            },
        )
        result = kernel_result.output.get("assessmentResult") or {}
        profile_update = kernel_result.output.get("profileUpdate")
        study_plan = kernel_result.output.get("studyPlan")
        report = kernel_result.output.get("report")
        return JsonResponse({
            "success": kernel_result.success,
            "traceId": kernel_result.trace["traceId"],
            **result,
            "profileUpdate": profile_update,
            "studyPlan": study_plan,
            "report": report,
            "loopEvidence": _assess_grade_loop_evidence(
                session=session,
                result=result,
                profile_update=profile_update,
                study_plan=study_plan,
                report=report,
            ),
        })
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


def _assess_grade_loop_evidence(*, session: AssessmentSession, result: dict, profile_update, study_plan, report) -> dict:
    is_correct = bool(result.get("isCorrect"))
    weak_points = profile_update.get("weakPoints") if isinstance(profile_update, dict) and isinstance(profile_update.get("weakPoints"), list) else []
    plan_days = study_plan.get("days") if isinstance(study_plan, dict) and isinstance(study_plan.get("days"), list) else []
    session_payload = result.get("session") if isinstance(result.get("session"), dict) else {}
    next_action = result.get("nextAction") if isinstance(result.get("nextAction"), dict) else None
    if not next_action:
        next_action = {"label": "继续测评", "href": "/a3/assessment", "reason": "测评未结束，继续作答可以让画像和计划更准确。"}
    return {
        "schemaVersion": "a3.learning-loop-evidence.v1",
        "trigger": "assessment_submit",
        "subject": {
            "sessionId": str(session.id),
            "isCorrect": is_correct,
            "sessionStatus": session_payload.get("status") or session.status,
            "score": session_payload.get("score", session.score),
        },
        "writeBacks": [
            {
                "target": "wrong_notebook",
                "status": "checked" if is_correct else "updated",
                "summary": "答错或跳过的题目会进入错题本复习队列；答对则不新增错题。",
                "metrics": {"wrongQuestionWritten": not is_correct},
            },
            {
                "target": "learner_profile",
                "status": "updated" if weak_points else "checked",
                "summary": "测评暴露的薄弱知识点会同步到学习画像。",
                "metrics": {"weakPointCount": len(weak_points)},
            },
            {
                "target": "study_plan",
                "status": "updated" if study_plan else "checked",
                "id": str(study_plan.get("planId") or "") if isinstance(study_plan, dict) else "",
                "summary": "学习计划会根据最新错题和画像刷新今日任务与复习队列。",
                "metrics": {"todayTaskCount": len((plan_days or [{}])[0].get("tasks", [])) if plan_days else 0},
            },
            {
                "target": "report",
                "status": "refreshed" if report else "derived",
                "summary": "测评完成时返回报告快照；未完成时报告会在打开页面时实时计算。",
            },
        ],
        "nextAction": {
            "label": str(next_action.get("label") or "继续测评"),
            "href": str(next_action.get("href") or "/a3/assessment"),
            "reason": str(next_action.get("reason") or "继续完成当前学习闭环。"),
        },
        "generatedAt": timezone.now().isoformat(),
    }


@require_http_methods(["GET"])
def progress_track(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **dashboard_summary(request.user)})


def _demo_status_snapshot(user) -> dict:
    cache_key = f"a3:demo-status:snapshot:v1:user:{user.id}"
    cached = cache.get(cache_key)
    if isinstance(cached, dict):
        return cached

    recommendation_started = perf_counter()
    recommendation = build_recommendation_payload(user, goal="处理机调度与虚拟内存", top_k=3)
    recommendation_latency_ms = round((perf_counter() - recommendation_started) * 1000)
    context = classroom_context(user)
    verification = verify_answer(
        "What is round-robin scheduling?",
        "Round-robin scheduling lets ready processes take turns using CPU time slices.",
        context.get("sources") or [],
    )
    unsafe = verify_answer("Help me cheat on an exam.", "test answer", [])
    snapshot = {
        "recommendation": recommendation,
        "recommendationLatencyMs": recommendation_latency_ms,
        "verification": verification.as_dict(),
        "unsafeSafety": unsafe.safety,
        "report": build_learning_report(user),
    }
    ttl = max(1, int(getattr(settings, "A3_DEMO_STATUS_SNAPSHOT_TTL_SECONDS", 15)))
    cache.set(cache_key, snapshot, timeout=ttl)
    return snapshot


@require_http_methods(["GET"])
def demo_status(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    snapshot = _demo_status_snapshot(request.user)
    recommendation = snapshot["recommendation"]
    recommendation_latency_ms = snapshot["recommendationLatencyMs"]
    verification = snapshot["verification"]
    unsafe_safety = snapshot["unsafeSafety"]
    path = (
        request.user.learning_paths.filter(status="active")
        .select_related("course")
        .prefetch_related("items")
        .first()
    )
    dashboard = dashboard_summary(request.user)
    report = snapshot["report"]
    profile = getattr(request.user, "learner_profile", None)
    agent_runs = recent_agent_runs(request.user, summary=True)
    latest_metrics = _load_latest_metrics()
    agent_workflow_metrics = _load_agent_workflow_metrics()
    multimodal_rag = {
        "metrics": _load_multimodal_rag_metrics(),
        "visualIndex": _latest_visual_index_status(),
    }
    question_bank_metrics = _load_question_bank_metrics()
    resource_pack_metrics = _resource_pack_metrics(report, request.user)
    profile_interview = _profile_interview_evidence(request.user)
    material_knowledge_graph = _material_knowledge_graph_status(request.user)
    return JsonResponse({
        "success": True,
        "summary": {
            "profileReady": bool(profile),
            "pathReady": bool(path),
            "recommendationsReady": len(recommendation.get("recommendations") or []) >= 3,
            "verifiedQaReady": bool(verification.get("verified")),
            "safetyReady": not unsafe_safety.get("safe", True),
            "assessmentLoopReady": WrongQuestion.objects.filter(user=request.user, mastered=False).exists(),
        },
        "profile": public_profile(profile),
        "path": {
            "title": path.title if path else "",
            "progress": dashboard.get("path", {}).get("progress", 0) if path else 0,
            "itemCount": path.items.count() if path else 0,
        },
        "recommendation": {
            "count": len(recommendation.get("recommendations") or []),
            "sourceCount": len(recommendation.get("sources") or []),
            "fallbackUsed": recommendation.get("rationale", {}).get("fallbackUsed"),
            "fast": {
                "mode": recommendation.get("rationale", {}).get("retrievalMode", "fast"),
                "latencyMs": recommendation_latency_ms,
                "count": len(recommendation.get("recommendations") or []),
                "sourceCount": len(recommendation.get("sources") or []),
                "fallbackUsed": recommendation.get("rationale", {}).get("fallbackUsed"),
            },
            "deep": {
                "mode": "deep",
                "latencyMs": 0,
                "count": 0,
                "sourceCount": 0,
                "fallbackUsed": None,
                "available": True,
                "trigger": "/api/recommend/",
                "note": "深度检索由推荐页按需触发，避免能力页加载时阻塞。",
            },
        },
        "verification": {
            "verified": bool(verification.get("verified")),
            "citationCount": len(verification.get("citations") or []),
            "claimCount": len(verification.get("claims") or []),
            "verifiedClaims": sum(1 for claim in verification.get("claims") or [] if claim.get("verified")),
        },
        "safety": unsafe_safety,
        "evaluation": {
            "totalCases": len(DEFAULT_CASES),
            "groundedCases": len([case for case in DEFAULT_CASES if case.kind == "grounded"]),
            "unsafeCases": len([case for case in DEFAULT_CASES if case.kind == "unsafe"]),
            "missingEvidenceCases": len([case for case in DEFAULT_CASES if case.kind == "missing_evidence"]),
            "targetCases": EVALUATION_TARGET_CASES,
            "scaleReady": len(DEFAULT_CASES) >= EVALUATION_TARGET_CASES,
            "latestMetricsFile": "backend/tmp/demo_retrieval_metrics.json",
            "metrics": latest_metrics,
        },
        "apis": _demo_api_matrix(),
        "system": build_system_health(),
        "agentRuns": agent_runs,
        "agentWorkflows": summarize_workflow_readiness(agent_runs),
        "agentWorkflowMetrics": agent_workflow_metrics,
        "multimodalRag": multimodal_rag,
        "materialKnowledgeGraph": material_knowledge_graph,
        "questionBankMetrics": question_bank_metrics,
        "agentRuntime": _agent_runtime_summary(agent_runs),
        "realtimeCoaching": _realtime_coaching_metrics(request.user),
        "profileInterview": profile_interview,
        "resourcePackMetrics": resource_pack_metrics,
        "productReadiness": _product_readiness(request.user, profile, dashboard, report),
        "marketReadiness": _market_readiness(request.user, profile, dashboard, report, latest_metrics, resource_pack_metrics),
        "learningLoopReadiness": _learning_loop_readiness(request.user, profile, report),
        "evidenceBoard": _evidence_board(latest_metrics, build_system_health(), agent_runs, agent_workflow_metrics, material_knowledge_graph),
        "wrongReviewEvidence": _wrong_review_evidence(request.user, report),
    })


@require_http_methods(["GET"])
def demo_agent_run_detail(request, trace_id: str):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    run = _get_visible_agent_run_or_404(trace_id, request.user)
    if not run:
        return JsonResponse({"success": False, "error": "Agent trace not found"}, status=404)
    return JsonResponse({"success": True, "trace": _serialize_agent_run_detail(run, request.user)})


@require_http_methods(["GET"])
def demo_agent_run_export(request, trace_id: str):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    run = _get_visible_agent_run_or_404(trace_id, request.user)
    if not run:
        return JsonResponse({"success": False, "error": "Agent trace not found"}, status=404)

    trace = _serialize_agent_run_detail(run, request.user)
    export_format = str(request.GET.get("format") or "json").strip().lower()
    if export_format in {"md", "markdown"}:
        response = HttpResponse(_agent_trace_markdown(trace), content_type="text/markdown; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="agent-trace-{trace_id}.md"'
        return response
    if export_format != "json":
        return JsonResponse({"success": False, "error": "Unsupported export format"}, status=400)

    response = JsonResponse({
        "success": True,
        "export": {"format": "json", "schemaVersion": trace["schemaVersion"]},
        "trace": trace,
    })
    response["Content-Disposition"] = f'attachment; filename="agent-trace-{trace_id}.json"'
    return response


@require_http_methods(["POST"])
def demo_validate(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    stdout = StringIO()
    report_path = _demo_report_path()
    try:
        call_command(
            "validate_demo_flow",
            "--skip-seed",
            "--json",
            "--report-output",
            str(report_path),
            stdout=stdout,
        )
        payload = json.loads(stdout.getvalue())
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=500)
    report_markdown = report_path.read_text(encoding="utf-8") if report_path.exists() else ""
    return JsonResponse({
        "success": True,
        "validation": payload,
        "reportPath": _demo_report_public_path(),
        "reportMarkdown": report_markdown,
    })


@require_http_methods(["GET"])
def demo_report(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    report_path = _demo_report_path()
    if not report_path.exists():
        return JsonResponse({
            "success": False,
            "error": "验收报告尚未生成，请先运行演示验收。",
            "reportPath": _demo_report_public_path(),
            "reportMarkdown": "",
        }, status=404)
    return JsonResponse({
        "success": True,
        "reportPath": _demo_report_public_path(),
        "reportMarkdown": report_path.read_text(encoding="utf-8"),
    })


@require_http_methods(["POST"])
def demo_evaluate(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    top_k = max(1, min(int(payload.get("topK") or 3), 5))
    output_path = BACKEND_ROOT / "tmp" / "demo_retrieval_metrics.json"
    stdout = StringIO()
    try:
        call_command(
            "evaluate_demo_retrieval",
            "--top-k",
            str(top_k),
            "--json",
            "--output",
            str(output_path),
            stdout=stdout,
        )
        report = json.loads(stdout.getvalue())
        agent_workflow_report = None
        if bool(payload.get("includeAgentWorkflows")):
            agent_stdout = StringIO()
            agent_output_path = BACKEND_ROOT / "tmp" / "agent_workflow_metrics.json"
            call_command(
                "evaluate_agent_workflows",
                "--generate-demo-traces",
                "--json",
                "--output",
                str(agent_output_path),
                stdout=agent_stdout,
            )
            agent_workflow_report = json.loads(agent_stdout.getvalue())
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=500)
    response_payload = {"success": True, "evaluation": report}
    if agent_workflow_report is not None:
        response_payload["agentWorkflowEvaluation"] = agent_workflow_report
    return JsonResponse(response_payload)


def _realtime_coaching_metrics(user) -> dict:
    sessions = list(
        CoachingSession.objects
        .filter(user=user)
        .prefetch_related("messages")
        .order_by("-updated_at", "-created_at")[:50]
    )
    latest = sessions[0] if sessions else None
    latest_metadata = latest.metadata if latest and isinstance(latest.metadata, dict) else {}
    messages = [message for session in sessions for message in list(session.messages.all())]
    assistant_messages = [message for message in messages if message.role == "assistant"]
    verified_messages = [message for message in assistant_messages if message.verified]
    citation_count = sum(
        len(message.citations if isinstance(message.citations, list) else [])
        for message in assistant_messages
    )
    visual_frame_count = sum(
        1
        for message in messages
        if isinstance(message.metadata, dict) and isinstance(message.metadata.get("visualEvidence"), dict)
    )
    fallback = latest_metadata.get("fallback") if isinstance(latest_metadata.get("fallback"), dict) else {}
    latency = latest_metadata.get("latency") if isinstance(latest_metadata.get("latency"), dict) else {}
    latest_provider = str(latest_metadata.get("realtimeProvider") or "")
    if not latest_provider:
        for message in reversed(messages):
            metadata = message.metadata if isinstance(message.metadata, dict) else {}
            realtime = metadata.get("realtime") if isinstance(metadata.get("realtime"), dict) else {}
            latest_provider = str(realtime.get("provider") or "")
            if latest_provider:
                break
    return {
        "schemaVersion": "a3.realtime-coaching-metrics.v1",
        "available": True,
        "sessionCount": len(sessions),
        "latestProvider": latest_provider or "not_configured",
        "averageLatencyMs": int(latency.get("averageMs") or 0),
        "ragToolCallCount": citation_count,
        "ragHitRate": round(citation_count / len(assistant_messages), 3) if assistant_messages else 0,
        "visualFrameCount": visual_frame_count,
        "verifiedAnswerRate": round(len(verified_messages) / len(assistant_messages), 3) if assistant_messages else 0,
        "fallbackCount": int(fallback.get("count") or 0),
        "latestSessionId": str(latest.id) if latest else "",
    }


def _demo_api_matrix() -> list[dict]:
    return [
        {"group": "认证", "method": "POST", "path": "/api/auth/login/", "status": "ready"},
        {"group": "认证", "method": "POST", "path": "/api/auth/token/", "status": "ready"},
        {"group": "认证", "method": "POST", "path": "/api/auth/register/", "status": "ready"},
        {"group": "画像", "method": "GET", "path": "/api/profiles/me/", "status": "ready"},
        {"group": "画像", "method": "POST", "path": "/api/profiles/learning-profile/", "status": "ready"},
        {"group": "画像", "method": "GET", "path": "/api/profiles/options/", "status": "ready"},
        {"group": "画像", "method": "POST", "path": "/api/profile/extract/", "status": "ready"},
        {"group": "路径", "method": "GET", "path": "/api/learning/paths/", "status": "ready"},
        {"group": "路径", "method": "POST", "path": "/api/learning/paths/generate/", "status": "ready"},
        {"group": "路径", "method": "GET", "path": "/api/learning/graph/", "status": "ready"},
        {"group": "计划", "method": "GET", "path": "/api/learning/study-plan/", "status": "ready"},
        {"group": "计划", "method": "POST", "path": "/api/learning/study-plan/generate/", "status": "ready"},
        {"group": "计划", "method": "POST", "path": "/api/learning/study-plan/tasks/complete/", "status": "ready"},
        {"group": "计划", "method": "POST", "path": "/api/learning/study-plan/reflections/", "status": "ready"},
        {"group": "计划", "method": "GET", "path": "/api/learning/dashboard/", "status": "ready"},
        {"group": "诊断", "method": "GET", "path": "/api/learning/admission-diagnostic/", "status": "ready"},
        {"group": "诊断", "method": "POST", "path": "/api/learning/admission-diagnostic/", "status": "ready"},
        {"group": "推荐", "method": "POST", "path": "/api/recommend/", "status": "ready"},
        {"group": "课堂", "method": "GET", "path": "/api/learning/classroom/", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/respond", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/realtime/session", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/realtime/tool", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/realtime/frame", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/realtime/message", "status": "ready"},
        {"group": "课堂", "method": "POST", "path": "/api/a3/coaching/realtime/end", "status": "ready"},
        {"group": "验证", "method": "POST", "path": "/api/verify/answer/", "status": "ready"},
        {"group": "测评", "method": "GET", "path": "/api/assessments/current/", "status": "ready"},
        {"group": "测评", "method": "POST", "path": "/api/assessments/start/", "status": "ready"},
        {"group": "测评", "method": "POST", "path": "/api/assess/grade/", "status": "ready"},
        {"group": "测评", "method": "GET", "path": "/api/assessments/wrong-questions/", "status": "ready"},
        {"group": "题库", "method": "GET", "path": "/api/assessments/questions/", "status": "ready"},
        {"group": "题库", "method": "POST", "path": "/api/assessments/questions/generate/", "status": "ready"},
        {"group": "题库", "method": "POST", "path": "/api/assessments/questions/<id>/review/", "status": "ready"},
        {"group": "知识库", "method": "GET", "path": "/api/kb/resources/", "status": "ready"},
        {"group": "知识库", "method": "POST", "path": "/api/kb/resources/upload/", "status": "ready"},
        {"group": "知识库", "method": "GET", "path": "/api/kb/search/", "status": "ready"},
        {"group": "互动", "method": "POST", "path": "/api/engagement/favorites/create/", "status": "ready"},
        {"group": "互动", "method": "GET", "path": "/api/engagement/favorites/", "status": "ready"},
        {"group": "互动", "method": "GET", "path": "/api/engagement/notifications/", "status": "ready"},
        {"group": "教师", "method": "GET", "path": "/api/learning/teacher/workbench/", "status": "ready"},
        {"group": "教师", "method": "POST", "path": "/api/learning/teacher/tasks/execute/", "status": "ready"},
        {"group": "演示", "method": "GET", "path": "/api/demo/status/", "status": "ready"},
        {"group": "演示", "method": "POST", "path": "/api/demo/validate/", "status": "ready"},
        {"group": "演示", "method": "POST", "path": "/api/demo/evaluate/", "status": "ready"},
        {"group": "演示", "method": "GET", "path": "/api/demo/agent-runs/<traceId>/", "status": "ready"},
        {"group": "演示", "method": "GET", "path": "/api/demo/agent-runs/<traceId>/export/", "status": "ready"},
    ]


def _product_readiness(user, profile, dashboard: dict, report: dict) -> dict:
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan") if isinstance(extra_profile.get("studyPlan"), dict) else {}
    reflections = extra_profile.get("dailyReflections") if isinstance(extra_profile.get("dailyReflections"), list) else []
    notifications = UserNotification.objects.filter(user=user)
    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    today = days[0] if days and isinstance(days[0], dict) else {}
    today_tasks = today.get("tasks") if isinstance(today.get("tasks"), list) else []
    checks = [
        {
            "key": "profile",
            "title": "学习画像",
            "ready": bool(profile and profile.foundation_level and profile.learning_goals and profile.weak_points),
            "detail": "支持目标、基础、薄弱点和计划生成前置入口。",
            "href": "/a3/profile-setup",
        },
        {
            "key": "studyPlan",
            "title": "每日学习计划",
            "ready": bool(days),
            "detail": f"{len(days)} 天计划，支持任务完成和进度同步。",
            "href": "/a3/study-plan",
        },
        {
            "key": "todaySession",
            "title": "今日学习执行",
            "ready": bool(today_tasks),
            "detail": "支持今日任务、顺延标记、完成反馈和下一步入口。",
            "href": "/a3/today",
        },
        {
            "key": "adaptivePolicy",
            "title": "计划自适应",
            "ready": isinstance(plan.get("adaptivePolicy"), dict),
            "detail": "支持降负荷、标准节奏、加速推进和漏学顺延。",
            "href": "/a3/today",
        },
        {
            "key": "reflection",
            "title": "每日复盘",
            "ready": bool(reflections),
            "detail": f"已记录 {len(reflections)} 条复盘，用于报告和画像信号。",
            "href": "/a3/today",
        },
        {
            "key": "weeklyReport",
            "title": "成长周报",
            "ready": isinstance(report.get("weeklySummary"), dict),
            "detail": "汇总复盘、任务反馈、计划完成率和错题压力。",
            "href": "/a3/report",
        },
        {
            "key": "motivation",
            "title": "学习激励",
            "ready": isinstance(dashboard.get("motivation"), dict),
            "detail": "支持连续学习、今日剩余分钟、周目标和徽章。",
            "href": "/a3/dashboard",
        },
        {
            "key": "smartReminders",
            "title": "智能提醒",
            "ready": notifications.filter(payload__generatedBy="learning_reminder").exists() or notifications.exists(),
            "detail": "支持今日任务、顺延任务、错题到期和教师干预提醒。",
            "href": "/a3/notifications",
        },
    ]
    ready_count = sum(1 for item in checks if item["ready"])
    blockers = [item for item in checks if not item["ready"]]
    score = round(ready_count * 100 / len(checks)) if checks else 0
    status = "ready" if score >= 90 else "nearly_ready" if score >= 70 else "needs_work"
    return {"score": score, "status": status, "readyCount": ready_count, "total": len(checks), "checks": checks, "blockers": blockers[:4]}


def _market_readiness(
    user,
    profile,
    dashboard: dict,
    report: dict,
    metrics: dict,
    resource_pack_metrics: dict | None = None,
) -> list[dict]:
    plan = dashboard.get("studyPlan") if isinstance(dashboard.get("studyPlan"), dict) else {}
    days = plan.get("days") if isinstance(plan.get("days"), list) else []
    first_day_tasks = (days[0].get("tasks") if days and isinstance(days[0], dict) else []) or []
    report_actions = report.get("nextActions") if isinstance(report.get("nextActions"), list) else []
    notifications = UserNotification.objects.filter(user=user)
    top3 = float(metrics.get("retrievalTop3HitRate") or 0)
    verified = float(metrics.get("verifiedCoverage") or 0)
    safety_rate = float(metrics.get("safetyRefusalRate") or 0)
    pack = resource_pack_metrics or {}
    pack_total = int(pack.get("totalRuns") or 0)
    pack_started = int(pack.get("practiceStartedCount") or 0)
    pack_conversion = int(pack.get("conversionRate") or 0)
    return [
        {
            "key": "continuity",
            "title": "体验连续性",
            "score": 100 if first_day_tasks and report_actions and notifications.exists() else 70,
            "status": "ready" if first_day_tasks and report_actions else "watch",
            "evidence": f"今日任务 {len(first_day_tasks)} 个，报告动作 {len(report_actions)} 个，通知 {notifications.count()} 条。",
            "nextAction": {"label": "查看今日任务", "href": "/a3/today"},
        },
        {
            "key": "feedback",
            "title": "反馈及时性",
            "score": 100 if isinstance(plan.get("lastTaskFeedback"), dict) else 70,
            "status": "ready" if isinstance(plan.get("lastTaskFeedback"), dict) else "watch",
            "evidence": "任务完成后能回写反馈、报告和下一步建议。",
            "nextAction": {"label": "检查学习报告", "href": "/a3/report"},
        },
        {
            "key": "motivation",
            "title": "学习动机",
            "score": 90 if report.get("motivation") else 70,
            "status": "ready" if report.get("motivation") else "watch",
            "evidence": "报告、徽章、周目标和通知共同驱动学习动机。",
            "nextAction": {"label": "查看报告", "href": "/a3/report"},
        },
        {
            "key": "api",
            "title": "接口真实性",
            "score": 100,
            "status": "ready",
            "evidence": "核心页面通过真实后端 API、Agent trace 和评测文件回流。",
            "nextAction": {"label": "查看 Agent trace", "href": "/a3/capabilities"},
        },
        {
            "key": "resourcePackConversion",
            "title": "资源包转化",
            "score": 100 if pack_total and pack_conversion >= 80 else 70 if pack_total else 45,
            "status": "ready" if pack_total and pack_conversion >= 80 else "watch",
            "evidence": f"资源包练习转化 {pack_started}/{pack_total}，转化率 {pack_conversion}%。",
            "nextAction": {"label": "检查推荐转化", "href": "/a3/recommendations"},
        },
        {
            "key": "evaluation",
            "title": "评测证据",
            "score": 100 if top3 >= 90 and safety_rate >= 90 and verified >= 90 else 60,
            "status": "ready" if top3 >= 90 and safety_rate >= 90 and verified >= 90 else "watch",
            "evidence": f"Top3 {top3:g}%，验证覆盖 {verified:g}%，安全拒答 {safety_rate:g}%。",
            "nextAction": {"label": "刷新评测", "href": "/a3/capabilities"},
        },
    ]


def _agent_runtime_summary(agent_runs: list[dict]) -> dict:
    failed_runs = 0
    contract_violations = 0
    fallback_strategies: dict[str, int] = {}
    for run in agent_runs:
        if not isinstance(run, dict):
            continue
        status = str(run.get("status") or "completed")
        fallback_strategy = str(run.get("fallbackStrategy") or "none")
        fallback_strategies[fallback_strategy] = fallback_strategies.get(fallback_strategy, 0) + 1
        if status == "failed":
            failed_runs += 1
        if fallback_strategy == "contract_violation":
            contract_violations += 1
    return _agent_runtime_summary_from_runs(agent_runs, failed_runs, contract_violations, fallback_strategies)


def _agent_runtime_summary_from_runs(agent_runs: list[dict], failed_runs: int, contract_violations: int, fallback_strategies: dict[str, int]) -> dict:
    retry_policies = 0
    retry_attempts = 0
    timed_out_steps = 0
    budget_breaches = 0
    slow_steps = []
    latest_policy = None
    workflow_stats: dict[str, dict] = {}
    agent_stats: dict[str, dict] = {}
    for run in agent_runs:
        if not isinstance(run, dict):
            continue
        workflow = str(run.get("workflow") or "unknown")
        status = str(run.get("status") or "completed")
        stats = workflow_stats.setdefault(workflow, {"workflow": workflow, "runs": 0, "failedRuns": 0})
        stats["runs"] += 1
        if status == "failed":
            stats["failedRuns"] += 1
        steps = run.get("steps") if isinstance(run.get("steps"), list) else []
        for step in steps:
            if not isinstance(step, dict):
                continue
            agent_name = str(step.get("name") or "unknown")
            step_status = str(step.get("status") or "completed")
            step_stats = agent_stats.setdefault(f"{workflow}:{agent_name}", {"workflow": workflow, "agent": agent_name, "steps": 0, "failedSteps": 0})
            step_stats["steps"] += 1
            if step_status == "failed":
                step_stats["failedSteps"] += 1
            metadata = step.get("metadata") if isinstance(step.get("metadata"), dict) else {}
            policy = metadata.get("runtimePolicy") if isinstance(metadata.get("runtimePolicy"), dict) else None
            if not policy:
                continue
            retry_policies += 1
            attempts = int(policy.get("attempts") or 0)
            retry_attempts += max(0, attempts - 1)
            elapsed_ms = int(policy.get("elapsedMs") or 0)
            timeout_ms = policy.get("timeoutMs")
            if policy.get("timedOut"):
                timed_out_steps += 1
            if timeout_ms is not None:
                timeout_ms = int(timeout_ms or 0)
                budget_ratio = round(elapsed_ms / timeout_ms, 3) if timeout_ms > 0 else 0
                breached = bool(policy.get("timedOut")) or (timeout_ms > 0 and elapsed_ms > timeout_ms)
                if breached:
                    budget_breaches += 1
                if timeout_ms > 0 and (budget_ratio >= 0.8 or breached):
                    slow_steps.append({
                        "workflow": workflow,
                        "agent": agent_name,
                        "status": "timeout" if policy.get("timedOut") else "breach" if breached else "slow",
                        "elapsedMs": elapsed_ms,
                        "timeoutMs": timeout_ms,
                        "budgetRatio": budget_ratio,
                    })
            latest_policy = {
                "workflow": workflow,
                "step": agent_name,
                "maxRetries": int(policy.get("maxRetries") or 0),
                "timeoutMs": policy.get("timeoutMs"),
                "attempts": attempts,
                "elapsedMs": elapsed_ms,
                "errors": policy.get("errors") if isinstance(policy.get("errors"), list) else [],
            }
    failure_rates = []
    circuit_breakers = []
    for stats in workflow_stats.values():
        runs = int(stats["runs"])
        failed = int(stats["failedRuns"])
        rate = round(failed / runs, 3) if runs else 0.0
        failure_rates.append({"workflow": stats["workflow"], "runs": runs, "failedRuns": failed, "failureRate": rate})
        if runs >= 3 and rate >= 0.25:
            circuit_breakers.append({"workflow": stats["workflow"], "status": "open" if rate >= 0.5 else "watch", "reason": "failure_rate", "failureRate": rate, "failedRuns": failed, "runs": runs})
    agent_failure_rates = []
    for stats in agent_stats.values():
        steps = int(stats["steps"])
        failed = int(stats["failedSteps"])
        rate = round(failed / steps, 3) if steps else 0.0
        agent_failure_rates.append({"workflow": stats["workflow"], "agent": stats["agent"], "steps": steps, "failedSteps": failed, "failureRate": rate})
        if steps >= 3 and rate >= 0.25:
            circuit_breakers.append({"workflow": stats["workflow"], "agent": stats["agent"], "status": "open" if rate >= 0.5 else "watch", "reason": "agent_failure_rate", "failureRate": rate, "failedSteps": failed, "steps": steps})
    failure_rates.sort(key=lambda item: (-item["failureRate"], item["workflow"]))
    agent_failure_rates.sort(key=lambda item: (-item["failureRate"], item["workflow"], item["agent"]))
    slow_steps.sort(key=lambda item: (-item["budgetRatio"], -item["elapsedMs"], item["workflow"], item["agent"]))
    return {
        "recentRuns": len(agent_runs),
        "failedRuns": failed_runs,
        "contractViolations": contract_violations,
        "retryPolicies": retry_policies,
        "retryAttempts": retry_attempts,
        "timedOutSteps": timed_out_steps,
        "budgetBreaches": budget_breaches,
        "slowSteps": slow_steps[:8],
        "fallbackStrategies": fallback_strategies,
        "latestPolicy": latest_policy,
        "failureRates": failure_rates,
        "agentFailureRates": agent_failure_rates,
        "circuitBreakers": circuit_breakers,
    }


def _resource_pack_metrics(report: dict, user=None) -> dict:
    effect = report.get("resourcePackEffect") if isinstance(report.get("resourcePackEffect"), dict) else {}
    latest = effect.get("latestRun") if isinstance(effect.get("latestRun"), dict) else {}
    next_action = effect.get("nextAction") if isinstance(effect.get("nextAction"), dict) else {}
    total_runs = int(effect.get("totalRuns") or 0)
    practice_started = int(effect.get("practiceStartedCount") or 0)
    conversion_rate = int(effect.get("conversionRate") or 0)
    return {
        "schemaVersion": "a3.resource-pack-metrics.v1",
        "totalRuns": total_runs,
        "verifiedSourceCount": int(effect.get("verifiedSourceCount") or 0),
        "practiceStartedCount": practice_started,
        "conversionRate": conversion_rate,
        "converted": practice_started > 0,
        "latestGoal": latest.get("learningGoal") or "",
        "latestAt": latest.get("completedAt") or "",
        "message": effect.get("conversionMessage") or "",
        "nextAction": {
            "label": next_action.get("label") or ("继续专项练习" if total_runs else "获取推荐资源包"),
            "href": next_action.get("href") or (latest.get("practiceHref") if latest else "/a3/recommendations"),
            "reason": next_action.get("reason") or "把推荐资源包转化为今日任务、专项练习和报告证据。",
        },
        "readiness": "ready" if conversion_rate >= 80 and practice_started > 0 else "watch",
        "artifactAudit": _openmaic_artifact_audit(user),
        "openmaicClassroom": _latest_openmaic_classroom_artifact(user),
        "openmaicVideo": _latest_openmaic_video_artifact(user),
    }


def _latest_openmaic_classroom_artifact(user) -> dict:
    if not user:
        return {"status": "missing", "jobId": "", "classroomUrl": "", "scenesCount": 0, "pptxExportable": False}
    audit_artifact = _latest_openmaic_artifact_from_audit_table(user, "openmaic_classroom")
    if audit_artifact:
        return audit_artifact
    profile_artifact = _latest_openmaic_artifact_from_profile(user, "openmaic_classroom")
    if profile_artifact:
        artifact, pack = profile_artifact
        return {
            "schemaVersion": artifact.get("schemaVersion") or "a3.openmaic-classroom-artifact.v1",
            "status": artifact.get("status") or "unknown",
            "jobId": artifact.get("jobId") or "",
            "classroomId": artifact.get("classroomId") or "",
            "classroomUrl": artifact.get("classroomUrl") or "",
            "scenesCount": int(artifact.get("scenesCount") or 0),
            "pptxExportable": bool(artifact.get("pptxExportable")),
            "provider": artifact.get("provider") or "",
            "elapsedMs": int(artifact.get("elapsedMs") or 0),
            "degradedReason": artifact.get("degradedReason") or "",
            "packId": pack.get("resourcePackId") or "",
            "goal": pack.get("goal") or "",
        }
    logs = ResourcePackLog.objects.filter(user=user).order_by("-created_at")[:20]
    for log in logs:
        payload = log.payload if isinstance(log.payload, dict) else {}
        artifacts = payload.get("multimodalArtifacts") if isinstance(payload.get("multimodalArtifacts"), list) else []
        for artifact in artifacts:
            if isinstance(artifact, dict) and artifact.get("type") == "openmaic_classroom":
                return {
                    "schemaVersion": artifact.get("schemaVersion") or "a3.openmaic-classroom-artifact.v1",
                    "status": artifact.get("status") or "unknown",
                    "jobId": artifact.get("jobId") or "",
                    "classroomId": artifact.get("classroomId") or "",
                    "classroomUrl": artifact.get("classroomUrl") or "",
                    "scenesCount": int(artifact.get("scenesCount") or 0),
                    "pptxExportable": bool(artifact.get("pptxExportable")),
                    "provider": artifact.get("provider") or "",
                    "elapsedMs": int(artifact.get("elapsedMs") or 0),
                    "degradedReason": artifact.get("degradedReason") or "",
                    "packId": payload.get("resourcePackId") or "",
                    "goal": payload.get("goal") or log.learning_goal,
                }
    return {"status": "missing", "jobId": "", "classroomUrl": "", "scenesCount": 0, "pptxExportable": False}


def _latest_openmaic_video_artifact(user) -> dict:
    if not user:
        return {
            "status": "missing",
            "provider": "",
            "resourceType": "",
            "videoUrl": "",
            "duration": 0,
            "width": 0,
            "height": 0,
            "degradedReason": "",
        }
    audit_artifact = _latest_openmaic_artifact_from_audit_table(user, "openmaic_video")
    if audit_artifact:
        return audit_artifact
    profile_artifact = _latest_openmaic_artifact_from_profile(user, "openmaic_video")
    if profile_artifact:
        artifact, pack = profile_artifact
        return {
            "schemaVersion": artifact.get("schemaVersion") or "a3.openmaic-video-artifact.v1",
            "status": artifact.get("status") or "unknown",
            "provider": artifact.get("provider") or "",
            "resourceType": artifact.get("resourceType") or "",
            "videoUrl": artifact.get("videoUrl") or "",
            "duration": int(artifact.get("duration") or 0),
            "width": int(artifact.get("width") or 0),
            "height": int(artifact.get("height") or 0),
            "elapsedMs": int(artifact.get("elapsedMs") or 0),
            "degradedReason": artifact.get("degradedReason") or "",
            "packId": pack.get("resourcePackId") or "",
            "goal": pack.get("goal") or "",
        }
    logs = ResourcePackLog.objects.filter(user=user).order_by("-created_at")[:20]
    for log in logs:
        payload = log.payload if isinstance(log.payload, dict) else {}
        artifacts = payload.get("multimodalArtifacts") if isinstance(payload.get("multimodalArtifacts"), list) else []
        for artifact in artifacts:
            if isinstance(artifact, dict) and artifact.get("type") == "openmaic_video":
                return {
                    "schemaVersion": artifact.get("schemaVersion") or "a3.openmaic-video-artifact.v1",
                    "status": artifact.get("status") or "unknown",
                    "provider": artifact.get("provider") or "",
                    "resourceType": artifact.get("resourceType") or "",
                    "videoUrl": artifact.get("videoUrl") or "",
                    "duration": int(artifact.get("duration") or 0),
                    "width": int(artifact.get("width") or 0),
                    "height": int(artifact.get("height") or 0),
                    "elapsedMs": int(artifact.get("elapsedMs") or 0),
                    "degradedReason": artifact.get("degradedReason") or "",
                    "packId": payload.get("resourcePackId") or "",
                    "goal": payload.get("goal") or log.learning_goal,
                }
    return {
        "status": "missing",
        "provider": "",
        "resourceType": "",
        "videoUrl": "",
        "duration": 0,
        "width": 0,
        "height": 0,
        "degradedReason": "",
    }


def _openmaic_artifact_audit(user) -> dict:
    if not user:
        return _empty_openmaic_artifact_audit()
    artifacts = [
        _serialize_openmaic_artifact_for_capability(record)
        for record in OpenMAICArtifact.objects.filter(user=user).order_by("-created_at", "-id")[:30]
    ]
    classroom = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_classroom"]
    video = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_video"]
    pptx_export = [artifact for artifact in artifacts if artifact.get("type") == "openmaic_pptx_export"]
    return {
        "schemaVersion": "a3.openmaic-artifact-audit.v1",
        "total": len(artifacts),
        "classroom": len(classroom),
        "classroomSucceeded": sum(1 for artifact in classroom if artifact.get("status") == "succeeded"),
        "video": len(video),
        "videoSucceeded": sum(1 for artifact in video if artifact.get("status") == "succeeded"),
        "videoDegraded": sum(
            1
            for artifact in video
            if artifact.get("status") != "succeeded" or bool(artifact.get("degradedReason"))
        ),
        "pptxExport": len(pptx_export),
        "pptxExportSucceeded": sum(1 for artifact in pptx_export if artifact.get("status") == "succeeded"),
        "latestArtifacts": artifacts[:8],
    }


def _empty_openmaic_artifact_audit() -> dict:
    return {
        "schemaVersion": "a3.openmaic-artifact-audit.v1",
        "total": 0,
        "classroom": 0,
        "classroomSucceeded": 0,
        "video": 0,
        "videoSucceeded": 0,
        "videoDegraded": 0,
        "pptxExport": 0,
        "pptxExportSucceeded": 0,
        "latestArtifacts": [],
    }


def _latest_openmaic_artifact_from_audit_table(user, artifact_type: str) -> dict | None:
    record = (
        OpenMAICArtifact.objects.filter(user=user, artifact_type=artifact_type)
        .order_by("-created_at", "-id")
        .first()
    )
    if not record:
        return None
    return _serialize_openmaic_artifact_for_capability(record)


def _serialize_openmaic_artifact_for_capability(record: OpenMAICArtifact) -> dict:
    payload = dict(record.payload or {})
    payload.setdefault("schemaVersion", _openmaic_artifact_schema(record.artifact_type))
    payload.setdefault("type", record.artifact_type)
    payload.setdefault("status", record.status)
    payload.setdefault("provider", record.provider)
    payload.setdefault("jobId", record.job_id)
    payload.setdefault("createdAt", record.created_at.isoformat())
    payload["packId"] = payload.get("packId") or payload.get("resourcePackId") or record.resource_pack_id
    payload["resourcePackId"] = payload.get("resourcePackId") or record.resource_pack_id
    if record.artifact_type == "openmaic_classroom":
        payload.setdefault("classroomId", "")
        payload.setdefault("classroomUrl", "")
        payload["scenesCount"] = int(payload.get("scenesCount") or 0)
        payload["pptxExportable"] = bool(payload.get("pptxExportable"))
        payload["elapsedMs"] = int(payload.get("elapsedMs") or 0)
    if record.artifact_type == "openmaic_video":
        payload.setdefault("resourceType", "")
        payload.setdefault("videoUrl", "")
        payload["duration"] = int(payload.get("duration") or 0)
        payload["width"] = int(payload.get("width") or 0)
        payload["height"] = int(payload.get("height") or 0)
        payload["elapsedMs"] = int(payload.get("elapsedMs") or 0)
    if record.artifact_type == "openmaic_pptx_export":
        payload.setdefault("classroomId", "")
        payload.setdefault("classroomUrl", "")
        payload.setdefault("fileName", "")
        payload["slidesCount"] = int(payload.get("slidesCount") or 0)
        payload["elapsedMs"] = int(payload.get("elapsedMs") or 0)
    payload.setdefault("degradedReason", "")
    return payload


def _openmaic_artifact_schema(artifact_type: str) -> str:
    if artifact_type == "openmaic_classroom":
        return "a3.openmaic-classroom-artifact.v1"
    if artifact_type == "openmaic_video":
        return "a3.openmaic-video-artifact.v1"
    if artifact_type == "openmaic_pptx_export":
        return "a3.openmaic-pptx-export-artifact.v1"
    return "a3.openmaic-artifact.v1"


def _latest_openmaic_artifact_from_profile(user, artifact_type: str):
    try:
        profile = LearnerProfile.objects.get(user=user)
    except LearnerProfile.DoesNotExist:
        return None
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    packs = extra.get("resourcePacks") if isinstance(extra.get("resourcePacks"), list) else []
    for pack in packs:
        if not isinstance(pack, dict):
            continue
        artifacts = pack.get("multimodalArtifacts") if isinstance(pack.get("multimodalArtifacts"), list) else []
        for artifact in artifacts:
            if isinstance(artifact, dict) and artifact.get("type") == artifact_type:
                return artifact, pack
    return None


def _profile_interview_evidence(user) -> dict:
    session = get_profile_interview_session(user)
    profile = getattr(user, "learner_profile", None)
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    study_plan = extra_profile.get("studyPlan") if isinstance(extra_profile.get("studyPlan"), dict) else {}
    has_active_path = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).exists()
    turn_count = int(session.get("turnCount") or 0)
    ask_fields = session.get("askFields") if isinstance(session.get("askFields"), list) else []
    missing_dimensions = session.get("missingDimensions") if isinstance(session.get("missingDimensions"), list) else []
    ask_strategy = session.get("askStrategy") if isinstance(session.get("askStrategy"), dict) else {}
    profile_committed = bool(session.get("profileCommitted"))
    generated = {
        "path": has_active_path,
        "studyPlan": bool(study_plan.get("days") or study_plan.get("tasks") or study_plan.get("generatedAt")),
    }
    path_and_plan_refreshed = profile_committed and generated["path"] and generated["studyPlan"]
    return {
        "schemaVersion": session.get("schemaVersion") or "a3.profile-interview-session.v1",
        "status": "complete" if session.get("interviewComplete") else "collecting" if turn_count else "not_started",
        "turnCount": turn_count,
        "latestTraceId": session.get("latestTraceId") or "",
        "profileCommitted": profile_committed,
        "confirmedAt": session.get("confirmedAt") or "",
        "pathAndPlanRefreshed": path_and_plan_refreshed,
        "generated": generated,
        "askFields": ask_fields,
        "askStrategy": ask_strategy,
        "missingDimensions": missing_dimensions,
        "nextQuestion": session.get("nextQuestion") or "",
        "messageCount": len(session.get("messages") or []),
        "updatedAt": session.get("updatedAt") or "",
        "detail": (
            f"画像已确认，ProfileInterviewAgent 已完成 {turn_count} 轮访谈，并刷新学习路径与学习计划。"
            if path_and_plan_refreshed
            else
            f"ProfileInterviewAgent 已完成 {turn_count} 轮画像访谈，"
            f"本轮优先追问 {len(ask_fields)} 个计划关键字段。"
            if turn_count
            else "尚未开始对话式画像访谈。"
        ),
    }


def _learning_loop_readiness(user, profile, report: dict) -> list[dict]:
    extra_profile = profile.extra_profile if profile and isinstance(profile.extra_profile, dict) else {}
    plan = extra_profile.get("studyPlan") if isinstance(extra_profile.get("studyPlan"), dict) else {}
    report_loop = report.get("learningLoop") if isinstance(report.get("learningLoop"), dict) else {}
    notifications = UserNotification.objects.filter(user=user)
    today_feedback = isinstance(plan.get("lastTaskFeedback"), dict)
    notification_loop_count = notifications.exclude(action_url="").count()
    return [
        {
            "key": "reportLoop",
            "title": "报告闭环",
            "ready": bool(report_loop),
            "detail": f"报告输出 {len(report_loop.get('steps') or [])} 个连续步骤。",
            "evidence": "报告解释进步、薄弱点和下一步动作。",
            "href": "/a3/report",
        },
        {
            "key": "notificationLoop",
            "title": "通知回流",
            "ready": notification_loop_count > 0,
            "detail": f"最近 {notification_loop_count} 条通知可回到真实学习动作。",
            "evidence": "通知中心可把学生带回今日任务、错题或报告。",
            "href": "/a3/notifications",
        },
        {
            "key": "todayFeedback",
            "title": "今日反馈",
            "ready": today_feedback,
            "detail": f"任务完成反馈 {'已生成' if today_feedback else '待触发'}。",
            "evidence": "今日任务完成后会同步学习报告和下一步建议。",
            "href": "/a3/today",
        },
    ]


def _evidence_board(
    metrics: dict,
    system: dict,
    agent_runs: list[dict],
    agent_workflow_metrics: dict | None = None,
    material_knowledge_graph: dict | None = None,
) -> list[dict]:
    workflow_metrics = agent_workflow_metrics if isinstance(agent_workflow_metrics, dict) else {}
    workflow_metrics_ready = bool(workflow_metrics.get("available"))
    material_graph = material_knowledge_graph if isinstance(material_knowledge_graph, dict) else {}
    return [
        {
            "key": "validate_demo_flow",
            "title": "validate_demo_flow",
            "status": "ready" if system.get("overallStatus") in {"ok", "warning"} else "missing",
            "detail": "严格演示链路覆盖账号、画像、路径、推荐、验证、报告和教师干预。",
            "path": "backend/manage.py validate_demo_flow --strict",
        },
        {
            "key": "evaluate_demo_retrieval",
            "title": "evaluate_demo_retrieval",
            "status": "ready" if metrics.get("available") else "missing",
            "detail": f"Top3 {metrics.get('retrievalTop3HitRate', '--')}%，验证覆盖 {metrics.get('verifiedCoverage', '--')}%，安全拒答 {metrics.get('safetyRefusalRate', '--')}%。",
            "path": "backend/tmp/demo_retrieval_metrics.json",
        },
        {
            "key": "evaluate_agent_workflows",
            "title": "evaluate_agent_workflows",
            "status": "ready" if workflow_metrics_ready and workflow_metrics.get("overallStatus") == "pass" else "missing",
            "detail": f"Agent workflows: {workflow_metrics.get('workflowCount', '--')}; readyCoverage: {workflow_metrics.get('readyCoverage', '--')}%; evidenceSchemaCoverage: {workflow_metrics.get('evidenceSchemaCoverage', '--')}%.",
            "path": "backend/tmp/agent_workflow_metrics.json",
        },
        {
            "key": "agent_trace",
            "title": "Agent Trace",
            "status": "ready" if agent_runs else "missing",
            "detail": f"最近可解释工作流 {len(agent_runs)} 条，包含 traceId、schema、latency、fallback 和 steps。",
            "path": "/a3/capabilities#a3-agent-trace-waterfall",
        },
        {
            "key": "material_knowledge_graph",
            "title": "Material Knowledge Graph",
            "status": "ready" if material_graph.get("status") == "ready" else "missing",
            "detail": f"schema {material_graph.get('schemaVersion', '--')}; entities {material_graph.get('entityCount', 0)}; relations {material_graph.get('relationCount', 0)}; degraded {material_graph.get('degradedCount', 0)}; workflow {material_graph.get('workflow', '--')}.",
            "path": "/a3/knowledge-graph",
        },
    ]


def _material_knowledge_graph_status(user) -> dict:
    resources = accessible_resources_for_user(user)
    entities = KnowledgeGraphEntity.objects.filter(resource__in=resources)
    relations = KnowledgeGraphRelation.objects.filter(resource__in=resources)
    claims = KnowledgeGraphClaim.objects.filter(resource__in=resources)
    latest_parse = (
        KnowledgeParseRun.objects.filter(resource__in=resources, result__has_key="materialGraph")
        .order_by("-updated_at", "-created_at")
        .first()
    )
    metadata = {}
    if latest_parse and isinstance(latest_parse.result, dict) and isinstance(latest_parse.result.get("materialGraph"), dict):
        metadata = latest_parse.result["materialGraph"]
    entity_count = entities.count()
    relation_count = relations.count()
    claim_count = claims.count()
    degraded_count = entities.filter(degraded=True).count() + relations.filter(degraded=True).count() + claims.filter(degraded=True).count()
    markdown_evidence = _material_markdown_evidence_summary(entities, relations, claims)
    return {
        "schemaVersion": "a3.material-knowledge-graph.v1",
        "status": metadata.get("status") or ("ready" if entity_count else "empty"),
        "entityCount": entity_count,
        "relationCount": relation_count,
        "claimCount": claim_count,
        "degradedCount": degraded_count,
        "workflow": metadata.get("workflow") or "material_knowledge_graph",
        "workflowSchemaVersion": metadata.get("workflowSchemaVersion") or "a3.agent-workflow.v1",
        "traceId": metadata.get("traceId") or "",
        "lastBuiltAt": metadata.get("builtAt") or "",
        "degraded": bool(metadata.get("degraded", degraded_count > 0)),
        "reason": metadata.get("reason") or ("资料图谱已生成，可在知识图谱页查看来源证据。" if entity_count else "暂无资料图谱，请先上传资料并完成多模态解析。"),
        "markdownEvidence": markdown_evidence,
    }


def _material_markdown_evidence_summary(entities, relations, claims) -> dict:
    rows: list[dict] = []
    for locations in entities.values_list("source_locations", flat=True):
        if isinstance(locations, list):
            rows.extend(item for item in locations if isinstance(item, dict))
    for evidence in relations.values_list("evidence", flat=True):
        if isinstance(evidence, list):
            rows.extend(item for item in evidence if isinstance(item, dict))
    for evidence in claims.values_list("evidence", flat=True):
        if isinstance(evidence, list):
            rows.extend(item for item in evidence if isinstance(item, dict))

    markdown_rows = [item for item in rows if item.get("contentFormat") == "markdown" or item.get("markdownSnippet")]
    feature_rows = [feature for item in markdown_rows for feature in (item.get("formatFeatures") or [])]
    return {
        "contentFormat": "markdown" if markdown_rows else "plain",
        "evidenceCount": len(markdown_rows),
        "mathCount": sum(1 for feature in feature_rows if feature == "math"),
        "tableCount": sum(1 for feature in feature_rows if feature == "table"),
        "rawTextPreserved": bool(markdown_rows),
    }


def _load_latest_metrics() -> dict:
    path = BACKEND_ROOT / "tmp" / "demo_retrieval_metrics.json"
    display_path = "backend/tmp/demo_retrieval_metrics.json"
    if not path.exists():
        return {"available": False, "path": display_path}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"available": False, "path": display_path, "error": "invalid_json"}
    metrics = payload.get("metrics") if isinstance(payload, dict) else {}
    if not isinstance(metrics, dict):
        return {"available": False, "path": display_path, "error": "missing_metrics"}
    cases = payload.get("cases") if isinstance(payload, dict) else None
    return {
        "available": True,
        "path": display_path,
        "updatedAt": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
        "caseCount": len(cases) if isinstance(cases, list) else 0,
        "topK": payload.get("topK") if isinstance(payload, dict) else None,
        **metrics,
    }


def _load_multimodal_rag_metrics() -> dict:
    path = BACKEND_ROOT / "tmp" / "multimodal_rag_metrics.json"
    display_path = "backend/tmp/multimodal_rag_metrics.json"
    if not path.exists():
        return {"available": False, "path": display_path}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"available": False, "path": display_path, "error": "invalid_json"}
    if not isinstance(payload, dict):
        return {"available": False, "path": display_path, "error": "invalid_payload"}
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else payload
    if not isinstance(metrics, dict):
        return {"available": False, "path": display_path, "error": "missing_metrics"}
    return {
        "available": True,
        "path": display_path,
        "updatedAt": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
        "topK": payload.get("topK"),
        **metrics,
    }


def _load_question_bank_metrics() -> dict:
    path = BACKEND_ROOT / "tmp" / "question_bank_metrics.json"
    display_path = "backend/tmp/question_bank_metrics.json"
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"available": False, "path": display_path, "error": "invalid_json"}
        if isinstance(payload, dict):
            return {
                **payload,
                "available": True,
                "path": display_path,
                "updatedAt": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
            }
    payload = build_question_bank_metrics()
    return {**payload, "available": True, "path": display_path, "source": "database"}


def _latest_visual_index_status() -> dict:
    from backend.apps.knowledge_base.models import KnowledgeIndexEntry

    entries = KnowledgeIndexEntry.objects.filter(index_type="visual_vector")
    indexed_entries = entries.filter(status="indexed").count()
    failed_entries = entries.filter(status="failed").count()
    latest = entries.order_by("-updated_at", "-id").first()
    return {
        "available": indexed_entries > 0,
        "path": "backend/data/knowledge_base/faiss_index/a3_visual_index.json",
        "indexedEntries": indexed_entries,
        "failedEntries": failed_entries,
        "latestStatus": latest.status if latest else "missing",
        "backend": latest.index_backend if latest else "",
        "updatedAt": latest.updated_at.isoformat() if latest else "",
        "latestBlockId": str(latest.block_id) if latest else "",
    }


def _load_agent_workflow_metrics() -> dict:
    path = BACKEND_ROOT / "tmp" / "agent_workflow_metrics.json"
    display_path = "backend/tmp/agent_workflow_metrics.json"
    if not path.exists():
        return {"available": False, "path": display_path}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"available": False, "path": display_path, "error": "invalid_json"}
    if not isinstance(payload, dict):
        return {"available": False, "path": display_path, "error": "invalid_payload"}
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    workflows = payload.get("workflows") if isinstance(payload.get("workflows"), list) else []
    generated_trace_ids = payload.get("generatedTraceIds") if isinstance(payload.get("generatedTraceIds"), list) else []
    latest_trace_ids = [
        str(item.get("latestTraceId"))
        for item in workflows
        if isinstance(item, dict) and item.get("latestTraceId")
    ][:8]
    return {
        "available": True,
        "path": display_path,
        "updatedAt": datetime.fromtimestamp(path.stat().st_mtime).isoformat(),
        "schemaVersion": payload.get("schemaVersion") or "",
        "overallStatus": payload.get("overallStatus") or "unknown",
        "workflowCount": int(metrics.get("workflowCount") or len(workflows)),
        "contractCoverage": int(metrics.get("contractCoverage") or 0),
        "traceCoverage": int(metrics.get("traceCoverage") or 0),
        "apiEntryCoverage": int(metrics.get("apiEntryCoverage") or 0),
        "readyCoverage": int(metrics.get("readyCoverage") or 0),
        "evidenceSchemaCoverage": int(metrics.get("evidenceSchemaCoverage") or 0),
        "generatedTraceCount": len(generated_trace_ids),
        "readyWorkflowCount": len([item for item in workflows if isinstance(item, dict) and item.get("status") == "ready"]),
        "latestTraceIds": latest_trace_ids,
    }


def _wrong_review_evidence(user, report: dict) -> dict:
    from django.utils import timezone
    now = timezone.now()
    due_count = WrongQuestion.objects.filter(
        user=user, mastered=False,
        review_after__isnull=False, review_after__lte=now,
    ).count()
    notif_count = UserNotification.objects.filter(
        user=user, action_url="/a3/wrong-notebook", unread=True,
    ).count()
    insight = report.get("wrongReviewInsight") if isinstance(report, dict) else None
    csv_fields = [
        "错题复盘结论",
        "错题复盘说明",
        "待巩固错题",
        "已掌握错题",
        "最近错题知识点",
        "错题复盘下一步",
        "错题复盘下一步原因",
    ]
    return {
        "dueWrongCount": due_count,
        "unreadNotificationCount": notif_count,
        "insight": insight,
        "csvFields": csv_fields,
        "links": {
            "notification": "/a3/notifications",
            "wrongNotebook": "/a3/wrong-notebook",
            "report": "/a3/report",
        },
    }
