from __future__ import annotations

import logging
from copy import deepcopy
from datetime import timedelta
from typing import Any

from django.core.cache import cache
from django.db import transaction
from django.db.models import Count, Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from backend.apps.assessments.models import AssessmentAnswer, SessionStatus
from backend.apps.learning.models import (
    CoachingMessage,
    CoachingMessageRole,
    CoachingSession,
    CoachingSessionStatus,
    TutorAvatarAsset,
    TutorPersonaConfiguration,
    TutorPersonaFeedback,
)
from backend.apps.learning.tutor_persona_operations import (
    invalidate_tutor_persona_overlay_cache,
    is_safe_avatar_public_path,
)
from backend.apps.learning.tutor_personas import _TUTOR_PERSONAS
from backend.apps.system.admin_audit import record_admin_audit
from backend.apps.system.admin_catalog_services import AdminActionError, _require_reason
from backend.apps.system.admin_tutor_cache import (
    admin_tutor_analytics_cache_key,
    get_admin_tutor_analytics_generation,
    invalidate_admin_tutor_analytics_cache,
    schedule_admin_tutor_analytics_invalidation,
)


logger = logging.getLogger(__name__)

ADMIN_TUTOR_ANALYTICS_CACHE_SECONDS = 60
ADMIN_TUTOR_RANGES = {"7d": 7, "30d": 30, "90d": 90}
KNOWN_PERSONA_IDS = tuple(_TUTOR_PERSONAS)
PATCH_FIELDS = frozenset(
    {"enabled", "avatarAssetId", "voicePreviewEnabled", "reason", "expectedUpdatedAt"}
)
MUTATION_FIELDS = frozenset({"enabled", "avatarAssetId", "voicePreviewEnabled"})
AUDIT_FIELDS = ("enabled", "avatarAssetId", "voicePreviewEnabled")


class AdminTutorError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def list_admin_tutors(range_value: Any = "30d") -> dict[str, Any]:
    normalized_range = _normalize_range(range_value)
    personas = _persona_rows()
    analytics_payload = _cached_analytics(normalized_range)
    analytics = analytics_payload["analytics"]
    verified_response_rate = _analytics_metric(
        analytics["sessionQuality"], "verifiedAssistantResponseRate"
    )
    satisfaction = _analytics_metric(analytics["feedback"], "satisfaction")
    return {
        "range": normalized_range,
        "dataStatus": _overall_data_status(analytics_payload),
        "kpis": {
            "enabledPersonaCount": sum(row["enabled"] is True for row in personas),
            "sessionCount": analytics_payload["sessionCount"],
            "verifiedResponseRate": deepcopy(verified_response_rate),
            "satisfaction": deepcopy(satisfaction),
        },
        "personas": personas,
        "assets": _asset_rows(),
        "providerStatus": [
            {
                "id": "tutorVoicePreview",
                "status": "unknown",
                "dataStatus": "not_collected",
            }
        ],
        "analytics": analytics,
    }


