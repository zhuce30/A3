from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from math import isfinite
from typing import Any

from django.db import transaction
from django.utils import timezone

from backend.apps.learning.effect_events import LEARNING_EVENT_SCHEMA_V2, ingest_learning_event_v2
from backend.apps.learning.models import LearningEvent


ALGORITHM_LAB_SCHEMA_VERSION = "a3.algorithm-labs.catalog.v1"
ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION = "a3.algorithm-lab.completion.v1"
ALGORITHM_LAB_EFFECT_SCHEMA_VERSION = "a3.algorithm-lab.effect.v1"

_LAB_ASSESSMENT_TOPICS = {
    "cpu-scheduling": "处理机调度算法",
    "page-replacement": "虚拟内存与页面置换",
}


class AlgorithmLabCompletionConflict(Exception):
    pass


_LABS = (
    {
        "id": "cpu-scheduling",
        "version": "1.0.0",
        "title": "CPU 调度算法实验",
        "description": "比较不同调度策略对等待时间、周转时间和响应时间的影响。",
        "estimatedMinutes": 25,
        "knowledgePointCodes": ["OS.CPU.SCHEDULING", "OS.CPU.PERFORMANCE"],
        "algorithms": ["fcfs", "sjf", "priority", "rr"],
        "presets": [
            {
                "id": "cpu-foundation",
                "version": "1.0.0",
                "title": "基础调度过程",
                "description": "使用简单到达序列观察四种调度算法的执行顺序。",
                "difficulty": "foundation",
                "input": {
                    "processes": [
                        {"processId": "P1", "arrivalTime": 0, "burstTime": 5, "priority": 2},
                        {"processId": "P2", "arrivalTime": 1, "burstTime": 3, "priority": 1},
                        {"processId": "P3", "arrivalTime": 2, "burstTime": 4, "priority": 3},
                    ],
                    "timeQuantum": 2,
                },
                "expectedFingerprint": "a3lab-result.v1|cpu-scheduling|cpu-foundation|1.0.0|fcfs=cpu:30f71277755e0281d134aa1ca82e049c|priority=cpu:4aae8cbcb315ec683110dcf7aa793990|rr=cpu:7a045a7da6352c4488d7a567d0ff26c2|sjf=cpu:7958460a04842ebeb1e53aebf42d471a",
                "expectedPredictionAnswers": ["fcfs", "sjf", "priority"],
            },
            {
                "id": "cpu-misconception",
                "version": "1.0.0",
                "title": "短作业不一定先执行",
                "description": "辨析到达时间对短作业优先调度结果的影响。",
                "difficulty": "misconception",
                "input": {
                    "processes": [
                        {"processId": "P1", "arrivalTime": 0, "burstTime": 7, "priority": 2},
                        {"processId": "P2", "arrivalTime": 2, "burstTime": 1, "priority": 1},
                        {"processId": "P3", "arrivalTime": 3, "burstTime": 2, "priority": 0},
                    ],
                    "timeQuantum": 2,
                },
                "expectedFingerprint": "a3lab-result.v1|cpu-scheduling|cpu-misconception|1.0.0|fcfs=cpu:ff7344b6f31930e4b42709226d8c8577|priority=cpu:db26b868e76574744f2e2f28a8a996ed|rr=cpu:8e8bb02d9ec3de4401286d715e268199|sjf=cpu:359d2c5ae192f9b7d5979469d99f8a2a",
                "expectedPredictionAnswers": ["rr"],
            },
            {
                "id": "cpu-comparison",
                "version": "1.0.0",
                "title": "调度策略对比",
                "description": "在长短作业混合场景中比较吞吐量和平均等待时间。",
                "difficulty": "comparison",
                "input": {
                    "processes": [
                        {"processId": "P1", "arrivalTime": 0, "burstTime": 8, "priority": 3},
                        {"processId": "P2", "arrivalTime": 0, "burstTime": 2, "priority": 0},
                        {"processId": "P3", "arrivalTime": 1, "burstTime": 5, "priority": 2},
                        {"processId": "P4", "arrivalTime": 3, "burstTime": 1, "priority": 1},
                    ],
                    "timeQuantum": 3,
                },
                "expectedFingerprint": "a3lab-result.v1|cpu-scheduling|cpu-comparison|1.0.0|fcfs=cpu:c520046f25bbe4058d2c61bb25cf3993|priority=cpu:57d269d19173abad556bee5c445df657|rr=cpu:44f8caf514cdb0142bb833f80448a7c3|sjf=cpu:c5a8240ff2540e9cfb5327992901740a",
                "expectedPredictionAnswers": ["sjf", "priority"],
            },
        ],
    },
    {
        "id": "page-replacement",
        "version": "1.0.0",
        "title": "页面置换算法实验",
        "description": "跟踪页面帧状态，比较不同置换策略的缺页次数和命中率。",
        "estimatedMinutes": 20,
        "knowledgePointCodes": ["OS.MEMORY.VIRTUAL", "OS.MEMORY.PAGE_REPLACEMENT"],
        "algorithms": ["fifo", "lru", "opt"],
        "presets": [
            {
                "id": "page-foundation",
                "version": "1.0.0",
                "title": "基础页面置换",
                "description": "通过短引用串理解装入、命中和置换过程。",
                "difficulty": "foundation",
                "input": {"referenceString": [7, 0, 1, 2, 0, 3, 0, 4], "frameCount": 3},
                "expectedFingerprint": "a3lab-result.v1|page-replacement|page-foundation|1.0.0|fifo=page:ddb7ec42ee7271e8f2b64b3598b02071|lru=page:e6261a9ff4c93c9e155d46b7ac3d2c4f|opt=page:6a2a2b63a239393fc7e42ae9f272b050",
                "expectedPredictionAnswers": ["lru", "opt"],
            },
            {
                "id": "page-misconception",
                "version": "1.0.0",
                "title": "更多页框不总是更少缺页",
                "description": "使用经典引用串观察 FIFO 算法的 Belady 异常。",
                "difficulty": "misconception",
                "input": {"referenceString": [1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5], "frameCount": 3},
                "expectedFingerprint": "a3lab-result.v1|page-replacement|page-misconception|1.0.0|fifo=page:df3134e293ed4900e05c770dca6d45d2|lru=page:fa5becb4f88650e18823419b40c516a0|opt=page:2aca00a926f42393b0a113ddc296f493",
                "expectedPredictionAnswers": ["opt"],
            },
            {
                "id": "page-comparison",
                "version": "1.0.0",
                "title": "置换策略对比",
                "description": "比较 FIFO、LRU 和 OPT 在局部性引用串中的表现。",
                "difficulty": "comparison",
                "input": {"referenceString": [2, 3, 2, 1, 5, 2, 4, 5, 3, 2, 5, 2], "frameCount": 3},
                "expectedFingerprint": "a3lab-result.v1|page-replacement|page-comparison|1.0.0|fifo=page:bccf1310cb40cf798f55f0f3485294cb|lru=page:2016723a3a830b028d97be8b2d1d6477|opt=page:653fe5f21922da90794bfb2e467c9c08",
                "expectedPredictionAnswers": ["opt"],
            },
        ],
    },
)


