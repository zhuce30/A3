from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any

from django.utils import timezone

from backend.apps.learning.models import KnowledgePoint, LearningEvent


def build_learning_effect_metrics(user, *, days: int = 30) -> dict:
    safe_days = max(1, min(_safe_int(days, 30), 365))
    now = timezone.now()
    started_at = now - timedelta(days=safe_days)
    events = list(LearningEvent.objects.filter(user=user, created_at__gte=started_at).order_by("created_at", "id"))
    question_events = [event for event in events if event.event_type == "question_answered"]
    knowledge_points = _knowledge_point_effects(question_events)
    behavior = _behavior_metrics(events)
    assessment = _assessment_metrics(question_events, events)
    trends = {
        "sevenDay": _window_metrics(events, now, 7),
        "fourteenDay": _window_metrics(events, now, 14),
        "thirtyDay": _window_metrics(events, now, 30),
    }
    confidence, missing = _confidence_and_missing(events, question_events, knowledge_points)
    overall = _overall_effect_score(knowledge_points, behavior, assessment)
    return {
        "overallEffectScore": overall,
        "confidence": confidence,
        "missingEvidence": missing,
        "timeWindow": {
            "days": safe_days,
            "startedAt": started_at.date().isoformat(),
            "endedAt": now.date().isoformat(),
        },
        "behavior": behavior,
        "assessment": assessment,
        "knowledgePoints": knowledge_points,
        "trends": trends,
        "baseline": {
            "type": "self_history",
            "planExpectedCompletionRate": 0.8,
            "actualCompletionRate": behavior["taskCompletionRate"],
        },
    }


def _knowledge_point_effects(question_events: list[LearningEvent]) -> list[dict]:
    grouped: dict[str, list[LearningEvent]] = defaultdict(list)
    for event in question_events:
        if event.knowledge_point_id:
            grouped[event.knowledge_point_id].append(event)
    points = {str(point.id): point for point in KnowledgePoint.objects.filter(id__in=list(grouped.keys()))}
    effects = []
    for point_id, events in grouped.items():
        ordered = sorted(events, key=lambda item: (item.created_at, str(item.id)))
        scores = [_event_score(event) for event in ordered]
        correct = sum(1 for event in ordered if _event_correct(event))
        wrong_count = len(ordered) - correct
        review_count = sum(1 for event in ordered if str((event.metadata or {}).get("source") or "") == "review")
        pre_score = round(sum(scores[:1]) / len(scores[:1])) if scores else 0
        post_scores = scores[-2:] if len(scores) >= 2 else scores
        post_score = round(sum(post_scores) / len(post_scores)) if post_scores else 0
        learning_gain = post_score - pre_score
        confidence = _knowledge_confidence(len(ordered))
        effects.append(
            {
                "knowledgePointId": point_id,
                "name": points[point_id].title if point_id in points else point_id,
                "preScore": pre_score,
                "postScore": post_score,
                "learningGain": learning_gain,
                "attemptCount": len(ordered),
                "correctRate": round(correct / len(ordered), 3) if ordered else 0,
                "wrongCount": wrong_count,
                "reviewCount": review_count,
                "lastPracticedAt": ordered[-1].created_at.isoformat() if ordered else "",
                "trend": _trend_from_gain(learning_gain),
                "confidence": confidence,
                "evidence": _knowledge_evidence(len(ordered), wrong_count, review_count),
            }
        )
    return sorted(effects, key=lambda item: (item["confidence"] != "high", -abs(item["learningGain"]), item["name"]))[:10]


def _behavior_metrics(events: list[LearningEvent]) -> dict:
    active_days = len({event.created_at.date().isoformat() for event in events})
    task_events = [event for event in events if event.event_type.startswith("task_")]
    completed_tasks = len([event for event in events if event.event_type == "task_completed"])
    return {
        "activeDays": active_days,
        "totalDurationSec": sum(max(0, int(event.duration_sec or 0)) for event in events),
        "taskCompletionRate": round(completed_tasks / len(task_events), 3) if task_events else 0,
        "completedTaskCount": completed_tasks,
        "taskEventCount": len(task_events),
        "reflectionCount": len([event for event in events if event.event_type == "reflection_submitted"]),
        "eventCount": len(events),
    }


def _assessment_metrics(question_events: list[LearningEvent], events: list[LearningEvent]) -> dict:
    scores = [_event_score(event) for event in question_events]
    correct = sum(1 for event in question_events if _event_correct(event))
    return {
        "attemptCount": len(question_events),
        "averageScore": round(sum(scores) / len(scores), 1) if scores else 0,
        "correctRate": round(correct / len(question_events), 3) if question_events else 0,
        "wrongQuestionCount": len([event for event in events if event.event_type == "wrong_question_added"]),
        "reviewedWrongQuestionCount": len([event for event in events if event.event_type == "wrong_question_reviewed"]),
    }


def _window_metrics(events: list[LearningEvent], now, days: int) -> dict:
    window_start = now - timedelta(days=days)
    scoped = [event for event in events if event.created_at >= window_start]
    question_events = [event for event in scoped if event.event_type == "question_answered"]
    behavior = _behavior_metrics(scoped)
    assessment = _assessment_metrics(question_events, scoped)
    return {
        "days": days,
        "behavior": behavior,
        "assessment": assessment,
    }


def _confidence_and_missing(events: list[LearningEvent], question_events: list[LearningEvent], knowledge_points: list[dict]) -> tuple[str, list[str]]:
    missing = []
    if len(question_events) < 3:
        missing.append("近 30 天测评数据不足")
    if len(events) < 3:
        missing.append("近 30 天学习事件不足")
    if not knowledge_points:
        missing.append("缺少知识点级作答证据")
    if len(question_events) >= 3 and knowledge_points:
        return "high", missing
    if question_events or len(events) >= 3:
        return "medium", missing
    return "low", missing


def _overall_effect_score(knowledge_points: list[dict], behavior: dict, assessment: dict) -> int:
    if not knowledge_points and not assessment["attemptCount"]:
        return 0
    post_score = round(sum(item["postScore"] for item in knowledge_points) / len(knowledge_points)) if knowledge_points else assessment["averageScore"]
    completion = int(round(behavior["taskCompletionRate"] * 100))
    activity = min(100, behavior["activeDays"] * 12)
    return int(round((post_score * 0.6) + (completion * 0.25) + (activity * 0.15)))


def _event_score(event: LearningEvent) -> float:
    if event.score is None:
        return 0
    try:
        return float(event.score)
    except (TypeError, ValueError):
        return 0


def _event_correct(event: LearningEvent) -> bool:
    quality = event.quality if isinstance(event.quality, dict) else {}
    if "isCorrect" in quality:
        return bool(quality.get("isCorrect"))
    return _event_score(event) >= 60


def _knowledge_confidence(attempt_count: int) -> str:
    if attempt_count >= 3:
        return "high"
    if attempt_count >= 1:
        return "medium"
    return "low"


def _knowledge_evidence(attempt_count: int, wrong_count: int, review_count: int) -> list[str]:
    evidence = []
    if attempt_count:
        evidence.append("assessment")
    if wrong_count:
        evidence.append("wrong_notebook")
    if review_count:
        evidence.append("review")
    return evidence


def _trend_from_gain(gain: int | float) -> str:
    if gain > 5:
        return "improving"
    if gain < -5:
        return "declining"
    return "stable"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
