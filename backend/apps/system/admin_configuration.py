from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from celery import current_app
from django.conf import settings
from django.core.cache import cache
from django.core.mail import get_connection
from django.db import connection, transaction
from django.utils import timezone

from backend.apps.system.admin_audit import record_admin_audit
from backend.apps.system.admin_catalog_services import (
    AdminActionError,
    _error_summary,
    _require_reason,
    _safe_audit_reason,
)


VERIFY_TIMEOUT_SECONDS = 2.0
_EVIDENCE_CACHE_PREFIX = "a3:admin:configuration:verification:"
_EVIDENCE_FIELDS = {
    "database": ("reachable",),
    "redis": ("reachable",),
    "celery": ("workerCount",),
    "celery_beat": ("scheduleConfigured",),
    "smtp": ("reachable", "remoteConnectionTested"),
    "sms": ("configured", "messageSent"),
    "model_provider": ("configured", "paidCallPerformed"),
    "storage": ("available", "absolutePathReturned"),
    "realtime_proxy": ("configured", "remoteCallPerformed"),
    "knowledge_index": ("available", "absolutePathReturned"),
}


def _configured(*values: Any) -> bool:
    return any(bool(str(value or "").strip()) for value in values)


def _setting_or_env(name: str) -> str:
    return str(getattr(settings, name, "") or os.getenv(name, "")).strip()


