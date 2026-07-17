from __future__ import annotations

from threading import Lock
from time import monotonic

import pymysql
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from redis import Redis

from backend.apps.system.services import build_system_health


READINESS_CACHE_SECONDS = 2.0
READINESS_DEPENDENCY_TIMEOUT_SECONDS = 1
_readiness_lock = Lock()
_readiness_snapshot: tuple[float, dict[str, str]] | None = None


@require_http_methods(["GET"])
def liveness(request):
    return JsonResponse({"success": True, "status": "alive"})


def _database_ready() -> bool:
    database = None
    try:
        config = settings.DATABASES["default"]
        database = pymysql.connect(
            host=str(config.get("HOST") or "127.0.0.1"),
            port=int(config.get("PORT") or 3306),
            user=str(config.get("USER") or ""),
            password=str(config.get("PASSWORD") or ""),
            database=str(config.get("NAME") or ""),
            charset="utf8mb4",
            connect_timeout=READINESS_DEPENDENCY_TIMEOUT_SECONDS,
            read_timeout=READINESS_DEPENDENCY_TIMEOUT_SECONDS,
            write_timeout=READINESS_DEPENDENCY_TIMEOUT_SECONDS,
        )
        with database.cursor() as cursor:
            cursor.execute("SELECT 1")
            return cursor.fetchone() == (1,)
    except Exception:
        return False
    finally:
        if database is not None:
            database.close()


def _cache_ready() -> bool:
    redis = None
    try:
        redis_url = str(getattr(settings, "CACHE_REDIS_URL", "")).strip()
        if not redis_url:
            return False
        redis = Redis.from_url(
            redis_url,
            socket_connect_timeout=READINESS_DEPENDENCY_TIMEOUT_SECONDS,
            socket_timeout=READINESS_DEPENDENCY_TIMEOUT_SECONDS,
        )
        return bool(redis.ping())
    except Exception:
        return False
    finally:
        if redis is not None:
            redis.close()


@require_http_methods(["GET"])
def readiness(request):
    dependencies = _readiness_dependencies()
    is_ready = all(status == "ok" for status in dependencies.values())
    return JsonResponse(
        {
            "success": is_ready,
            "status": "ready" if is_ready else "not_ready",
            "dependencies": dependencies,
        },
        status=200 if is_ready else 503,
    )


def _readiness_dependencies() -> dict[str, str]:
    global _readiness_snapshot

    now = monotonic()
    if _readiness_snapshot and now - _readiness_snapshot[0] < READINESS_CACHE_SECONDS:
        return dict(_readiness_snapshot[1])

    with _readiness_lock:
        now = monotonic()
        if _readiness_snapshot and now - _readiness_snapshot[0] < READINESS_CACHE_SECONDS:
            return dict(_readiness_snapshot[1])
        dependencies = {
            "database": "ok" if _database_ready() else "error",
            "redis": "ok" if _cache_ready() else "error",
        }
        _readiness_snapshot = (monotonic(), dependencies)
        return dict(dependencies)


@require_http_methods(["GET"])
def health(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "Please login first"}, status=401)
    return JsonResponse({"success": True, **build_system_health()})