def update_tutor_persona(
    *,
    actor,
    persona_id: str,
    payload: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    changes, reason, expected_updated_at = _validate_patch(persona_id, payload)

    with transaction.atomic():
        configurations = list(
            TutorPersonaConfiguration.objects.select_for_update()
            .select_related("avatar_asset")
            .filter(persona_id__in=KNOWN_PERSONA_IDS)
        )
        target = next((row for row in configurations if row.persona_id == persona_id), None)
        if target is None:
            raise AdminTutorError("导师人格配置不存在", status_code=409)
        if target.updated_at != expected_updated_at:
            raise AdminTutorError("导师人格配置已被其他管理员更新，请刷新后重试", status_code=409)

        assets = list(TutorAvatarAsset.objects.select_for_update().all())
        assets_by_id = {asset.pk: asset for asset in assets}
        if not any(
            asset.is_default
            and _is_usable_avatar_asset(asset)
            for asset in assets
        ):
            raise AdminTutorError("至少需要保留一个可用的默认导师资产", status_code=409)

        selected_asset = assets_by_id.get(target.avatar_asset_id)
        if "avatarAssetId" in changes:
            selected_asset = next(
                (asset for asset in assets if asset.asset_id == changes["avatarAssetId"]),
                None,
            )
            if selected_asset is None:
                raise AdminTutorError("导师头像资产不存在", status_code=404)
        next_enabled = changes.get("enabled", target.enabled)
        validate_selected_asset = next_enabled or "avatarAssetId" in changes
        if validate_selected_asset and (
            selected_asset is None or selected_asset.status != "enabled"
        ):
            raise AdminTutorError("导师头像资产未启用")
        if validate_selected_asset and not is_safe_avatar_public_path(selected_asset.public_path):
            raise AdminTutorError("导师头像资产路径不安全")
        if not any(
            (next_enabled if row.persona_id == target.persona_id else row.enabled)
            and _is_usable_avatar_asset(
                selected_asset
                if row.persona_id == target.persona_id
                else assets_by_id.get(row.avatar_asset_id)
            )
            for row in configurations
        ):
            raise AdminTutorError("不能停用最后一个可用导师人格", status_code=409)

        before = _configuration_state(target)
        target.enabled = next_enabled
        target.avatar_asset = selected_asset
        target.voice_preview_enabled = changes.get(
            "voicePreviewEnabled", target.voice_preview_enabled
        )
        target.updated_by = actor
        target.save(
            update_fields=[
                "enabled",
                "avatar_asset",
                "voice_preview_enabled",
                "updated_by",
                "updated_at",
            ]
        )
        after = _configuration_state(target)
        record_admin_audit(
            actor=actor,
            action="tutor.persona.update",
            target_type="tutor_persona",
            target_id=target.persona_id,
            summary="更新导师人格运行配置",
            reason=reason,
            before=before,
            after=after,
            before_allowlist=AUDIT_FIELDS,
            after_allowlist=AUDIT_FIELDS,
            actor_ip=actor_ip,
        )
        transaction.on_commit(invalidate_tutor_persona_overlay_cache)
        schedule_admin_tutor_analytics_invalidation()

    return {"persona": _serialize_persona(target)}


def _normalize_range(value: Any) -> str:
    if not isinstance(value, str) or value not in ADMIN_TUTOR_RANGES:
        raise AdminTutorError("统计周期仅支持 7d、30d 或 90d")
    return value


def _validate_patch(persona_id: Any, payload: Any) -> tuple[dict[str, Any], str, Any]:
    if not isinstance(persona_id, str) or persona_id not in _TUTOR_PERSONAS:
        raise AdminTutorError("导师人格不存在", status_code=404)
    if not isinstance(payload, dict):
        raise AdminTutorError("请求体必须是 JSON 对象")
    unknown_fields = set(payload) - PATCH_FIELDS
    if unknown_fields:
        raise AdminTutorError("请求包含不支持的字段")
    if not set(payload).intersection(MUTATION_FIELDS):
        raise AdminTutorError("请提供需要修改的导师人格配置")

    try:
        reason = _require_reason(payload.get("reason"))
    except AdminActionError as exc:
        raise AdminTutorError(str(exc), status_code=exc.status_code) from exc

    expected_updated_at_raw = payload.get("expectedUpdatedAt")
    expected_updated_at = (
        parse_datetime(expected_updated_at_raw)
        if isinstance(expected_updated_at_raw, str)
        else None
    )
    if expected_updated_at is None or timezone.is_naive(expected_updated_at):
        raise AdminTutorError("expectedUpdatedAt 必须是 GET 返回的有效更新时间")

    changes: dict[str, Any] = {}
    for field in ("enabled", "voicePreviewEnabled"):
        if field in payload:
            if not isinstance(payload[field], bool):
                raise AdminTutorError(f"{field} 必须是布尔值")
            changes[field] = payload[field]
    if "avatarAssetId" in payload:
        asset_id = payload["avatarAssetId"]
        if not isinstance(asset_id, str) or not asset_id.strip() or len(asset_id.strip()) > 64:
            raise AdminTutorError("avatarAssetId 无效")
        changes["avatarAssetId"] = asset_id.strip()
    return changes, reason, expected_updated_at


def _configuration_state(configuration: TutorPersonaConfiguration) -> dict[str, Any]:
    return {
        "enabled": bool(configuration.enabled),
        "avatarAssetId": configuration.avatar_asset.asset_id,
        "voicePreviewEnabled": bool(configuration.voice_preview_enabled),
    }


def _is_usable_avatar_asset(asset: TutorAvatarAsset | None) -> bool:
    return bool(
        asset
        and asset.status == "enabled"
        and is_safe_avatar_public_path(asset.public_path)
    )


def _persona_rows() -> list[dict[str, Any]]:
    configurations = {
        row.persona_id: row
        for row in TutorPersonaConfiguration.objects.select_related("avatar_asset").filter(
            persona_id__in=KNOWN_PERSONA_IDS
        )
    }
    rows = []
    for persona_id in KNOWN_PERSONA_IDS:
        configuration = configurations.get(persona_id)
        rows.append(_serialize_persona(configuration, persona_id=persona_id))
    return rows


def _serialize_persona(
    configuration: TutorPersonaConfiguration | None,
    *,
    persona_id: str | None = None,
) -> dict[str, Any]:
    resolved_id = persona_id or (configuration.persona_id if configuration else "")
    identity = _TUTOR_PERSONAS[resolved_id]
    return {
        "id": resolved_id,
        "name": identity["name"],
        "shortDescription": identity["shortDescription"],
        "teachingStyle": identity["teachingStyle"],
        "allowedWorkflows": list(identity["allowedWorkflows"]),
        "schemaVersion": identity["schemaVersion"],
        "enabled": bool(configuration.enabled) if configuration else None,
        "avatarAssetId": configuration.avatar_asset.asset_id if configuration else None,
        "voicePreviewEnabled": bool(configuration.voice_preview_enabled) if configuration else None,
        "configurationDataStatus": "collected" if configuration else "not_collected",
        "updatedAt": configuration.updated_at.isoformat() if configuration else None,
    }


def _asset_rows() -> list[dict[str, Any]]:
    rows = []
    for asset in TutorAvatarAsset.objects.order_by("asset_id"):
        if not is_safe_avatar_public_path(asset.public_path):
            continue
        rows.append(
            {
                "assetId": asset.asset_id,
                "displayName": asset.display_name,
                "publicPath": asset.public_path,
                "fileSizeBytes": asset.file_size_bytes,
                "sha256": asset.sha256,
                "status": asset.status,
                "isDefault": bool(asset.is_default),
                "licenseComplete": all(
                    (
                        asset.author,
                        asset.source_name,
                        asset.source_url,
                        asset.license_name,
                        asset.license_url,
                        isinstance(asset.usage_scope, list) and bool(asset.usage_scope),
                    )
                ),
            }
        )
    return rows


def _cached_analytics(range_value: str) -> dict[str, Any]:
    generation = get_admin_tutor_analytics_generation()
    if generation is None:
        return deepcopy(_build_analytics(days=ADMIN_TUTOR_RANGES[range_value]))
    cache_key = admin_tutor_analytics_cache_key(range_value, generation)
    try:
        cached = cache.get(cache_key)
    except Exception:
        logger.warning("Unable to read admin tutor analytics cache", exc_info=True)
        cached = None
    if isinstance(cached, dict) and "analytics" in cached and "sessionCount" in cached:
        return deepcopy(cached)

    payload = _build_analytics(days=ADMIN_TUTOR_RANGES[range_value])
    try:
        if get_admin_tutor_analytics_generation() == generation:
            cache.set(cache_key, payload, timeout=ADMIN_TUTOR_ANALYTICS_CACHE_SECONDS)
    except Exception:
        logger.warning("Unable to write admin tutor analytics cache", exc_info=True)
    return deepcopy(payload)


def _build_analytics(*, days: int) -> dict[str, Any]:
    now = timezone.now()
    since = now - timedelta(days=days)
    sessions = list(
        CoachingSession.objects.filter(started_at__gte=since, started_at__lte=now).only(
            "id",
            "user_id",
            "knowledge_point_id",
            "status",
            "metadata",
            "started_at",
            "ended_at",
        )
    )
    known_sessions = [session for session in sessions if _session_persona_id(session) in _TUTOR_PERSONAS]
    known_ended_sessions = [
        session for session in known_sessions if session.status == CoachingSessionStatus.ENDED
    ]

    message_counts = _message_counts(since, now)
    feedback_rows = _feedback_rows(since, now)
    session_count = len(sessions)

    adoption_trend = _adoption_trend(sessions, since=since, days=days)
    average_turns = _average_metric(message_counts["user"], session_count)
    verified_rate = _rate(message_counts["verifiedAssistant"], message_counts["assistant"])
    end_state_sessions = [
        session
        for session in sessions
        if session.status in {CoachingSessionStatus.ACTIVE, CoachingSessionStatus.ENDED}
    ]
    normal_ended_rate = _rate(
        sum(session.status == CoachingSessionStatus.ENDED for session in end_state_sessions),
        len(end_state_sessions),
    )
    runtime_fallback_rate = _runtime_fallback_metric(known_sessions)
    satisfaction = _satisfaction_metric(feedback_rows)
    feedback_coverage = _rate(len(feedback_rows), len(known_ended_sessions))
    association = _assessment_association(known_sessions)

    return {
        "sessionCount": session_count,
        "analytics": {
            "adoption": adoption_trend,
            "sessionQuality": [
                {
                    "metric": "perPersonaSessionCount",
                    "values": [
                        {
                            "personaId": persona_id,
                            "sessionCount": sum(
                                _session_persona_id(session) == persona_id
                                for session in known_sessions
                            ),
                        }
                        for persona_id in KNOWN_PERSONA_IDS
                    ],
                    "dataStatus": "collected" if session_count else "not_collected",
                },
                {
                    "metric": "averageStudentMessageTurns",
                    **average_turns,
                },
                {
                    "metric": "verifiedAssistantResponseRate",
                    **verified_rate,
                },
                {
                    "metric": "normalEndedRate",
                    **normal_ended_rate,
                },
                {
                    "metric": "runtimeFallbackRate",
                    **runtime_fallback_rate,
                },
            ],
            "feedback": [
                {
                    "metric": "satisfaction",
                    **satisfaction,
                },
                {
                    "metric": "coverage",
                    **feedback_coverage,
                },
            ],
            "assessmentAssociation": association,
        },
    }


def _adoption_trend(
    sessions: list[CoachingSession],
    *,
    since,
    days: int,
) -> list[dict[str, Any]]:
    buckets = [{"numerator": 0, "denominator": 0} for _item in range(days)]
    for session in sessions:
        elapsed_days = int((session.started_at - since).total_seconds() // 86400)
        bucket_index = min(max(elapsed_days, 0), days - 1)
        buckets[bucket_index]["denominator"] += 1
        if _session_persona_id(session) in _TUTOR_PERSONAS:
            buckets[bucket_index]["numerator"] += 1

    trend = []
    for index, bucket in enumerate(buckets):
        metric = _rate(bucket["numerator"], bucket["denominator"])
        trend.append(
            {
                "date": timezone.localtime(since + timedelta(days=index)).date().isoformat(),
                **metric,
            }
        )
    return trend


def _analytics_metric(rows: list[dict[str, Any]], metric: str) -> dict[str, Any]:
    row = next(item for item in rows if item.get("metric") == metric)
    return {key: value for key, value in row.items() if key != "metric"}


def _session_persona_id(session: CoachingSession) -> str | None:
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    snapshot = metadata.get("tutorPersona")
    persona_id = snapshot.get("id") if isinstance(snapshot, dict) else None
    if not isinstance(persona_id, str):
        return None
    normalized = persona_id.strip()
    return normalized if normalized else None


def _message_counts(since, now) -> dict[str, int]:
    counts = {"user": 0, "assistant": 0, "verifiedAssistant": 0}
    for row in (
        CoachingMessage.objects.filter(
            session__started_at__gte=since,
            session__started_at__lte=now,
        )
        .values("role")
        .annotate(total=Count("id"), verified=Count("id", filter=Q(verified=True)))
    ):
        if row["role"] == CoachingMessageRole.USER:
            counts["user"] = row["total"]
        elif row["role"] == CoachingMessageRole.ASSISTANT:
            counts["assistant"] = row["total"]
            counts["verifiedAssistant"] = row["verified"]
    return counts


def _feedback_rows(since, now) -> list[tuple]:
    return list(
        TutorPersonaFeedback.objects.filter(
            session__started_at__gte=since,
            session__started_at__lte=now,
            session__status=CoachingSessionStatus.ENDED,
            persona_id__in=KNOWN_PERSONA_IDS,
            rating__gte=1,
            rating__lte=5,
        ).values_list("session_id", "rating")
    )


def _rate(numerator: int, denominator: int) -> dict[str, Any]:
    return {
        "value": round(numerator / denominator, 4) if denominator else None,
        "numerator": numerator,
        "denominator": denominator,
        "dataStatus": "collected" if denominator else "not_collected",
    }


def _average_metric(total: int, count: int) -> dict[str, Any]:
    return {
        "value": round(total / count, 4) if count else None,
        "sampleCount": count,
        "dataStatus": "collected" if count else "not_collected",
    }


def _satisfaction_metric(feedback_rows: list[tuple]) -> dict[str, Any]:
    ratings = [rating for _session_id, rating in feedback_rows]
    return {
        "value": round(sum(ratings) / len(ratings), 2) if ratings else None,
        "sampleCount": len(ratings),
        "dataStatus": "collected" if ratings else "not_collected",
    }


def _runtime_fallback_metric(sessions: list[CoachingSession]) -> dict[str, Any]:
    evidence = []
    for session in sessions:
        metadata = session.metadata if isinstance(session.metadata, dict) else {}
        value = metadata.get("fallbackUsed")
        if isinstance(value, bool):
            evidence.append(value)
    numerator = sum(evidence)
    denominator = len(sessions)
    evidence_count = len(evidence)
    if not denominator or not evidence_count:
        value = None
        data_status = "not_collected"
    elif evidence_count < denominator:
        value = None
        data_status = "partial"
    else:
        value = round(numerator / denominator, 4)
        data_status = "collected"
    return {
        "value": value,
        "numerator": numerator,
        "denominator": denominator,
        "evidenceCount": evidence_count,
        "dataStatus": data_status,
    }


def _assessment_association(sessions: list[CoachingSession]) -> dict[str, Any]:
    eligible = [
        session
        for session in sessions
        if session.user_id and session.knowledge_point_id and session.ended_at is not None
    ]
    point_scores: dict[tuple[int, Any], list[tuple[Any, str, float]]] = {}
    if eligible:
        earliest = min(session.started_at - timedelta(days=7) for session in eligible)
        latest = max(session.ended_at + timedelta(days=7) for session in eligible)
        score_rows = (
            AssessmentAnswer.objects.filter(
                session__user_id__in={session.user_id for session in eligible},
                session__status=SessionStatus.COMPLETED,
                session__completed_at__isnull=False,
                session__completed_at__gte=earliest,
                session__completed_at__lte=latest,
                question__knowledge_point_id__in={
                    session.knowledge_point_id for session in eligible
                },
            )
            .values(
                "session_id",
                "session__user_id",
                "session__completed_at",
                "question__knowledge_point_id",
            )
            .annotate(total=Count("id"), correct=Count("id", filter=Q(is_correct=True)))
            .order_by("session__completed_at", "session_id")
        )
        for row in score_rows:
            if not row["total"]:
                continue
            key = (row["session__user_id"], row["question__knowledge_point_id"])
            point_scores.setdefault(key, []).append(
                (
                    row["session__completed_at"],
                    str(row["session_id"]),
                    row["correct"] / row["total"] * 100,
                )
            )
        for scores in point_scores.values():
            scores.sort(key=lambda item: (item[0], item[1]))

    deltas = []
    for session in eligible:
        scores = point_scores.get((session.user_id, session.knowledge_point_id), [])
        before = [
            item
            for item in scores
            if session.started_at - timedelta(days=7) <= item[0] < session.started_at
        ]
        after = [
            item
            for item in scores
            if session.ended_at < item[0] <= session.ended_at + timedelta(days=7)
        ]
        if before and after:
            deltas.append(after[0][2] - before[-1][2])

    pair_count = len(deltas)
    return {
        "averageDelta": round(sum(deltas) / pair_count, 2) if pair_count >= 5 else None,
        "positiveCount": sum(delta > 0 for delta in deltas),
        "flatCount": sum(delta == 0 for delta in deltas),
        "negativeCount": sum(delta < 0 for delta in deltas),
        "pairCount": pair_count,
        "coverage": _rate(pair_count, len(eligible)),
        "observedAssociation": True,
        "note": "观察到的相关性，不代表因果关系",
        "dataStatus": "collected" if pair_count >= 5 else "insufficient_sample",
    }


def _overall_data_status(payload: dict[str, Any]) -> str:
    analytics = payload["analytics"]
    statuses = [
        *(row["dataStatus"] for row in analytics["adoption"]),
        *(row["dataStatus"] for row in analytics["sessionQuality"]),
        *(row["dataStatus"] for row in analytics["feedback"]),
        analytics["assessmentAssociation"]["dataStatus"],
    ]
    return "collected" if all(status == "collected" for status in statuses) else "partial"
