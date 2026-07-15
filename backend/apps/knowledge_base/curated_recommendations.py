from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from django.db.models import Prefetch, Q, QuerySet

from backend.apps.assessments.models import WrongQuestion
from backend.apps.knowledge_base.models import (
    CuratedLearningResource,
    CuratedResourceDeliveryMode,
    CuratedResourceDifficulty,
    CuratedResourceType,
    CuratedResourceVerificationStatus,
    KnowledgeBlock,
)
from backend.apps.learning.models import LearningEvent, LearningPath, LearningPathStatus, PathItemStatus


@dataclass(frozen=True)
class CuratedResourceMatch:
    resource: CuratedLearningResource
    score: float
    reason: str
    matched_knowledge_points: tuple[str, ...]
    matched_triggers: tuple[str, ...]
    ranking_basis: tuple[dict, ...]


class CuratedResourceMatcher:
    """Deterministic matcher for platform-managed learning resources."""

    def match(self, user, *, queryset: QuerySet | None = None, limit: int | None = None) -> list[CuratedResourceMatch]:
        resources = list((queryset or eligible_curated_resources()).select_related("course", "knowledge_resource"))
        profile = getattr(user, "learner_profile", None)
        active_points = self._active_path_points(user)
        wrong_points = self._wrong_question_points(user)
        event_counts = self._resource_event_counts(user)

        matches = [
            self._score_resource(
                resource,
                profile=profile,
                active_points=active_points,
                wrong_points=wrong_points,
                event_counts=event_counts.get(resource.resource_code, Counter()),
            )
            for resource in resources
        ]
        matches.sort(key=lambda item: (-item.score, item.resource.resource_code))
        return matches[: max(0, int(limit))] if limit is not None else matches

    @staticmethod
    def _active_path_points(user) -> dict[str, str]:
        paths = LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE).prefetch_related(
            "items__knowledge_point"
        )
        points: dict[str, str] = {}
        for path in paths:
            for item in path.items.all():
                if item.status == PathItemStatus.CURRENT:
                    points[str(item.knowledge_point_id)] = item.knowledge_point.title
        return points

    @staticmethod
    def _wrong_question_points(user) -> dict[str, dict]:
        rows = WrongQuestion.objects.filter(user=user, mastered=False).values_list(
            "question__knowledge_point_id",
            "question__knowledge_point__title",
            "wrong_count",
        )
        points: dict[str, dict] = {}
        for point_id, title, wrong_count in rows:
            key = str(point_id)
            current = points.setdefault(key, {"title": title, "wrongCount": 0})
            current["wrongCount"] += int(wrong_count or 1)
        return points

    @staticmethod
    def _resource_event_counts(user) -> dict[str, Counter]:
        rows = LearningEvent.objects.filter(
            user=user,
            target_type="curated_resource",
            event_type__in=["resource_opened", "resource_completed", "resource_skipped", "resource_favorited"],
        ).values_list("target_id", "event_type")
        result: dict[str, Counter] = {}
        for target_id, event_type in rows:
            result.setdefault(str(target_id), Counter())[str(event_type)] += 1
        return result

    def _score_resource(
        self,
        resource: CuratedLearningResource,
        *,
        profile,
        active_points: dict[str, str],
        wrong_points: dict[str, dict],
        event_counts: Counter,
    ) -> CuratedResourceMatch:
        point_pairs = [(str(point.id), point.title) for point in resource.knowledge_points.all()]
        point_titles = [title for _, title in point_pairs]
        searchable = " ".join(
            [
                resource.title,
                resource.summary,
                resource.key_segment,
                *point_titles,
                *[str(item) for item in (resource.keywords or [])],
                *[str(item) for item in (resource.weakness_triggers or [])],
            ]
        ).lower()
        score = 35.0
        triggers: list[str] = []
        matched_points: list[str] = []
        basis: list[dict] = []

        current_matches = [title for point_id, title in point_pairs if point_id in active_points]
        if current_matches:
            score += 30
            triggers.append("current_path")
            matched_points.extend(current_matches)
            basis.append({"label": "当前路径知识点", "value": current_matches})

        wrong_matches = [wrong_points[point_id] for point_id, _ in point_pairs if point_id in wrong_points]
        if wrong_matches:
            wrong_count = sum(int(item["wrongCount"]) for item in wrong_matches)
            score += min(20, 6 + wrong_count * 4)
            triggers.append("wrong_question")
            matched_points.extend(str(item["title"]) for item in wrong_matches)
            basis.append({"label": "未掌握错题", "value": wrong_count})

        weak_points = _string_list(getattr(profile, "weak_points", []))
        weak_matches = [item for item in weak_points if item.lower() in searchable or any(token in item for token in point_titles)]
        if weak_matches:
            score += min(18, 10 + len(weak_matches) * 4)
            triggers.append("profile_weak_point")
            matched_points.extend(weak_matches)
            basis.append({"label": "画像薄弱点", "value": weak_matches})

        goals = _string_list(getattr(profile, "learning_goals", []))
        goal_matches = [item for item in goals if _has_shared_terms(item, searchable)]
        if goal_matches:
            score += min(10, 5 + len(goal_matches) * 2)
            triggers.append("learning_goal")
            basis.append({"label": "学习目标", "value": goal_matches})

        expected_resources = _string_list(getattr(profile, "expected_resources", []))
        resource_type_label = resource.get_resource_type_display()
        preference_matches = [
            item for item in expected_resources if item in resource_type_label or item.lower() in resource.resource_type.lower()
        ]
        if preference_matches:
            score += 8
            triggers.append("resource_preference")
            basis.append({"label": "资源偏好", "value": preference_matches})

        foundation_level = str(getattr(profile, "foundation_level", "") or "")
        if _difficulty_fits_foundation(resource.difficulty, foundation_level):
            score += 5
            triggers.append("difficulty_fit")
            basis.append({"label": "基础水平适配", "value": foundation_level or "未设置"})

        daily_minutes = int(getattr(profile, "daily_study_time", 0) or 0)
        if daily_minutes and resource.estimated_minutes <= daily_minutes:
            score += 7
            triggers.append("daily_time_fit")
            basis.append({"label": "每日时间适配", "value": f"{resource.estimated_minutes}/{daily_minutes} 分钟"})
        elif daily_minutes:
            score -= min(8, max(2, (resource.estimated_minutes - daily_minutes) / 5))
            basis.append({"label": "建议拆分学习", "value": f"预计 {resource.estimated_minutes} 分钟"})

        if event_counts["resource_favorited"]:
            score += 6
            triggers.append("previously_favorited")
            basis.append({"label": "历史收藏", "value": event_counts["resource_favorited"]})
        if event_counts["resource_completed"]:
            penalty = min(45, event_counts["resource_completed"] * 35)
            score -= penalty
            triggers.append("recently_completed")
            basis.append({"label": "近期已完成降权", "value": -penalty})
        if event_counts["resource_skipped"]:
            penalty = min(30, event_counts["resource_skipped"] * 12)
            score -= penalty
            triggers.append("repeatedly_skipped")
            basis.append({"label": "历史跳过降权", "value": -penalty})

        unique_points = tuple(dict.fromkeys(item for item in matched_points if item))
        unique_triggers = tuple(dict.fromkeys(triggers))
        reason = _recommendation_reason(resource, unique_points, unique_triggers)
        return CuratedResourceMatch(
            resource=resource,
            score=round(max(0, min(score, 100)), 1),
            reason=reason,
            matched_knowledge_points=unique_points,
            matched_triggers=unique_triggers,
            ranking_basis=tuple(basis),
        )


