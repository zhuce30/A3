from __future__ import annotations

from threading import Lock
from time import monotonic
from uuid import uuid4

from django.core.cache import caches
from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.system.services import build_system_health


READINESS_CACHE_SECONDS = 2.0
_readiness_lock = Lock()
_readiness_snapshot: tuple[float, dict[str, str]] | None = None


@require_http_methods(["GET"])
def liveness(request):
    return JsonResponse({"success": True, "status": "alive"})


def _database_ready() -> bool:
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            return cursor.fetchone() == (1,)
    except Exception:
        return False


def _cache_ready() -> bool:
    token = uuid4().hex
    key = f"a3:readiness:{token}"
    try:
        cache = caches["default"]
        cache.set(key, token, timeout=5)
        return cache.get(key) == token
    except Exception:
        return False


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
