from __future__ import annotations

import os

import requests


class VideoProviderNetworkError(RuntimeError):
    pass


class VideoProviderRequestError(RuntimeError):
    pass


def submit_video_provider_task(segment) -> str:
    payload = _call_bridge(
        {
            "action": "submit",
            "provider": segment.job.provider,
            "prompt": segment.prompt,
            "duration": segment.duration,
            "aspectRatio": segment.aspect_ratio,
            "resolution": segment.resolution,
        }
    )
    task_id = str(payload.get("providerTaskId") or "").strip()
    if not task_id:
        raise VideoProviderRequestError("视频服务未返回任务 ID")
    return task_id


def poll_video_provider_task(provider: str, provider_task_id: str) -> dict:
    return _call_bridge(
        {
            "action": "poll",
            "provider": provider,
            "providerTaskId": provider_task_id,
        }
    )


def _call_bridge(payload: dict) -> dict:
    base_url = os.getenv("A3_INTERNAL_FRONTEND_BASE_URL", "http://frontend:3000").rstrip("/")
    token = os.getenv("A3_VIDEO_WORKER_TOKEN", "").strip()
    if not token:
        raise VideoProviderRequestError("视频任务内部凭据未配置")
    try:
        response = requests.post(
            f"{base_url}/api/internal/a3-video-provider",
            json=payload,
            headers={"x-a3-video-worker-token": token},
            timeout=30,
        )
    except requests.RequestException as exc:
        raise VideoProviderNetworkError("视频服务连接暂时中断") from exc
    try:
        data = response.json()
    except ValueError as exc:
        raise VideoProviderNetworkError("视频服务返回了无法识别的数据") from exc
    if not response.ok or not data.get("success"):
        error = str(data.get("error") or f"视频服务请求失败（{response.status_code}）")
        if response.status_code >= 500:
            raise VideoProviderNetworkError(error)
        raise VideoProviderRequestError(error)
    return data
