from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import Q
from django.http import JsonResponse
from django.middleware.csrf import get_token
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from backend.apps.accounts.services import (
    create_verification_code,
    login_user,
    logout_user,
    public_user,
    register_user,
    verify_code,
)
from backend.apps.accounts.tokens import create_access_token
from backend.apps.accounts.permissions import require_authenticated
from backend.apps.accounts.presence import touch_user_presence
from backend.utils.http import json_body

User = get_user_model()


def _is_local_request(request) -> bool:
    remote_addr = request.META.get("REMOTE_ADDR", "")
    host = request.get_host().split(":")[0]
    return remote_addr in {"127.0.0.1", "::1"} and host in {"localhost", "127.0.0.1"}


@ensure_csrf_cookie
@require_http_methods(["GET"])
def csrf_token(request):
    return JsonResponse({"success": True, "csrfToken": get_token(request)})


@require_http_methods(["POST"])
def register(request):
    try:
        body = json_body(request)
        password = str(body.get("password", ""))
        if password != str(body.get("confirmPassword", password)):
            raise ValueError("两次输入的密码不一致")
        user = register_user(
            request,
            phone=str(body.get("phone", "")).strip(),
            email=str(body.get("email", "")).strip(),
            code=str(body.get("code", "")).strip(),
            password=password,
            role=str(body.get("role", "student")),
            school=str(body.get("school", "")),
            display_name=str(body.get("displayName", "")).strip(),
        )
        return JsonResponse({"success": True, "user": public_user(user)}, status=201)
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def login_view(request):
    try:
        body = json_body(request)
        user = login_user(
            request,
            identifier=str(body.get("identifier", "")).strip(),
            password=str(body.get("password", "")),
        )
        return JsonResponse({"success": True, "user": public_user(user)})
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=401)


@require_http_methods(["POST"])
def token_login(request):
    try:
        body = json_body(request)
        user = login_user(
            request,
            identifier=str(body.get("identifier", "") or body.get("phone", "")).strip(),
            password=str(body.get("password", "")),
        )
        return JsonResponse({
            "success": True,
            "tokenType": "Bearer",
            "accessToken": create_access_token(user),
            "expiresIn": 60 * 60 * 24 * 7,
            "user": public_user(user),
        })
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=401)


@require_http_methods(["POST"])
def logout_view(request):
    logout_user(request)
    return JsonResponse({"success": True, "loggedOut": True})


@require_http_methods(["GET"])
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": True, "user": None})
    return JsonResponse({"success": True, "user": public_user(request.user)})


@require_http_methods(["POST"])
def send_code(request):
    try:
        body = json_body(request)
        delivery = create_verification_code(
            str(body.get("target", "")).strip(),
            purpose=str(body.get("purpose", "")).strip(),
            allow_dev_code=_is_local_request(request),
        )
        payload = {
            "success": True,
            "sent": delivery.sent,
            "retryAfter": delivery.retry_after,
        }
        if delivery.dev_code:
            payload["devCode"] = delivery.dev_code
        return JsonResponse(payload)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=429)
    except RuntimeError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=503)


@require_http_methods(["POST"])
def reset_password(request):
    try:
        body = json_body(request)
        identifier = str(body.get("identifier", "")).strip()
        code = str(body.get("code", "")).strip()
        password = str(body.get("password", ""))
        if password != str(body.get("confirmPassword", password)):
            raise ValueError("两次输入的密码不一致")
        if len(password) < 8:
            raise ValueError("密码至少需要 8 位")
        if not verify_code(identifier, code, purpose="reset", consume=True):
            raise ValueError("验证码不正确、已过期或尝试次数过多")
        user = User.objects.filter(
            Q(phone=identifier) | Q(email=identifier) | Q(student_id=identifier)
        ).first()
        if user is None:
            raise ValueError("账号不存在")
        user.set_password(password)
        user.save(update_fields=["password", "updated_at"])
        return JsonResponse({"success": True, "user": public_user(user)})
    except Exception as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["POST"])
def presence_heartbeat(request):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    body = json_body(request)
    path = str(body.get("path", ""))[:255]
    if path and not path.startswith("/a3"):
        return JsonResponse({"success": False, "error": "页面路径无效"}, status=400)
    presence = touch_user_presence(request.user, request, path)
    return JsonResponse({"success": True, "presence": presence})
