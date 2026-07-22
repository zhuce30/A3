from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import requests
from django.conf import settings
from django.http import FileResponse, StreamingHttpResponse


class VideoStorageError(RuntimeError):
    pass


def video_storage_root() -> Path:
    root = Path(settings.A3_VIDEO_STORAGE_ROOT).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def segment_storage_file(segment) -> Path | None:
    if not segment.stored_path:
        return None
    root = video_storage_root()
    candidate = (root / segment.stored_path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def segment_playback_available(segment) -> bool:
    candidate = segment_storage_file(segment)
    return bool(candidate and candidate.is_file() and candidate.stat().st_size == segment.file_size > 0)


def persist_segment_video(segment, remote_url: str) -> None:
    parsed = urlparse(str(remote_url or "").strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise VideoStorageError("视频服务返回了无效的下载地址")

    root = video_storage_root()
    safe_job_id = re.sub(r"[^A-Za-z0-9._-]", "_", segment.job.job_id)[:120]
    relative = Path(str(segment.job.user_id), safe_job_id, f"segment-{segment.index}-{segment.playback_id}.mp4")
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    max_bytes = int(settings.A3_VIDEO_STORAGE_MAX_BYTES)
    digest = hashlib.sha256()
    written = 0
    prefix = bytearray()

    try:
        with requests.get(remote_url, stream=True, allow_redirects=True, timeout=(10, 120)) as response:
            if response.status_code != 200:
                raise VideoStorageError(f"视频文件下载失败（HTTP {response.status_code}）")
            content_type = str(response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            if not (content_type.startswith("video/") or content_type == "application/octet-stream"):
                raise VideoStorageError("视频服务返回的内容不是视频文件")
            content_length = str(response.headers.get("content-length") or "").strip()
            if content_length.isdigit() and int(content_length) > max_bytes:
                raise VideoStorageError("视频文件超过系统保存上限")
            with temporary.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    written += len(chunk)
                    if written > max_bytes:
                        raise VideoStorageError("视频文件超过系统保存上限")
                    if len(prefix) < 64:
                        prefix.extend(chunk[: 64 - len(prefix)])
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        if written < 12 or b"ftyp" not in bytes(prefix[:64]):
            raise VideoStorageError("视频文件校验失败，未检测到有效 MP4 文件头")
        os.replace(temporary, destination)
    except requests.RequestException as exc:
        raise VideoStorageError("视频文件下载连接中断") from exc
    finally:
        if temporary.exists():
            temporary.unlink()

    segment.video_url = f"/api/a3/resources/video-playback/{segment.playback_id}"
    segment.stored_path = relative.as_posix()
    segment.content_type = "video/mp4"
    segment.file_size = written
    segment.sha256 = digest.hexdigest()
    segment.save(
        update_fields=[
            "video_url",
            "stored_path",
            "content_type",
            "file_size",
            "sha256",
            "updated_at",
        ]
    )


def build_video_stream_response(request, segment):
    path = segment_storage_file(segment)
    if not path or not path.is_file():
        raise FileNotFoundError("视频文件不存在")
    size = path.stat().st_size
    content_type = segment.content_type or "video/mp4"
    range_header = str(request.headers.get("Range") or "").strip()
    if not range_header:
        response = FileResponse(path.open("rb"), content_type=content_type)
        response["Content-Length"] = str(size)
        response["Accept-Ranges"] = "bytes"
        response["Content-Disposition"] = f'inline; filename="segment-{segment.index}.mp4"'
        return response

    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
    if not match or (not match.group(1) and not match.group(2)):
        raise ValueError("无效的 Range 请求")
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:
        suffix_length = int(match.group(2))
        start = max(0, size - suffix_length)
        end = size - 1
    if start >= size or start < 0 or end < start:
        raise ValueError("Range 超出视频文件范围")
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
    response["Content-Disposition"] = f'inline; filename="segment-{segment.index}.mp4"'
    return response
