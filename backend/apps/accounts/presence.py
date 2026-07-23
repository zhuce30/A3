from __future__ import annotations

from datetime import timedelta

from django.core.cache import cache
from django.utils import timezone

from backend.apps.accounts.client_ip import get_client_ip, get_trusted_country
from backend.apps.accounts.models import UserAccessEvent, UserAccessState


PRESENCE_TTL_SECONDS = 120
PRESENCE_IDLE_MINUTES = 15
PRESENCE_PERSIST_INTERVAL = timedelta(minutes=5)


def _presence_key(user_id) -> str:
    return f"a3:presence:{user_id}"


def record_user_access(user, request, event_type: str, path: str = "") -> UserAccessState:
    now = timezone.now()
    ip_address = get_client_ip(request) or None
    country = get_trusted_country(request)
    state, created = UserAccessState.objects.get_or_create(user=user)
    if event_type == "register" and created:
        state.registration_ip = ip_address
        state.registration_country = country
    state.last_ip = ip_address
    state.last_country = country
    state.last_path = str(path or "")[:255]
    state.last_seen_at = now
    state.last_persisted_at = now
    state.save()
    UserAccessEvent.objects.create(
        user=user,
        event_type=event_type,
        ip_address=ip_address,
        country=country,
        path=state.last_path,
    )
    return state


def touch_user_presence(user, request, path: str = "") -> dict:
    now = timezone.now()
    cache.set(_presence_key(user.pk), now.isoformat(), timeout=PRESENCE_TTL_SECONDS)
    state, _ = UserAccessState.objects.get_or_create(user=user)
    if not state.last_persisted_at or now - state.last_persisted_at >= PRESENCE_PERSIST_INTERVAL:
        state.last_ip = get_client_ip(request) or None
        state.last_country = get_trusted_country(request)
        state.last_path = str(path or "")[:255]
        state.last_seen_at = now
        state.last_persisted_at = now
        state.save()
    return get_user_presence(user, state=state, now=now)


def get_user_presence(user, *, state: UserAccessState | None = None, now=None) -> dict:
    now = now or timezone.now()
    heartbeat = cache.get(_presence_key(user.pk))
    if heartbeat:
        return {"status": "online", "lastSeenAt": str(heartbeat)}
    if state is None:
        try:
            state = user.access_state
        except UserAccessState.DoesNotExist:
            state = None
    last_seen = state.last_seen_at if state else None
    if last_seen and now - last_seen <= timedelta(minutes=PRESENCE_IDLE_MINUTES):
        status = "idle"
    else:
        status = "offline"
    return {"status": status, "lastSeenAt": last_seen.isoformat() if last_seen else None}