def list_algorithm_labs(user) -> dict:
    events = list(
        LearningEvent.objects.filter(user=user, event_type="algorithm_lab_completed")
        .order_by("-created_at", "-id")
    )
    events_by_lab: dict[str, list[LearningEvent]] = defaultdict(list)
    for event in events:
        events_by_lab[event.target_id].append(event)

    labs = []
    for lab in _LABS:
        lab_events = events_by_lab.get(lab["id"], [])
        scores = [float(event.score) for event in lab_events if event.score is not None]
        latest = lab_events[0] if lab_events else None
        labs.append(
            {
                **_public_lab(lab),
                "progress": {
                    "completed": bool(lab_events),
                    "bestScore": round(max(scores), 1) if scores else None,
                    "lastCompletedAt": latest.created_at.isoformat() if latest else None,
                    "verifiedRuns": sum(_event_verified(event) for event in lab_events),
                },
                "recentSession": _serialize_completion(latest) if latest else None,
            }
        )
    return {"schemaVersion": ALGORITHM_LAB_SCHEMA_VERSION, "labs": labs}


def complete_algorithm_lab(user, payload) -> dict:
    normalized = _normalize_completion(payload)
    lab = _get_lab(normalized["labId"])
    if lab is None or lab["version"] != normalized["labVersion"]:
        raise ValueError("实验或版本不存在")
    supported_algorithms = lab["algorithms"]
    _validate_algorithms(normalized["selectedAlgorithms"], supported_algorithms)
    preset = _get_preset(lab, normalized["presetId"], normalized["presetVersion"])
    if not normalized["customInput"] and preset is None:
        raise ValueError("标准预设或版本不存在")

    verified = bool(
        not normalized["customInput"]
        and preset is not None
        and set(normalized["selectedAlgorithms"]) == set(supported_algorithms)
        and normalized["resultFingerprint"] == preset["expectedFingerprint"]
    )
    score = _derived_score(normalized["checkpoints"], normalized["metrics"])
    prediction = _server_prediction(normalized["prediction"], preset, verified)
    metadata = {
        "schemaVersion": ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION,
        "labVersion": normalized["labVersion"],
        "presetId": normalized["presetId"],
        "presetVersion": normalized["presetVersion"],
        "customInput": normalized["customInput"],
        "selectedAlgorithms": normalized["selectedAlgorithms"],
        "prediction": prediction,
        "checkpoints": {"answered": normalized["checkpoints"]["answered"], "correct": normalized["checkpoints"]["correct"]},
        "metrics": {
            "durationSec": normalized["metrics"]["durationSec"],
            "replayCount": normalized["metrics"]["replayCount"],
            "reviewedCount": len(normalized["metrics"]["reviewedStepIndexes"]),
            "reviewedStepIndexes": normalized["metrics"]["reviewedStepIndexes"],
        },
        "resultFingerprint": normalized["resultFingerprint"],
    }
    quality = {
        "verified": verified,
        "masteryEvidenceAccepted": verified,
        "nextAction": "assessment" if verified and score >= 80 else "replay_lab",
    }
    with transaction.atomic():
        locked_user = user.__class__.objects.select_for_update().get(pk=user.pk)
        existing = LearningEvent.objects.filter(user=locked_user, event_id=normalized["eventId"]).first()
        if existing:
            if _is_same_completion(existing, normalized):
                return {"status": "duplicate", "completion": _serialize_completion(existing)}
            raise AlgorithmLabCompletionConflict("该事件 ID 已用于其他学习操作")
        event_result = ingest_learning_event_v2(
            locked_user,
            {
                "schemaVersion": LEARNING_EVENT_SCHEMA_V2,
                "eventId": normalized["eventId"],
                "eventType": "algorithm_lab_completed",
                "targetType": "algorithm_lab",
                "targetId": normalized["labId"],
                "resourceType": "interactive_lab",
                "durationSec": normalized["metrics"]["durationSec"],
                "score": score,
                "quality": quality,
                "metadata": metadata,
                "sourcePage": f"/a3/labs/{normalized['labId']}",
            },
            trusted=True,
        )
    return {"status": event_result["status"], "completion": _serialize_completion(event_result["event"])}


