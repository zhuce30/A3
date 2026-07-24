from __future__ import annotations

import re
from collections.abc import Collection, Mapping
from datetime import date, datetime, time
from decimal import Decimal
from math import isfinite
from typing import Any
from uuid import UUID

from backend.apps.system.models import AdminAuditLog


AuditFieldAllowlist = Collection[str]


_SENSITIVE_KEY_MARKERS = (
    "password",
    "passwd",
    "token",
    "cookie",
    "secret",
    "authorization",
    "apikey",
    "accesskey",
    "privatekey",
    "credential",
    "session",
    "verificationcode",
    "authcode",
    "otp",
    "signedurl",
    "presignedurl",
    "conversationbody",
    "conversationcontent",
    "messagebody",
    "filecontent",
    "filebody",
    "rawcontent",
)


def _is_sensitive_key(key: object) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
    is_signed_url = normalized.startswith(("signed", "presigned")) and normalized.endswith("url")
    return is_signed_url or any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS)


def _normalize_allowlist(allowlist: AuditFieldAllowlist | None) -> frozenset[str]:
    if allowlist is None:
        return frozenset()
    return frozenset(path for item in allowlist if (path := str(item).strip(".")))


def _is_allowlisted_path(path: str, allowlist: frozenset[str]) -> bool:
    return path in allowlist or any(item.startswith(f"{path}.") for item in allowlist)


def _sanitize_json_value(
    value: Any,
    *,
    allowlist: frozenset[str],
    path: str = "",
) -> Any:
    if isinstance(value, Mapping):
        sanitized = {}
        for key, item in value.items():
            key_text = str(key)
            item_path = f"{path}.{key_text}" if path else key_text
            if _is_sensitive_key(key) or not _is_allowlisted_path(item_path, allowlist):
                continue
            sanitized[key_text] = _sanitize_json_value(
                item,
                allowlist=allowlist,
                path=item_path,
            )
        return sanitized
    if isinstance(value, (list, tuple, set, frozenset)):
        return [
            _sanitize_json_value(item, allowlist=allowlist, path=path)
            for item in value
        ]
    if isinstance(value, float):
        return value if isfinite(value) else None
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, (Decimal, UUID)):
        return str(value)
    return str(value)


def _sanitize_audit_payload(
    value: Any,
    allowlist: AuditFieldAllowlist | None,
) -> Any:
    if value is None:
        return {}
    return _sanitize_json_value(value, allowlist=_normalize_allowlist(allowlist))


def record_admin_audit(
    *,
    actor: Any,
    action: str,
    target_user: Any | None = None,
    target_type: str = "",
    target_id: str = "",
    summary: str = "",
    reason: str = "",
    before: Any = None,
    after: Any = None,
    metadata: Any = None,
    before_allowlist: AuditFieldAllowlist | None = None,
    after_allowlist: AuditFieldAllowlist | None = None,
    metadata_allowlist: AuditFieldAllowlist | None = None,
    actor_ip: str | None = None,
    success: bool = True,
) -> AdminAuditLog:
    """Persist an audit event with explicit dot-path allowlists for mapping fields.

    Unknown mapping keys are dropped. The hard sensitive-key policy always wins,
    including for nested mappings and mappings contained in lists.
    """
    return AdminAuditLog.objects.create(
        actor=actor,
        action=action,
        target_user=target_user,
        target_type=target_type,
        target_id=str(target_id),
        summary=summary,
        reason=reason,
        before=_sanitize_audit_payload(before, before_allowlist),
        after=_sanitize_audit_payload(after, after_allowlist),
        metadata=_sanitize_audit_payload(metadata, metadata_allowlist),
        actor_ip=actor_ip,
        success=success,
    )
