from pathlib import Path

from django.test import SimpleTestCase


class ProductionCeleryLimitTests(SimpleTestCase):
    def test_compose_limits_worker_memory_and_recycles_large_children(self):
        compose = (Path(__file__).resolve().parents[4] / "docker-compose.prod.yml").read_text(encoding="utf-8")

        self.assertIn("--max-memory-per-child=900000", compose)
        self.assertIn("mem_limit: 1400m", compose)
        self.assertIn("memswap_limit: 1600m", compose)
