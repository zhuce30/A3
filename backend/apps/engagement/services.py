from __future__ import annotations

from collections import Counter
from typing import Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from backend.apps.assessments.models import WrongQuestion
from backend.apps.engagement.models import FavoriteType, NotificationType, UserFavorite, UserNotification


TYPE_LABELS = dict(FavoriteType.choices)
NOTIFICATION_LABELS = dict(NotificationType.choices)

GENERATED_FAVORITE_TYPES = {
    "lecture_doc": FavoriteType.COURSEWARE,
    "knowledge_card": FavoriteType.KNOWLEDGE_CARD,
    "mind_map": FavoriteType.KNOWLEDGE_CARD,
    "practice_set": FavoriteType.EXERCISE,
    "case_study": FavoriteType.COURSEWARE,
    "code_lab": FavoriteType.EXERCISE,
    "micro_video_script": FavoriteType.VIDEO,
}

GENERATED_RESOURCE_SLUGS = {
    "lecture_doc": "document",
    "knowledge_card": "cards",
    "mind_map": "mind-map",
    "practice_set": "practice",
    "case_study": "case-study",
    "code_lab": "code-lab",
    "micro_video_script": "video",
}


def create_notification(
    user,
    *,
    title: str,
    detail: str,
    notification_type: str = NotificationType.SYSTEM,
    action_url: str = "",
    payload: dict[str, Any] | None = None,
) -> UserNotification:
    return UserNotification.objects.create(
        user=user,
        title=title,
        detail=detail,
        notification_type=notification_type,
        action_url=action_url,
        payload=payload or {},
    )


def restore_resource_event_favorites(user, *, limit: int = 1000) -> int:
    """Materialize legacy favorite events into the user's real favorites collection."""
    from backend.apps.learning.models import LearningEvent

    events = list(
        LearningEvent.objects.filter(
            user=user,
            event_type="resource_favorited",
            target_type__in=["curated_resource", "resource_pack"],
        ).filter(
            Q(metadata__favoriteMaterialized=False) | Q(metadata__favoriteMaterialized__isnull=True)
        ).order_by("created_at", "id")[: max(1, min(limit, 5000))]
    )
    existing_favorites = list(UserFavorite.objects.filter(user=user))
    existing_keys = {(item.title, item.resource_type, item.source) for item in existing_favorites}
    existing_targets = {
        (
            str(item.metadata.get("targetType") or ""),
            str(item.metadata.get("targetId") or ""),
            str(item.metadata.get("resourceType") or ""),
        )
        for item in existing_favorites
        if isinstance(item.metadata, dict) and item.metadata.get("targetId")
    }
    pending: dict[tuple[str, str, str], UserFavorite] = {}
    processed_events = []
    for event in events:
        event_metadata = event.metadata if isinstance(event.metadata, dict) else {}
        if event_metadata.get("favoriteMaterialized") is True:
            continue
        favorite = _favorite_from_learning_event(user, event)
        event.metadata = {**event_metadata, "favoriteMaterialized": True}
        processed_events.append(event)
        if favorite is None:
            continue
        key = (favorite.title, favorite.resource_type, favorite.source)
        target_key = (event.target_type, event.target_id, event.resource_type)
        if key not in existing_keys and target_key not in existing_targets:
            pending[key] = favorite
            existing_targets.add(target_key)
    if not processed_events:
        return 0
    with transaction.atomic():
        if pending:
            UserFavorite.objects.bulk_create(pending.values(), ignore_conflicts=True)
        LearningEvent.objects.bulk_update(processed_events, ["metadata"])
    return len(pending)


