from __future__ import annotations

import uuid
from typing import Any

from celery import current_app
from django.db import transaction

from backend.apps.compat.models import VideoComposition, VideoGenerationJob
from backend.apps.compat.video_director import estimate_narration_ms
from backend.apps.compat.video_jobs import _epoch_milliseconds, _serialize_video_segment


ALLOWED_VOICES = {"Cherry", "Serena", "Ethan", "Chelsie"}
ACTIVE_COMPOSITION_STATUSES = {"queued", "generating_narration", "composing"}


def get_or_create_composition(job: VideoGenerationJob) -> VideoComposition:
    composition, _ = VideoComposition.objects.get_or_create(job=job)
    return composition


def _locked_composition(job: VideoGenerationJob) -> VideoComposition:
    composition, created = VideoComposition.objects.get_or_create(job=job)
    if created:
        return composition
    return VideoComposition.objects.select_for_update().get(pk=composition.pk)


def _send_queued_task(
    composition_id: int,
    task_name: str,
    args: list[Any],
    task_id: str,
) -> None:
    try:
        current_app.send_task(
            task_name,
            args=args,
            queue="video-compose",
            task_id=task_id,
        )
    except Exception as exc:
        VideoComposition.objects.filter(
            pk=composition_id,
            status="queued",
            celery_task_id=task_id,
        ).update(
            status="failed",
            message="视频制作任务队列暂时不可用，请稍后重试",
            error_code="queue_unavailable",
            error_message=str(exc)[:4000],
        )
        raise ValueError("视频制作任务队列暂时不可用，请稍后重试") from exc


def _stage(stage_id: str, label: str, status: str, detail: str) -> dict[str, str]:
    return {"id": stage_id, "label": label, "status": status, "detail": detail}


def serialize_composition(composition: VideoComposition) -> dict[str, Any]:
    job = composition.job
    segments = list(job.segments.all())
    video_succeeded = sum(segment.status == "succeeded" and bool(segment.stored_path) for segment in segments)
    audio_succeeded = sum(
        segment.audio_status == "succeeded" and bool(segment.audio_path) for segment in segments
    )
    audio_failed = sum(segment.audio_status == "failed" for segment in segments)
    video_failed = sum(segment.status == "failed" for segment in segments)
    total = len(segments)

    segment_stage = "completed" if total and video_succeeded == total else "failed" if video_failed else "pending"
    narration_stage = (
        "completed"
        if total and audio_succeeded == total
        else "failed"
        if audio_failed
        else "running"
        if composition.status == "generating_narration"
        else "pending"
    )
    compose_stage = (
        "completed"
        if composition.status == "succeeded" and composition.final_video_path
        else "failed"
        if composition.status == "failed" and composition.stage == "compose"
        else "running"
        if composition.status == "composing"
        else "pending"
    )
    asset_base = f"/api/resources/video-jobs/{job.job_id}/composition/assets"
    return {
        "jobId": job.job_id,
        "resourcePackId": job.resource_pack_id,
        "status": composition.status,
        "stage": composition.stage,
        "progress": composition.progress,
        "message": composition.message,
        "ttsProvider": composition.tts_provider,
        "ttsModel": composition.tts_model,
        "voice": composition.voice,
        "speed": composition.speed,
        "voiceOptions": sorted(ALLOWED_VOICES),
        "errorCode": composition.error_code,
        "error": composition.error_message,
        "celeryTaskId": composition.celery_task_id,
        "createdAt": _epoch_milliseconds(composition.created_at),
        "updatedAt": _epoch_milliseconds(composition.updated_at),
        "finishedAt": _epoch_milliseconds(composition.finished_at),
        "stages": [
            _stage("storyboard", "分镜", "completed" if total else "pending", f"{total} 个片段"),
            _stage("segments", "视频片段", segment_stage, f"{video_succeeded}/{total} 已完成"),
            _stage("narration", "旁白与字幕", narration_stage, f"{audio_succeeded}/{total} 已完成"),
            _stage("compose", "最终合并", compose_stage, composition.message or "等待开始"),
        ],
        "segments": [_serialize_video_segment(segment) for segment in segments],
        "assets": {
            "finalUrl": f"{asset_base}/final/" if composition.final_video_path else "",
            "narrationUrl": f"{asset_base}/narration/" if composition.narration_text else "",
            "subtitlesUrl": f"{asset_base}/subtitles/" if composition.subtitles_path else "",
        },
    }


def _reset_segment_audio(segment) -> None:
    segment.audio_status = "pending"
    segment.audio_path = ""
    segment.audio_content_type = ""
    segment.audio_file_size = 0
    segment.audio_sha256 = ""
    segment.audio_duration_ms = 0
    segment.error_code = ""
    segment.error_message = ""


