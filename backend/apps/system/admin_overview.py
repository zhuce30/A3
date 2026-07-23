from __future__ import annotations

from datetime import timedelta

from django.contrib.auth import get_user_model
from django.utils import timezone

from backend.apps.accounts.models import UserAccessState
from backend.apps.compat.models import AgentRun, AgentSpan, ResourceGenerationJob, VideoGenerationJob
from backend.apps.knowledge_base.models import KnowledgeIndexJob, KnowledgeResource
from backend.apps.learning.models import CoachingSession, LearningEvent, ResourcePackLog
from backend.apps.system.models import SecurityEvent
from backend.apps.system.services import build_system_health


User = get_user_model()


def build_admin_overview() -> dict:
    now = timezone.now()
    since = now - timedelta(hours=24)
    health = build_system_health()
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
    services = [
        {
            "key": item["name"],
            "name": service_labels.get(item["name"], item["name"]),
            "status": "configured" if item["name"] in {"celery", "celeryBeat"} and item["status"] != "error" else status_map.get(item["status"], "unknown"),
            "message": item["message"],
        }
        for item in health["checks"]
    ]
    services.insert(0, {"key": "django", "name": "Django API", "status": "healthy", "message": "当前管理接口可正常响应"})
    services.extend([
        {"key": "nextjs", "name": "Next.js 前端", "status": "unknown", "message": "后端未采集前端进程心跳"},
        {"key": "realtimeProxy", "name": "实时代理", "status": "unknown", "message": "尚未采集独立 healthz 心跳"},
        _provider_service(now),
    ])
    return {
        "schemaVersion": "a3.admin-overview.v1",
        "generatedAt": now.isoformat(),
        "metrics": {
            "users": {"value": User.objects.count(), "dataStatus": "collected", "definition": "注册账号总数"},
            "activeUsers24h": {
                "value": UserAccessState.objects.filter(last_seen_at__gte=since).count(),
                "dataStatus": "collected",
                "definition": "最近 24 小时有可信心跳或登录记录的账号",
            },
            "coachingSessions24h": {"value": CoachingSession.objects.filter(created_at__gte=since).count(), "dataStatus": "collected", "definition": "最近 24 小时辅导会话"},
            "learningEvents24h": {"value": LearningEvent.objects.filter(created_at__gte=since).count(), "dataStatus": "collected", "definition": "最近 24 小时学习事件"},
            "resourcePacks24h": {"value": ResourcePackLog.objects.filter(created_at__gte=since).count(), "dataStatus": "collected", "definition": "最近 24 小时资源包"},
            "agentRuns24h": {"value": AgentRun.objects.filter(created_at__gte=since).count(), "dataStatus": "collected", "definition": "最近 24 小时 Agent 工作流"},
        },
        "services": services,
        "tasks": {
            "resource": _task_counts(ResourceGenerationJob),
            "video": _task_counts(VideoGenerationJob),
            "knowledge": _task_counts(KnowledgeIndexJob),
        },
        "knowledgeBase": {
            "resources": KnowledgeResource.objects.count(),
            "failedJobs": KnowledgeIndexJob.objects.filter(status="failed").count(),
        },
        "security": {"events24h": SecurityEvent.objects.filter(created_at__gte=since).count()},
    }


def _task_counts(model) -> dict:
    statuses = {"queued": 0, "running": 0, "succeeded": 0, "failed": 0}
    for status in statuses:
        statuses[status] = model.objects.filter(status=status).count()
    return statuses


def _provider_service(now) -> dict:
    latest = AgentSpan.objects.filter(kind__in=["llm", "model", "vision", "realtime"]).order_by("-started_at").first()
    if latest is None:
        return {"key": "modelProviders", "name": "模型 Provider", "status": "unknown", "message": "暂无真实调用证据"}
    age = now - latest.started_at
    if latest.status in {"completed", "succeeded", "success"} and age <= timedelta(hours=24):
        return {"key": "modelProviders", "name": "模型 Provider", "status": "healthy", "message": "最近 24 小时存在成功 AgentSpan"}
    if age <= timedelta(hours=24):
        return {"key": "modelProviders", "name": "模型 Provider", "status": "degraded", "message": "最近一次模型调用未成功"}
    return {"key": "modelProviders", "name": "模型 Provider", "status": "unknown", "message": "最近 24 小时无调用证据"}
