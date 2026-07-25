from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db.models import Count, Q
from django.db.models.functions import TruncDay, TruncHour
from django.utils import timezone

from backend.apps.accounts.models import UserAccessState
from backend.apps.compat.models import AgentRun, AgentSpan, ResourceGenerationJob, VideoGenerationJob
from backend.apps.knowledge_base.models import KnowledgeIndexJob, KnowledgeResource
from backend.apps.learning.models import CoachingSession, LearningEvent, ResourcePackLog
from backend.apps.system.models import AdminAuditLog, SecurityEvent
from backend.apps.system.services import build_system_health


User = get_user_model()

SHANGHAI = ZoneInfo("Asia/Shanghai")
VALID_RANGES = {"24h", "7d", "30d"}
DEFAULT_RANGE = "24h"
CACHE_TTL_SECONDS = 30
STALE_AFTER = timedelta(minutes=30)
ACTIVITY_LIMIT = 20
TASK_STATES = ("queued", "running", "succeeded", "failed", "cancelled", "stale")
STATUS_ALIASES = {
    "queued": {"queued", "pending", "created", "waiting", "retry", "retrying"},
    "running": {
        "running",
        "processing",
        "started",
        "in_progress",
        "indexing",
        "submitted",
        "polling",
        "generating",
        "generating_narration",
        "composing",
        "active",
    },
    "succeeded": {
        "succeeded",
        "success",
        "completed",
        "complete",
        "done",
        "completed_with_warnings",
        "indexed",
        "ended",
        "archived",
    },
    "failed": {"failed", "error", "errored", "rejected", "timed_out", "timeout", "partial"},
    "cancelled": {"cancelled", "canceled", "revoked", "aborted"},
    "stale": {"stale"},
}


def build_admin_overview(range_value: str = DEFAULT_RANGE) -> dict:
    if range_value not in VALID_RANGES:
        raise ValueError("时间范围仅支持 24h、7d 或 30d")

    cache_key = f"a3:admin-overview:v2:{range_value}"
    try:
        cached = cache.get(cache_key)
    except Exception:  # pragma: no cover - backend-specific cache outage
        cached = None
    if isinstance(cached, dict):
        return cached

    overview = _collect_overview(range_value)
    try:
        cache.set(cache_key, overview, timeout=CACHE_TTL_SECONDS)
    except Exception:  # pragma: no cover - overview data remains usable without cache
        pass
    return overview


