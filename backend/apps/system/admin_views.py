from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods

from backend.apps.accounts.client_ip import get_client_ip
from backend.apps.accounts.models import UserAccessState, UserRole
from backend.apps.accounts.permissions import require_admin_role
from backend.apps.system.admin_agent_services import get_agent_run, list_agent_runs
from backend.apps.system.admin_catalog_services import list_courses, list_resources
from backend.apps.system.admin_conversation_services import (
    get_conversation,
    list_conversations,
    reveal_conversation_messages,
)
from backend.apps.system.admin_overview import build_admin_overview
from backend.apps.system.admin_task_services import get_task, list_tasks
from backend.apps.system.admin_user_services import admin_user_queryset, list_admin_users, serialize_admin_user
from backend.apps.system.models import AdminAuditLog, SecurityEvent
from backend.utils.http import json_body


User = get_user_model()


def _admin_rejection(request):
    rejected = require_admin_role(request)
    if rejected and request.user.is_authenticated:
        SecurityEvent.objects.create(
            user=request.user,
            category="admin_access_denied",
            severity="warning",
            source="admin_api",
            summary="非管理员账号尝试访问系统管理接口",
        )
    return rejected


@require_http_methods(["GET"])
def overview(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    try:
        payload = build_admin_overview(request.GET.get("range", "24h"))
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    return JsonResponse({"success": True, **payload})


@require_http_methods(["GET"])
def users(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    try:
        return JsonResponse({"success": True, **list_admin_users(request.GET)})
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["GET"])
def user_detail(request, user_id: int):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    user = admin_user_queryset().filter(pk=user_id).first()
    if not user:
        return JsonResponse({"success": False, "error": "用户不存在"}, status=404)
    return JsonResponse({"success": True, "user": serialize_admin_user(user)})


@require_http_methods(["POST"])
def user_status(request, user_id: int):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body = json_body(request)
    is_active = body.get("isActive")
    reason = str(body.get("reason", "")).strip()[:255]
    if not isinstance(is_active, bool) or not reason:
        return JsonResponse({"success": False, "error": "请提供账号状态和操作原因"}, status=400)
    if request.user.pk == user_id and not is_active:
        return JsonResponse({"success": False, "error": "不能停用当前管理员账号"}, status=400)
    with transaction.atomic():
        target = User.objects.select_for_update().filter(pk=user_id).first()
        if not target:
            return JsonResponse({"success": False, "error": "用户不存在"}, status=404)
        if target.role == UserRole.ADMIN and not is_active:
            remaining = User.objects.filter(role=UserRole.ADMIN, is_active=True).exclude(pk=target.pk).count()
            if remaining < 1:
                return JsonResponse({"success": False, "error": "不能停用最后一个可用管理员"}, status=400)
        before = {"isActive": target.is_active}
        target.is_active = is_active
        target.save(update_fields=["is_active", "updated_at"])
        AdminAuditLog.objects.create(
            actor=request.user,
            target_user=target,
            action="user.enable" if is_active else "user.disable",
            reason=reason,
            before=before,
            after={"isActive": is_active},
            actor_ip=get_client_ip(request) or None,
        )
    return JsonResponse({"success": True, "user": serialize_admin_user(admin_user_queryset().get(pk=user_id))})


@require_http_methods(["POST"])
def reveal_ip(request, user_id: int):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body = json_body(request)
    field = str(body.get("field", "last"))
    if field not in {"last", "registration"}:
        return JsonResponse({"success": False, "error": "IP 字段无效"}, status=400)
    target = User.objects.filter(pk=user_id).first()
    if not target:
        return JsonResponse({"success": False, "error": "用户不存在"}, status=404)
    try:
        state = target.access_state
    except UserAccessState.DoesNotExist:
        state = None
    value = getattr(state, f"{field}_ip", None) if state else None
    AdminAuditLog.objects.create(
        actor=request.user,
        target_user=target,
        action="user.reveal_ip",
        reason=str(body.get("reason", "查看用户访问来源"))[:255],
        after={"field": field, "available": bool(value)},
        actor_ip=get_client_ip(request) or None,
    )
    return JsonResponse({"success": True, "ip": str(value) if value else None, "dataStatus": "collected" if value else "not_collected"})


@require_http_methods(["GET"])
def activity(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    items = [
        {
            "id": str(item.pk),
            "type": "admin_audit",
            "summary": item.action,
            "status": "succeeded" if item.success else "failed",
            "createdAt": item.created_at.isoformat(),
        }
        for item in AdminAuditLog.objects.all()[:50]
    ]
    return JsonResponse({"success": True, "items": items})


@require_http_methods(["GET"])
def security_events(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    items = list(SecurityEvent.objects.values("id", "category", "severity", "source", "summary", "created_at")[:100])
    for item in items:
        item["id"] = str(item["id"])
        item["createdAt"] = item.pop("created_at").isoformat()
    return JsonResponse({"success": True, "items": items})


def _service_response(service, *args, **kwargs):
    try:
        payload = service(*args, **kwargs)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    return JsonResponse({"success": True, **payload})


@require_http_methods(["GET"])
def conversations(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_conversations, request.GET)


@require_http_methods(["GET"])
def conversation_detail(request, session_id):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    payload = get_conversation(session_id)
    if payload is None:
        return JsonResponse({"success": False, "error": "辅导会话不存在"}, status=404)
    return JsonResponse({"success": True, "conversation": payload})


@require_http_methods(["POST"])
def conversation_reveal(request, session_id):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    try:
        body = json_body(request)
    except (ValueError, UnicodeDecodeError):
        return JsonResponse({"success": False, "error": "请求 JSON 格式无效"}, status=400)
    if not isinstance(body, dict):
        return JsonResponse({"success": False, "error": "请求体必须是 JSON 对象"}, status=400)
    try:
        payload = reveal_conversation_messages(
            request=request,
            session_id=session_id,
            reason=body.get("reason", ""),
            params=request.GET,
        )
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    if payload is None:
        return JsonResponse({"success": False, "error": "辅导会话不存在"}, status=404)
    return JsonResponse({"success": True, **payload})


@require_http_methods(["GET"])
def courses(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_courses, request.GET)


@require_http_methods(["GET"])
def resources(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_resources, request.GET)


@require_http_methods(["GET"])
def tasks(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_tasks, request.GET)


@require_http_methods(["GET"])
def task_detail(request, kind: str, item_id: str):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    try:
        payload = get_task(kind, item_id)
    except (TypeError, ValueError) as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    if payload is None:
        return JsonResponse({"success": False, "error": "任务不存在"}, status=404)
    return JsonResponse({"success": True, "task": payload})


@require_http_methods(["GET"])
def agent_runs(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_agent_runs, request.GET)


@require_http_methods(["GET"])
def agent_run_detail(request, trace_id: str):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    payload = get_agent_run(trace_id)
    if payload is None:
        return JsonResponse({"success": False, "error": "Agent 运行记录不存在"}, status=404)
    return JsonResponse({"success": True, "run": payload})