def _safe_evidence(check: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    safe = {}
    for field in _EVIDENCE_FIELDS.get(check, ()):
        item = value.get(field)
        if item is None or isinstance(item, (bool, int, float)):
            safe[field] = item
    return safe


def _safe_message(value: Any, fallback: str) -> str:
    message = str(value or fallback).strip()[:255]
    return message if _error_summary(message) == message[:200] else "配置验证详情已隐藏"


def _item(
    check: str,
    label: str,
    group: str,
    configured: bool,
    message: str,
) -> dict[str, Any]:
    cached = cache.get(f"{_EVIDENCE_CACHE_PREFIX}{check}")
    result = {
        "check": check,
        "label": label,
        "group": group,
        "status": "configured" if configured else "not_configured",
        "configured": configured,
        "message": message,
        "lastVerifiedAt": None,
        "evidence": {},
    }
    if isinstance(cached, dict):
        result.update(
            {
                "status": str(cached.get("status") or result["status"]),
                "message": _safe_message(cached.get("message"), result["message"]),
                "lastVerifiedAt": cached.get("lastVerifiedAt"),
                "evidence": _safe_evidence(check, cached.get("evidence")),
            }
        )
    return result


def _configuration_items() -> list[dict[str, Any]]:
    database_configured = bool(connection.settings_dict.get("ENGINE"))
    cache_backend = str(settings.CACHES.get("default", {}).get("BACKEND", ""))
    broker_configured = _configured(getattr(settings, "CELERY_BROKER_URL", ""))
    beat_configured = bool(getattr(settings, "CELERY_BEAT_SCHEDULE", {}))
    smtp_configured = _configured(getattr(settings, "EMAIL_HOST_USER", "")) and _configured(
        getattr(settings, "EMAIL_HOST_PASSWORD", "")
    )
    sms_configured = _configured(getattr(settings, "SMS_WEBHOOK_URL", ""))
    model_configured = _configured(
        _setting_or_env("OPENAI_API_KEY"),
        _setting_or_env("DASHSCOPE_API_KEY"),
        _setting_or_env("ARK_API_KEY"),
    )
    storage_configured = _configured(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", ""))
    realtime_configured = _configured(
        getattr(settings, "REALTIME_PROXY_URL", ""),
        getattr(settings, "A3_REALTIME_PROXY_URL", ""),
    )
    index_configured = _configured(getattr(settings, "FAISS_INDEX_DIR", "")) or _configured(
        os.getenv("A3_FAISS_INDEX_DIR", "")
    )
    return [
        _item("database", "数据库", "runtime", database_configured, "数据库连接参数已配置" if database_configured else "数据库未配置"),
        _item("redis", "Redis 缓存", "runtime", "locmem" not in cache_backend.lower(), "共享缓存已配置" if "locmem" not in cache_backend.lower() else "当前使用进程内缓存"),
        _item("celery", "Celery 队列", "runtime", broker_configured, "任务队列已配置" if broker_configured else "任务队列未配置"),
        _item("celery_beat", "Celery Beat", "runtime", beat_configured, "定时任务已登记" if beat_configured else "定时任务未登记"),
        _item("smtp", "邮件服务", "notifications", smtp_configured, "邮件服务已配置" if smtp_configured else "邮件服务未配置"),
        _item("sms", "短信服务", "notifications", sms_configured, "短信服务已配置" if sms_configured else "短信服务未配置"),
        _item("model_provider", "模型 Provider", "providers", model_configured, "模型凭据已配置" if model_configured else "模型凭据未配置"),
        _item("storage", "知识资料存储", "storage", storage_configured, "资料存储已配置" if storage_configured else "资料存储未配置"),
        _item("realtime_proxy", "实时代理", "providers", realtime_configured, "实时代理已配置" if realtime_configured else "实时代理未配置"),
        _item("knowledge_index", "知识库索引", "storage", index_configured, "索引目录已配置" if index_configured else "索引目录未配置"),
    ]


def list_configuration() -> dict[str, Any]:
    return {"items": _configuration_items(), "generatedAt": timezone.now().isoformat()}


def _verification(status: str, message: str, evidence: dict[str, Any]) -> dict[str, Any]:
    return {"status": status, "message": message, "evidence": evidence}


def _verify_database(*, timeout: float) -> dict[str, Any]:
    del timeout
    connection.ensure_connection()
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        cursor.fetchone()
    return _verification("configured", "数据库连接验证成功", {"reachable": True})


def _verify_redis(*, timeout: float) -> dict[str, Any]:
    del timeout
    key = "a3:admin:configuration:redis-probe"
    cache.set(key, "ok", timeout=5)
    reachable = cache.get(key) == "ok"
    cache.delete(key)
    return _verification(
        "configured" if reachable else "error",
        "缓存读写验证成功" if reachable else "缓存读写验证失败",
        {"reachable": reachable},
    )


def _verify_celery(*, timeout: float) -> dict[str, Any]:
    responses = current_app.control.inspect(timeout=timeout).ping() or {}
    reachable = bool(responses)
    return _verification(
        "configured" if reachable else "not_monitored",
        "检测到 Celery Worker" if reachable else "未检测到 Celery Worker 心跳",
        {"workerCount": len(responses)},
    )


def _verify_celery_beat(*, timeout: float) -> dict[str, Any]:
    del timeout
    configured = bool(getattr(settings, "CELERY_BEAT_SCHEDULE", {}))
    return _verification(
        "configured" if configured else "not_configured",
        "定时任务配置已登记" if configured else "未登记定时任务配置",
        {"scheduleConfigured": configured},
    )


def _verify_smtp(*, timeout: float) -> dict[str, Any]:
    backend = str(getattr(settings, "EMAIL_BACKEND", ""))
    if backend.endswith("locmem.EmailBackend"):
        return _verification("not_monitored", "当前使用本地邮件后端", {"remoteConnectionTested": False})
    connection_backend = get_connection(timeout=timeout)
    opened = bool(connection_backend.open())
    connection_backend.close()
    return _verification(
        "configured" if opened else "error",
        "邮件服务连接验证成功" if opened else "邮件服务连接验证失败",
        {"reachable": opened},
    )


def _verify_sms(*, timeout: float) -> dict[str, Any]:
    del timeout
    configured = _configured(getattr(settings, "SMS_WEBHOOK_URL", ""))
    return _verification(
        "configured" if configured else "not_configured",
        "短信配置格式有效，未发送测试短信" if configured else "短信服务未配置",
        {"configured": configured, "messageSent": False},
    )


def _verify_model_provider(*, timeout: float) -> dict[str, Any]:
    del timeout
    configured = _configured(
        _setting_or_env("OPENAI_API_KEY"),
        _setting_or_env("DASHSCOPE_API_KEY"),
        _setting_or_env("ARK_API_KEY"),
    )
    return _verification(
        "configured" if configured else "not_configured",
        "模型服务配置格式有效，未执行付费调用" if configured else "模型服务未配置，未执行付费调用",
        {"configured": configured, "paidCallPerformed": False},
    )


def _verify_storage(*, timeout: float) -> dict[str, Any]:
    del timeout
    root = Path(str(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", "") or "."))
    available = root.exists() and root.is_dir()
    return _verification(
        "configured" if available else "error",
        "资料存储目录可用" if available else "资料存储目录不可用",
        {"available": available, "absolutePathReturned": False},
    )


def _verify_realtime_proxy(*, timeout: float) -> dict[str, Any]:
    del timeout
    configured = _configured(
        getattr(settings, "REALTIME_PROXY_URL", ""),
        getattr(settings, "A3_REALTIME_PROXY_URL", ""),
    )
    return _verification(
        "configured" if configured else "not_configured",
        "实时代理配置格式有效" if configured else "实时代理未配置",
        {"configured": configured, "remoteCallPerformed": False},
    )


def _verify_knowledge_index(*, timeout: float) -> dict[str, Any]:
    del timeout
    root_value = str(getattr(settings, "FAISS_INDEX_DIR", "") or os.getenv("A3_FAISS_INDEX_DIR", ""))
    available = bool(root_value and Path(root_value).exists())
    return _verification(
        "configured" if available else "not_configured",
        "知识库索引可用" if available else "尚未发现可用的知识库索引",
        {"available": available, "absolutePathReturned": False},
    )


_VERIFIERS = {
    "database": "_verify_database",
    "redis": "_verify_redis",
    "celery": "_verify_celery",
    "celery_beat": "_verify_celery_beat",
    "smtp": "_verify_smtp",
    "sms": "_verify_sms",
    "model_provider": "_verify_model_provider",
    "storage": "_verify_storage",
    "realtime_proxy": "_verify_realtime_proxy",
    "knowledge_index": "_verify_knowledge_index",
}


def verify_configuration(
    *,
    actor,
    check: str,
    reason: Any,
    actor_ip: str | None = None,
) -> dict[str, Any]:
    normalized_reason = str(reason or "").strip()[:255]
    audit_check = str(check or "")[:128]
    try:
        normalized_reason = _require_reason(reason)
        if not isinstance(check, str) or not check or len(check) > 64 or not check.replace("_", "").isalnum():
            raise AdminActionError("配置检查项无效", error_code="invalid_check")
        verifier_name = _VERIFIERS.get(check)
        if verifier_name is None:
            raise AdminActionError("配置检查项不存在", status_code=404, error_code="not_found")
        verifier = globals()[verifier_name]
        try:
            result = verifier(timeout=VERIFY_TIMEOUT_SECONDS)
        except Exception as exc:
            raise AdminActionError("配置验证失败，请检查服务状态", status_code=503, error_code="verification_failed") from exc
        verified_at = timezone.now().isoformat()
        cached = {
            "status": str(result.get("status") or "error"),
            "message": _safe_message(result.get("message"), "配置验证已完成"),
            "lastVerifiedAt": verified_at,
            "evidence": _safe_evidence(check, result.get("evidence")),
        }
        cache.set(f"{_EVIDENCE_CACHE_PREFIX}{check}", cached, timeout=86400)
        item = next(item for item in _configuration_items() if item["check"] == check)
        with transaction.atomic():
            record_admin_audit(
                actor=actor,
                action="configuration.verify",
                target_type="configuration",
                target_id=check,
                summary="验证系统配置",
                reason=normalized_reason,
                after={"status": item["status"], "check": check},
                metadata={"check": check},
                after_allowlist=("status", "check"),
                metadata_allowlist=("check",),
                actor_ip=actor_ip,
            )
        return {"item": item}
    except AdminActionError as exc:
        record_admin_audit(
            actor=actor,
            action="configuration.verify",
            target_type="configuration",
            target_id=audit_check,
            summary=str(exc),
            reason=_safe_audit_reason(normalized_reason),
            metadata={"errorCode": exc.error_code, "check": str(check)[:64]},
            metadata_allowlist=("errorCode", "check"),
            actor_ip=actor_ip,
            success=False,
        )
        raise
    except Exception as exc:
        error = AdminActionError("配置验证失败，请稍后重试", status_code=500, error_code="operation_failed")
        record_admin_audit(
            actor=actor,
            action="configuration.verify",
            target_type="configuration",
            target_id=audit_check,
            summary=str(error),
            reason=_safe_audit_reason(normalized_reason),
            metadata={"errorCode": error.error_code, "check": str(check)[:64]},
            metadata_allowlist=("errorCode", "check"),
            actor_ip=actor_ip,
            success=False,
        )
        raise error from exc
