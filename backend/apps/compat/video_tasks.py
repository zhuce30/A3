from __future__ import annotations

import uuid
from datetime import timedelta

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_provider_client import (
    VideoProviderNetworkError,
    poll_video_provider_task,
    submit_video_provider_task,
)


@shared_task(bind=True, name="compat.advance_video_generation_job", acks_late=True)
def advance_video_generation_job(self, job_id: str) -> dict:
    poll_existing_segment = False
    with transaction.atomic():
        job = VideoGenerationJob.objects.select_for_update().get(job_id=job_id)
        if job.status in {"succeeded", "partial", "failed"}:
            return {"jobId": job.job_id, "status": job.status}
        segment = job.segments.exclude(status__in=["succeeded", "failed"]).order_by("index").first()
        if segment is None:
            return _finalize_video_job(job)
        if not job.started_at:
            job.started_at = timezone.now()
        job.status = "running"
        job.stage = "generating"
        job.progress = _job_progress(job, segment.index)
        job.message = f"正在生成第 {segment.index}/{job.segments.count()} 段视频"
        job.celery_task_id = self.request.id or job.celery_task_id
        job.save(update_fields=["status", "stage", "progress", "message", "celery_task_id", "started_at", "updated_at"])
        if segment.provider_task_id:
            poll_existing_segment = True
        elif segment.status == "submitting":
            if timezone.now() - segment.updated_at < timedelta(minutes=1):
                advance_video_generation_job.apply_async(args=[job.job_id], countdown=30)
                return {"jobId": job.job_id, "segment": segment.index, "status": "submitting"}
            segment.status = "failed"
            segment.error_code = "submission_outcome_unknown"
            segment.error_message = "视频任务提交结果未知，请仅重试该片段。"
            segment.finished_at = timezone.now()
            segment.save(update_fields=["status", "error_code", "error_message", "finished_at", "updated_at"])
            advance_video_generation_job.delay(job.job_id)
            return {"jobId": job.job_id, "segment": segment.index, "status": "failed"}
        else:
            segment.status = "submitting"
            segment.submission_attempts += 1
            segment.celery_task_id = self.request.id or segment.celery_task_id
            segment.save(update_fields=["status", "submission_attempts", "celery_task_id", "updated_at"])

    if poll_existing_segment:
        _schedule_segment_poll(segment, countdown=5)
        return {"jobId": job.job_id, "segment": segment.index, "status": "polling"}

    try:
        provider_task_id = submit_video_provider_task(segment)
    except Exception as exc:
        with transaction.atomic():
            locked = VideoGenerationSegment.objects.select_for_update().get(id=segment.id)
            locked.status = "failed"
            locked.error_code = "submission_failed"
            locked.error_message = str(exc)[:1000]
            locked.finished_at = timezone.now()
            locked.save(update_fields=["status", "error_code", "error_message", "finished_at", "updated_at"])
        advance_video_generation_job.delay(job_id)
        return {"jobId": job_id, "segment": segment.index, "status": "failed"}

    with transaction.atomic():
        locked = VideoGenerationSegment.objects.select_for_update().get(id=segment.id)
        locked.provider_task_id = provider_task_id
        locked.status = "polling"
        locked.submitted_at = timezone.now()
        locked.error_code = ""
        locked.error_message = ""
        locked.save(update_fields=["provider_task_id", "status", "submitted_at", "error_code", "error_message", "updated_at"])
    locked.refresh_from_db()
    _schedule_segment_poll(locked, countdown=5)
    return {"jobId": job_id, "segment": segment.index, "status": "polling"}


