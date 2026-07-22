from __future__ import annotations

import tempfile
from pathlib import Path

from django.test import TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoComposition, VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_composition_storage import (
    asset_file,
    build_narration_text,
    build_webvtt,
    persist_segment_audio,
)


class VideoCompositionStorageTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = override_settings(A3_VIDEO_STORAGE_ROOT=Path(self.temp.name))
        self.settings.enable()
        self.addCleanup(self.settings.disable)
        self.addCleanup(self.temp.cleanup)
        user = User.objects.create_user(phone="13800009921", password="Password123")
        self.job = VideoGenerationJob.objects.create(job_id="compose-storage", user=user, resource_pack_id="pack-1")
        self.first = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="prompt",
            narration="第一段旁白",
            duration=3,
        )
        self.second = VideoGenerationSegment.objects.create(
            job=self.job,
            index=2,
            title="总结",
            prompt="prompt",
            narration="第二段旁白",
            duration=4,
        )
        self.composition = VideoComposition.objects.create(job=self.job)

    def test_persists_wav_with_relative_path_and_digest(self):
        persist_segment_audio(self.first, b"RIFFxxxxWAVEdata", duration_ms=1250)
        self.first.refresh_from_db()

        self.assertEqual(self.first.audio_status, "succeeded")
        self.assertFalse(Path(self.first.audio_path).is_absolute())
        self.assertTrue((Path(self.temp.name) / self.first.audio_path).is_file())
        self.assertEqual(self.first.audio_duration_ms, 1250)
        self.assertEqual(len(self.first.audio_sha256), 64)

    def test_rejects_path_traversal_from_database(self):
        self.composition.final_video_path = "../outside.mp4"
        self.composition.save(update_fields=["final_video_path", "updated_at"])
        with self.assertRaisesRegex(ValueError, "存储路径"):
            asset_file(self.composition, "final")

    def test_builds_plain_narration_and_webvtt(self):
        segments = [self.first, self.second]
        narration = build_narration_text(segments)
        subtitles = build_webvtt(segments)

        self.assertIn("第一段旁白", narration)
        self.assertIn("WEBVTT", subtitles)
        self.assertIn("00:00:00.000 --> 00:00:03.000", subtitles)
        self.assertIn("00:00:03.000 --> 00:00:07.000", subtitles)
