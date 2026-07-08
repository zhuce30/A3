from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.system.services import build_system_health


@require_http_methods(["GET"])
def health(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "Please login first"}, status=401)
    return JsonResponse({"success": True, **build_system_health()})
