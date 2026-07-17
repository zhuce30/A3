from __future__ import annotations


def build_cache_config(redis_url: str, socket_timeout: float = 3.0) -> dict:
    location = redis_url.strip()
    if location:
        return {
            "default": {
                "BACKEND": "django.core.cache.backends.redis.RedisCache",
                "LOCATION": location,
                "KEY_PREFIX": "a3",
                "OPTIONS": {
                    "socket_connect_timeout": socket_timeout,
                    "socket_timeout": socket_timeout,
                },
            }
        }

    return {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
            "LOCATION": "a3-local",
            "KEY_PREFIX": "a3",
        }
    }
