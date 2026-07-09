from __future__ import annotations

from pathlib import Path
from typing import Literal

from django.conf import settings
from django.db import connection

from backend.apps.learning.models import Course
from backend.apps.learning.services import DEFAULT_COURSE_CODE
from backend.core.settings import DEFAULT_EMBED_MODEL, FAISS_INDEX_DIR

CheckStatus = Literal["ok", "warning", "error"]


def _check(name: str, status: CheckStatus, message: str, detail: dict | None = None) -> dict:
    return {
        "name": name,
        "status": status,
        "message": message,
        "detail": detail or {},
    }


def _path_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".a3-healthcheck"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def build_system_health() -> dict:
    checks = [
        _database_check(),
        _course_check(),
        _knowledge_upload_check(),
        _vector_index_check(),
        _verification_code_check(),
        _celery_check(),
        _celery_beat_check(),
        _security_check(),
    ]
    statuses = {item["status"] for item in checks}
    overall: CheckStatus = "error" if "error" in statuses else "warning" if "warning" in statuses else "ok"
    return {
        "overallStatus": overall,
        "checks": checks,
    }


def _database_check() -> dict:
    try:
        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        database = connection.settings_dict
        return _check(
            "database",
            "ok",
            "MySQL connection is available",
            {
                "engine": database.get("ENGINE", ""),
                "host": database.get("HOST", ""),
                "port": database.get("PORT", ""),
                "name": database.get("NAME", ""),
            },
        )
    except Exception as exc:  # pragma: no cover - depends on local database availability
        return _check("database", "error", "Database connection failed", {"error": str(exc)})


def _course_check() -> dict:
    active_count = Course.objects.filter(is_active=True).count()
    default_course = Course.objects.filter(code=DEFAULT_COURSE_CODE, is_active=True).first()
    detail = {"activeCourseCount": active_count, "defaultCourseCode": DEFAULT_COURSE_CODE}
    if default_course:
        detail["defaultCourseTitle"] = default_course.title
        return _check("defaultCourse", "ok", "Default operating-system course is active", detail)
    if active_count:
        return _check("defaultCourse", "warning", f"{DEFAULT_COURSE_CODE} is missing; using another active course", detail)
    return _check("defaultCourse", "error", "No active course is available", detail)


def _knowledge_upload_check() -> dict:
    upload_root = Path(getattr(settings, "KNOWLEDGE_UPLOAD_ROOT", ""))
    if _path_writable(upload_root):
        return _check("knowledgeUpload", "ok", "Knowledge upload directory is writable", {"root": str(upload_root)})
    return _check("knowledgeUpload", "error", "Knowledge upload directory is not writable", {"root": str(upload_root)})


def _vector_index_check() -> dict:
    index_dir = Path(FAISS_INDEX_DIR)
    if index_dir.exists() and any(index_dir.iterdir()):
        return _check(
            "vectorIndex",
            "ok",
            "Vector index directory contains index files",
            {"root": str(index_dir), "embedModel": DEFAULT_EMBED_MODEL},
        )
    return _check(
        "vectorIndex",
        "warning",
        "Vector index has not been built yet",
        {"root": str(index_dir), "embedModel": DEFAULT_EMBED_MODEL},
    )


def _verification_code_check() -> dict:
    sms_configured = bool(str(getattr(settings, "SMS_WEBHOOK_URL", "")).strip())
    email_configured = bool(str(getattr(settings, "EMAIL_HOST_USER", "")).strip() and str(getattr(settings, "EMAIL_HOST_PASSWORD", "")).strip())
    dev_mode = bool(getattr(settings, "VERIFICATION_CODE_DEV_MODE", False))
    if email_configured:
        return _check("smsVerification", "ok", "Email verification is configured", {"mode": "email", "host": str(getattr(settings, "EMAIL_HOST", ""))})
    if sms_configured:
        return _check("smsVerification", "ok", "SMS webhook is configured", {"mode": "webhook"})
    if dev_mode and getattr(settings, "DEBUG", False):
        return _check("smsVerification", "warning", "Using local development verification code", {"mode": "development"})
    return _check("smsVerification", "warning", "Email or SMS verification is not configured", {"mode": "unconfigured"})


def _celery_check() -> dict:
    broker_url = str(getattr(settings, "CELERY_BROKER_URL", ""))
    if broker_url.startswith("redis://") or broker_url == "filesystem://":
        return _check("celery", "ok", "Celery broker is configured", {"broker": _mask_url(broker_url)})
    return _check("celery", "warning", "Celery broker configuration should be reviewed", {"broker": _mask_url(broker_url)})


def _celery_beat_check() -> dict:
    schedule = getattr(settings, "CELERY_BEAT_SCHEDULE", {})
    entry = schedule.get("a3-evaluate-optimization-policy-outcomes-daily") if isinstance(schedule, dict) else None
    if not isinstance(entry, dict):
        return _check(
            "celeryBeat",
            "warning",
            "Optimization policy outcome beat schedule is not registered",
            {"expectedTask": "learning.evaluate_optimization_policy_outcomes"},
        )
    task = str(entry.get("task") or "")
    kwargs = entry.get("kwargs") if isinstance(entry.get("kwargs"), dict) else {}
    schedule_value = entry.get("schedule")
    detail = {
        "entry": "a3-evaluate-optimization-policy-outcomes-daily",
        "task": task,
        "schedule": str(schedule_value),
        "kwargs": kwargs,
        "deployment": "docker compose service celery-beat or equivalent scheduler",
    }
    if task == "learning.evaluate_optimization_policy_outcomes":
        return _check("celeryBeat", "ok", "Optimization policy outcome beat schedule is registered", detail)
    return _check("celeryBeat", "warning", "Optimization policy beat task name should be reviewed", detail)


def _security_check() -> dict:
    debug = bool(getattr(settings, "DEBUG", False))
    allowed_hosts = list(getattr(settings, "ALLOWED_HOSTS", []))
    if debug:
        return _check("security", "warning", "Django is running in DEBUG mode", {"debug": debug, "allowedHosts": allowed_hosts})
    return _check("security", "ok", "Django production safety flags are enabled", {"debug": debug, "allowedHosts": allowed_hosts})


def _mask_url(value: str) -> str:
    if "@" not in value:
        return value
    scheme, rest = value.split("://", 1) if "://" in value else ("", value)
    host = rest.split("@", 1)[1]
    return f"{scheme}://***@{host}" if scheme else f"***@{host}"
