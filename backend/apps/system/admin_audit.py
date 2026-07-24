from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any
from uuid import UUID

from backend.apps.system.models import AdminAuditLog


_SENSITIVE_KEY_MARKERS = (
    "password",
    "passwd",
    "token",
    "cookie",
    "secret",
    "authorization",
    "apikey",
    "accesskey",
)


def _is_sensitive_key(key: object) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
    return any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS)


def _sanitize_json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _sanitize_json_value(item)
            for key, item in value.items()
            if not _is_sensitive_key(key)
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_sanitize_json_value(item) for item in value]
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (Decimal, UUID)):
        return str(value)
    return str(value)


def record_admin_audit(
    *,
    actor,
    action: str,
    target_user=None,
    target_type: str = "",
    target_id: str = "",
    summary: str = "",
    reason: str = "",
    before: Any = None,
    after: Any = None,
    metadata: Any = None,
    actor_ip: str | None = None,
    success: bool = True,
) -> AdminAuditLog:
    return AdminAuditLog.objects.create(
        actor=actor,
        action=action,
        target_user=target_user,
        target_type=target_type,
        target_id=str(target_id),
        summary=summary,
        reason=reason,
        before=_sanitize_json_value(before or {}),
        after=_sanitize_json_value(after or {}),
        metadata=_sanitize_json_value(metadata or {}),
        actor_ip=actor_ip,
        success=success,
    )