def build_algorithm_lab_effect(user, days=30) -> dict:
    safe_days = max(1, min(_integer(days, 30), 365))
    started_at = timezone.now() - timedelta(days=safe_days)
    events = list(
        LearningEvent.objects.filter(
            user=user,
            event_type="algorithm_lab_completed",
            created_at__gte=started_at,
        ).order_by("-created_at", "-id")
    )
    by_lab: dict[str, dict] = {}
    totals = _empty_effect_counts()
    for event in events:
        counts = by_lab.setdefault(event.target_id, {"labId": event.target_id, **_empty_effect_counts()})
        _add_effect_event(totals, event)
        _add_effect_event(counts, event)
    return {
        "schemaVersion": ALGORITHM_LAB_EFFECT_SCHEMA_VERSION,
        "timeWindowDays": safe_days,
        **totals,
        "byLab": sorted(by_lab.values(), key=lambda item: item["labId"]),
    }


def _public_lab(lab: dict) -> dict:
    return {
        key: value
        for key, value in lab.items()
        if key != "presets"
    } | {
        "presets": [
            {key: value for key, value in preset.items() if not key.startswith("expected")}
            for preset in lab["presets"]
        ]
    }


def _normalize_completion(payload: Any) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("完成数据必须是对象")
    if "steps" in payload:
        raise ValueError("完成数据不允许提交步骤明细")
    if payload.get("schemaVersion") != ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION:
        raise ValueError("完成数据 schemaVersion 无效")
    event_id = _required_string(payload.get("eventId"), "事件 ID", 128)
    lab_id = _required_string(payload.get("labId"), "实验 ID", 64)
    lab_version = _required_string(payload.get("labVersion"), "实验版本", 32)
    custom_input = payload.get("customInput")
    if type(custom_input) is not bool:
        raise ValueError("customInput 必须是布尔值")
    preset_id = _optional_string(payload.get("presetId"), "预设 ID", 64)
    preset_version = _optional_string(payload.get("presetVersion"), "预设版本", 32)
    algorithms = payload.get("selectedAlgorithms")
    if not isinstance(algorithms, list) or not algorithms:
        raise ValueError("至少选择一种算法")
    if not all(isinstance(algorithm, str) and algorithm.strip() for algorithm in algorithms):
        raise ValueError("算法列表无效")
    prediction = _normalize_prediction(payload.get("prediction"))
    checkpoints = _normalize_checkpoints(payload.get("checkpoints"))
    metrics = _normalize_metrics(payload.get("metrics"))
    fingerprint = _required_string(payload.get("resultFingerprint"), "结果指纹", 1024)
    return {
        "eventId": event_id,
        "labId": lab_id,
        "labVersion": lab_version,
        "presetId": preset_id,
        "presetVersion": preset_version,
        "customInput": custom_input,
        "selectedAlgorithms": [algorithm.strip() for algorithm in algorithms],
        "prediction": prediction,
        "checkpoints": checkpoints,
        "metrics": metrics,
        "resultFingerprint": fingerprint,
    }


