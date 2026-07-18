from __future__ import annotations

import uuid
from typing import Any

from celery import current_app
from django.db import transaction

from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment


TERMINAL_VIDEO_JOB_STATUSES = {"succeeded", "partial", "failed"}


def _epoch_milliseconds(value) -> int | None:
    return int(value.timestamp() * 1000) if value else None


def dispatch_video_job(job: VideoGenerationJob) -> VideoGenerationJob:
    try:
        result = current_app.send_task("compat.advance_video_generation_job", args=[job.job_id])
        job.celery_task_id = result.id or job.celery_task_id
        job.save(update_fields=["celery_task_id", "updated_at"])
    except Exception as exc:
        job.message = "视频任务已保存，队列暂时不可用，将在恢复后继续。"
        job.error_message = str(exc)[:1000]
        job.save(update_fields=["message", "error_message", "updated_at"])
    return job


def create_video_job(user, pack_id: str, payload: dict) -> tuple[VideoGenerationJob, bool]:
    segments = payload.get("segments") if isinstance(payload.get("segments"), list) else []
    if not 1 <= len(segments) <= 6:
        raise ValueError("视频任务必须包含 1-6 个分段")
    job_id = str(payload.get("jobId") or f"a3_video_{uuid.uuid4().hex}").strip()
    if not job_id or len(job_id) > 120:
        raise ValueError("视频任务 ID 无效")
    with transaction.atomic():
        job, created = VideoGenerationJob.objects.get_or_create(
            job_id=job_id,
            defaults={
                "user": user,
                "resource_pack_id": pack_id,
                "resource_type": str(payload.get("resourceType") or "micro_video_script")[:40],
                "provider": str(payload.get("provider") or "seedance")[:40],
                "requested_duration": max(1, min(int(payload.get("duration") or 60), 60)),
                "aspect_ratio": str(payload.get("aspectRatio") or "16:9")[:16],
                "resolution": str(payload.get("resolution") or "1080p")[:16],
                "message": "视频任务已创建，等待云端生成",
            },
        )
        if job.user_id != user.id:
            raise ValueError("视频任务 ID 已被占用")
        if job.resource_pack_id != pack_id:
            raise ValueError("视频任务 ID 已关联其他资源包")
        if created:
            rows = []
            seen_indexes = set()
            for fallback_index, item in enumerate(segments, start=1):
                if not isinstance(item, dict):
                    raise ValueError("视频分段格式无效")
                index = int(item.get("index") or fallback_index)
                prompt = str(item.get("prompt") or "").strip()
                if index < 1 or index > 6 or index in seen_indexes or not prompt or len(prompt) > 12_000:
                    raise ValueError("视频分段序号或提示词无效")
                seen_indexes.add(index)
                rows.append(
                    VideoGenerationSegment(
                        job=job,
                        index=index,
                        title=str(item.get("title") or f"片段 {index}")[:120],
                        prompt=prompt,
                        duration=max(1, min(int(item.get("duration") or 10), 10)),
                        aspect_ratio=job.aspect_ratio,
                        resolution=job.resolution,
                    )
                )
            VideoGenerationSegment.objects.bulk_create(rows)
            transaction.on_commit(lambda: dispatch_video_job(job))
    return job, created


def retry_failed_video_segments(job: VideoGenerationJob) -> int:
    with transaction.atomic():
        locked = VideoGenerationJob.objects.select_for_update().get(id=job.id)
        failed = locked.segments.filter(status="failed")
        count = failed.count()
        if not count:
            raise ValueError("当前没有可重试的失败片段")
        failed.update(
            status="pending",
            provider_task_id="",
            celery_task_id="",
            submission_attempts=0,
            poll_attempts=0,
            network_retry_count=0,
            error_code="",
            error_message="",
            submitted_at=None,
            last_polled_at=None,
            finished_at=None,
        )
        locked.status = "queued"
        locked.stage = "retrying"
        locked.progress = max(0, locked.progress - 5)
        locked.message = f"正在重试 {count} 个失败片段，已成功片段保持不变"
        locked.error_message = ""
        locked.finished_at = None
        locked.retry_generation += 1
        locked.save()
        transaction.on_commit(lambda: dispatch_video_job(locked))
    return count


def serialize_video_job(job: VideoGenerationJob, *, include_segments: bool = True) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": job.job_id,
        "jobId": job.job_id,
        "type": "openmaic_video",
        "workflow": "openmaic_video",
        "status": job.status,
        "progress": job.progress,
        "stage": job.stage,
        "message": job.message,
        "done": job.status in TERMINAL_VIDEO_JOB_STATUSES,
        "resourcePackId": job.resource_pack_id,
        "resourceType": job.resource_type,
        "provider": job.provider,
        "traceId": job.trace_id,
        "artifact": job.artifact if isinstance(job.artifact, dict) else {},
        "error": job.error_message,
        "createdAt": _epoch_milliseconds(job.created_at),
        "startedAt": _epoch_milliseconds(job.started_at),
        "finishedAt": _epoch_milliseconds(job.finished_at),
        "updatedAt": _epoch_milliseconds(job.updated_at),
        "actionUrl": f"/a3/resources/{job.resource_pack_id}/video",
    }
    if include_segments:
        payload["segments"] = [
            {
                "index": segment.index,
                "title": segment.title,
                "status": segment.status,
                "duration": segment.duration,
                "videoUrl": segment.video_url,
                "width": segment.width,
                "height": segment.height,
                "errorCode": segment.error_code,
                "degradedReason": segment.error_message,
                "submissionAttempts": segment.submission_attempts,
                "pollAttempts": segment.poll_attempts,
                "updatedAt": _epoch_milliseconds(segment.updated_at),
            }
            for segment in job.segments.all()
        ]
    return payload