def eligible_curated_resources() -> QuerySet:
    return (
        CuratedLearningResource.objects.filter(
            is_active=True,
            verification_status=CuratedResourceVerificationStatus.VERIFIED,
        )
        .select_related("course", "knowledge_resource")
        .prefetch_related("knowledge_points")
    )


def filter_curated_resources(queryset: QuerySet, *, resource_type: str = "", difficulty: str = "", query: str = "") -> QuerySet:
    if resource_type:
        queryset = queryset.filter(resource_type=resource_type)
    if difficulty:
        queryset = queryset.filter(difficulty=difficulty)
    if query:
        queryset = queryset.filter(
            Q(title__icontains=query)
            | Q(summary__icontains=query)
            | Q(key_segment__icontains=query)
            | Q(knowledge_points__title__icontains=query)
            | Q(knowledge_points__code__icontains=query)
        ).distinct()
    return queryset


def serialize_curated_resource(match: CuratedResourceMatch, *, include_content: bool = False) -> dict:
    resource = match.resource
    is_internal = resource.delivery_mode == CuratedResourceDeliveryMode.INTERNAL_DOCUMENT
    action_href = (
        f"/api/kb/library/{resource.resource_code}/content/"
        if is_internal
        else resource.external_url
    )
    payload = {
        "resourceCode": resource.resource_code,
        "title": resource.title,
        "resourceType": resource.resource_type,
        "resourceTypeLabel": resource.get_resource_type_display(),
        "deliveryMode": resource.delivery_mode,
        "deliveryModeLabel": resource.get_delivery_mode_display(),
        "summary": resource.summary,
        "provider": resource.provider,
        "course": {"code": resource.course.code, "title": resource.course.title},
        "difficulty": resource.difficulty,
        "difficultyLabel": resource.get_difficulty_display(),
        "estimatedMinutes": resource.estimated_minutes,
        "keySegment": resource.key_segment,
        "knowledgePoints": [
            {"id": str(point.id), "code": point.code, "title": point.title}
            for point in resource.knowledge_points.all()
        ],
        "prerequisites": _string_list(resource.prerequisites),
        "learnerProfiles": _string_list(resource.learner_profiles),
        "learningObjectives": _string_list(resource.learning_objectives),
        "completionCriteria": _string_list(resource.completion_criteria),
        "isFree": resource.is_free,
        "personalization": {
            "score": match.score,
            "reason": match.reason,
            "matchedKnowledgePoints": list(match.matched_knowledge_points),
            "matchedTriggers": list(match.matched_triggers),
            "rankingBasis": list(match.ranking_basis),
        },
        "action": {
            "label": "站内阅读文档" if is_internal else "打开外部视频",
            "href": action_href,
            "external": not is_internal,
        },
        "verification": {
            "status": resource.verification_status,
            "catalogVerified": resource.verification_status == CuratedResourceVerificationStatus.VERIFIED,
            "citationEligible": bool(is_internal and resource.knowledge_resource_id),
            "note": (
                "站内文档已关联知识库，可作为检索与引用来源。"
                if is_internal
                else "仅核验资源目录和链接；没有字幕或转写证据时，不作为回答引用。"
            ),
            "verifiedAt": resource.verified_at.isoformat() if resource.verified_at else None,
        },
    }
    if include_content:
        payload["contentPreview"] = _content_preview(resource)
    return payload


