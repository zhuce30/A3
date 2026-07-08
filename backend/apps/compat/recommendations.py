from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

from backend.apps.assessments.models import WrongQuestion
from backend.apps.knowledge_base.display import format_source_display_location, format_source_type_label, safe_source_filename, source_origin_label
from backend.apps.learning.models import LearningPath, LearningPathStatus
from backend.apps.learning.resource_attribution import attribution_by_resource_type, build_resource_effect_attribution
from backend.apps.learning.services import classroom_context
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.services import public_profile
from backend.domains.knowledge_base.retriever import search_knowledge_base


@dataclass(frozen=True)
class RecommendationSeed:
    title: str
    resource_type: str
    href: str
    score: float
    reason: str
    source: dict | None = None
    evidence: dict | None = None


def build_recommendation_payload(user, *, goal: str = "", top_k: int = 6, retrieval_mode: str = "fast") -> dict:
    profile = getattr(user, "learner_profile", None)
    snapshot = profile_snapshot_for_user(user)
    context = classroom_context(user)
    target = context.get("target") or {}
    query = _recommendation_query(profile, target, goal)
    normalized_mode = "deep" if retrieval_mode == "deep" else "fast"
    sources = _search_sources(context, query=query, top_k=max(top_k, 5), retrieval_mode=normalized_mode)

    seeds = _source_recommendations(sources, profile, target)
    seeds.extend(_path_recommendations(user, profile, target))
    seeds.extend(_wrong_question_recommendations(user))
    attribution_report = build_resource_effect_attribution(user, days=30)
    seeds = _apply_resource_effect_attribution(seeds, attribution_report, profile)
    deduped = _dedupe_and_rank(seeds, top_k=top_k)
    recommendations = [_serialize_recommendation(seed, index) for index, seed in enumerate(deduped, start=1)]
    serialized_sources = [_serialize_source(source, index) for index, source in enumerate(sources[:top_k], start=1)]

    return {
        "profile": public_profile(profile),
        "target": target or None,
        "query": query,
        "profileSignals": _profile_signals(profile),
        "recommendations": recommendations,
        "sources": serialized_sources,
        "resourcePack": _build_resource_pack(
            query=query,
            target=target,
            recommendations=recommendations,
            sources=serialized_sources,
            retrieval_mode=normalized_mode,
            fallback_used=not bool(sources),
        ),
        "rationale": {
            "strategy": "结合学习画像、当前路径节点、错题信号和本地知识库召回结果进行规则排序。",
            "profileInputs": _profile_inputs(profile, snapshot),
            "weights": [
                {"label": "当前学习目标匹配", "value": 0.35},
                {"label": "画像薄弱点命中", "value": 0.25},
                {"label": "知识库相似度", "value": 0.25},
                {"label": "错题与学习闭环", "value": 0.15},
            ],
            "fallbackUsed": not bool(sources),
            "retrievalMode": normalized_mode,
            "resourceEffectAttribution": {
                "schemaVersion": attribution_report.get("schemaVersion"),
                "summary": attribution_report.get("summary", {}),
            },
        },
    }


