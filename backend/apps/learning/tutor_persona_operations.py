from __future__ import annotations

import logging
import re
from copy import deepcopy
from typing import Mapping
from urllib.parse import unquote
from uuid import uuid4

from django.core.cache import cache
from django.db import DatabaseError, transaction

from backend.apps.learning.models import TutorPersonaConfiguration


TUTOR_CONFIG_CACHE_PREFIX = "a3:tutor-persona-config:v2:"
TUTOR_CONFIG_CACHE_GENERATION_KEY = "a3:tutor-persona-config:generation:v1"
TUTOR_CONFIG_CACHE_SECONDS = 60
DEFAULT_AVATAR_ASSET_ID = "teacher-default-v1"
DEFAULT_AVATAR_PUBLIC_PATH = "/a3/assets/teacher-avatar/teacher.vrm"
_SAFE_AVATAR_PUBLIC_PATH = re.compile(
    r"/a3/assets/teacher-avatar/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\.vrm"
)
logger = logging.getLogger(__name__)


def invalidate_tutor_persona_overlay_cache() -> None:
    try:
        previous = cache.get(TUTOR_CONFIG_CACHE_GENERATION_KEY)
        cache.set(TUTOR_CONFIG_CACHE_GENERATION_KEY, uuid4().hex, timeout=None)
        if isinstance(previous, str) and previous:
            cache.delete(tutor_persona_overlay_cache_key(previous))
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
    generation = get_tutor_persona_overlay_cache_generation()
    cache_key = tutor_persona_overlay_cache_key(generation) if generation else None
    try:
        cached = cache.get(cache_key) if cache_key else None
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
        if cache_key and get_tutor_persona_overlay_cache_generation() == generation:
            cache.set(cache_key, catalog, timeout=TUTOR_CONFIG_CACHE_SECONDS)
    except Exception:
        logger.warning("Unable to write the tutor persona overlay cache", exc_info=True)
    return deepcopy(catalog)


def get_tutor_persona_overlay_cache_generation() -> str | None:
    try:
        generation = cache.get(TUTOR_CONFIG_CACHE_GENERATION_KEY)
        if isinstance(generation, str) and generation:
            return generation

        candidate = uuid4().hex
        if cache.add(TUTOR_CONFIG_CACHE_GENERATION_KEY, candidate, timeout=None):
            return candidate
        generation = cache.get(TUTOR_CONFIG_CACHE_GENERATION_KEY)
        return generation if isinstance(generation, str) and generation else None
    except Exception:
        logger.warning("Unable to read the tutor persona overlay cache generation", exc_info=True)
        return None


def tutor_persona_overlay_cache_key(generation: str) -> str:
    return f"{TUTOR_CONFIG_CACHE_PREFIX}{generation}"


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