def _favorite_from_learning_event(user, event) -> UserFavorite | None:
    metadata = event.metadata if isinstance(event.metadata, dict) else {}
    title = str(metadata.get("resourceTitle") or metadata.get("title") or "").strip()[:160]
    if not title or not event.target_id:
        return None
    if event.target_type == "curated_resource":
        favorite_type = _system_resource_favorite_type(event.resource_type)
        provider = str(metadata.get("provider") or "").strip()
        source = f"系统资料 · {provider}" if provider else "系统资料"
        group = "系统资料"
        url = event.source_page if str(event.source_page).startswith("/a3/") else f"/a3/library/{event.target_id}"
    elif event.target_type == "resource_pack":
        favorite_type = GENERATED_FAVORITE_TYPES.get(event.resource_type, FavoriteType.COURSEWARE)
        source = "个性资源包"
        group = "个性资源"
        slug = str(metadata.get("resourcePage") or GENERATED_RESOURCE_SLUGS.get(event.resource_type, "document")).strip()
        url = event.source_page if str(event.source_page).startswith("/a3/") else f"/a3/resources/{event.target_id}/{slug}"
    else:
        return None
    return UserFavorite(
        user=user,
        title=title,
        resource_type=favorite_type,
        source=source[:120],
        url=str(url)[:500],
        group=group,
        metadata={
            "targetType": event.target_type,
            "targetId": event.target_id,
            "resourceType": event.resource_type,
            "traceId": event.trace_id,
            "restoredFromLearningEvent": str(event.id),
        },
    )


def _system_resource_favorite_type(resource_type: str) -> str:
    if resource_type == "video":
        return FavoriteType.VIDEO
    if resource_type == "code_lab":
        return FavoriteType.EXERCISE
    return FavoriteType.COURSEWARE


def ensure_learning_reminders(user, *, plan: dict | None = None, motivation: dict | None = None) -> list[UserNotification]:
    today = timezone.localdate().isoformat()
    reminders = []
    plan = plan if isinstance(plan, dict) else {}
    motivation = motivation if isinstance(motivation, dict) else {}
    _refresh_legacy_rollover_reminders(user)
    today_day = next((day for day in plan.get("days", []) if isinstance(day, dict) and day.get("date") == today), None)
    tasks = today_day.get("tasks", []) if isinstance(today_day, dict) and isinstance(today_day.get("tasks"), list) else []
    pending_tasks = [task for task in tasks if isinstance(task, dict) and task.get("status") != "completed"]
    rollover_tasks = [task for task in pending_tasks if task.get("rolledOverFrom")]
    plan_change = _notification_plan_change(plan)
    if pending_tasks:
        reminders.append(
            _ensure_reminder(
                user,
                key=f"today-tasks:{today}",
                title="今日学习任务待完成",
                detail=f"还有 {len(pending_tasks)} 个任务，预计 {motivation.get('todayRemainingMinutes', 0)} 分钟。",
                notification_type=NotificationType.LEARNING_TASK,
                action_url="/a3/today",
                payload={
                    "pendingTasks": len(pending_tasks),
                    "remainingMinutes": motivation.get("todayRemainingMinutes", 0),
                    **({"planChange": plan_change} if plan_change else {}),
                },
            )
        )
    if rollover_tasks:
        reminders.append(
            _ensure_reminder(
                user,
                key=f"rollover:{today}",
                title="有顺延任务需要处理",
                detail=f"{len(rollover_tasks)} 个任务已顺延到今天，建议优先完成。",
                notification_type=NotificationType.LEARNING_TASK,
                action_url="/a3/study-plan",
                payload={"rolloverTasks": len(rollover_tasks), **({"planChange": plan_change} if plan_change else {})},
            )
        )
    review_queue = plan.get("reviewQueue", []) if isinstance(plan.get("reviewQueue"), list) else []
    due_reviews = [item for item in review_queue if isinstance(item, dict) and str(item.get("reviewAfter", ""))[:10] <= today]
    due_wrong_questions = _due_wrong_questions(user)
    due_review_count = max(len(due_reviews), len(due_wrong_questions))
    if due_review_count:
        reminders.append(
            _ensure_reminder(
                user,
                key=f"review-due:{today}",
                title="错题复习到期",
                detail=f"{due_review_count} 个错题知识点需要复习，避免遗忘曲线回落。",
                notification_type=NotificationType.ASSESSMENT,
                action_url="/a3/wrong-notebook",
                payload={
                    "dueReviews": due_review_count,
                    **({"wrongQuestionIds": [str(item.id) for item in due_wrong_questions]} if due_wrong_questions else {}),
                    **({"knowledgePoints": _wrong_question_titles(due_wrong_questions)} if due_wrong_questions else {}),
                },
            )
        )
    if int(motivation.get("streakDays") or 0) == 0 and int(motivation.get("todayTotalTasks") or 0) > 0:
        reminders.append(
            _ensure_reminder(
                user,
                key=f"streak-risk:{today}",
                title="连续学习待启动",
                detail="今天还没有形成学习记录，完成一个小任务即可点亮连续学习。",
                notification_type=NotificationType.LEARNING_TASK,
                action_url="/a3/today",
                payload={"streakDays": 0, **({"planChange": plan_change} if plan_change else {})},
            )
        )
    return [item for item in reminders if item is not None]