def _collect_overview(range_value: str) -> dict:
    now = timezone.now()
    period = _build_period(now, range_value)
    since = period["start_at"]

    user_total = User.objects.count()
    new_users = User.objects.filter(created_at__gte=since, created_at__lte=now).count()
    active_users, active_user_trends = _active_user_evidence(period, now)
    coaching_sessions = CoachingSession.objects.filter(created_at__gte=since, created_at__lte=now).count()
    learning_events = LearningEvent.objects.filter(created_at__gte=since, created_at__lte=now).count()
    resource_packs = ResourcePackLog.objects.filter(completed_at__gte=since, completed_at__lte=now).count()
    agent_stats = AgentRun.objects.filter(started_at__gte=since, started_at__lte=now).aggregate(
        total=Count("pk"),
        failed=Count("pk", filter=Q(status__in=STATUS_ALIASES["failed"])),
    )
    security_stats = SecurityEvent.objects.filter(created_at__gte=since, created_at__lte=now).aggregate(
        total=Count("pk"),
        actionable=Count(
            "pk",
            filter=Q(review_status=SecurityEvent.ReviewStatus.PENDING)
            & Q(severity__in=["warning", "error", "critical"]),
        ),
    )

    agent_total = agent_stats["total"] or 0
    agent_failed = agent_stats["failed"] or 0
    metrics = {
        "users": _metric(user_total, "注册账号总数", "accounts.User", "all_time"),
        "newUsers": _metric(new_users, "所选周期内新增账号", "accounts.User.created_at", range_value),
        "activeUsers": _metric(
            active_users,
            "所选周期内有访问心跳或学习事件证据的账号（去重）",
            "accounts.UserAccessState.last_seen_at|learning.LearningEvent.created_at",
            range_value,
        ),
        "coachingSessions": _metric(coaching_sessions, "所选周期内创建的辅导会话", "learning.CoachingSession.created_at", range_value),
        "learningEvents": _metric(learning_events, "所选周期内写入的学习事件", "learning.LearningEvent.created_at", range_value),
        "resourcePacks": _metric(resource_packs, "所选周期内完成写回的资源包", "learning.ResourcePackLog.completed_at", range_value),
        "agentRuns": _metric(agent_total, "所选周期内启动的 Agent 工作流", "compat.AgentRun.started_at", range_value),
        "agentFailureRate": _metric(
            round(agent_failed * 100 / agent_total, 2) if agent_total else 0.0,
            "所选周期内失败 Agent 工作流占比（%）",
            "compat.AgentRun.status",
            range_value,
        ),
        "securityEvents": _metric(security_stats["total"] or 0, "所选周期内安全事件", "system.SecurityEvent.created_at", range_value),
    }
    if range_value == "24h":
        metrics.update(
            {
                "activeUsers24h": dict(metrics["activeUsers"]),
                "coachingSessions24h": dict(metrics["coachingSessions"]),
                "learningEvents24h": dict(metrics["learningEvents"]),
                "resourcePacks24h": dict(metrics["resourcePacks"]),
                "agentRuns24h": dict(metrics["agentRuns"]),
            }
        )

    trends = _build_trends(period, now, active_user_trends)
    task_groups = {
        "resource": _task_counts(ResourceGenerationJob, now),
        "video": _task_counts(VideoGenerationJob, now),
        "knowledge": _task_counts(KnowledgeIndexJob, now),
        "agent": _task_counts(AgentRun, now),
    }
    task_totals = {
        state: sum(group[state] for group in task_groups.values())
        for state in TASK_STATES
    }
    knowledge_stats = KnowledgeResource.objects.aggregate(resources=Count("pk"))

    services, services_partial = _build_services(now)
    activity_partial = False
    try:
        activity = _build_activity(since, now)
    except Exception:  # pragma: no cover - isolated degradation for optional feed
        activity = []
        activity_partial = True

    data_status = "partial" if services_partial or activity_partial else "collected"
    alerts = _build_alerts(
        services=services,
        task_groups=task_groups,
        task_totals=task_totals,
        security_total=security_stats["total"] or 0,
        actionable_security=security_stats["actionable"] or 0,
    )
    task_groups["totals"] = dict(task_totals)

    return {
        "schemaVersion": "a3.admin-overview.v2",
        "generatedAt": now.isoformat(),
        "range": range_value,
        "dataStatus": data_status,
        "period": {
            "startAt": since.isoformat(),
            "endAt": now.isoformat(),
            "startDate": period["start_date"].isoformat(),
            "endDate": period["end_date"].isoformat(),
            "timeZone": "Asia/Shanghai",
            "bucketUnit": period["bucket_unit"],
        },
        "metrics": metrics,
        "trends": trends,
        "services": services,
        "tasks": task_groups,
        "taskTotals": task_totals,
        "alerts": alerts,
        "activity": activity,
        "knowledgeBase": {
            "resources": knowledge_stats["resources"] or 0,
            "failedJobs": task_groups["knowledge"]["failed"],
            "dataStatus": "collected",
            "evidence": {"source": "knowledge_base.KnowledgeResource/index_job"},
        },
        "security": {
            "events24h": SecurityEvent.objects.filter(created_at__gte=now - timedelta(hours=24), created_at__lte=now).count()
            if range_value != "24h"
            else security_stats["total"] or 0,
            "eventsInRange": security_stats["total"] or 0,
            "actionableInRange": security_stats["actionable"] or 0,
            "dataStatus": "collected",
        },
        "evidence": {
            "sources": [
                "accounts.User",
                "accounts.UserAccessState",
                "learning.CoachingSession",
                "learning.LearningEvent",
                "learning.ResourcePackLog",
                "compat.AgentRun",
                "compat.ResourceGenerationJob",
                "compat.VideoGenerationJob",
                "knowledge_base.KnowledgeIndexJob",
                "system.SecurityEvent",
                "system.AdminAuditLog",
            ],
            "fabricatedValues": False,
        },
    }


def _metric(value: int | float, definition: str, source: str, window: str) -> dict:
    return {
        "value": value,
        "dataStatus": "collected",
        "definition": definition,
        "evidence": {"source": source, "window": window},
    }


