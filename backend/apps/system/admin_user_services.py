from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db.models import Count, Q

from backend.apps.accounts.client_ip import mask_ip
from backend.apps.accounts.models import UserAccessState
from backend.apps.accounts.presence import get_user_presence
from backend.apps.profiles.models import LearnerProfile


User = get_user_model()


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
            "learningEvents": int(getattr(user, "learning_event_count", 0)),
            "coachingSessions": int(getattr(user, "coaching_session_count", 0)),
            "resourcePacks": int(getattr(user, "resource_pack_count", 0)),
            "agentRuns": int(getattr(user, "agent_run_count", 0)),
        },
    }


def admin_user_queryset():
    return User.objects.select_related("learner_profile", "access_state").annotate(
        learning_event_count=Count("learning_events", distinct=True),
        coaching_session_count=Count("coaching_sessions", distinct=True),
        resource_pack_count=Count("resource_pack_logs", distinct=True),
        agent_run_count=Count("a3_agent_runs", distinct=True),
    ).order_by("-created_at", "-id")


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
    items = [serialize_admin_user(user) for user in queryset[start:start + page_size]]
    return {"items": items, "pagination": {"page": page, "pageSize": page_size, "total": total}}