def profile_snapshot_for_user(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return {}
    return aggregate_profile_snapshot(profile, save=False)


def _recommendation_query(profile: LearnerProfile | None, target: dict, goal: str) -> str:
    explicit_goal = goal.strip()
    if explicit_goal:
        return explicit_goal
    parts: list[str] = []
    if target:
        parts.extend([str(target.get("title", "")), str(target.get("description", ""))])
    if profile:
        parts.extend(str(item) for item in (profile.weak_points or [])[:5])
        parts.extend(str(item) for item in (profile.learning_goals or [])[:3])
        parts.extend(str(item) for item in (profile.expected_resources or [])[:3])
    return " ".join(part for part in parts if part).strip() or "当前课程重点知识点"


def _search_sources(context: dict, *, query: str, top_k: int, retrieval_mode: str) -> list:
    if retrieval_mode == "deep":
        try:
            return search_knowledge_base(query=query, top_k=top_k)
        except Exception:
            return []
    return [
        _ContextSource(source)
        for source in (context.get("sources") or [])[:top_k]
        if isinstance(source, dict)
    ]


def _build_resource_pack(
    *,
    query: str,
    target: dict,
    recommendations: list[dict],
    sources: list[dict],
    retrieval_mode: str,
    fallback_used: bool,
) -> dict:
    primary = recommendations[0] if recommendations else {}
    target_title = str(target.get("title") or "").strip()
    learning_goal = str(query or target_title or primary.get("title") or "完成当前学习目标").strip()
    verified_source_count = len([source for source in sources if source.get("score") is not None or source.get("snippet")])
    resources = [_resource_pack_item(item) for item in recommendations[:5]]
    practice_href = _practice_href(learning_goal)
    estimated_minutes = max(
        10,
        min(
            120,
            sum(_estimated_minutes_for_resource(item) for item in resources) or int(target.get("estimatedMinutes") or 30),
        ),
    )
    weak_review_items = [
        item
        for item in recommendations
        if isinstance(item.get("evidence"), dict)
        and isinstance(item["evidence"].get("profileMatch"), dict)
        and item["evidence"]["profileMatch"].get("matched")
    ]
    next_href = "/a3/classroom"
    next_label = "杩涘叆 AI 璇惧爞璁茶В"
    if primary.get("href") == "/a3/wrong-notebook":
        next_href = "/a3/wrong-notebook"
        next_label = "先复盘错题"
    elif primary.get("type") == "练习题库":
        next_href = "/a3/assessment"
        next_label = "开始专项练习"
    elif primary.get("href") == "/a3/learning-path":
        next_href = "/a3/learning-path"
        next_label = "查看学习路径"
    confidence = "high" if verified_source_count >= 2 and not fallback_used else "medium" if verified_source_count else "low"
    return {
        "schemaVersion": "a3.resource-pack.v1",
        "title": f"{learning_goal} 学习资源包",
        "learningGoal": learning_goal,
        "target": target or None,
        "estimatedMinutes": estimated_minutes,
        "resources": resources,
        "practice": {
            "title": f"{learning_goal} 专项练习",
            "href": practice_href,
            "reason": "用测评结果回写错题本和学习画像，形成诊断到复习的闭环。",
            "recommendedAfterMinutes": min(30, max(10, estimated_minutes // 2)),
        },
        "reviewQueue": [
            {
                "title": item.get("title", ""),
                "href": item.get("href", "/a3/wrong-notebook"),
                "reason": item.get("reason", ""),
            }
            for item in (weak_review_items or recommendations[:2])
        ][:3],
        "evidence": {
            "verifiedSourceCount": verified_source_count,
            "sourceCount": len(sources),
            "fallbackUsed": bool(fallback_used),
            "confidence": confidence,
            "retrievalMode": retrieval_mode,
        },
        "nextAction": {
            "label": next_label,
            "href": next_href,
            "reason": primary.get("reason") or "从最高优先级资源开始，完成后进入练习和复习。",
        },
    }


def _resource_pack_item(recommendation: dict) -> dict:
    evidence = recommendation.get("evidence") if isinstance(recommendation.get("evidence"), dict) else {}
    source = recommendation.get("citation") or evidence.get("sourceEvidence")
    return {
        "recommendationId": recommendation.get("id"),
        "rank": recommendation.get("rank"),
        "title": recommendation.get("title", ""),
        "type": recommendation.get("type", ""),
        "score": recommendation.get("score", 0),
        "reason": recommendation.get("reason", ""),
        "source": source,
        "action": {
            "label": _action_label(recommendation),
            "href": recommendation.get("href") or "/a3/learning-path",
        },
    }


def _practice_href(goal: str) -> str:
    normalized = str(goal or "").strip()
    if not normalized:
        return "/a3/assessment"
    return f"/a3/assessment?practice={quote(normalized)}"


def _action_label(recommendation: dict) -> str:
    href = recommendation.get("href")
    if href == "/a3/wrong-notebook":
        return "复盘错题"
    if href == "/a3/knowledge-base":
        return "查看资料"
    if href == "/a3/classroom":
        return "进课堂学习"
    if href == "/a3/learning-path":
        return "学习该节点"
    return "开始学习"


def _estimated_minutes_for_resource(item: dict) -> int:
    resource_type = str(item.get("type") or "")
    if "练习" in resource_type:
        return 20
    if "文档" in resource_type or "课件" in resource_type:
        return 25
    return 15


class _ContextSource:
    def __init__(self, source: dict):
        self.score = source.get("score")
        self.text = str(source.get("snippet") or "")
        self.metadata = {
            "title": source.get("title"),
            "location": source.get("location"),
            "resource_type": source.get("type"),
            "retriever": "classroom_context",
        }


def _source_recommendations(sources: list, profile: LearnerProfile | None, target: dict) -> list[RecommendationSeed]:
    preferred_types = set(profile.expected_resources or []) if profile else set()
    target_title = str(target.get("title", ""))
    seeds: list[RecommendationSeed] = []
    for source in sources:
        metadata = source.metadata if isinstance(source.metadata, dict) else {}
        resource_type = _resource_type(metadata)
        score = 70 + min(25, int((float(source.score or 0) * 100) if source.score is not None else 8))
        title = str(metadata.get("title") or metadata.get("file_name") or metadata.get("original_name") or safe_source_filename(metadata.get("source_path")) or "知识库资源")
        if preferred_types and any(token in resource_type or token in title for token in preferred_types):
            score += 5
        reason = f"与“{target_title or '当前目标'}”语义接近"
        if source.score is not None:
            reason += f"，召回分数 {round(float(source.score), 3)}"
        source_payload = _serialize_source(source, len(seeds) + 1)
        seeds.append(
            RecommendationSeed(
                title=title,
                resource_type=resource_type,
                href="/a3/knowledge-base",
                score=min(score, 99),
                reason=reason,
                source=source_payload,
                evidence={
                    "profileMatch": _profile_match_evidence(profile, resource_type, title),
                    "rankingBasis": [
                        {"label": "知识库相似度", "value": round(float(source.score), 3) if source.score is not None else None},
                        {"label": "资源类型", "value": resource_type},
                        {"label": "资源偏好加权", "value": bool(preferred_types and any(token in resource_type or token in title for token in preferred_types))},
                    ],
                    "sourceEvidence": source_payload,
                    "fallback": False,
                },
            )
        )
    return seeds


def _path_recommendations(user, profile: LearnerProfile | None, target: dict) -> list[RecommendationSeed]:
    path = (
        LearningPath.objects.filter(user=user, status=LearningPathStatus.ACTIVE)
        .prefetch_related("items__knowledge_point__chapter")
        .first()
    )
    if not path:
        return [
            RecommendationSeed(
                title="先生成个性化学习路径",
                resource_type="学习路径",
                href="/a3/courses",
                score=82,
                reason="尚未形成路径，推荐先完成课程选择和路径规划。",
                evidence={
                    "profileMatch": _profile_match_evidence(profile, "学习路径", "个性化学习路径"),
                    "rankingBasis": [{"label": "路径状态", "value": "未生成"}],
                    "sourceEvidence": None,
                    "fallback": True,
                },
            )
        ]

    weak_text = " ".join(str(item) for item in (profile.weak_points or [])) if profile else ""
    foundation_level = str(profile.foundation_level or "") if profile else ""
    daily_minutes = int(profile.daily_study_time or 0) if profile else 0
    needs_low_load = _needs_low_load_recommendation(profile)
    seeds: list[RecommendationSeed] = []
    for item in path.items.select_related("knowledge_point__chapter").all():
        if item.status == "completed":
            continue
        point = item.knowledge_point
        score = 78
        weak_match = point.title in weak_text
        wrong_feedback = WrongQuestion.objects.filter(user=user, question__knowledge_point=point, mastered=False).exists()
        low_load_match = needs_low_load and (not daily_minutes or item.estimated_minutes >= daily_minutes)
        if weak_match:
            score += 24
        if wrong_feedback:
            score += 6
        if target and str(target.get("id")) == str(point.id):
            score += 8
        if low_load_match:
            score += 5
        reason_parts = [
            f"路径第 {item.order} 个节点",
            f"难度 {point.difficulty}",
            f"预计 {item.estimated_minutes} 分钟",
        ]
        if weak_match:
            reason_parts.append(f"命中画像薄弱点：{point.title}")
        if low_load_match:
            reason_parts.append(_low_load_reason(foundation_level, daily_minutes, item.estimated_minutes))
        ranking_basis = [
            {"label": "路径节点", "value": item.order},
            {"label": "难度", "value": point.difficulty},
            {"label": "预计分钟", "value": item.estimated_minutes},
            {"label": "薄弱点命中", "value": weak_match},
        ]
        if low_load_match:
            ranking_basis.extend(_low_load_ranking_basis(foundation_level, daily_minutes))
        seeds.append(
            RecommendationSeed(
                title=f"{point.title} 专项学习包",
                resource_type="知识卡片",
                href="/a3/classroom",
                score=min(score, 100),
                reason="；".join(reason_parts),
                evidence={
                    "profileMatch": _profile_match_evidence(profile, "知识卡片", point.title, weak_match=weak_match, low_load_match=low_load_match),
                    "rankingBasis": ranking_basis,
                    "sourceEvidence": None,
                    "fallback": True,
                },
            )
        )
        if len(seeds) >= 4:
            break
    return seeds


def _wrong_question_recommendations(user) -> list[RecommendationSeed]:
    wrong_items = (
        WrongQuestion.objects.filter(user=user, mastered=False)
        .select_related("question__knowledge_point__chapter")
        .order_by("-wrong_count", "-last_wrong_at")[:3]
    )
    return [
        RecommendationSeed(
            title=f"{item.question.knowledge_point.title} 错题复盘",
            resource_type="练习题库",
            href="/a3/wrong-notebook",
            score=min(74 + item.wrong_count * 6, 98),
            reason=f"该知识点累计答错 {item.wrong_count} 次，需要闭环巩固。",
            evidence={
                "profileMatch": {
                    "matched": True,
                    "signals": [item.question.knowledge_point.title],
                    "reason": "错题记录命中当前薄弱知识点",
                },
                "rankingBasis": [
                    {"label": "错题次数", "value": item.wrong_count},
                    {"label": "掌握状态", "value": "未掌握"},
                ],
                "sourceEvidence": None,
                "fallback": True,
            },
        )
        for item in wrong_items
    ]


def _apply_resource_effect_attribution(seeds: list[RecommendationSeed], attribution_report: dict, profile: LearnerProfile | None) -> list[RecommendationSeed]:
    attribution = attribution_by_resource_type(attribution_report)
    adjusted: list[RecommendationSeed] = []
    for seed in seeds:
        effect = _matching_resource_effect(attribution, seed.resource_type)
        delta, label, resource_effect = _resource_effect_adjustment(effect)
        legacy_delta = 0
        legacy_label = ""
        if profile:
            legacy_delta, legacy_label = _resource_feedback_adjustment(profile, seed.resource_type)
        if resource_effect and resource_effect.get("effectConfidence") == "low" and legacy_label:
            delta = legacy_delta
            label = f"资源反馈调权 {legacy_label}"
            resource_effect = {
                **resource_effect,
                "basis": "legacy_resource_feedback",
            }
        elif not resource_effect and legacy_label:
            delta = legacy_delta
            label = f"资源反馈调权 {legacy_label}"
            resource_effect = {
                "resourceType": seed.resource_type,
                "historicalEffectiveness": max(0, min(100, 50 + legacy_delta * 4)),
                "effectConfidence": "low",
                "explorationRecommended": True,
                "basis": "legacy_resource_feedback",
            }
        elif not resource_effect:
            adjusted.append(seed)
            continue
        if not label:
            label = _resource_effect_label(resource_effect)
        evidence = dict(seed.evidence or {})
        ranking_basis = list(evidence.get("rankingBasis") if isinstance(evidence.get("rankingBasis"), list) else [])
        if resource_effect.get("effectConfidence") != "low" or legacy_label:
            ranking_basis.extend(
                [
                    {"label": "同类资源效果", "value": resource_effect.get("historicalEffectiveness")},
                    {"label": "是否适合试学", "value": bool(resource_effect.get("explorationRecommended"))},
                    {"label": "反馈可信度", "value": resource_effect.get("effectConfidence")},
                ]
            )
        if legacy_label:
            ranking_basis.append({"label": "资源反馈调权", "value": legacy_label})
        evidence["rankingBasis"] = ranking_basis
        evidence["resourceEffect"] = resource_effect
        adjusted.append(
            RecommendationSeed(
                title=seed.title,
                resource_type=seed.resource_type,
                href=seed.href,
                score=max(0, min(seed.score + delta, 99)),
                reason=f"{seed.reason}；{label}" if label else seed.reason,
                source=seed.source,
                evidence=evidence,
            )
        )
    return adjusted


def _matching_resource_effect(attribution: dict[str, dict], recommendation_type: str) -> dict | None:
    if recommendation_type in attribution:
        return attribution[recommendation_type]
    for effect_type, effect in attribution.items():
        if _feedback_resource_matches(recommendation_type, effect_type):
            return effect
    return None


def _resource_effect_adjustment(effect: dict | None) -> tuple[int, str, dict | None]:
    if not isinstance(effect, dict):
        return 0, "", None
    score = _safe_float(effect.get("historicalEffectiveness"), 0)
    confidence = str(effect.get("effectConfidence") or "low")
    exploration = bool(effect.get("explorationRecommended"))
    if confidence == "high":
        delta = 10 if score >= 70 else -8 if score < 40 else 4
    elif confidence == "medium":
        delta = 6 if score >= 70 else -4 if score < 40 else 2
    else:
        delta = 0
        exploration = True
    resource_effect = {**effect, "explorationRecommended": exploration}
    return delta, _resource_effect_label(resource_effect), resource_effect


def _resource_effect_label(resource_effect: dict) -> str:
    score = _safe_float(resource_effect.get("historicalEffectiveness"), 0)
    confidence = str(resource_effect.get("effectConfidence") or "low")
    if bool(resource_effect.get("explorationRecommended")):
        return "同类学习记录还不多，先按课程和薄弱点试学"
    if confidence == "high" and score >= 70:
        return "同类资源完成效果较好，优先推荐"
    if confidence == "medium":
        return "已有部分学习反馈，可作为优先参考"
    if score < 40:
        return "同类资源反馈一般，建议快速浏览后再决定"
    return "结合使用反馈和当前学习目标推荐"


def _exploration_resource_effect(resource_type: str) -> dict:
    return {
        "resourceType": resource_type,
        "historicalEffectiveness": 50,
        "effectConfidence": "low",
        "explorationRecommended": True,
        "opened": 0,
        "completed": 0,
        "skipped": 0,
        "favorited": 0,
    }


def _resource_feedback_adjustment(profile: LearnerProfile | None, resource_type: str) -> tuple[int, str]:
    if not profile:
        return 0, ""
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    feedbacks = [item for item in extra.get("resourceFeedback", []) if isinstance(item, dict)]
    matching = [
        item for item in feedbacks[:20]
        if _feedback_resource_matches(resource_type, str(item.get("resourceType") or ""))
    ]
    if not matching:
        return 0, ""
    weights = {"completed": 8, "favorited": 6, "opened": 2, "skipped": -8}
    latest = matching[0]
    action = str(latest.get("action") or "")
    delta = int(weights.get(action, 0))
    if not delta:
        return 0, ""
    sign = "+" if delta > 0 else ""
    return delta, f"{action}:{sign}{delta}"


def _safe_float(value, default: float = 0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _feedback_resource_matches(recommendation_type: str, feedback_type: str) -> bool:
    normalized_recommendation = str(recommendation_type or "").lower()
    normalized_feedback = str(feedback_type or "").lower()
    aliases = {
        "practice_set": ("练习", "题库", "practice", "exercise"),
        "lecture_doc": ("讲义", "文档", "课程", "document", "lecture"),
        "knowledge_card": ("知识卡", "卡片", "card"),
        "mind_map": ("思维导图", "mind"),
        "case_study": ("案例", "case"),
        "micro_video_script": ("视频", "脚本", "video"),
    }
    tokens = aliases.get(normalized_feedback, (normalized_feedback,))
    return any(token and token in normalized_recommendation for token in tokens)


def _dedupe_and_rank(seeds: list[RecommendationSeed], *, top_k: int) -> list[RecommendationSeed]:
    seen = set()
    ranked = []
    for seed in sorted(seeds, key=lambda item: item.score, reverse=True):
        key = (seed.title, seed.resource_type)
        if key in seen:
            continue
        seen.add(key)
        ranked.append(seed)
        if len(ranked) >= top_k:
            break
    return ranked


def _needs_low_load_recommendation(profile: LearnerProfile | None) -> bool:
    if not profile:
        return False
    foundation = str(profile.foundation_level or "")
    daily_minutes = int(profile.daily_study_time or 0)
    return any(token in foundation for token in ("弱", "薄弱", "一般")) or (0 < daily_minutes <= 30)


def _low_load_reason(foundation_level: str, daily_minutes: int, estimated_minutes: int) -> str:
    parts = ["低负荷拆解"]
    if foundation_level:
        parts.append(f"基础水平 {foundation_level}")
    if daily_minutes:
        parts.append(f"每日 {daily_minutes} 分钟，建议分 {max(2, (estimated_minutes + daily_minutes - 1) // daily_minutes)} 次完成")
    return "；".join(parts)


def _low_load_ranking_basis(foundation_level: str, daily_minutes: int) -> list[dict]:
    basis: list[dict] = []
    if foundation_level:
        basis.append({"label": "基础水平适配", "value": foundation_level})
    if daily_minutes:
        basis.append({"label": "每日时间适配", "value": f"{daily_minutes} 分钟"})
    return basis


def _serialize_recommendation(seed: RecommendationSeed, rank: int) -> dict:
    evidence = seed.evidence or {
        "profileMatch": {"matched": False, "signals": [], "reason": ""},
        "rankingBasis": [],
        "sourceEvidence": seed.source,
        "fallback": seed.source is None,
    }
    profile_match = evidence.get("profileMatch") if isinstance(evidence.get("profileMatch"), dict) else {}
    ranking_basis = evidence.get("rankingBasis") if isinstance(evidence.get("rankingBasis"), list) else []
    ranking_labels = {str(item.get("label")) for item in ranking_basis if isinstance(item, dict)}
    if "weakPoint" in (profile_match.get("signals") or []) and "测评错题回流" not in ranking_labels:
        ranking_basis = [*ranking_basis, {"label": "测评错题回流", "value": True}]
        evidence = {**evidence, "rankingBasis": ranking_basis}
    return {
        "id": f"rec-{rank}",
        "rank": rank,
        "title": seed.title,
        "type": seed.resource_type,
        "score": round(seed.score, 1),
        "reason": seed.reason,
        "href": seed.href,
        "citation": seed.source,
        "evidence": evidence,
    }


def _profile_match_evidence(profile: LearnerProfile | None, resource_type: str, title: str, *, weak_match: bool = False, low_load_match: bool = False) -> dict:
    if not profile:
        return {"matched": False, "signals": [], "reason": "尚未形成学习画像"}
    signals = []
    if weak_match:
        signals.append("weakPoint")
    if low_load_match:
        signals.append("foundationPace")
    preferred = [item for item in (profile.expected_resources or []) if item and (item in resource_type or item in title)]
    if preferred:
        signals.append("resourcePreference")
    goals = [item for item in (profile.learning_goals or []) if item and item in title]
    if goals:
        signals.append("learningGoal")
    reason_parts = []
    if preferred:
        reason_parts.extend(preferred)
    elif goals:
        reason_parts.extend(goals)
    elif weak_match and profile.weak_points:
        reason_parts.extend((profile.weak_points or [])[:1])
    if low_load_match:
        reason_parts.append("基础和每日时间需要低负荷安排")
    return {
        "matched": bool(signals),
        "signals": signals,
        "reason": "、".join(str(item) for item in reason_parts if item) or "按当前路径与学习状态匹配",
    }


def _profile_inputs(profile: LearnerProfile | None, snapshot: dict | None = None) -> dict:
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    snapshot_fields = {
        "snapshotSchemaVersion": snapshot.get("schemaVersion", ""),
        "readiness": snapshot.get("readiness", {}),
        "evidenceSources": snapshot.get("signalSummary", {}).get("bySource", {}),
    }
    if not profile:
        return {
            "foundationLevel": "",
            "dailyMinutes": 0,
            "learningGoals": [],
            "weakPoints": [],
            "expectedResources": [],
            "pace": "",
            **snapshot_fields,
        }
    return {
        "foundationLevel": profile.foundation_level or "",
        "dailyMinutes": int(profile.daily_study_time or 0),
        "learningGoals": profile.learning_goals if isinstance(profile.learning_goals, list) else [],
        "weakPoints": profile.weak_points if isinstance(profile.weak_points, list) else [],
        "expectedResources": profile.expected_resources if isinstance(profile.expected_resources, list) else [],
        "pace": profile.pace or "",
        **snapshot_fields,
    }


def _serialize_source(source, index: int) -> dict:
    metadata = source.metadata if isinstance(source.metadata, dict) else {}
    source_type_label = format_source_type_label(metadata, fallback=_resource_type(metadata))
    return {
        "id": f"source-{index}",
        "title": str(metadata.get("title") or metadata.get("file_name") or metadata.get("original_name") or safe_source_filename(metadata.get("source_path")) or "知识库来源"),
        "location": format_source_display_location(metadata),
        "type": source_type_label,
        "sourceTypeLabel": source_type_label,
        "sourceOrigin": source_origin_label(metadata),
        "score": round(float(source.score), 3) if source.score is not None else None,
        "snippet": source.text[:260],
    }


def _resource_type(metadata: dict) -> str:
    source_type = str(metadata.get("source_type") or metadata.get("resource_type") or "").lower()
    if "ppt" in source_type:
        return "课件讲义"
    if "pdf" in source_type or "document" in source_type:
        return "文档资料"
    if "qa" in source_type or "question" in source_type:
        return "练习题库"
    return "知识卡片"


def _profile_signals(profile: LearnerProfile | None) -> list[dict]:
    if not profile:
        return [{"label": "画像状态", "value": "未完成", "tone": "orange"}]
    return [
        {"label": "年级", "value": profile.grade or "未填写", "tone": "blue"},
        {"label": "基础水平", "value": profile.foundation_level or "未判断", "tone": "green"},
        {"label": "学习节奏", "value": profile.pace, "tone": "violet"},
        {"label": "薄弱点", "value": f"{len(profile.weak_points or [])} 个", "tone": "orange"},
        {"label": "期望资源", "value": "、".join((profile.expected_resources or [])[:2]) or "未设置", "tone": "slate"},
    ]
