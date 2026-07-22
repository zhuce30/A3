from __future__ import annotations

import os
import wave
from io import BytesIO
from urllib.parse import urlparse

import requests


DEFAULT_QWEN_TTS_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/"
    "multimodal-generation/generation"
)
MAX_TTS_AUDIO_BYTES = 25 * 1024 * 1024


class TTSConfigurationError(RuntimeError):
    pass


def resolve_tts_api_key() -> str:
    for name in (
        "A3_VIDEO_TTS_API_KEY",
        "TTS_QWEN_API_KEY",
        "DASHSCOPE_API_KEY",
        "QWEN_API_KEY",
        "A3_LLM_API_KEY",
    ):
        value = os.getenv(name, "").strip()
        if value:
            return value
    raise TTSConfigurationError("未配置视频语音合成密钥，请联系管理员。")


def wav_duration_ms(audio: bytes) -> int:
    try:
        with wave.open(BytesIO(audio), "rb") as wav:
            frame_rate = wav.getframerate()
            frame_count = wav.getnframes()
    except (EOFError, wave.Error) as exc:
        raise RuntimeError("旁白音频文件校验失败") from exc
    if frame_rate <= 0 or frame_count <= 0:
        raise RuntimeError("旁白音频文件校验失败")
    return max(1, round(frame_count * 1000 / frame_rate))


def _download_audio(audio_url: str) -> bytes:
    try:
        response = requests.get(
            audio_url,
            timeout=(10, 120),
            stream=True,
            allow_redirects=False,
        )
        if response.status_code != 200:
            raise RuntimeError(f"旁白音频下载失败（HTTP {response.status_code}）")
        content_type = str(response.headers.get("content-type") or "").split(";", 1)[0].lower()
        if content_type and not (
            content_type.startswith("audio/") or content_type == "application/octet-stream"
        ):
            raise RuntimeError("语音合成服务返回的文件不是音频")
        content_length = str(response.headers.get("content-length") or "").strip()
        if content_length:
            try:
                if int(content_length) > MAX_TTS_AUDIO_BYTES:
                    raise RuntimeError("旁白音频文件超过大小限制")
            except ValueError as exc:
                raise RuntimeError("语音合成服务返回了无效的文件大小") from exc
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_TTS_AUDIO_BYTES:
                raise RuntimeError("旁白音频文件超过大小限制")
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        if "response" in locals():
            response.close()


def synthesize_qwen_audio(
    text: str,
    *,
    model: str = "qwen3-tts-flash",
    voice: str = "Cherry",
    speed: float = 1.0,
) -> bytes:
    narration = str(text or "").strip()
    if not narration:
        raise ValueError("旁白不能为空")
    if len(narration) > 2_000:
        raise ValueError("单段旁白不能超过 2000 字")
    normalized_speed = max(0.5, min(float(speed), 2.0))
    rate = round((normalized_speed - 1.0) * 500)
    try:
        response = requests.post(
            DEFAULT_QWEN_TTS_URL,
            headers={
                "Authorization": f"Bearer {resolve_tts_api_key()}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json={
                "model": str(model or "qwen3-tts-flash")[:80],
                "input": {
                    "text": narration,
                    "voice": str(voice or "Cherry")[:80],
                    "language_type": "Chinese",
                },
                "parameters": {"rate": rate},
            },
            timeout=(10, 120),
        )
        if response.status_code != 200:
            raise RuntimeError(f"语音合成服务返回 HTTP {response.status_code}")
        payload = response.json()
        audio_url = str(payload.get("output", {}).get("audio", {}).get("url") or "").strip()
        parsed = urlparse(audio_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise RuntimeError("语音合成服务返回了无效的下载地址")
        audio = _download_audio(audio_url)
    except requests.RequestException as exc:
        raise RuntimeError("语音合成服务连接中断，请稍后重试") from exc
    except (TypeError, ValueError) as exc:
        raise RuntimeError("语音合成服务返回的数据无效") from exc

    if not 12 <= len(audio) <= MAX_TTS_AUDIO_BYTES or not (audio.startswith(b"RIFF") and b"WAVE" in audio[:16]):
        raise RuntimeError("旁白音频文件校验失败")
    wav_duration_ms(audio)
    return audio
