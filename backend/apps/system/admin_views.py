from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from backend.apps.accounts.client_ip import get_client_ip
from backend.apps.accounts.models import UserAccessState, UserRole
from backend.apps.accounts.permissions import require_admin_role
from backend.apps.system.admin_agent_services import get_agent_run, list_agent_runs
from backend.apps.system.admin_audit import _is_sensitive_key, record_admin_audit
from backend.apps.system.admin_catalog_services import (
    AdminActionError,
    _error_summary,
    list_courses,
    list_resources,
    reindex_resource,
    _require_reason,
    _safe_audit_reason,
    set_course_status,
    set_resource_status,
)
from backend.apps.system.admin_configuration import list_configuration, verify_configuration
from backend.apps.system.admin_conversation_services import (
    get_conversation,
    list_conversations,
    parse_pagination,
    reveal_conversation_messages,
)
from backend.apps.system.admin_overview import build_admin_overview
from backend.apps.system.admin_task_services import cancel_task, get_task, list_tasks, retry_task
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


def _failed_action_audit(
    request,
    *,
    action: str,
    target_type: str,
    target_id,
    reason: str = "",
    error_code: str,
    summary: str,
):
    record_admin_audit(
        actor=request.user,
        action=action,
        target_type=str(target_type)[:64],
        target_id=str(target_id)[:128],
        summary=summary,
        reason=_safe_audit_reason(reason),
        metadata={"errorCode": error_code},
        metadata_allowlist=("errorCode",),
        actor_ip=get_client_ip(request) or None,
        success=False,
    )


def _action_json(request, *, action: str, target_type: str, target_id):
    try:
        body = json_body(request)
    except (TypeError, ValueError, UnicodeDecodeError):
        message = "请求 JSON 格式无效"
        _failed_action_audit(
            request,
            action=action,
            target_type=target_type,
            target_id=target_id,
            error_code="invalid_json",
            summary=message,
        )
        return None, JsonResponse({"success": False, "error": message}, status=400)
    if not isinstance(body, dict):
        message = "请求体必须是 JSON 对象"
        _failed_action_audit(
            request,
            action=action,
            target_type=target_type,
            target_id=target_id,
            error_code="invalid_body",
            summary=message,
        )
        return None, JsonResponse({"success": False, "error": message}, status=400)
    return body, None


