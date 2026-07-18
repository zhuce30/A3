from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from celery import current_app
from django.db import transaction
from django.utils import timezone

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


def _normalize_video_segment_requests(value) -> list[dict[str, Any]]:
    segments = value if isinstance(value, list) else []
    if not 1 <= len(segments) <= 6:
        raise ValueError("视频任务必须包含 1-6 个分段")

    normalized = []
    seen_indexes = set()
    for fallback_index, item in enumerate(segments, start=1):
        if not isinstance(item, dict):
            raise ValueError("视频分段格式无效")
        raw_index = item.get("index")
        try:
            index = int(raw_index) if raw_index not in (None, "") else fallback_index
            duration = max(1, min(int(item.get("duration") or 10), 10))
        except (TypeError, ValueError) as exc:
            raise ValueError("视频分段序号或时长无效") from exc
        prompt = str(item.get("prompt") or "").strip()
        if index < 1 or index > 6 or index in seen_indexes or not prompt or len(prompt) > 12_000:
            raise ValueError("视频分段序号或提示词无效")
        seen_indexes.add(index)
        normalized.append(
            {
                "index": index,
                "title": str(item.get("title") or f"片段 {index}")[:120],
                "prompt": prompt,
                "duration": duration,
            }
        )
    return normalized


def eligible_legacy_video_artifact(pack: dict) -> dict | None:
    if not isinstance(pack, dict):
        return None
    artifacts = pack.get("multimodalArtifacts")
    if not isinstance(artifacts, list):
        return None

    for artifact in artifacts:
        if (
            not isinstance(artifact, dict)
            or artifact.get("type") != "openmaic_video"
            or artifact.get("jobId")
        ):
            continue
        segments = artifact.get("segments")
        if not isinstance(segments, list) or not segments:
            continue

        indexes = []
        has_succeeded = False
        has_failed = False
        valid = True
        for item in segments:
            if not isinstance(item, dict):
                valid = False
                break
            try:
                index = int(item.get("index"))
            except (TypeError, ValueError):
                valid = False
                break
            indexes.append(index)
            status = str(item.get("status") or "")
            if status == "succeeded" and str(item.get("videoUrl") or "").strip():
                has_succeeded = True
            elif status == "failed":
                has_failed = True
            else:
                valid = False
                break

        if (
            valid
            and has_succeeded
            and has_failed
            and len(indexes) == len(set(indexes))
            and all(1 <= index <= 6 for index in indexes)
        ):
            return artifact
    return None


def _legacy_video_job_id(user_id: int, pack_id: str, artifact: dict) -> str:
    canonical_segments = []
    for item in sorted(artifact.get("segments", []), key=lambda segment: int(segment.get("index") or 0)):
        video_url = str(item.get("videoUrl") or "")
        try:
            duration = int(item.get("duration") or 0)
            width = int(item.get("width") or 0)
            height = int(item.get("height") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("旧视频分段数据无效") from exc
        canonical_segments.append(
            {
                "index": int(item.get("index") or 0),
                "title": str(item.get("title") or ""),
                "status": str(item.get("status") or ""),
                "videoUrlHash": hashlib.sha256(video_url.encode("utf-8")).hexdigest(),
                "duration": duration,
                "width": width,
                "height": height,
            }
        )
    canonical = json.dumps(
        {
            "userId": user_id,
            "packId": pack_id,
            "createdAt": str(artifact.get("createdAt") or ""),
            "segments": canonical_segments,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:48]
    return f"a3_legacy_video_{fingerprint}"


def create_video_job(user, pack_id: str, payload: dict) -> tuple[VideoGenerationJob, bool]:
    segments = _normalize_video_segment_requests(payload.get("segments"))
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
            rows = [
                VideoGenerationSegment(
                    job=job,
                    index=item["index"],
                    title=item["title"],
                    prompt=item["prompt"],
                    duration=item["duration"],
                    aspect_ratio=job.aspect_ratio,
                    resolution=job.resolution,
                )
                for item in segments
            ]
            VideoGenerationSegment.objects.bulk_create(rows)
            transaction.on_commit(lambda: dispatch_video_job(job))
    return job, created


def create_legacy_video_retry_job(
    user,
    pack_id: str,
    pack: dict,
    payload: dict,
) -> tuple[VideoGenerationJob, bool, int, int]:
    if not isinstance(payload, dict):
        raise ValueError("视频任务请求格式无效")
    artifact = eligible_legacy_video_artifact(pack)
    if not artifact:
        raise ValueError("当前视频不需要旧任务迁移")

    requested = _normalize_video_segment_requests(payload.get("segments"))
    legacy = {int(item["index"]): item for item in artifact["segments"]}
    requested_by_index = {item["index"]: item for item in requested}
    if set(legacy) != set(requested_by_index):
        raise ValueError("视频分段与旧任务不匹配")

    imported = sum(
        1
        for item in legacy.values()
        if item.get("status") == "succeeded" and str(item.get("videoUrl") or "").strip()
    )
    queued = sum(1 for item in legacy.values() if item.get("status") == "failed")
    if not imported or not queued:
        raise ValueError("当前视频不需要旧任务迁移")

    job_id = _legacy_video_job_id(user.id, pack_id, artifact)
    now = timezone.now()
    try:
        requested_duration = max(1, min(int(payload.get("duration") or 60), 60))
    except (TypeError, ValueError) as exc:
        raise ValueError("视频任务时长无效") from exc

    with transaction.atomic():
        job, created = VideoGenerationJob.objects.get_or_create(
            job_id=job_id,
            defaults={
                "user": user,
                "resource_pack_id": pack_id,
                "resource_type": str(payload.get("resourceType") or "micro_video_script")[:40],
                "provider": str(payload.get("provider") or "seedance")[:40],
                "requested_duration": requested_duration,
                "aspect_ratio": str(payload.get("aspectRatio") or "16:9")[:16],
                "resolution": str(payload.get("resolution") or "1080p")[:16],
                "progress": min(85, round((imported / len(legacy)) * 85)),
                "message": f"已保留 {imported} 个成功片段，等待补生成 {queued} 个失败片段",
            },
        )
        if job.user_id != user.id or job.resource_pack_id != pack_id:
            raise ValueError("旧视频迁移任务归属不匹配")
        if created:
            rows = []
            for index in sorted(legacy):
                old = legacy[index]
                request_item = requested_by_index[index]
                succeeded = old.get("status") == "succeeded" and bool(
                    str(old.get("videoUrl") or "").strip()
                )
                try:
                    duration = (
                        int(old.get("duration") or request_item["duration"])
                        if succeeded
                        else request_item["duration"]
                    )
                    if duration < 1:
                        raise ValueError("duration must be positive")
                    width = max(0, int(old.get("width") or 0)) if succeeded else 0
                    height = max(0, int(old.get("height") or 0)) if succeeded else 0
                except (TypeError, ValueError) as exc:
                    raise ValueError("旧视频分段数据无效") from exc
                rows.append(
                    VideoGenerationSegment(
                        job=job,
                        index=index,
                        title=str(old.get("title") or request_item["title"])[:120],
                        prompt=request_item["prompt"],
                        duration=duration,
                        aspect_ratio=job.aspect_ratio,
                        resolution=job.resolution,
                        status="succeeded" if succeeded else "pending",
                        video_url=str(old.get("videoUrl") or "").strip() if succeeded else "",
                        width=width,
                        height=height,
                        finished_at=now if succeeded else None,
                    )
                )
            VideoGenerationSegment.objects.bulk_create(rows)
            transaction.on_commit(lambda: dispatch_video_job(job))
    return job, created, imported, queued


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