def curated_resource_summary(queryset: QuerySet) -> dict:
    counts = Counter(queryset.values_list("resource_type", flat=True))
    documents = counts[CuratedResourceType.LECTURE_DOC] + counts[CuratedResourceType.CODE_LAB]
    return {
        "total": sum(counts.values()),
        "documents": documents,
        "videos": counts[CuratedResourceType.VIDEO],
    }


def _content_preview(resource: CuratedLearningResource) -> list[dict]:
    if not resource.knowledge_resource_id:
        return []
    blocks = KnowledgeBlock.objects.filter(resource_id=resource.knowledge_resource_id).exclude(
        Q(markdown="") & Q(text="")
    )[:8]
    return [
        {
            "modality": block.modality,
            "markdown": (block.markdown or block.text)[:4000],
            "confidence": round(float(block.confidence or 0), 3),
        }
        for block in blocks
    ]


def _recommendation_reason(resource: CuratedLearningResource, points: tuple[str, ...], triggers: tuple[str, ...]) -> str:
    parts = []
    if points:
        parts.append(f"匹配你的薄弱知识点：{'、'.join(points[:3])}")
    if "wrong_question" in triggers:
        parts.append("近期错题尚未掌握")
    if "current_path" in triggers:
        parts.append("对应当前学习路径")
    if "daily_time_fit" in triggers:
        parts.append(f"可在约 {resource.estimated_minutes} 分钟内完成")
    if "resource_preference" in triggers:
        parts.append(f"符合你偏好的{resource.get_resource_type_display()}")
    return "；".join(parts) or "根据课程知识点、资源难度和学习时长综合匹配"


def _difficulty_fits_foundation(difficulty: str, foundation_level: str) -> bool:
    if any(token in foundation_level for token in ("弱", "基础", "入门")):
        return difficulty == CuratedResourceDifficulty.FOUNDATION
    if any(token in foundation_level for token in ("强", "优秀", "进阶")):
        return difficulty in {CuratedResourceDifficulty.INTERMEDIATE, CuratedResourceDifficulty.ADVANCED}
    return difficulty != CuratedResourceDifficulty.ADVANCED


def _has_shared_terms(value: str, searchable: str) -> bool:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return False
    if normalized in searchable:
        return True
    terms = [term for term in normalized.replace("，", " ").replace("、", " ").split() if len(term) >= 2]
    return any(term in searchable for term in terms)


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]