def _refresh_legacy_rollover_reminders(user) -> None:
    candidates = UserNotification.objects.filter(
        user=user,
        action_url="/a3/today",
        payload__generatedBy="learning_reminder",
    )
    for notification in candidates:
        payload = dict(notification.payload) if isinstance(notification.payload, dict) else {}
        if not str(payload.get("reminderKey") or "").startswith("rollover:"):
            continue
        payload["actionKind"] = "plan"
        notification.action_url = "/a3/study-plan"
        notification.payload = payload
        notification.save(update_fields=["action_url", "payload"])


def _due_wrong_questions(user) -> list[WrongQuestion]:
    now = timezone.now()
    return list(
        WrongQuestion.objects.filter(user=user, mastered=False)
        .filter(review_after__isnull=False, review_after__lte=now)
        .order_by("review_after", "-wrong_count")[:20]
    )


def _wrong_question_titles(wrong_questions: list[WrongQuestion]) -> list[str]:
    titles = []
    for item in wrong_questions:
        title = str(item.question.knowledge_point.title).strip()
        if title and title not in titles:
            titles.append(title)
    return titles[:5]


def _ensure_reminder(
    user,
    *,
    key: str,
    title: str,
    detail: str,
    notification_type: str,
    action_url: str,
    payload: dict[str, Any] | None = None,
) -> UserNotification | None:
    metadata = payload if isinstance(payload, dict) else {}
    next_payload = {
        **metadata,
        "reminderKey": key,
        "generatedBy": "learning_reminder",
        "actionKind": _action_kind(action_url),
    }
    existing = UserNotification.objects.filter(user=user, payload__reminderKey=key).first()
    if existing:
        existing.title = title
        existing.detail = detail
        existing.notification_type = notification_type
        existing.action_url = action_url
        existing.payload = next_payload
        existing.save(update_fields=["title", "detail", "notification_type", "action_url", "payload"])
        return existing
    return create_notification(
        user,
        title=title,
        detail=detail,
        notification_type=notification_type,
        action_url=action_url,
        payload=next_payload,
    )


def _action_kind(action_url: str) -> str:
    if "wrong-notebook" in action_url:
        return "review"
    if "study-plan" in action_url or "learning-path" in action_url:
        return "plan"
    if "assessment" in action_url:
        return "assessment"
    if "report" in action_url:
        return "report"
    return "today"


ACTION_GROUP_META = {
    "today": {"label": "今日任务", "href": "/a3/today", "description": "回到今日任务，完成最小学习闭环。", "priority": 1},
    "review": {"label": "错题复盘", "href": "/a3/wrong-notebook", "description": "处理到期错题和高频错因。", "priority": 2},
    "plan": {"label": "学习计划", "href": "/a3/study-plan", "description": "查看计划调整、顺延任务和复习节奏。", "priority": 3},
    "assessment": {"label": "阶段测评", "href": "/a3/assessment", "description": "完成测评，刷新画像和推荐。", "priority": 4},
    "report": {"label": "学习报告", "href": "/a3/report", "description": "查看周总结、薄弱趋势和下周建议。", "priority": 5},
}


