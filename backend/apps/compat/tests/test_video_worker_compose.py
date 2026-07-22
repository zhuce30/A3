from __future__ import annotations

from pathlib import Path

from django.test import SimpleTestCase


ROOT = Path(__file__).resolve().parents[4]


class VideoWorkerComposeContractTests(SimpleTestCase):
    def test_backend_image_installs_ffmpeg(self):
        dockerfile = (ROOT / "backend" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("ffmpeg", dockerfile)

    def test_local_and_production_compose_define_isolated_single_worker(self):
        for filename in ("docker-compose.yml", "docker-compose.prod.yml"):
            with self.subTest(filename=filename):
                source = (ROOT / filename).read_text(encoding="utf-8")
                self.assertIn("video-worker:", source)
                self.assertIn("--queues=video-compose", source)
                self.assertIn("--concurrency=1", source)
                self.assertIn("--prefetch-multiplier=1", source)
                self.assertIn("a3-video-data:/app/storage/a3-videos", source)
                self.assertIn("A3_VIDEO_TTS_API_KEY", source)
