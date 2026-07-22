from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from celery import shared_task
from django.db import transaction
from django.utils import timezone

from backend.apps.compat.models import VideoComposition, VideoGenerationJob
from backend.apps.compat.video_composition_storage import (
    composition_directory,
    persist_segment_audio,
    persist_text_assets,
    segment_audio_file,
)
from backend.apps.compat.video_storage import segment_storage_file
from backend.apps.compat.video_tts import synthesize_qwen_audio, wav_duration_ms


logger = logging.getLogger(__name__)


def _hash_file(path: Path, *, chunk_size: int = 1024 * 1024) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def build_segment_ffmpeg_args(
    video_path: Path,
    audio_path: Path,
    output_path: Path,
    *,
    duration: int,
) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-filter_complex",
        "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,"
        "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v];"
        "[1:a]aresample=48000,apad[a]",
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-t",
        str(max(1, int(duration))),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def build_concat_ffmpeg_args(list_path: Path, output_path: Path) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_path),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def _run_ffmpeg(args: list[str]) -> None:
    with tempfile.TemporaryFile() as stderr:
        try:
            subprocess.run(
                args,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=stderr,
                timeout=900,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("服务器尚未安装 FFmpeg") from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("视频合成超时，请重试合并步骤") from exc
        except subprocess.CalledProcessError as exc:
            stderr.seek(0, os.SEEK_END)
            size = stderr.tell()
            stderr.seek(max(0, size - 4096))
            detail = stderr.read().decode("utf-8", errors="replace")
            logger.error("FFmpeg video composition failed: %s", detail)
            raise RuntimeError("视频合成失败，请稍后重试合并步骤") from exc


def _composition(job: VideoGenerationJob) -> VideoComposition:
    composition, _ = VideoComposition.objects.get_or_create(job=job)
    return composition


def _current_task_id(task) -> str:
    return str(getattr(task.request, "id", "") or "")


def _composition_task_is_current(
    composition_id: int,
    task_id: str,
    *,
    stage: str,
) -> bool:
    if not task_id:
        return True
    return VideoComposition.objects.filter(
        pk=composition_id,
        celery_task_id=task_id,
        stage=stage,
        status__in=["queued", "generating_narration", "composing"],
    ).exists()


def _locked_current_composition(
    composition_id: int,
    task_id: str,
    *,
    stage: str,
) -> VideoComposition | None:
    composition = VideoComposition.objects.select_for_update().get(pk=composition_id)
    if composition.stage != stage or composition.status not in {
        "queued",
        "generating_narration",
        "composing",
    }:
        return None
    if task_id and composition.celery_task_id and composition.celery_task_id != task_id:
        return None
    return composition


@shared_task(
    bind=True,
    name="compat.generate_video_narration",
    acks_late=True,
    reject_on_worker_lost=True,
    soft_time_limit=1200,
    time_limit=1320,
)
def generate_video_narration(self, job_id: str, segment_indexes: list[int] | None = None) -> dict:
    job = VideoGenerationJob.objects.prefetch_related("segments").get(job_id=job_id)
    composition = _composition(job)
    task_id = _current_task_id(self)
    if not _composition_task_is_current(composition.id, task_id, stage="narration"):
        return {"success": False, "stale": True, "jobId": job_id}
    selected = {int(index) for index in segment_indexes or []}
    segments = list(job.segments.all())
    targets = [segment for segment in segments if not selected or segment.index in selected]
    if not targets:
        raise ValueError("没有可生成旁白的片段")
    for segment in targets:
        if not segment.narration.strip():
            raise ValueError(f"第 {segment.index} 段旁白为空")
        if not segment.narration_fits:
            raise ValueError(f"第 {segment.index} 段旁白超过片段时长，请先缩短旁白")

    composition.status = "generating_narration"
    composition.stage = "narration"
    composition.progress = 45
    composition.message = "正在生成分段旁白"
    composition.error_code = ""
    composition.error_message = ""
    composition.narration_attempts += 1
    composition.started_at = composition.started_at or timezone.now()
    composition.finished_at = None
    composition.celery_task_id = task_id or composition.celery_task_id
    composition.save()

    generated = 0
    try:
        for segment in targets:
            if not _composition_task_is_current(composition.id, task_id, stage="narration"):
                return {"success": False, "stale": True, "jobId": job_id}
            if segment.audio_status == "succeeded" and segment.audio_path:
                continue
            segment.audio_status = "generating"
            segment.error_code = ""
            segment.error_message = ""
            segment.save(update_fields=["audio_status", "error_code", "error_message", "updated_at"])
            try:
                audio = synthesize_qwen_audio(
                    segment.narration,
                    model=composition.tts_model,
                    voice=composition.voice,
                    speed=composition.speed,
                )
                duration_ms = wav_duration_ms(audio)
                if duration_ms > segment.duration * 1_000:
                    raise ValueError(
                        f"第 {segment.index} 段实际旁白时长超过视频片段，请缩短旁白或提高语速"
                    )
                if not _composition_task_is_current(composition.id, task_id, stage="narration"):
                    return {"success": False, "stale": True, "jobId": job_id}
                persist_segment_audio(
                    segment,
                    audio,
                    duration_ms=duration_ms,
                )
                generated += 1
            except Exception as exc:
                if not _composition_task_is_current(composition.id, task_id, stage="narration"):
                    return {"success": False, "stale": True, "jobId": job_id}
                segment.audio_status = "failed"
                segment.error_code = "tts_failed"
                segment.error_message = str(exc)[:1000]
                segment.save(
                    update_fields=[
                        "audio_status",
                        "error_code",
                        "error_message",
                        "updated_at",
                    ]
                )
                raise

        if not _composition_task_is_current(composition.id, task_id, stage="narration"):
            return {"success": False, "stale": True, "jobId": job_id}
        refreshed = list(job.segments.all())
        with transaction.atomic():
            locked = _locked_current_composition(
                composition.id,
                task_id,
                stage="narration",
            )
            if locked is None:
                return {"success": False, "stale": True, "jobId": job_id}
            if all(segment.audio_status == "succeeded" and segment.audio_path for segment in refreshed):
                persist_text_assets(locked, refreshed)
                locked.status = "narration_ready"
                locked.progress = 65
                locked.message = "旁白和字幕已生成，可以合并最终视频"
            else:
                locked.status = "draft"
                locked.progress = 55
                locked.message = "已更新所选旁白片段"
            locked.error_code = ""
            locked.error_message = ""
            locked.save()
        return {"success": True, "generated": generated, "jobId": job_id}
    except Exception as exc:
        with transaction.atomic():
            locked = _locked_current_composition(
                composition.id,
                task_id,
                stage="narration",
            )
            if locked is None:
                return {"success": False, "stale": True, "jobId": job_id}
            locked.status = "failed"
            locked.message = "旁白生成失败，可单独重试失败片段"
            locked.error_code = "tts_failed"
            locked.error_message = str(exc)[:4000]
            locked.finished_at = timezone.now()
            locked.save()
        raise


@shared_task(
    bind=True,
    name="compat.compose_final_video",
    acks_late=True,
    reject_on_worker_lost=True,
    soft_time_limit=1800,
    time_limit=1920,
)
def compose_final_video(self, job_id: str) -> dict:
    job = VideoGenerationJob.objects.prefetch_related("segments").get(job_id=job_id)
    composition = _composition(job)
    task_id = _current_task_id(self)
    if not _composition_task_is_current(composition.id, task_id, stage="compose"):
        return {"success": False, "stale": True, "jobId": job_id}
    segments = list(job.segments.all())
    if not segments or any(segment.status != "succeeded" or not segment.stored_path for segment in segments):
        raise ValueError("所有片段视频成功并保存后才能合并")
    if any(segment.audio_status != "succeeded" or not segment.audio_path for segment in segments):
        raise ValueError("请先为所有片段生成旁白")

    composition.status = "composing"
    composition.stage = "compose"
    composition.progress = 75
    composition.message = "正在合并视频片段和旁白"
    composition.error_code = ""
    composition.error_message = ""
    composition.compose_attempts += 1
    composition.started_at = composition.started_at or timezone.now()
    composition.finished_at = None
    composition.celery_task_id = task_id or composition.celery_task_id
    composition.save()

    directory, relative = composition_directory(composition)
    work_directory = directory / f".work-{task_id[:16] or 'legacy'}"
    if work_directory.exists():
        shutil.rmtree(work_directory)
    work_directory.mkdir(parents=True, exist_ok=True)
    normalized_paths: list[Path] = []
    try:
        persist_text_assets(composition, segments)
        for segment in segments:
            if not _composition_task_is_current(composition.id, task_id, stage="compose"):
                return {"success": False, "stale": True, "jobId": job_id}
            video_path = segment_storage_file(segment)
            if not video_path or not video_path.is_file():
                raise ValueError(f"第 {segment.index} 段片段视频文件不存在")
            audio_path = segment_audio_file(segment)
            normalized = work_directory / f"normalized-{segment.index}.mp4"
            _run_ffmpeg(
                build_segment_ffmpeg_args(
                    video_path,
                    audio_path,
                    normalized,
                    duration=segment.duration,
                )
            )
            normalized_paths.append(normalized)

        concat_list = work_directory / "concat.txt"
        concat_list.write_text(
            "".join(f"file '{path.as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n" for path in normalized_paths),
            encoding="utf-8",
        )
        temporary = work_directory / "final.part.mp4"
        final_path = directory / "final.mp4"
        _run_ffmpeg(build_concat_ffmpeg_args(concat_list, temporary))
        if not temporary.is_file() or temporary.stat().st_size < 12:
            raise RuntimeError("最终视频文件校验失败")
        final_sha256, final_file_size = _hash_file(temporary)
        with transaction.atomic():
            locked = _locked_current_composition(
                composition.id,
                task_id,
                stage="compose",
            )
            if locked is None:
                return {"success": False, "stale": True, "jobId": job_id}
            os.replace(temporary, final_path)
            locked.final_video_path = (relative / "final.mp4").as_posix()
            locked.final_content_type = "video/mp4"
            locked.final_file_size = final_file_size
            locked.final_sha256 = final_sha256
            locked.status = "succeeded"
            locked.stage = "completed"
            locked.progress = 100
            locked.message = "最终视频已生成"
            locked.error_code = ""
            locked.error_message = ""
            locked.finished_at = timezone.now()
            locked.save()
        return {"success": True, "jobId": job_id, "fileSize": final_file_size}
    except Exception as exc:
        with transaction.atomic():
            locked = _locked_current_composition(
                composition.id,
                task_id,
                stage="compose",
            )
            if locked is None:
                return {"success": False, "stale": True, "jobId": job_id}
            locked.status = "failed"
            locked.message = "最终视频合并失败，可单独重试合并步骤"
            locked.error_code = "compose_failed"
            locked.error_message = str(exc)[:4000]
            locked.finished_at = timezone.now()
            locked.save()
        raise
    finally:
        shutil.rmtree(work_directory, ignore_errors=True)