def notification_action_groups(notifications) -> list[dict[str, Any]]:
    groups: dict[str, list[UserNotification]] = {}
    for notification in notifications:
        kind = _notification_action_kind(notification)
        groups.setdefault(kind, []).append(notification)
    rows = []
    for kind, items in groups.items():
        meta = ACTION_GROUP_META.get(kind, ACTION_GROUP_META["today"])
        recent = items[0]
        rows.append({
            "kind": kind,
            "label": meta["label"],
            "count": len(items),
            "unread": sum(1 for item in items if item.unread),
            "description": _action_group_description(kind, recent),
            "primaryAction": {
                "label": f"处理{meta['label']}",
                "href": recent.action_url or meta["href"],
                "reason": recent.detail or meta["description"],
            },
            "learningLoop": _notification_learning_loop(recent),
            "recent": serialize_notification(recent),
            "priority": meta["priority"],
        })
    return sorted(rows, key=lambda item: (item["priority"], -item["unread"], -item["count"]))


def _notification_action_kind(notification: UserNotification) -> str:
    payload = notification.payload if isinstance(notification.payload, dict) else {}
    action_kind = str(payload.get("actionKind") or "").strip()
    if action_kind in ACTION_GROUP_META:
        return action_kind
    return _action_kind(notification.action_url)


def _action_group_description(kind: str, notification: UserNotification) -> str:
    payload = notification.payload if isinstance(notification.payload, dict) else {}
    if kind == "today":
        pending = int(payload.get("pendingTasks") or 0)
        minutes = int(payload.get("remainingMinutes") or 0)
        if pending:
            return f"还有 {pending} 个任务，预计 {minutes} 分钟。"
    if kind == "review":
        due = int(payload.get("dueReviews") or 0)
        if due:
            point_summary = _notification_knowledge_point_summary(payload)
            if point_summary:
                return f"{due} 个错题知识点已到复习时间：{point_summary}。"
            return f"{due} 个错题知识点已到复习时间。"
    return ACTION_GROUP_META.get(kind, ACTION_GROUP_META["today"])["description"]


def _notification_knowledge_point_summary(payload: dict[str, Any]) -> str:
    points = payload.get("knowledgePoints") if isinstance(payload.get("knowledgePoints"), list) else []
    titles = []
    for point in points:
        title = str(point).strip()
        if title and title not in titles:
            titles.append(title)
    if not titles:
        return ""
    return f"{titles[0]} +{len(titles) - 1}" if len(titles) > 1 else titles[0]


def _notification_learning_loop(notification: UserNotification) -> dict[str, Any]:
    kind = _notification_action_kind(notification)
    meta = ACTION_GROUP_META.get(kind, ACTION_GROUP_META["today"])
    payload = notification.payload if isinstance(notification.payload, dict) else {}
    metric = _notification_loop_metric(kind, payload)
    loop = {
        "schemaVersion": "a3.notification-loop.v1",
        "kind": kind,
        "reason": f"为什么提醒：{_notification_loop_reason(kind, metric)}",
        "expectedFeedback": f"完成后反馈：{_notification_loop_feedback(kind)}",
        "nextAction": {
            "label": meta["label"],
            "href": notification.action_url or meta["href"],
        },
    }
    plan_change = payload.get("planChange") if isinstance(payload.get("planChange"), dict) else {}
    if plan_change:
        loop["planChange"] = plan_change
    return loop


def _notification_plan_change(plan: dict[str, Any]) -> dict[str, Any]:
    explanation = plan.get("explanation") if isinstance(plan.get("explanation"), dict) else {}
    current_change = explanation.get("currentChange") if isinstance(explanation.get("currentChange"), dict) else {}
    if not current_change:
        return {}
    next_action = explanation.get("nextAction") if isinstance(explanation.get("nextAction"), dict) else {}
    return {
        "schemaVersion": "a3.notification-plan-change.v1",
        "currentChange": current_change,
        "nextAction": next_action,
    }