def _build_period(now: datetime, range_value: str) -> dict:
    local_now = now.astimezone(SHANGHAI)
    if range_value == "24h":
        filter_start = local_now - timedelta(hours=24)
        first_bucket = filter_start.replace(minute=0, second=0, microsecond=0)
        current_bucket = local_now.replace(minute=0, second=0, microsecond=0)
        bucket_count = int((current_bucket - first_bucket).total_seconds() // 3600) + 1
        bucket_starts = [first_bucket + timedelta(hours=offset) for offset in range(bucket_count)]
        bucket_unit = "hour"
    else:
        days = 7 if range_value == "7d" else 30
        first_date = local_now.date() - timedelta(days=days - 1)
        first_bucket = datetime.combine(first_date, datetime.min.time(), SHANGHAI)
        filter_start = first_bucket
        bucket_starts = [first_bucket + timedelta(days=offset) for offset in range(days)]
        bucket_unit = "day"
    return {
        "start_at": filter_start,
        "start_date": filter_start.date(),
        "end_date": local_now.date(),
        "bucket_starts": bucket_starts,
        "bucket_unit": bucket_unit,
    }


def _active_user_evidence(period: dict, now: datetime) -> tuple[int, dict[str, int]]:
    truncation = TruncHour if period["bucket_unit"] == "hour" else TruncDay
    start_at = period["start_at"]
    users_by_bucket: dict[str, set[int]] = {}
    all_users: set[int] = set()
    for model, field in (
        (UserAccessState, "last_seen_at"),
        (LearningEvent, "created_at"),
    ):
        rows = (
            model.objects.filter(**{f"{field}__gte": start_at, f"{field}__lte": now})
            .annotate(bucket=truncation(field, tzinfo=SHANGHAI))
            .values_list("bucket", "user_id")
            .distinct()
        )
        for bucket, user_id in rows:
            key = _bucket_key(bucket, period["bucket_unit"])
            users_by_bucket.setdefault(key, set()).add(user_id)
            all_users.add(user_id)
    return len(all_users), {key: len(user_ids) for key, user_ids in users_by_bucket.items()}


def _build_trends(period: dict, now: datetime, active_user_trends: dict[str, int]) -> list[dict]:
    truncation = TruncHour if period["bucket_unit"] == "hour" else TruncDay
    start_at = period["start_at"]
    counts = {
        "activeUsers": active_user_trends,
        "coachingSessions": _trend_counts(CoachingSession, "created_at", start_at, now, truncation),
        "resourcePacks": _trend_counts(ResourcePackLog, "completed_at", start_at, now, truncation),
        "agentRuns": _trend_counts(AgentRun, "started_at", start_at, now, truncation),
    }
    trends = []
    for bucket_start in period["bucket_starts"]:
        key = _bucket_key(bucket_start, period["bucket_unit"])
        trends.append(
            {
                "date": key,
                "label": bucket_start.strftime("%H:00" if period["bucket_unit"] == "hour" else "%m-%d"),
                **{name: values.get(key, 0) for name, values in counts.items()},
                "dataStatus": "collected",
            }
        )
    return trends


def _trend_counts(model, field: str, start_at: datetime, now: datetime, truncation) -> dict[str, int]:
    rows = (
        model.objects.filter(**{f"{field}__gte": start_at, f"{field}__lte": now})
        .annotate(bucket=truncation(field, tzinfo=SHANGHAI))
        .values("bucket")
        .annotate(value=Count("pk"))
        .values_list("bucket", "value")
    )
    bucket_unit = "hour" if truncation is TruncHour else "day"
    return {_bucket_key(bucket, bucket_unit): value for bucket, value in rows}


def _bucket_key(value: datetime, bucket_unit: str) -> str:
    local_value = value.astimezone(SHANGHAI) if timezone.is_aware(value) else value.replace(tzinfo=SHANGHAI)
    if bucket_unit == "hour":
        return local_value.isoformat(timespec="hours")
    return local_value.date().isoformat()


def _task_counts(model, now: datetime | None = None) -> dict:
    current_time = now or timezone.now()
    if model is ResourceGenerationJob:
        filters = _resource_task_filters(current_time)
    elif model is KnowledgeIndexJob:
        filters = _knowledge_task_filters(current_time)
    elif model is VideoGenerationJob:
        filters = _video_task_filters(current_time)
    elif model is AgentRun:
        filters = _agent_task_filters(current_time)
    else:  # pragma: no cover - only the four operational models are supported
        raise ValueError(f"Unsupported admin task model: {model.__name__}")
    counts = model.objects.aggregate(
        **{
            state: Count("pk", filter=filters[state])
            for state in TASK_STATES
        }
    )
    return {state: counts[state] or 0 for state in TASK_STATES}


def _terminal_task_filters() -> dict[str, Q]:
    return {
        "succeeded": Q(status__in=STATUS_ALIASES["succeeded"]),
        "failed": Q(status__in=STATUS_ALIASES["failed"]),
        "cancelled": Q(status__in=STATUS_ALIASES["cancelled"]),
    }


def _resource_task_filters(now: datetime) -> dict[str, Q]:
    normal_cutoff = now - timedelta(minutes=_setting_minutes("RESOURCE_GENERATION_JOB_STALE_MINUTES", 15))
    celery_cutoff = now - timedelta(minutes=_setting_minutes("RESOURCE_GENERATION_CELERY_STALE_MINUTES", 240))
    active_statuses = STATUS_ALIASES["queued"] | STATUS_ALIASES["running"]
    celery = Q(metadata__executionBackend="celery")
    non_celery = Q(metadata__executionBackend__isnull=True) | ~celery
    stale_active = Q(status__in=active_statuses) & (
        (celery & Q(updated_at__lt=celery_cutoff))
        | (non_celery & Q(updated_at__lt=normal_cutoff))
    )
    fresh_backend = (
        (celery & Q(updated_at__gte=celery_cutoff))
        | (non_celery & Q(updated_at__gte=normal_cutoff))
    )
    return {
        "queued": Q(status__in=STATUS_ALIASES["queued"]) & fresh_backend,
        "running": Q(status__in=STATUS_ALIASES["running"]) & fresh_backend,
        **_terminal_task_filters(),
        "stale": Q(status__in=STATUS_ALIASES["stale"]) | stale_active,
    }


def _knowledge_task_filters(now: datetime) -> dict[str, Q]:
    cutoff = now - timedelta(minutes=_setting_minutes("KNOWLEDGE_INDEX_JOB_STALE_MINUTES", 10))
    stale_running = Q(status="running", updated_at__lt=cutoff)
    return {
        "queued": Q(status__in=STATUS_ALIASES["queued"]),
        "running": Q(status__in=STATUS_ALIASES["running"]) & ~stale_running,
        **_terminal_task_filters(),
        "stale": Q(status__in=STATUS_ALIASES["stale"]) | stale_running,
    }


def _video_task_filters(now: datetime) -> dict[str, Q]:
    cutoff = now - timedelta(minutes=_setting_minutes("VIDEO_GENERATION_JOB_STALE_MINUTES", 5))
    active_statuses = STATUS_ALIASES["queued"] | STATUS_ALIASES["running"]
    stale_active = Q(status__in=active_statuses, updated_at__lt=cutoff)
    fresh_active = Q(updated_at__gte=cutoff)
    return {
        "queued": Q(status__in=STATUS_ALIASES["queued"]) & fresh_active,
        "running": Q(status__in=STATUS_ALIASES["running"]) & fresh_active,
        **_terminal_task_filters(),
        "stale": Q(status__in=STATUS_ALIASES["stale"]) | stale_active,
    }


def _agent_task_filters(now: datetime) -> dict[str, Q]:
    # Running AgentRun rows have no recovery command, so admin overview uses this configurable evidence threshold.
    cutoff = now - timedelta(minutes=_setting_minutes("ADMIN_AGENT_RUN_STALE_MINUTES", 30))
    stale_running = Q(status__in=STATUS_ALIASES["running"], updated_at__lt=cutoff)
    return {
        "queued": Q(status__in=STATUS_ALIASES["queued"]),
        "running": Q(status__in=STATUS_ALIASES["running"]) & Q(updated_at__gte=cutoff),
        **_terminal_task_filters(),
        "stale": Q(status__in=STATUS_ALIASES["stale"]) | stale_running,
    }


def _setting_minutes(name: str, default: int) -> int:
    try:
        value = int(getattr(settings, name, default) or default)
    except (TypeError, ValueError):
        value = default
    return max(value, 1)


def _build_services(now: datetime) -> tuple[list[dict], bool]:
    status_map = {"ok": "healthy", "warning": "degraded", "error": "down"}
    service_labels = {
        "database": "MySQL",
        "redis": "Redis",
        "celery": "Celery Worker",
        "celeryBeat": "Celery Beat",
        "knowledgeUpload": "知识库文件存储",
        "vectorIndex": "知识库向量索引",
        "defaultCourse": "默认课程",
        "smsVerification": "验证码服务",
        "security": "Django 安全配置",
    }
    partial = False
    try:
        health = build_system_health()
        services = [
            {
                "key": "django",
                "name": "Django API",
                "status": "healthy",
                "message": "当前管理接口已正常响应",
                "dataStatus": "collected",
                "evidence": {"source": "admin_overview_request"},
            }
        ]
        for item in health["checks"]:
            item_data_status = item.get("dataStatus", "collected")
            if item_data_status == "partial":
                partial = True
            services.append(
                {
                "key": item["name"],
                "name": service_labels.get(item["name"], item["name"]),
                "status": (
                    "configured"
                    if item["name"] in {"celery", "celeryBeat"} and item["status"] != "error"
                    else status_map.get(item["status"], "unknown")
                ),
                "message": item["message"],
                "dataStatus": item_data_status,
                "evidence": {"source": "system_health", "probe": item["name"]},
                }
            )
    except Exception:
        partial = True
        services = [
            {
                "key": "systemHealth",
                "name": "系统健康探针",
                "status": "unknown",
                "message": "健康探针暂时不可用",
                "dataStatus": "partial",
                "evidence": {"source": "system_health", "available": False},
            }
        ]

    services.extend(
        [
            {
                "key": "nextjs",
                "name": "Next.js 前端",
                "status": "unknown",
                "message": "后端未采集前端进程心跳",
                "dataStatus": "not_collected",
                "evidence": {"source": "heartbeat", "available": False},
            },
            {
                "key": "realtimeProxy",
                "name": "实时代理",
                "status": "unknown",
                "message": "尚未采集独立 healthz 心跳",
                "dataStatus": "not_collected",
                "evidence": {"source": "heartbeat", "available": False},
            },
        ]
    )
    try:
        services.append(_provider_service(now))
    except Exception:  # pragma: no cover - isolated provider evidence failure
        partial = True
        services.append(
            {
                "key": "modelProviders",
                "name": "模型 Provider",
                "status": "unknown",
                "message": "模型调用证据暂时不可用",
                "dataStatus": "partial",
                "evidence": {"source": "compat.AgentSpan", "available": False},
            }
        )
    return services, partial


def _provider_service(now: datetime) -> dict:
    latest = AgentSpan.objects.filter(kind__in=["llm", "model", "vision", "realtime"]).order_by("-started_at").first()
    base = {
        "key": "modelProviders",
        "name": "模型 Provider",
        "evidence": {"source": "compat.AgentSpan", "latestStartedAt": latest.started_at.isoformat() if latest else None},
    }
    if latest is None:
        return {
            **base,
            "status": "unknown",
            "message": "暂无真实调用证据",
            "dataStatus": "not_collected",
        }
    age = now - latest.started_at
    if latest.status in STATUS_ALIASES["succeeded"] and age <= timedelta(hours=24):
        return {**base, "status": "healthy", "message": "最近 24 小时存在成功 AgentSpan", "dataStatus": "collected"}
    if age <= timedelta(hours=24):
        return {**base, "status": "degraded", "message": "最近一次模型调用未成功", "dataStatus": "collected"}
    return {**base, "status": "unknown", "message": "最近 24 小时无调用证据", "dataStatus": "collected"}


def _build_alerts(
    *,
    services: list[dict],
    task_groups: dict[str, dict[str, int]],
    task_totals: dict[str, int],
    security_total: int,
    actionable_security: int,
) -> list[dict]:
    alerts = []
    if task_totals["failed"]:
        alerts.append(
            _alert(
                "tasks:failed",
                "failed_tasks",
                "error",
                "失败任务",
                task_totals["failed"],
                "资源、视频、索引和 Agent 状态聚合",
            )
        )
    if task_totals["stale"]:
        alerts.append(
            _alert(
                "tasks:stale",
                "stale_tasks",
                "warning",
                "陈旧任务",
                task_totals["stale"],
                f"排队或运行状态超过 {int(STALE_AFTER.total_seconds() // 60)} 分钟",
            )
        )
    if task_groups["agent"]["failed"]:
        alerts.append(
            _alert(
                "agents:failed",
                "agent_failures",
                "warning",
                "Agent 运行失败",
                task_groups["agent"]["failed"],
                "compat.AgentRun.status",
            )
        )
    if task_groups["knowledge"]["failed"]:
        alerts.append(
            _alert(
                "knowledge:failed",
                "knowledge_index_failures",
                "warning",
                "知识库索引失败",
                task_groups["knowledge"]["failed"],
                "knowledge_base.KnowledgeIndexJob.status",
            )
        )
    if security_total:
        alerts.append(
            _alert(
                "security:events",
                "security_events",
                "warning" if actionable_security else "info",
                "安全事件",
                security_total,
                "system.SecurityEvent；其中待处理事件按审核状态统计",
            )
        )
    for service in services:
        if service["status"] in {"degraded", "down"}:
            alerts.append(
                {
                    "id": f"service:{service['key']}",
                    "type": "service_status",
                    "severity": "error" if service["status"] == "down" else "warning",
                    "title": service["name"],
                    "summary": service["message"],
                    "count": 1,
                    "dataStatus": service["dataStatus"],
                    "evidence": service["evidence"],
                }
            )
    return alerts


def _alert(alert_id: str, alert_type: str, severity: str, title: str, count: int, source: str) -> dict:
    return {
        "id": alert_id,
        "type": alert_type,
        "severity": severity,
        "title": title,
        "summary": source,
        "count": count,
        "dataStatus": "collected",
        "evidence": {"source": source},
    }


def _build_activity(since: datetime, now: datetime) -> list[dict]:
    items = []
    for row in (
        AdminAuditLog.objects.filter(created_at__gte=since, created_at__lte=now)
        .order_by("-created_at")
        .values("id", "action", "summary", "success", "created_at")[:ACTIVITY_LIMIT]
    ):
        items.append(
            _activity_item(
                f"audit:{row['id']}",
                "admin_audit",
                row["summary"] or row["action"],
                "succeeded" if row["success"] else "failed",
                row["created_at"],
                "system.AdminAuditLog",
            )
        )
    for row in (
        CoachingSession.objects.filter(created_at__gte=since, created_at__lte=now)
        .order_by("-created_at")
        .values("id", "topic_title", "status", "created_at")[:ACTIVITY_LIMIT]
    ):
        items.append(
            _activity_item(
                f"coaching:{row['id']}",
                "coaching_session",
                row["topic_title"] or "辅导会话",
                _normalized_status(row["status"]),
                row["created_at"],
                "learning.CoachingSession",
            )
        )
    for row in (
        ResourcePackLog.objects.filter(completed_at__gte=since, completed_at__lte=now)
        .order_by("-completed_at")
        .values("id", "task_title", "learning_goal", "completed_at")[:ACTIVITY_LIMIT]
    ):
        items.append(
            _activity_item(
                f"resource:{row['id']}",
                "resource_pack",
                row["task_title"] or row["learning_goal"],
                "succeeded",
                row["completed_at"],
                "learning.ResourcePackLog",
            )
        )
    for row in (
        AgentRun.objects.filter(started_at__gte=since, started_at__lte=now)
        .order_by("-started_at")
        .values("id", "workflow", "status", "started_at")[:ACTIVITY_LIMIT]
    ):
        items.append(
            _activity_item(
                f"agent:{row['id']}",
                "agent_run",
                row["workflow"],
                _normalized_status(row["status"]),
                row["started_at"],
                "compat.AgentRun",
            )
        )
    items.sort(key=lambda item: item["_sortAt"], reverse=True)
    for item in items:
        item.pop("_sortAt")
    return items[:ACTIVITY_LIMIT]


def _activity_item(item_id: str, item_type: str, summary: str, status: str, created_at: datetime, source: str) -> dict:
    return {
        "id": item_id,
        "type": item_type,
        "summary": summary,
        "status": status,
        "createdAt": created_at.isoformat(),
        "dataStatus": "collected",
        "evidence": {"source": source},
        "_sortAt": created_at,
    }


def _normalized_status(status: str) -> str:
    for normalized, aliases in STATUS_ALIASES.items():
        if status in aliases:
            return normalized
    return "failed"
