from __future__ import annotations

import json

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from backend.apps.engagement.models import FavoriteType, UserFavorite, UserNotification
from backend.apps.engagement.services import (
    ensure_learning_reminders,
    favorite_summary,
    notification_action_groups,
    notification_summary,
    restore_resource_event_favorites,
    serialize_favorite,
    serialize_notification,
)


def _require_login(request):
    if not request.user.is_authenticated:
        return JsonResponse({"success": False, "error": "请先登录"}, status=401)
    return None


def _body(request) -> dict:
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError as exc:
        raise ValueError("请求数据不是有效 JSON") from exc


@require_http_methods(["GET"])
def favorites(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    restore_resource_event_favorites(request.user)
    queryset = UserFavorite.objects.filter(user=request.user)
    group = str(request.GET.get("group", "")).strip()
    resource_type = str(request.GET.get("type", "")).strip()
    query = str(request.GET.get("q", "")).strip()
    if group:
        queryset = queryset.filter(group=group)
    if resource_type:
        queryset = queryset.filter(resource_type=resource_type)
    if query:
        queryset = queryset.filter(title__icontains=query)
    return JsonResponse(
        {
            "success": True,
            "favorites": [serialize_favorite(item) for item in queryset[:100]],
            "summary": favorite_summary(request.user),
        }
    )


@require_http_methods(["POST"])
def create_favorite(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    try:
        payload = _body(request)
        resource_type = str(payload.get("type", FavoriteType.NOTE)).strip()
        if resource_type not in FavoriteType.values:
            raise ValueError("收藏类型不受支持")
        title = str(payload.get("title", "")).strip()
        if not title:
            raise ValueError("收藏标题不能为空")
        favorite, created = UserFavorite.objects.update_or_create(
            user=request.user,
            title=title,
            resource_type=resource_type,
            source=str(payload.get("source", "")).strip(),
            defaults={
                "url": str(payload.get("url", "")).strip(),
                "group": str(payload.get("group", "默认收藏夹")).strip() or "默认收藏夹",
                "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
            },
        )
        return JsonResponse({"success": True, "created": created, "favorite": serialize_favorite(favorite)}, status=201)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)


@require_http_methods(["DELETE"])
def delete_favorite(request, favorite_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    favorite = get_object_or_404(UserFavorite, id=favorite_id, user=request.user)
    favorite.delete()
    return JsonResponse({"success": True, "deleted": True})


@require_http_methods(["GET"])
def notifications(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    _ensure_current_learning_reminders(request.user)
    queryset = UserNotification.objects.filter(user=request.user)
    if request.GET.get("unread") == "1":
        queryset = queryset.filter(unread=True)
    action = str(request.GET.get("action", "")).strip()
    if action:
        queryset = _filter_notifications_by_action(queryset, action)
    limit = min(max(int(request.GET.get("limit", 50)), 1), 100)
    items = list(queryset[:limit])
    return JsonResponse(
        {
            "success": True,
            "notifications": [serialize_notification(item) for item in items],
            "summary": notification_summary(request.user),
            "actionGroups": notification_action_groups(items),
        }
    )


def _filter_notifications_by_action(queryset, action: str):
    if action == "review":
        return queryset.filter(payload__actionKind="review") | queryset.filter(action_url__icontains="wrong-notebook")
    if action == "plan":
        return queryset.filter(payload__actionKind="plan") | queryset.filter(action_url__icontains="study-plan") | queryset.filter(action_url__icontains="learning-path")
    if action == "assessment":
        return queryset.filter(payload__actionKind="assessment") | queryset.filter(action_url__icontains="assessment")
    if action == "report":
        return queryset.filter(payload__actionKind="report") | queryset.filter(action_url__icontains="report")
    if action == "today":
        return queryset.filter(payload__actionKind="today") | queryset.filter(action_url__icontains="today")
    return queryset


def _ensure_current_learning_reminders(user) -> None:
    from backend.apps.learning.services import _motivation_summary, current_study_plan

    plan = current_study_plan(user)
    motivation = _motivation_summary(user, None)
    ensure_learning_reminders(user, plan=plan, motivation=motivation)


@require_http_methods(["POST"])
def mark_notification_read(request, notification_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    notification = get_object_or_404(UserNotification, id=notification_id, user=request.user)
    if notification.unread:
        notification.unread = False
        notification.read_at = timezone.now()
        notification.save(update_fields=["unread", "read_at"])
    return JsonResponse({"success": True, "notification": serialize_notification(notification)})


@require_http_methods(["POST"])
def mark_all_notifications_read(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    now = timezone.now()
    updated = UserNotification.objects.filter(user=request.user, unread=True).update(unread=False, read_at=now)
    return JsonResponse({"success": True, "updated": updated, "summary": notification_summary(request.user)})