def _notification_loop_metric(kind: str, payload: dict[str, Any]) -> int:
    if kind == "today":
        return int(payload.get("pendingTasks") or 0)
    if kind == "review":
        return int(payload.get("dueReviews") or 0)
    if kind == "plan":
        return int(payload.get("rolloverTasks") or 0)
    return 0


def _notification_loop_reason(kind: str, metric: int) -> str:
    if kind == "today":
        return f"还有 {metric} 个今日任务未完成，先做一个最小任务可以保持连续学习。" if metric else "今天需要先建立学习记录，避免学习链路中断。"
    if kind == "review":
        return f"{metric} 个错题知识点已到复习时间，需要在遗忘前处理错因。" if metric else "错题复盘会直接影响画像薄弱点和后续推荐。"
    if kind == "plan":
        return f"{metric} 个顺延任务提示计划负荷偏高，需要先调整节奏。" if metric else "计划入口用于确认延期任务、复习队列和接下来安排。"
    if kind == "assessment":
        return "阶段测评会刷新水平、薄弱点和后续推荐。"
    if kind == "report":
        return "学习报告会把本周表现转成下一步行动建议。"
    return "系统检测到有可执行学习动作需要处理。"


def _notification_loop_feedback(kind: str) -> str:
    if kind == "today":
        return "今日任务页会显示完成反馈、下一步建议和报告回流入口。"
    if kind == "review":
        return "错题本会更新掌握状态、下次复习时间和报告指标。"
    if kind == "plan":
        return "学习计划会显示顺延任务、复习节奏和调整原因。"
    if kind == "assessment":
        return "测评结果会写入错题本、画像薄弱点和学习报告。"
    if kind == "report":
        return "报告页会显示连续学习闭环和当前最优先动作。"
    return "处理后通知会标记已读，并回到对应学习页面。"



def serialize_favorite(favorite: UserFavorite) -> dict[str, Any]:
    return {
        "id": str(favorite.id),
        "title": favorite.title,
        "type": favorite.resource_type,
        "typeLabel": TYPE_LABELS.get(favorite.resource_type, favorite.resource_type),
        "source": favorite.source,
        "url": favorite.url,
        "group": favorite.group,
        "metadata": favorite.metadata,
        "createdAt": favorite.created_at.isoformat(),
    }


def favorite_summary(user) -> dict[str, Any]:
    queryset = UserFavorite.objects.filter(user=user)
    groups = Counter(queryset.values_list("group", flat=True))
    types = Counter(queryset.values_list("resource_type", flat=True))
    return {
        "total": queryset.count(),
        "groups": [{"name": name, "count": count} for name, count in groups.items()],
        "types": [{"type": key, "label": TYPE_LABELS.get(key, key), "count": count} for key, count in types.items()],
    }


def serialize_notification(notification: UserNotification) -> dict[str, Any]:
    return {
        "id": str(notification.id),
        "title": notification.title,
        "detail": notification.detail,
        "type": notification.notification_type,
        "typeLabel": NOTIFICATION_LABELS.get(notification.notification_type, notification.notification_type),
        "unread": notification.unread,
        "actionUrl": notification.action_url,
        "payload": notification.payload,
        "learningLoop": _notification_learning_loop(notification),
        "createdAt": notification.created_at.isoformat(),
        "readAt": notification.read_at.isoformat() if notification.read_at else None,
    }


def notification_summary(user) -> dict[str, Any]:
    queryset = UserNotification.objects.filter(user=user)
    return {
        "total": queryset.count(),
        "unread": queryset.filter(unread=True).count(),
        "byType": [
            {"type": key, "label": NOTIFICATION_LABELS.get(key, key), "count": count}
            for key, count in Counter(queryset.values_list("notification_type", flat=True)).items()
        ],
    }
