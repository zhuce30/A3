from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.learning.tutor_personas import (
    get_user_tutor_preference,
    list_public_tutor_personas,
    public_tutor_persona,
    resolve_tutor_persona,
    save_user_tutor_preference,
)
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_updates import confirm_profile_update, dynamic_profile_feed, reject_profile_update
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


@require_http_methods(["GET", "PATCH"])
def tutor_preference(request):
    rejected = _require_login(request)
    if rejected:
        return rejected

    if request.method == "GET":
        preference = get_user_tutor_preference(request.user)
        return JsonResponse(
            {
                "success": True,
                "personas": list_public_tutor_personas(),
                "preference": preference,
                "selectedPersona": public_tutor_persona(preference["personaId"]),
            }
        )

    try:
        payload = json_body(request)
        if not isinstance(payload, dict) or set(payload) != {"personaId"}:
            raise ValueError("request must contain only personaId")
        persona_id = payload["personaId"]
        if not isinstance(persona_id, str) or not persona_id.strip():
            raise ValueError("personaId must be a non-empty string")
        if resolve_tutor_persona(persona_id) is None:
            raise ValueError("personaId is not supported")
        preference = save_user_tutor_preference(request.user, persona_id.strip())
        return JsonResponse(
            {
                "success": True,
                "preference": preference,
                "selectedPersona": public_tutor_persona(preference["personaId"]),
            }
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


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


@require_http_methods(["GET"])
def dynamic_profile(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    profile, _created = LearnerProfile.objects.get_or_create(user=request.user)
    return JsonResponse({"success": True, **dynamic_profile_feed(profile)})


@require_http_methods(["POST"])
def confirm_profile_update_view(request, update_id: str):
    rejected = _require_login(request)
    if rejected:
        return rejected
    profile, _created = LearnerProfile.objects.get_or_create(user=request.user)
    try:
        return JsonResponse({"success": True, **confirm_profile_update(profile, update_id)})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=404)


@require_http_methods(["POST"])
def reject_profile_update_view(request, update_id: str):
    rejected = _require_login(request)
    if rejected:
        return rejected
    profile, _created = LearnerProfile.objects.get_or_create(user=request.user)
    body = json_body(request)
    try:
        return JsonResponse({"success": True, **reject_profile_update(profile, update_id, reason=str(body.get("reason") or ""))})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=404)
