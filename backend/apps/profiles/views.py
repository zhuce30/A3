from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.profiles.services import get_learning_profile_options, get_profile_payload, save_learning_profile, update_user_profile, extract_and_save_profile
from backend.utils.http import json_body


def _require_login(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "请先登录"}, status=401)
    return None


@require_http_methods(["GET", "PATCH"])
def my_profile(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    if request.method == "GET":
        return JsonResponse({"success": True, **get_profile_payload(request.user)})

    try:
        payload = update_user_profile(request.user, json_body(request))
        return JsonResponse({"success": True, **payload})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def profile_options(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **get_learning_profile_options()})


@require_http_methods(["POST"])
def learning_profile(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = save_learning_profile(request.user, json_body(request))
        return JsonResponse({"success": True, **payload})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def extract_profile(request):
    """Extract and save a learner profile from free-form text."""
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        body = json_body(request)
        text = str(body.get("text", "")).strip()
        if not text:
            return JsonResponse({"success": False, "error": "text 不能为空"}, status=400)
        result = extract_and_save_profile(request.user, text)
        return JsonResponse({"success": True, **result})
    except PermissionError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=403)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=500)