def _normalize_prediction(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("预测数据必须是对象")
    answer = value.get("answer")
    skipped = value.get("skipped")
    if not isinstance(answer, str) or len(answer) > 32:
        raise ValueError("预测答案必须是不超过 32 个字符的字符串")
    if type(skipped) is not bool:
        raise ValueError("预测跳过状态必须是布尔值")
    if "correct" in value:
        if type(value["correct"]) is not bool:
            raise ValueError("预测正确性必须是布尔值")
    return {"answer": answer.strip(), "skipped": skipped}


def _normalize_checkpoints(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("检查点数据必须是对象")
    answered = _bounded_integer(value.get("answered"), "检查点已答数量", 0, 20)
    correct = _bounded_integer(value.get("correct"), "检查点正确数量", 0, 20)
    if correct > answered:
        raise ValueError("检查点正确数量不能超过已答数量")
    items = value.get("items")
    if not isinstance(items, list) or len(items) > 20:
        raise ValueError("检查点明细最多 20 项")
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("检查点明细必须是对象")
        if not isinstance(item.get("id"), str) or len(item["id"]) > 64:
            raise ValueError("检查点 ID 必须是不超过 64 个字符的字符串")
        if type(item.get("correct")) is not bool:
            raise ValueError("检查点正确性必须是布尔值")
    derived_answered = len(items)
    derived_correct = sum(item["correct"] for item in items)
    if answered != derived_answered or correct != derived_correct:
        raise ValueError("检查点汇总必须与明细一致")
    return {"answered": derived_answered, "correct": derived_correct, "items": items}


def _normalize_metrics(value: Any) -> dict:
    if not isinstance(value, dict):
        raise ValueError("指标数据必须是对象")
    score = _number(value.get("score"), "得分", 0, 100)
    duration = _bounded_integer(value.get("durationSec"), "实验时长", 0, 86400)
    replay_count = _bounded_integer(value.get("replayCount"), "重放次数", 0, 100)
    indexes = value.get("reviewedStepIndexes")
    if not isinstance(indexes, list) or len(indexes) > 50:
        raise ValueError("复习步骤最多 50 项")
    if any(type(index) is not int or index < 0 or index > 10000 for index in indexes) or len(set(indexes)) != len(indexes):
        raise ValueError("复习步骤索引无效")
    return {"score": score, "durationSec": duration, "replayCount": replay_count, "reviewedStepIndexes": indexes}


def _validate_algorithms(selected: list[str], supported: list[str]) -> None:
    if len(selected) > len(supported) or len(selected) != len(set(selected)):
        raise ValueError("算法选择数量或重复项无效")
    if any(algorithm not in supported for algorithm in selected):
        raise ValueError("包含不支持的算法")


def _get_lab(lab_id: str) -> dict | None:
    return next((lab for lab in _LABS if lab["id"] == lab_id), None)


def _get_preset(lab: dict, preset_id: str, preset_version: str) -> dict | None:
    return next(
        (preset for preset in lab["presets"] if preset["id"] == preset_id and preset["version"] == preset_version),
        None,
    )


def _server_prediction(prediction: dict, preset: dict | None, verified: bool) -> dict:
    result = {"answer": prediction["answer"], "skipped": prediction["skipped"]}
    if verified and preset is not None:
        expected_answers = set(preset["expectedPredictionAnswers"])
        result["correct"] = not prediction["skipped"] and _prediction_answer_key(prediction["answer"]) in expected_answers
    return result


def _prediction_answer_key(answer: str) -> str:
    return answer.strip().casefold()


def _is_same_completion(event: LearningEvent, normalized: dict) -> bool:
    metadata = event.metadata if isinstance(event.metadata, dict) else {}
    return (
        event.event_type == "algorithm_lab_completed"
        and event.target_type == "algorithm_lab"
        and event.target_id == normalized["labId"]
        and metadata.get("labVersion") == normalized["labVersion"]
        and metadata.get("presetId") == normalized["presetId"]
        and metadata.get("presetVersion") == normalized["presetVersion"]
    )


def _serialize_completion(event: LearningEvent) -> dict:
    metadata = event.metadata if isinstance(event.metadata, dict) else {}
    quality = event.quality if isinstance(event.quality, dict) else {}
    score = float(event.score) if event.score is not None else 0
    verified = bool(quality.get("verified", False))
    return {
        "schemaVersion": metadata.get("schemaVersion", ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION),
        "eventId": event.event_id,
        "labId": event.target_id,
        "labVersion": metadata.get("labVersion", ""),
        "presetId": metadata.get("presetId", ""),
        "presetVersion": metadata.get("presetVersion", ""),
        "customInput": bool(metadata.get("customInput", False)),
        "selectedAlgorithms": metadata.get("selectedAlgorithms", []),
        "prediction": metadata.get("prediction", {}),
        "checkpoints": metadata.get("checkpoints", {"answered": 0, "correct": 0}),
        "score": score,
        "metrics": {"score": score, **(metadata.get("metrics", {}))},
        "verified": verified,
        "masteryEvidenceAccepted": bool(quality.get("masteryEvidenceAccepted", False)),
        "nextAction": _completion_next_action(event.target_id, verified, score),
        "completedAt": event.created_at.isoformat(),
    }


def _completion_next_action(lab_id: str, verified: bool, score: float) -> dict:
    topic = _LAB_ASSESSMENT_TOPICS.get(lab_id)
    if verified and score >= 80 and topic:
        return {
            "type": "assessment",
            "label": f"开始{topic}专项测评",
            "href": f"/a3/assessment?practice={topic}",
            "reason": f"实验结果已验证且得分不低于 80 分，建议进行{topic}专项测评。",
        }
    lab = _get_lab(lab_id)
    title = lab["title"] if lab else "当前实验"
    return {
        "type": "replay_lab",
        "label": f"重新完成 {title}",
        "href": f"/a3/labs/{lab_id}",
        "reason": "需要获得已验证且不低于 80 分的实验结果后再进入专项测评。",
    }


def _derived_score(checkpoints: dict, metrics: dict) -> float:
    if checkpoints["answered"]:
        return round(checkpoints["correct"] * 100 / checkpoints["answered"], 1)
    return metrics["score"]


def _event_verified(event: LearningEvent) -> int:
    return int(isinstance(event.quality, dict) and event.quality.get("verified") is True)


def _empty_effect_counts() -> dict:
    return {
        "completed": 0,
        "verified": 0,
        "prediction": {"answered": 0, "correct": 0},
        "checkpoints": {"answered": 0, "correct": 0},
        "reviewed": 0,
    }


def _add_effect_event(counts: dict, event: LearningEvent) -> None:
    metadata = event.metadata if isinstance(event.metadata, dict) else {}
    prediction = metadata.get("prediction") if isinstance(metadata.get("prediction"), dict) else {}
    checkpoints = metadata.get("checkpoints") if isinstance(metadata.get("checkpoints"), dict) else {}
    metrics = metadata.get("metrics") if isinstance(metadata.get("metrics"), dict) else {}
    counts["completed"] += 1
    counts["verified"] += _event_verified(event)
    if _event_verified(event) and prediction.get("skipped") is False:
        counts["prediction"]["answered"] += 1
        counts["prediction"]["correct"] += int(prediction.get("correct") is True)
    counts["checkpoints"]["answered"] += _integer(checkpoints.get("answered"), 0)
    counts["checkpoints"]["correct"] += _integer(checkpoints.get("correct"), 0)
    counts["reviewed"] += _integer(metrics.get("reviewedCount"), 0)


def _required_string(value: Any, field: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > max_length:
        raise ValueError(f"{field}不能为空且不能超过 {max_length} 个字符")
    return value.strip()


def _optional_string(value: Any, field: str, max_length: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value.strip()) > max_length:
        raise ValueError(f"{field}必须是不超过 {max_length} 个字符的字符串")
    return value.strip()


def _bounded_integer(value: Any, field: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError(f"{field}必须是 {minimum} 到 {maximum} 之间的整数")
    return value


def _number(value: Any, field: str, minimum: int, maximum: int) -> float:
    if type(value) not in {int, float} or not isfinite(value) or value < minimum or value > maximum:
        raise ValueError(f"{field}必须是 {minimum} 到 {maximum} 之间的数字")
    return float(value)


def _integer(value: Any, default: int) -> int:
    return value if type(value) is int else default