def _reset_final_output(composition: VideoComposition) -> None:
    composition.final_video_path = ""
    composition.final_content_type = ""
    composition.final_file_size = 0
    composition.final_sha256 = ""
    composition.finished_at = None
    composition.status = "draft"
    composition.stage = "storyboard"
    composition.progress = 25
    composition.message = "分镜已更新，请重新生成旁白"
    composition.error_code = ""
    composition.error_message = ""


@transaction.atomic
def update_composition(job: VideoGenerationJob, payload: dict) -> VideoComposition:
    composition = _locked_composition(job)
    if composition.status in ACTIVE_COMPOSITION_STATUSES:
        raise ValueError("视频制作任务正在进行中，请等待当前步骤完成后再修改")
    invalidate_all = False
    if "voice" in payload:
        voice = str(payload.get("voice") or "").strip()
        if voice not in ALLOWED_VOICES:
            raise ValueError("不支持的配音音色")
        if voice != composition.voice:
            composition.voice = voice
            invalidate_all = True
    if "speed" in payload:
        try:
            speed = float(payload["speed"])
        except (TypeError, ValueError) as exc:
            raise ValueError("语速必须是数字") from exc
        if not 0.5 <= speed <= 2.0:
            raise ValueError("语速必须在 0.5 到 2.0 之间")
        if speed != composition.speed:
            composition.speed = speed
            invalidate_all = True

    segments = {segment.index: segment for segment in job.segments.all()}
    changed_indexes: set[int] = set(segments) if invalidate_all else set()
    updates = payload.get("segments", [])
    if updates not in (None, []) and not isinstance(updates, list):
        raise ValueError("旁白修改格式无效")
    for item in updates or []:
        if not isinstance(item, dict):
            raise ValueError("旁白修改格式无效")
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError) as exc:
            raise ValueError("视频片段序号无效") from exc
        segment = segments.get(index)
        if not segment:
            raise ValueError("视频片段不存在")
        narration = str(item.get("narration") or "").strip()
        if not narration or len(narration) > 2_000:
            raise ValueError("旁白不能为空且不能超过 2000 字")
        if narration != segment.narration:
            segment.narration = narration
            changed_indexes.add(index)

    for segment in segments.values():
        estimated = estimate_narration_ms(segment.narration, speed=composition.speed)
        segment.narration_estimated_ms = estimated
        segment.narration_fits = estimated <= segment.duration * 1000
        if segment.index in changed_indexes:
            _reset_segment_audio(segment)
        segment.save()

    if changed_indexes:
        _reset_final_output(composition)
        composition.narration_text = ""
        composition.subtitles_path = ""
    composition.save()
    return composition


@transaction.atomic
def dispatch_narration(job: VideoGenerationJob, segment_indexes: list[int] | None = None) -> VideoComposition:
    composition = _locked_composition(job)
    if composition.status in ACTIVE_COMPOSITION_STATUSES:
        if composition.stage == "narration":
            return composition
        raise ValueError("最终视频合并正在进行中，请等待当前步骤完成")
    selected = {int(index) for index in segment_indexes or []}
    targets = [segment for segment in job.segments.all() if not selected or segment.index in selected]
    if not targets:
        raise ValueError("没有可生成旁白的片段")
    for segment in targets:
        if not segment.narration.strip():
            raise ValueError(f"第 {segment.index} 段旁白为空")
        if not segment.narration_fits:
            raise ValueError(f"第 {segment.index} 段旁白超过片段时长")
    task_id = uuid.uuid4().hex
    composition.status = "queued"
    composition.stage = "narration"
    composition.progress = 35
    composition.message = "旁白任务已进入专用队列"
    composition.celery_task_id = task_id
    composition.error_code = ""
    composition.error_message = ""
    composition.save()
    transaction.on_commit(
        lambda: _send_queued_task(
            composition.id,
            "compat.generate_video_narration",
            [job.job_id, sorted(selected)],
            task_id,
        )
    )
    return composition


@transaction.atomic
def dispatch_compose(job: VideoGenerationJob) -> VideoComposition:
    segments = list(job.segments.all())
    if not segments or any(segment.status != "succeeded" or not segment.stored_path for segment in segments):
        raise ValueError("所有片段视频成功并保存后才能合并")
    if any(segment.audio_status != "succeeded" or not segment.audio_path for segment in segments):
        raise ValueError("请先为所有片段生成旁白")
    composition = _locked_composition(job)
    if composition.status in ACTIVE_COMPOSITION_STATUSES:
        if composition.stage == "compose":
            return composition
        raise ValueError("旁白生成正在进行中，请等待当前步骤完成")
    task_id = uuid.uuid4().hex
    composition.status = "queued"
    composition.stage = "compose"
    composition.progress = 70
    composition.message = "最终合并任务已进入专用队列"
    composition.celery_task_id = task_id
    composition.error_code = ""
    composition.error_message = ""
    composition.save()
    transaction.on_commit(
        lambda: _send_queued_task(
            composition.id,
            "compat.compose_final_video",
            [job.job_id],
            task_id,
        )
    )
    return composition
