from pathlib import Path

from django.test import SimpleTestCase

from backend.config.cache import build_cache_config


PROJECT_ROOT = Path(__file__).resolve().parents[4]


class ProductionVerificationCacheTests(SimpleTestCase):
    def test_redis_cache_configuration_is_shared_between_web_workers(self):
        config = build_cache_config("redis://redis:6379/2")

        self.assertEqual(
            config["default"]["BACKEND"],
            "django.core.cache.backends.redis.RedisCache",
        )
        self.assertEqual(config["default"]["LOCATION"], "redis://redis:6379/2")
        self.assertEqual(config["default"]["KEY_PREFIX"], "a3")

    def test_production_compose_supplies_shared_cache_url(self):
        compose_source = (PROJECT_ROOT / "docker-compose.prod.yml").read_text(
            encoding="utf-8"
        )

        self.assertEqual(
            compose_source.count("CACHE_REDIS_URL: redis://redis:6379/2"),
            3,
        )
