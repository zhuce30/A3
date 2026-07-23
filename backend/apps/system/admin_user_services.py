from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import Count, Q

from backend.apps.accounts.client_ip import mask_ip
from backend.apps.accounts.models import UserAccessState
from backend.apps.accounts.presence import get_user_presence
from backend.apps.compat.models import AgentRun
from backend.apps.learning.models import CoachingSession, LearningEvent, ResourcePackLog
from backend.apps.profiles.models import LearnerProfile


User = get_user_model()

ACTIVITY_SOURCES = (
    ("learning_event_count", "learning_events", LearningEvent),
    ("coaching_session_count", "coaching_sessions", CoachingSession),
    ("resource_pack_count", "resource_pack_logs", ResourcePackLog),
    ("agent_run_count", "a3_agent_runs", AgentRun),
)


def _mask_identifier(value: str, *, email: bool = False) -> str:
    value = str(value or "")
    if not value:
        return ""
    if email and "@" in value:
        local, domain = value.split("@", 1)
        return f"{local[:2]}***@{domain}"
    if value.startswith("email:"):
        return "邮箱账号"
    if len(value) <= 4:
        return f"{value[:1]}***"
    return f"{value[:3]}****{value[-2:]}"


def _access_payload(state: UserAccessState | None, field: str) -> dict:
    value = getattr(state, field, None) if state else None
    if not value:
        return {"status": "not_collected", "masked": "", "label": "历史未记录"}
    return {"status": "collected", "masked": mask_ip(str(value)), "label": mask_ip(str(value))}


def _activity_count(user, annotation: str, related_name: str) -> int:
    value = getattr(user, annotation, None)
    if value is not None:
        return int(value)
    return int(getattr(user, related_name).count())


def _hydrate_activity_counts(users: list) -> None:
    user_ids = [user.pk for user in users]
    if not user_ids:
        return
    for annotation, _related_name, model in ACTIVITY_SOURCES:
        counts = {
            row["user_id"]: row["total"]
            for row in model.objects.filter(user_id__in=user_ids)
            .values("user_id")
            .annotate(total=Count("pk"))
        }
        for user in users:
            setattr(user, annotation, counts.get(user.pk, 0))


def serialize_admin_user(user) -> dict:
    try:
        state = user.access_state
    except UserAccessState.DoesNotExist:
        state = None
    try:
        profile = user.learner_profile
    except LearnerProfile.DoesNotExist:
        profile = None
    return {
        "id": str(user.pk),
        "displayName": user.display_name,
        "phone": _mask_identifier(user.phone),
        "email": _mask_identifier(user.email, email=True),
        "studentId": _mask_identifier(user.student_id),
        "role": user.role,
        "school": user.school,
        "isActive": user.is_active,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
        "lastLoginAt": user.last_login.isoformat() if user.last_login else None,
        "presence": get_user_presence(user, state=state),
        "registrationIp": _access_payload(state, "registration_ip"),
        "lastIp": _access_payload(state, "last_ip"),
        "country": state.last_country if state else "",
        "learningProfile": {
            "majorDirection": profile.major_direction if profile else "",
            "foundationLevel": profile.foundation_level if profile else "",
            "primaryGoal": str((profile.learning_goals or [""])[0]) if profile and profile.learning_goals else "",
        },
        "activity": {
            "learningEvents": _activity_count(user, "learning_event_count", "learning_events"),
            "coachingSessions": _activity_count(user, "coaching_session_count", "coaching_sessions"),
            "resourcePacks": _activity_count(user, "resource_pack_count", "resource_pack_logs"),
            "agentRuns": _activity_count(user, "agent_run_count", "a3_agent_runs"),
        },
    }


def admin_user_queryset():
    return User.objects.select_related("learner_profile", "access_state").order_by("-created_at", "-id")


def list_admin_users(params) -> dict:
    queryset = admin_user_queryset()
    search = str(params.get("search", "")).strip()[:120]
    if search:
        queryset = queryset.filter(
            Q(display_name__icontains=search)
            | Q(phone__icontains=search)
            | Q(email__icontains=search)
            | Q(student_id__icontains=search)
            | Q(access_state__registration_ip__icontains=search)
            | Q(access_state__last_ip__icontains=search)
        )
    role = str(params.get("role", "")).strip()
    if role in {"student", "teacher", "admin"}:
        queryset = queryset.filter(role=role)
    status = str(params.get("status", "")).strip()
    if status in {"active", "disabled"}:
        queryset = queryset.filter(is_active=status == "active")
    try:
        page = max(1, int(params.get("page", 1)))
        page_size = min(100, max(10, int(params.get("pageSize", 20))))
    except (TypeError, ValueError):
        raise ValueError("分页参数无效")
    total = queryset.count()
    start = (page - 1) * page_size
    user_ids = list(queryset.values_list("pk", flat=True)[start:start + page_size])
    users_by_id = {
        user.pk: user
        for user in User.objects.select_related("learner_profile", "access_state").filter(pk__in=user_ids)
    }
    users = [users_by_id[user_id] for user_id in user_ids if user_id in users_by_id]
    _hydrate_activity_counts(users)
    items = [serialize_admin_user(user) for user in users]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}