@shared_task(bind=True, name="compat.poll_video_generation_segment", acks_late=True)
def poll_video_generation_segment(self, job_id: str, index: int) -> dict:
    segment = VideoGenerationSegment.objects.select_related("job").get(job__job_id=job_id, index=index)
    current_task_id = str(self.request.id or "")
    if current_task_id and segment.celery_task_id and current_task_id != segment.celery_task_id:
        return {"jobId": job_id, "segment": index, "status": "stale"}
    if segment.status in {"succeeded", "failed"}:
        return {"jobId": job_id, "segment": index, "status": segment.status}
    if not segment.provider_task_id:
        advance_video_generation_job.delay(job_id)
        return {"jobId": job_id, "segment": index, "status": "pending"}
    if segment.submitted_at and timezone.now() - segment.submitted_at > timedelta(hours=2):
        segment.status = "failed"
        segment.error_code = "provider_timeout"
        segment.error_message = "云端视频任务超过 2 小时仍未完成，可仅重试该片段。"
        segment.finished_at = timezone.now()
        segment.save(update_fields=["status", "error_code", "error_message", "finished_at", "updated_at"])
        advance_video_generation_job.delay(job_id)
        return {"jobId": job_id, "segment": index, "status": "failed"}
    try:
        result = poll_video_provider_task(segment.job.provider, segment.provider_task_id)
    except VideoProviderNetworkError:
        segment.network_retry_count += 1
        segment.last_polled_at = timezone.now()
        segment.save(update_fields=["network_retry_count", "last_polled_at", "updated_at"])
        _schedule_segment_poll(segment, countdown=10 if segment.network_retry_count == 1 else 30)
        return {"jobId": job_id, "segment": index, "status": "polling"}

    segment.poll_attempts += 1
    segment.last_polled_at = timezone.now()
    status = str(result.get("status") or "running")
    if status in {"queued", "running"}:
        segment.status = "polling"
        segment.save(update_fields=["status", "poll_attempts", "last_polled_at", "updated_at"])
        _schedule_segment_poll(segment, countdown=5)
        return {"jobId": job_id, "segment": index, "status": "polling"}
    if status == "succeeded":
        video = result.get("result") if isinstance(result.get("result"), dict) else {}
        segment.status = "succeeded"
        segment.video_url = str(video.get("url") or "")
        segment.duration = max(1, int(video.get("duration") or segment.duration))
        segment.width = max(0, int(video.get("width") or 0))
        segment.height = max(0, int(video.get("height") or 0))
        segment.error_code = ""
        segment.error_message = ""
        segment.finished_at = timezone.now()
        segment.save()
        advance_video_generation_job.delay(job_id)
        return {"jobId": job_id, "segment": index, "status": "succeeded"}
    if status == "failed" and segment.submission_attempts < 2:
        segment.status = "pending"
        segment.provider_task_id = ""
        segment.error_code = "provider_failed_retryable"
        segment.error_message = str(result.get("error") or "视频服务生成失败，正在自动重试")[:1000]
        segment.save(update_fields=["status", "provider_task_id", "poll_attempts", "last_polled_at", "error_code", "error_message", "updated_at"])
        advance_video_generation_job.delay(job_id)
        return {"jobId": job_id, "segment": index, "status": "retrying"}
    segment.status = "failed"
    segment.error_code = "provider_failed"
    segment.error_message = str(result.get("error") or "视频服务生成失败")[:1000]
    segment.finished_at = timezone.now()
    segment.save()
    advance_video_generation_job.delay(job_id)
    return {"jobId": job_id, "segment": index, "status": "failed"}


def _job_progress(job: VideoGenerationJob, current_index: int) -> int:
    total = max(1, job.segments.count())
    completed = job.segments.filter(status__in=["succeeded", "failed"]).count()
    return min(90, max(5, round((completed / total) * 85) + (5 if current_index else 0)))


def _schedule_segment_poll(segment: VideoGenerationSegment, *, countdown: int) -> str:
    task_id = uuid.uuid4().hex
    segment.celery_task_id = task_id
    segment.save(update_fields=["celery_task_id", "updated_at"])
    poll_video_generation_segment.apply_async(
        args=[segment.job.job_id, segment.index],
        countdown=countdown,
        task_id=task_id,
    )
    return task_id


def _finalize_video_job(job: VideoGenerationJob) -> dict:
    segments = list(job.segments.order_by("index"))
    succeeded_segments = [segment for segment in segments if segment.status == "succeeded" and segment.video_url]
    succeeded = len(succeeded_segments)
    total = len(segments)
    status = "succeeded" if total and succeeded == total else "partial" if succeeded else "failed"
    first_succeeded = succeeded_segments[0] if succeeded_segments else None
    error_reasons = list(dict.fromkeys(segment.error_message for segment in segments if segment.status == "failed" and segment.error_message))
    now = timezone.now()
    elapsed_ms = max(0, int((now - (job.started_at or job.created_at)).total_seconds() * 1000))
    artifact = {
        "schemaVersion": "a3.openmaic-video-artifact.v1",
        "type": "openmaic_video",
        "jobId": job.job_id,
        "status": status,
        "provider": job.provider,
        "resourceType": job.resource_type,
        "videoUrl": first_succeeded.video_url if first_succeeded else "",
        "duration": sum(segment.duration for segment in succeeded_segments),
        "width": first_succeeded.width if first_succeeded else 0,
        "height": first_succeeded.height if first_succeeded else 0,
        "segments": [
            {
                "index": segment.index,
                "title": segment.title,
                "status": segment.status,
                "videoUrl": segment.video_url,
                "duration": segment.duration,
                "width": segment.width,
                "height": segment.height,
                "degradedReason": segment.error_message,
            }
            for segment in segments
        ],
        "elapsedMs": elapsed_ms,
        "degradedReason": "" if status == "succeeded" else f"视频分段生成完成：{succeeded}/{total} 段成功" + (f"；原因：{'；'.join(error_reasons[:2])}" if error_reasons else ""),
        "createdAt": now.isoformat(),
    }
    from backend.apps.compat.resource_generation import record_openmaic_video_artifact

    persisted = record_openmaic_video_artifact(job.user, job.resource_pack_id, artifact)
    resource_pack = persisted.get("resourcePack") if isinstance(persisted, dict) else None
    if isinstance(resource_pack, dict):
        artifact["resourcePack"] = resource_pack
        job.trace_id = str(resource_pack.get("traceId") or job.trace_id or "")
    job.artifact = artifact
    job.status = status
    job.stage = "completed" if succeeded else "failed"
    job.progress = 100
    job.message = f"视频分段生成完成：{succeeded}/{total} 段成功"
    job.error_message = artifact["degradedReason"] if status != "succeeded" else ""
    job.finished_at = now
    job.save(update_fields=["artifact", "status", "stage", "progress", "message", "error_message", "trace_id", "finished_at", "updated_at"])
    return {"jobId": job.job_id, "status": job.status}
