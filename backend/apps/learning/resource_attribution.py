from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import timedelta

from django.utils import timezone
from django.db import DatabaseError, ProgrammingError

from backend.apps.learning.models import LearningEvent


RESOURCE_ACTIONS = {
    "resource_opened": "opened",
    "resource_completed": "completed",
    "resource_skipped": "skipped",
    "resource_favorited": "favorited",
}


@dataclass(frozen=True)
class ResourceEffect:
    resource_type: str
    knowledge_point_id: str
    opened: int
    completed: int
    skipped: int
    favorited: int
    open_rate: float
    completion_rate: float
    skip_rate: float
    favorite_rate: float
    practice_conversion_rate: float
    post_assessment_gain: float
    effect_score: float
    effect_confidence: str
    exploration_recommended: bool


def build_resource_effect_attribution(user, *, days: int = 30) -> dict:
    safe_days = max(1, min(_safe_int(days, 30), 365))
    ended_at = timezone.now()
    started_at = ended_at - timedelta(days=safe_days)
    try:
        events = list(
            LearningEvent.objects.filter(user=user, created_at__gte=started_at)
            .order_by("created_at", "id")
        )
    except (DatabaseError, ProgrammingError):
        events = []
    effects = _resource_effects(events)
    return {
        "schemaVersion": "a3.resource-effect-attribution.v1",
        "timeWindow": {
            "days": safe_days,
            "startedAt": started_at.isoformat(),
            "endedAt": ended_at.isoformat(),
        },
        "resourceTypes": [_serialize_effect(effect) for effect in sorted(effects, key=lambda item: item.effect_score, reverse=True)],
        "summary": {
            "resourceEventCount": len([event for event in events if event.event_type in RESOURCE_ACTIONS]),
            "assessmentEventCount": len([event for event in events if event.event_type in {"question_answered", "assessment_submitted"}]),
            "highConfidenceCount": len([effect for effect in effects if effect.effect_confidence == "high"]),
            "explorationCount": len([effect for effect in effects if effect.exploration_recommended]),
        },
    }


def attribution_by_resource_type(report: dict) -> dict[str, dict]:
    items = report.get("resourceTypes") if isinstance(report.get("resourceTypes"), list) else []
    return {
        str(item.get("resourceType") or ""): item
        for item in items
        if isinstance(item, dict) and item.get("resourceType")
    }


def _resource_effects(events: list[LearningEvent]) -> list[ResourceEffect]:
    grouped: dict[tuple[str, str], list[LearningEvent]] = defaultdict(list)
    assessment_events = [event for event in events if event.event_type in {"question_answered", "assessment_submitted"}]
    for event in events:
        if event.event_type not in RESOURCE_ACTIONS:
            continue
        resource_type = event.resource_type or "unknown"
        metadata = event.metadata if isinstance(event.metadata, dict) else {}
        knowledge_point_id = event.knowledge_point_id or str(metadata.get("knowledgePointId") or "")
        grouped[(resource_type, knowledge_point_id)].append(event)

    effects: list[ResourceEffect] = []
    for (resource_type, knowledge_point_id), resource_events in grouped.items():
        counts = {action: 0 for action in RESOURCE_ACTIONS.values()}
        for event in resource_events:
            counts[RESOURCE_ACTIONS[event.event_type]] += 1
        total = sum(counts.values())
        engagement_base = max(1, counts["opened"] + counts["completed"] + counts["skipped"])
        completed_or_skipped = max(1, counts["completed"] + counts["skipped"])
        gain = _post_assessment_gain(resource_events, assessment_events, knowledge_point_id)
        practice_conversion = _practice_conversion_rate(resource_events, assessment_events, knowledge_point_id)
        completion_rate = round(counts["completed"] / completed_or_skipped, 3)
        skip_rate = round(counts["skipped"] / completed_or_skipped, 3)
        favorite_rate = round(counts["favorited"] / max(1, total), 3)
        open_rate = round(counts["opened"] / engagement_base, 3)
        effect_score = round(
            min(
                100,
                max(
                    0,
                    completion_rate * 45
                    + (1 - skip_rate) * 20
                    + favorite_rate * 15
                    + practice_conversion * 10
                    + max(-20, min(40, gain)) * 0.25
                    + min(10, total),
                ),
            ),
            1,
        )
        confidence = _effect_confidence(total, counts["completed"], assessment_events, knowledge_point_id)
        effects.append(
            ResourceEffect(
                resource_type=resource_type,
                knowledge_point_id=knowledge_point_id,
                opened=counts["opened"],
                completed=counts["completed"],
                skipped=counts["skipped"],
                favorited=counts["favorited"],
                open_rate=open_rate,
                completion_rate=completion_rate,
                skip_rate=skip_rate,
                favorite_rate=favorite_rate,
                practice_conversion_rate=practice_conversion,
                post_assessment_gain=gain,
                effect_score=effect_score,
                effect_confidence=confidence,
                exploration_recommended=confidence == "low",
            )
        )
    return effects


def _post_assessment_gain(resource_events: list[LearningEvent], assessment_events: list[LearningEvent], knowledge_point_id: str) -> float:
    if not assessment_events:
        return 0
    first_resource_at = min(event.created_at for event in resource_events)
    relevant = _assessment_for_point(assessment_events, knowledge_point_id)
    before = [_event_score(event) for event in relevant if event.created_at < first_resource_at and event.score is not None]
    after = [_event_score(event) for event in relevant if event.created_at >= first_resource_at and event.score is not None]
    if not before or not after:
        return 0
    return round((sum(after) / len(after)) - (sum(before) / len(before)), 1)


def _practice_conversion_rate(resource_events: list[LearningEvent], assessment_events: list[LearningEvent], knowledge_point_id: str) -> float:
    if not resource_events:
        return 0
    relevant = _assessment_for_point(assessment_events, knowledge_point_id)
    converted = 0
    for event in resource_events:
        converted += int(any(assessment.created_at >= event.created_at for assessment in relevant))
    return round(converted / len(resource_events), 3)


def _assessment_for_point(events: list[LearningEvent], knowledge_point_id: str) -> list[LearningEvent]:
    if not knowledge_point_id:
        return events
    return [event for event in events if str(event.knowledge_point_id or "") == str(knowledge_point_id)]


def _effect_confidence(total_events: int, completed: int, assessment_events: list[LearningEvent], knowledge_point_id: str) -> str:
    relevant_assessments = _assessment_for_point(assessment_events, knowledge_point_id)
    if total_events >= 6 and completed >= 2 and len(relevant_assessments) >= 3:
        return "high"
    if total_events >= 3 or completed >= 1 or len(relevant_assessments) >= 2:
        return "medium"
    return "low"


def _serialize_effect(effect: ResourceEffect) -> dict:
    return {
        "resourceType": effect.resource_type,
        "knowledgePointId": effect.knowledge_point_id,
        "opened": effect.opened,
        "completed": effect.completed,
        "skipped": effect.skipped,
        "favorited": effect.favorited,
        "openRate": effect.open_rate,
        "completionRate": effect.completion_rate,
        "skipRate": effect.skip_rate,
        "favoriteRate": effect.favorite_rate,
        "practiceConversionRate": effect.practice_conversion_rate,
        "postAssessmentGain": effect.post_assessment_gain,
        "historicalEffectiveness": effect.effect_score,
        "effectConfidence": effect.effect_confidence,
        "explorationRecommended": effect.exploration_recommended,
    }


def _event_score(event: LearningEvent) -> float:
    try:
        return float(event.score or 0)
    except (TypeError, ValueError):
        return 0


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
