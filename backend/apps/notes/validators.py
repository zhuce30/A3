from __future__ import annotations

import json
import math
import re

from django.core.exceptions import ValidationError


_DRIVE_PATH_RE = re.compile(r"^[A-Za-z]:")
_ALLOWED_METADATA_SCALAR_KEYS = {
    "actorId",
    "fromVersion",
    "memoryId",
    "nextStatus",
    "noteId",
    "previewId",
    "previousStatus",
    "reasonCode",
    "source",
    "toVersion",
    "traceId",
}
_ALLOWED_METADATA_ID_LIST_KEYS = {"memoryIds", "noteIds"}
_MAX_METADATA_BYTES = 16 * 1024
_MAX_METADATA_ID_LIST_ITEMS = 100


def validate_relative_path(value: str) -> None:
    if not value:
        return
    if value != value.strip() or "\\" in value or value.startswith("/") or _DRIVE_PATH_RE.match(value):
        raise ValidationError("Path must be a safe relative POSIX path.")
    segments = value.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValidationError("Path must not contain empty or traversal segments.")


def validate_finite_number(value: float) -> None:
    if not math.isfinite(value):
        raise ValidationError("Value must be a finite number.")


def validate_note_metadata(value: object) -> None:
    try:
        serialized = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        encoded = serialized.encode("utf-8")
    except (TypeError, ValueError, RecursionError) as exc:
        raise ValidationError("Note metadata must be valid JSON.") from exc
    if len(encoded) > _MAX_METADATA_BYTES:
        raise ValidationError("Note metadata is too large.")

    metadata = json.loads(serialized)
    if not isinstance(metadata, dict):
        raise ValidationError("Note metadata must be an object.")
    unknown_keys = set(metadata) - _ALLOWED_METADATA_SCALAR_KEYS - _ALLOWED_METADATA_ID_LIST_KEYS
    if unknown_keys:
        raise ValidationError("Note metadata contains unsupported keys.")

    scalar_types = (str, int, float, bool, type(None))
    for key, item in metadata.items():
        if key in _ALLOWED_METADATA_SCALAR_KEYS:
            if not isinstance(item, scalar_types):
                raise ValidationError("Note metadata scalar fields cannot contain nested values.")
            continue
        if not isinstance(item, list) or len(item) > _MAX_METADATA_ID_LIST_ITEMS:
            raise ValidationError("Note metadata ID lists must be bounded arrays.")
        if any(not isinstance(identifier, str) for identifier in item):
            raise ValidationError("Note metadata ID lists may contain only string identifiers.")
