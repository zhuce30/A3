from __future__ import annotations

import logging
from uuid import uuid4

from django.core.cache import cache
from django.db import transaction


logger = logging.getLogger(__name__)

ADMIN_TUTOR_ANALYTICS_CACHE_PREFIX = "a3:admin:tutors:analytics:v3:"
ADMIN_TUTOR_ANALYTICS_GENERATION_KEY = "a3:admin:tutors:analytics:generation:v1"
ADMIN_TUTOR_ANALYTICS_RANGES = ("7d", "30d", "90d")


def get_admin_tutor_analytics_generation() -> str | None:
    try:
        generation = cache.get(ADMIN_TUTOR_ANALYTICS_GENERATION_KEY)
        if isinstance(generation, str) and generation:
            return generation

        candidate = uuid4().hex
        if cache.add(ADMIN_TUTOR_ANALYTICS_GENERATION_KEY, candidate, timeout=None):
            return candidate
        generation = cache.get(ADMIN_TUTOR_ANALYTICS_GENERATION_KEY)
        return generation if isinstance(generation, str) and generation else None
    except Exception:
        logger.warning("Unable to read admin tutor analytics cache generation", exc_info=True)
        return None


def admin_tutor_analytics_cache_key(range_value: str, generation: str) -> str:
    return f"{ADMIN_TUTOR_ANALYTICS_CACHE_PREFIX}{generation}:{range_value}"


def invalidate_admin_tutor_analytics_cache() -> None:
    try:
        previous = cache.get(ADMIN_TUTOR_ANALYTICS_GENERATION_KEY)
        cache.set(ADMIN_TUTOR_ANALYTICS_GENERATION_KEY, uuid4().hex, timeout=None)
        if isinstance(previous, str) and previous:
            cache.delete_many(
                [admin_tutor_analytics_cache_key(item, previous) for item in ADMIN_TUTOR_ANALYTICS_RANGES]
            )
    except Exception:
        logger.warning("Unable to invalidate admin tutor analytics cache", exc_info=True)


def schedule_admin_tutor_analytics_invalidation() -> None:
    transaction.on_commit(invalidate_admin_tutor_analytics_cache)
