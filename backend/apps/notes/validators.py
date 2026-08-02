from __future__ import annotations

import json
import re
import unicodedata

from django.core.exceptions import ValidationError


_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:")
_SENSITIVE_AUDIT_KEYS = {
    "api_key",
    "body",
    "content",
    "content_json",
    "content_text",
    "password",
    "prompt",
    "secret",
    "signed_url",
    "token",
}
_MAX_AUDIT_METADATA_BYTES = 16 * 1024
_MAX_AUDIT_METADATA_DEPTH = 8
_MAX_AUDIT_METADATA_NODES = 1_000


def validate_relative_path(value: str) -> None:
    if not value:
        return
    if value != value.strip() or "\\" in value or value.startswith("/") or _DRIVE_PATH_RE.match(value):
        raise ValidationError("Path must be a safe relative POSIX path.")
    segments = value.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValidationError("Path must not contain empty or traversal segments.")


def validate_audit_metadata(value: object) -> None:
    try:
        serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        encoded = serialized.encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValidationError("Audit metadata must be valid JSON.") from exc
    if len(encoded) > _MAX_AUDIT_METADATA_BYTES:
        raise ValidationError("Audit metadata is too large.")

    node_count = 0

    def walk(item: object, depth: int) -> None:
        nonlocal node_count
        node_count += 1
        if depth > _MAX_AUDIT_METADATA_DEPTH or node_count > _MAX_AUDIT_METADATA_NODES:
            raise ValidationError("Audit metadata is too deeply nested or complex.")
        if isinstance(item, dict):
            for key, nested in item.items():
                normalized_key = unicodedata.normalize("NFKC", str(key)).strip().casefold().replace("-", "_")
                if normalized_key in _SENSITIVE_AUDIT_KEYS:
                    raise ValidationError("Audit metadata contains a prohibited key.")
                walk(nested, depth + 1)
        elif isinstance(item, list):
            for nested in item:
                walk(nested, depth + 1)

    walk(json.loads(serialized), 0)
