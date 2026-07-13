from __future__ import annotations


def build_cache_config(redis_url: str) -> dict:
    location = redis_url.strip()
    if location:
        return {
            "default": {
                "BACKEND": "django.core.cache.backends.redis.RedisCache",
                "LOCATION": location,
                "KEY_PREFIX": "a3",
            }
        }

    return {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "a3-local",
            "KEY_PREFIX": "a3",
        }
    }
