from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Iterable

from django.http import FileResponse, StreamingHttpResponse

from backend.apps.compat.video_storage import video_storage_root


class InvalidRangeError(ValueError):
    def __init__(self, message: str, size: int):
        super().__init__(message)
        self.size = size


def _safe_job_id(job_id: str) -> str:
    value = "".join(character if character.isalnum() or character in "._-" else "_" for character in job_id)
    return value[:120] or "video-job"


def _resolve_relative(relative_path: str) -> Path:
    if not relative_path:
        raise FileNotFoundError("文件尚未生成")
    root = video_storage_root()
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("无效的媒体存储路径") from exc
    return candidate


def composition_directory(composition) -> tuple[Path, Path]:
    relative = Path(str(composition.job.user_id), _safe_job_id(composition.job.job_id), "composition")
    directory = video_storage_root() / relative
    directory.mkdir(parents=True, exist_ok=True)
    return directory, relative


def persist_segment_audio(segment, audio: bytes, *, duration_ms: int) -> Path:
    if not (audio.startswith(b"RIFF") and b"WAVE" in audio[:16]):
        raise ValueError("旁白音频不是有效的 WAV 文件")
    root = video_storage_root()
    relative = Path(
        str(segment.job.user_id),
        _safe_job_id(segment.job.job_id),
        "audio",
        f"segment-{segment.index}-{segment.audio_playback_id}.wav",
    )
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".wav.part")
    try:
        temporary.write_bytes(audio)
        os.replace(temporary, destination)
    finally:
        if temporary.exists():
            temporary.unlink()
    segment.audio_status = "succeeded"
    segment.audio_path = relative.as_posix()
    segment.audio_content_type = "audio/wav"
    segment.audio_file_size = len(audio)
    segment.audio_sha256 = hashlib.sha256(audio).hexdigest()
    segment.audio_duration_ms = max(0, int(duration_ms))
    segment.save(
        update_fields=[
            "audio_status",
            "audio_path",
            "audio_content_type",
            "audio_file_size",
            "audio_sha256",
            "audio_duration_ms",
            "updated_at",
        ]
    )
    return destination


def segment_audio_file(segment) -> Path:
    candidate = _resolve_relative(segment.audio_path)
    if not candidate.is_file() or candidate.stat().st_size != segment.audio_file_size:
        raise FileNotFoundError("旁白音频文件不存在")
    return candidate


def build_narration_text(segments: Iterable) -> str:
    lines = []
    for segment in segments:
        narration = str(segment.narration or "").strip()
        if narration:
            lines.append(f"{segment.index}. {segment.title}\n{narration}")
    return "\n\n".join(lines).strip() + ("\n" if lines else "")


def _vtt_timestamp(milliseconds: int) -> str:
    total = max(0, int(milliseconds))
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def build_webvtt(segments: Iterable) -> str:
    cues = ["WEBVTT", ""]
    cursor = 0
    for segment in segments:
        duration_ms = max(1_000, int(segment.duration) * 1_000)
        end = cursor + duration_ms
        narration = str(segment.narration or "").strip()
        if narration:
            cues.extend(
                [
                    str(segment.index),
                    f"{_vtt_timestamp(cursor)} --> {_vtt_timestamp(end)}",
                    narration,
                    "",
                ]
            )
        cursor = end
    return "\n".join(cues)


def persist_text_assets(composition, segments: Iterable) -> None:
    segment_list = list(segments)
    directory, relative = composition_directory(composition)
    narration = build_narration_text(segment_list)
    subtitles = build_webvtt(segment_list)
    narration_path = directory / "narration.txt"
    subtitles_path = directory / "subtitles.vtt"
    narration_path.write_text(narration, encoding="utf-8")
    subtitles_path.write_text(subtitles, encoding="utf-8")
    composition.narration_text = narration
    composition.subtitles_path = (relative / "subtitles.vtt").as_posix()
    composition.save(update_fields=["narration_text", "subtitles_path", "updated_at"])


def asset_file(composition, asset: str) -> Path:
    if asset == "final":
        return _resolve_relative(composition.final_video_path)
    if asset == "subtitles":
        return _resolve_relative(composition.subtitles_path)
    if asset == "narration":
        directory, _ = composition_directory(composition)
        return directory / "narration.txt"
    raise ValueError("不支持的合成文件类型")


def build_file_response(request, path: Path, *, content_type: str, filename: str, inline: bool = False):
    if not path.is_file():
        raise FileNotFoundError("文件不存在")
    size = path.stat().st_size
    range_header = str(request.headers.get("Range") or "").strip()
    disposition = "inline" if inline else "attachment"
    if not range_header:
        response = FileResponse(path.open("rb"), content_type=content_type)
        response["Content-Length"] = str(size)
        response["Accept-Ranges"] = "bytes"
        response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
        return response

    import re

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
    if not match or (not match.group(1) and not match.group(2)):
        raise InvalidRangeError("无效的 Range 请求", size)
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:
        start = max(0, size - int(match.group(2)))
        end = size - 1
    if start < 0 or start >= size or end < start:
        raise InvalidRangeError("Range 超出文件范围", size)
    end = min(end, size - 1)
    length = end - start + 1

    def stream_range():
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    response = StreamingHttpResponse(stream_range(), status=206, content_type=content_type)
    response["Content-Length"] = str(length)
    response["Content-Range"] = f"bytes {start}-{end}/{size}"
    response["Accept-Ranges"] = "bytes"
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    return response
