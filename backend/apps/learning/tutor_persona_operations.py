from __future__ import annotations

import logging
import re
from copy import deepcopy
from typing import Mapping
from urllib.parse import unquote

from django.core.cache import cache
from django.db import DatabaseError, transaction

from backend.apps.learning.models import TutorPersonaConfiguration


TUTOR_CONFIG_CACHE_KEY = "a3:tutor-persona-config:v1"
TUTOR_CONFIG_CACHE_SECONDS = 60
DEFAULT_AVATAR_ASSET_ID = "teacher-default-v1"
DEFAULT_AVATAR_PUBLIC_PATH = "/a3/assets/teacher-avatar/teacher.vrm"
_SAFE_AVATAR_PUBLIC_PATH = re.compile(
    r"/a3/assets/teacher-avatar/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\.vrm"
)
logger = logging.getLogger(__name__)


def invalidate_tutor_persona_overlay_cache() -> None:
    try:
        cache.delete(TUTOR_CONFIG_CACHE_KEY)
    except Exception:
        logger.warning("Unable to invalidate the tutor persona overlay cache", exc_info=True)


def is_safe_avatar_public_path(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    return (
        value == unquote(value)
        and ".." not in value
        and _SAFE_AVATAR_PUBLIC_PATH.fullmatch(value) is not None
    )


def get_tutor_persona_overlay_catalog(code_personas: Mapping[str, dict]) -> dict:
    try:
        cached = cache.get(TUTOR_CONFIG_CACHE_KEY)
    except Exception:
        logger.warning("Unable to read the tutor persona overlay cache", exc_info=True)
        cached = None
    if isinstance(cached, dict) and isinstance(cached.get("overlays"), dict):
        return deepcopy(cached)

    try:
        with transaction.atomic():
            rows = list(
                TutorPersonaConfiguration.objects.select_related("avatar_asset")
                .filter(persona_id__in=tuple(code_personas))
                .only(
                    "persona_id",
                    "enabled",
                    "voice_preview_enabled",
                    "avatar_asset_id",
                    "avatar_asset__asset_id",
                    "avatar_asset__public_path",
                    "avatar_asset__status",
                )
            )
            database_has_rows = bool(rows) or TutorPersonaConfiguration.objects.exists()
    except DatabaseError:
        catalog = _code_only_catalog(code_personas)
    else:
        catalog = _database_catalog(rows, code_personas, database_has_rows=database_has_rows)

    try:
        cache.set(TUTOR_CONFIG_CACHE_KEY, catalog, timeout=TUTOR_CONFIG_CACHE_SECONDS)
    except Exception:
        logger.warning("Unable to write the tutor persona overlay cache", exc_info=True)
    return deepcopy(catalog)


def _database_catalog(
    rows: list[TutorPersonaConfiguration],
    code_personas: Mapping[str, dict],
    *,
    database_has_rows: bool,
) -> dict:
    overlays: dict[str, dict] = {}
    for row in rows:
        if row.persona_id not in code_personas:
            continue
        asset = row.avatar_asset
        if asset.status != "enabled" or not is_safe_avatar_public_path(asset.public_path):
            continue
        overlays[row.persona_id] = {
            "enabled": bool(row.enabled),
            "voicePreviewEnabled": bool(row.voice_preview_enabled),
            "avatarAssetId": asset.asset_id,
            "avatarPublicPath": asset.public_path,
        }

    if not database_has_rows:
        return _code_only_catalog(code_personas)
    return {"overlays": overlays, "fallbackUsed": False, "source": "database"}


def _code_only_catalog(code_personas: Mapping[str, dict]) -> dict:
    overlays = {
        persona_id: {
            "enabled": True,
            "voicePreviewEnabled": True,
            "avatarAssetId": str(persona.get("avatarAssetId") or DEFAULT_AVATAR_ASSET_ID),
            "avatarPublicPath": DEFAULT_AVATAR_PUBLIC_PATH,
        }
        for persona_id, persona in code_personas.items()
    }
    return {"overlays": overlays, "fallbackUsed": True, "source": "code_fallback"}
