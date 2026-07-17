from __future__ import annotations

from uuid import uuid4

from django.core.cache import caches
from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.system.services import build_system_health


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
    dependencies = {
        "database": "ok" if _database_ready() else "error",
        "redis": "ok" if _cache_ready() else "error",
    }
    is_ready = all(status == "ok" for status in dependencies.values())
    return JsonResponse(
        {
            "success": is_ready,
            "status": "ready" if is_ready else "not_ready",
            "dependencies": dependencies,
        },
        status=200 if is_ready else 503,
    )


@require_http_methods(["GET"])
def health(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "Please login first"}, status=401)
    return JsonResponse({"success": True, **build_system_health()})