def _admin_action_response(service, *, response_status: int = 200, **kwargs):
    try:
        payload = service(**kwargs)
    except AdminActionError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=exc.status_code)
    return JsonResponse({"success": True, **payload}, status=response_status)


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
    try:
        page, page_size = parse_pagination(request.GET)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    queryset = SecurityEvent.objects.select_related("user", "reviewer")
    filters = {
        "category": "category",
        "severity": "severity",
        "source": "source",
        "reviewStatus": "review_status",
    }
    for param, field in filters.items():
        value = str(request.GET.get(param, "")).strip()
        if value:
            queryset = queryset.filter(**{field: value})
    total = queryset.count()
    start = (page - 1) * page_size
    items = [
        {
            "id": str(item.pk),
            "category": item.category,
            "severity": item.severity,
            "source": item.source,
            "summary": _redacted_text(item.summary),
            "reviewStatus": item.review_status,
            "reviewNote": _redacted_text(item.review_note),
            "user": (
                {"id": str(item.user_id), "displayName": item.user.display_name}
                if item.user_id
                else None
            ),
            "reviewer": (
                {"id": str(item.reviewer_id), "displayName": item.reviewer.display_name}
                if item.reviewer_id
                else None
            ),
            "reviewedAt": item.reviewed_at.isoformat() if item.reviewed_at else None,
            "createdAt": item.created_at.isoformat(),
        }
        for item in queryset[start : start + page_size]
    ]
    return JsonResponse(
        {"success": True, "items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}
    )


@require_http_methods(["POST"])
def security_event_review(request, event_id: int):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action="security_event.review",
        target_type="security_event",
        target_id=event_id,
    )
    if error_response:
        return error_response
    reason = str(body.get("reason") or "").strip()[:255]
    raw_status = body.get("status")
    action = body.get("action")
    action_statuses = {
        "confirm": SecurityEvent.ReviewStatus.CONFIRMED,
        "false_positive": SecurityEvent.ReviewStatus.FALSE_POSITIVE,
        "resolve": SecurityEvent.ReviewStatus.RESOLVED,
    }
    if raw_status is None and isinstance(action, str):
        raw_status = action_statuses.get(action.strip())
    try:
        reason = _require_reason(body.get("reason"))
        if raw_status not in {
            SecurityEvent.ReviewStatus.CONFIRMED,
            SecurityEvent.ReviewStatus.FALSE_POSITIVE,
            SecurityEvent.ReviewStatus.RESOLVED,
        }:
            raise AdminActionError("安全事件处理动作无效", error_code="invalid_status")
        note_value = body.get("note", "")
        if not isinstance(note_value, str):
            raise AdminActionError("处理备注必须是字符串", error_code="invalid_note")
        note = note_value.strip()
        if len(note) > 2000:
            raise AdminActionError("处理备注不能超过 2000 个字符", error_code="note_too_long")
        with transaction.atomic():
            event = SecurityEvent.objects.select_for_update().filter(pk=event_id).first()
            if event is None:
                raise AdminActionError("安全事件不存在", status_code=404, error_code="not_found")
            allowed = {
                SecurityEvent.ReviewStatus.PENDING: {
                    SecurityEvent.ReviewStatus.CONFIRMED,
                    SecurityEvent.ReviewStatus.FALSE_POSITIVE,
                    SecurityEvent.ReviewStatus.RESOLVED,
                },
                SecurityEvent.ReviewStatus.CONFIRMED: {SecurityEvent.ReviewStatus.RESOLVED},
                SecurityEvent.ReviewStatus.FALSE_POSITIVE: set(),
                SecurityEvent.ReviewStatus.RESOLVED: set(),
            }
            if raw_status not in allowed.get(event.review_status, set()):
                raise AdminActionError("安全事件不能执行该状态转换", status_code=409, error_code="invalid_transition")
            before = {"reviewStatus": event.review_status}
            event.review_status = raw_status
            event.reviewer = request.user
            event.reviewed_at = timezone.now()
            event.review_note = note
            event.save(update_fields=["review_status", "reviewer", "reviewed_at", "review_note"])
            record_admin_audit(
                actor=request.user,
                action="security_event.review",
                target_user=event.user,
                target_type="security_event",
                target_id=event.pk,
                summary="审核安全事件",
                reason=reason,
                before=before,
                after={"reviewStatus": event.review_status, "noteProvided": bool(note)},
                before_allowlist=("reviewStatus",),
                after_allowlist=("reviewStatus", "noteProvided"),
                actor_ip=get_client_ip(request) or None,
            )
        return JsonResponse(
            {
                "success": True,
                "event": {
                    "id": str(event.pk),
                    "reviewStatus": event.review_status,
                    "reviewedAt": event.reviewed_at.isoformat(),
                },
            }
        )
    except AdminActionError as exc:
        _failed_action_audit(
            request,
            action="security_event.review",
            target_type="security_event",
            target_id=event_id,
            reason=reason,
            error_code=exc.error_code,
            summary=str(exc),
        )
        return JsonResponse({"success": False, "error": str(exc)}, status=exc.status_code)
    except Exception:
        message = "安全事件审核失败，请稍后重试"
        _failed_action_audit(
            request,
            action="security_event.review",
            target_type="security_event",
            target_id=event_id,
            reason=reason,
            error_code="operation_failed",
            summary=message,
        )
        return JsonResponse({"success": False, "error": message}, status=500)


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


@require_http_methods(["POST"])
def course_status(request, course_id):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action="course.status",
        target_type="course",
        target_id=course_id,
    )
    if error_response:
        return error_response
    is_active = body.get("isActive")
    status_value = body.get("status")
    if is_active is None and isinstance(status_value, str):
        is_active = {"active": True, "inactive": False}.get(status_value.strip())
    return _admin_action_response(
        set_course_status,
        actor=request.user,
        course_id=course_id,
        is_active=is_active,
        reason=body.get("reason"),
        actor_ip=get_client_ip(request) or None,
    )


@require_http_methods(["GET"])
def resources(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return _service_response(list_resources, request.GET)


@require_http_methods(["POST"])
def resource_status(request, resource_id):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action="resource.status",
        target_type="knowledge_resource",
        target_id=resource_id,
    )
    if error_response:
        return error_response
    status_value = body.get("status")
    if status_value is None and isinstance(body.get("action"), str):
        status_value = {"publish": "published", "offline": "offline"}.get(body["action"].strip())
    return _admin_action_response(
        set_resource_status,
        actor=request.user,
        resource_id=resource_id,
        status=status_value,
        reason=body.get("reason"),
        actor_ip=get_client_ip(request) or None,
    )


