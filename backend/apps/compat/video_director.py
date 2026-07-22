from __future__ import annotations

import math
import re
from typing import Any


_CHINESE_CHARACTERS = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_ENGLISH_WORDS = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*")


class VideoDirectorAgent:
    """Deterministic storyboard director used before provider submission."""

    name = "VideoDirectorAgent"

    def direct(self, storyboard: Any, *, speed: float = 1.0) -> list[dict[str, Any]]:
        return direct_video_segments(storyboard, speed=speed)


def _normalized_speed(speed: float) -> float:
    try:
        value = float(speed)
    except (TypeError, ValueError) as exc:
        raise ValueError("语速必须是数字") from exc
    if not math.isfinite(value):
        raise ValueError("语速必须是有限数字")
    return max(0.5, min(value, 2.0))


def estimate_narration_ms(text: str, speed: float = 1.0) -> int:
    """Estimate spoken duration for mixed Chinese and English narration."""
    value = str(text or "").strip()
    if not value:
        return 0
    seconds = (
        len(_CHINESE_CHARACTERS.findall(value)) / 4.0
        + len(_ENGLISH_WORDS.findall(value)) / 2.5
    )
    return int(round(seconds * 1000 / _normalized_speed(speed)))


def direct_video_segments(value: Any, speed: float = 1.0) -> list[dict[str, Any]]:
    """Validate and normalize a structured storyboard for the video provider."""
    if not isinstance(value, list) or not 1 <= len(value) <= 6:
        raise ValueError("视频任务必须包含 1-6 个分段")

    directed: list[dict[str, Any]] = []
    seen_indexes: set[int] = set()
    for fallback_index, raw in enumerate(value, start=1):
        if not isinstance(raw, dict):
            raise ValueError("视频分段格式无效")
        try:
            index = int(raw.get("index") or fallback_index)
        except (TypeError, ValueError) as exc:
            raise ValueError("视频分段序号无效") from exc
        if index < 1 or index > 6 or index in seen_indexes:
            raise ValueError("视频分段序号无效")
        seen_indexes.add(index)

        try:
            duration = max(1, min(int(raw.get("duration") or 10), 10))
        except (TypeError, ValueError) as exc:
            raise ValueError("视频分段时长无效") from exc

        prompt = _text(raw.get("prompt"), "视频分段提示词无效", required=True, limit=12_000)
        visual = _text(raw.get("visual"), "视频分段画面描述无效", limit=4_000)
        narration = _text(raw.get("narration"), "视频分段旁白无效", limit=2_000)
        title = _text(raw.get("title"), "视频分段标题无效", limit=120) or f"片段 {index}"
        source_ids = _normalize_source_ids(raw.get("sourceIds", raw.get("source_ids")))
        estimated_ms = estimate_narration_ms(narration, speed=speed)
        directed.append(
            {
                "index": index,
                "title": title,
                "prompt": prompt,
                "visual": visual,
                "narration": narration,
                "duration": duration,
                "sourceIds": source_ids,
                "narrationEstimatedMs": estimated_ms,
                "narrationFits": estimated_ms <= duration * 1000,
            }
        )
    return directed


def _text(value: Any, message: str, *, required: bool = False, limit: int) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(message)
    normalized = value.strip()
    if (required and not normalized) or len(normalized) > limit:
        raise ValueError(message)
    return normalized


def _normalize_source_ids(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("sourceIds 必须是数组")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise ValueError("sourceIds 只能包含字符串")
        source_id = item.strip()
        if source_id and source_id not in seen:
            seen.add(source_id)
            result.append(source_id)
    if len(result) > 20:
        raise ValueError("sourceIds 最多包含 20 个来源")
    return result