@require_http_methods(["POST"])
def resource_reindex(request, resource_id):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action="resource.reindex",
        target_type="knowledge_resource",
        target_id=resource_id,
    )
    if error_response:
        return error_response
    return _admin_action_response(
        reindex_resource,
        response_status=202,
        actor=request.user,
        resource_id=resource_id,
        reason=body.get("reason"),
        actor_ip=get_client_ip(request) or None,
    )


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


def _task_action(request, *, kind: str, item_id: str, action: str):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action=f"task.{action}",
        target_type=kind,
        target_id=item_id,
    )
    if error_response:
        return error_response
    service = retry_task if action == "retry" else cancel_task
    return _admin_action_response(
        service,
        response_status=202 if action == "retry" else 200,
        actor=request.user,
        kind=kind,
        item_id=item_id,
        reason=body.get("reason"),
        actor_ip=get_client_ip(request) or None,
    )


@require_http_methods(["POST"])
def task_retry(request, kind: str, item_id: str):
    return _task_action(request, kind=kind, item_id=item_id, action="retry")


@require_http_methods(["POST"])
def task_cancel(request, kind: str, item_id: str):
    return _task_action(request, kind=kind, item_id=item_id, action="cancel")


@require_http_methods(["GET"])
def configuration(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **list_configuration()})


@require_http_methods(["POST"])
def configuration_verify(request, check: str):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    body, error_response = _action_json(
        request,
        action="configuration.verify",
        target_type="configuration",
        target_id=check,
    )
    if error_response:
        return error_response
    return _admin_action_response(
        verify_configuration,
        actor=request.user,
        check=check,
        reason=body.get("reason"),
        actor_ip=get_client_ip(request) or None,
    )


def _redacted_text(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    summary = _error_summary(text)
    return summary if summary == text[:200] else "敏感详情已隐藏"


def _safe_audit_value(value, *, depth: int = 0):
    if depth > 5:
        return None
    if isinstance(value, dict):
        return {
            str(key): _safe_audit_value(item, depth=depth + 1)
            for key, item in value.items()
            if not _is_sensitive_key(key) and "." not in str(key)
        }
    if isinstance(value, (list, tuple)):
        return [_safe_audit_value(item, depth=depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return _redacted_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _redacted_text(value)


@require_http_methods(["GET"])
def audit_logs(request):
    rejected = _admin_rejection(request)
    if rejected:
        return rejected
    try:
        page, page_size = parse_pagination(request.GET)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
    queryset = AdminAuditLog.objects.select_related("actor", "target_user")
    action = str(request.GET.get("action", "")).strip()
    if action:
        queryset = queryset.filter(action__icontains=action[:64])
    target_type = str(request.GET.get("targetType", "")).strip()
    if target_type:
        queryset = queryset.filter(target_type=target_type[:64])
    actor_id = str(request.GET.get("actorId", "")).strip()
    if actor_id:
        if not actor_id.isdigit():
            return JsonResponse({"success": False, "error": "管理员编号无效"}, status=400)
        queryset = queryset.filter(actor_id=int(actor_id))
    success_value = str(request.GET.get("success", "")).strip().lower()
    if success_value:
        if success_value not in {"true", "false"}:
            return JsonResponse({"success": False, "error": "操作结果筛选无效"}, status=400)
        queryset = queryset.filter(success=success_value == "true")
    total = queryset.count()
    start = (page - 1) * page_size
    items = [
        {
            "id": str(item.pk),
            "actor": (
                {"id": str(item.actor_id), "displayName": item.actor.display_name}
                if item.actor_id
                else None
            ),
            "action": item.action,
            "targetType": item.target_type,
            "targetId": _redacted_text(item.target_id),
            "targetUser": (
                {"id": str(item.target_user_id), "displayName": item.target_user.display_name}
                if item.target_user_id
                else None
            ),
            "summary": _redacted_text(item.summary),
            "reason": _redacted_text(item.reason),
            "success": item.success,
            "before": _safe_audit_value(item.before),
            "after": _safe_audit_value(item.after),
            "metadata": _safe_audit_value(item.metadata),
            "actorIp": str(item.actor_ip) if item.actor_ip else None,
            "createdAt": item.created_at.isoformat(),
        }
        for item in queryset[start : start + page_size]
    ]
    return JsonResponse(
        {"success": True, "items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}
    )


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
