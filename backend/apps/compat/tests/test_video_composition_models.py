from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from unittest import skipUnless

from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat import models as compat_models
from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment


class VideoCompositionModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009108", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="composition-model-job",
            user=self.user,
            resource_pack_id="composition-model-pack",
        )

    def test_segment_storyboard_and_audio_fields_persist(self):
        expected_fields = {
            "visual",
            "narration",
            "source_ids",
            "narration_estimated_ms",
            "narration_fits",
            "audio_status",
            "audio_path",
            "audio_content_type",
            "audio_file_size",
            "audio_sha256",
            "audio_duration_ms",
            "audio_playback_id",
        }
        field_names = {field.name for field in VideoGenerationSegment._meta.fields}
        self.assertTrue(expected_fields.issubset(field_names))
        audio_playback_field = VideoGenerationSegment._meta.get_field("audio_playback_id")
        self.assertTrue(audio_playback_field.unique)
        self.assertFalse(audio_playback_field.db_index)

        segment = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="Introduction",
            prompt="Show a concise introduction",
            visual="Animated process diagram",
            narration="First, identify the input and output.",
            source_ids=["source-1", "source-2"],
            narration_estimated_ms=4200,
            narration_fits=False,
            audio_status="succeeded",
            audio_path="video/audio/segment-1.mp3",
            audio_content_type="audio/mpeg",
            audio_file_size=8192,
            audio_sha256="a" * 64,
            audio_duration_ms=4100,
        )

        segment.refresh_from_db()
        self.assertEqual(segment.visual, "Animated process diagram")
        self.assertEqual(segment.narration, "First, identify the input and output.")
        self.assertEqual(segment.source_ids, ["source-1", "source-2"])
        self.assertEqual(segment.narration_estimated_ms, 4200)
        self.assertFalse(segment.narration_fits)
        self.assertEqual(segment.audio_status, "succeeded")
        self.assertEqual(segment.audio_path, "video/audio/segment-1.mp3")
        self.assertEqual(segment.audio_content_type, "audio/mpeg")
        self.assertEqual(segment.audio_file_size, 8192)
        self.assertEqual(segment.audio_sha256, "a" * 64)
        self.assertEqual(segment.audio_duration_ms, 4100)
        self.assertIsNotNone(segment.audio_playback_id)

    def test_composition_state_and_output_fields_persist(self):
        composition_model = getattr(compat_models, "VideoComposition", None)
        self.assertIsNotNone(composition_model)
        playback_field = composition_model._meta.get_field("playback_id")
        self.assertTrue(playback_field.unique)
        self.assertFalse(playback_field.db_index)
        self.assertEqual(
            [index.fields for index in composition_model._meta.indexes],
            [["status", "updated_at"]],
        )

        started_at = timezone.now()
        finished_at = started_at + timedelta(seconds=30)
        composition = composition_model.objects.create(
            job=self.job,
            status="succeeded",
            stage="complete",
            progress=100,
            message="Composition complete",
            tts_provider="qwen-tts",
            tts_model="qwen3-tts-flash",
            voice="Cherry",
            speed=1.1,
            narration_text="Combined narration",
            subtitles_path="video/subtitles/job.vtt",
            final_video_path="video/final/job.mp4",
            final_content_type="video/mp4",
            final_file_size=123456,
            final_sha256="b" * 64,
            celery_task_id="celery-composition-1",
            narration_attempts=2,
            compose_attempts=3,
            error_code="recovered",
            error_message="Recovered after retry",
            started_at=started_at,
            finished_at=finished_at,
        )

        composition.refresh_from_db()
        self.assertEqual(composition.job, self.job)
        self.assertEqual(composition.status, "succeeded")
        self.assertEqual(composition.stage, "complete")
        self.assertEqual(composition.progress, 100)
        self.assertEqual(composition.message, "Composition complete")
        self.assertEqual(composition.tts_provider, "qwen-tts")
        self.assertEqual(composition.tts_model, "qwen3-tts-flash")
        self.assertEqual(composition.voice, "Cherry")
        self.assertEqual(composition.speed, 1.1)
        self.assertEqual(composition.narration_text, "Combined narration")
        self.assertEqual(composition.subtitles_path, "video/subtitles/job.vtt")
        self.assertEqual(composition.final_video_path, "video/final/job.mp4")
        self.assertEqual(composition.final_content_type, "video/mp4")
        self.assertEqual(composition.final_file_size, 123456)
        self.assertEqual(composition.final_sha256, "b" * 64)
        self.assertIsNotNone(composition.playback_id)
        self.assertEqual(composition.celery_task_id, "celery-composition-1")
        self.assertEqual(composition.narration_attempts, 2)
        self.assertEqual(composition.compose_attempts, 3)
        self.assertEqual(composition.error_code, "recovered")
        self.assertEqual(composition.error_message, "Recovered after retry")
        self.assertEqual(composition.started_at, started_at)
        self.assertEqual(composition.finished_at, finished_at)

    def test_job_has_only_one_composition(self):
        composition_model = getattr(compat_models, "VideoComposition", None)
        self.assertIsNotNone(composition_model)
        composition = composition_model.objects.create(job=self.job)

        self.assertEqual(self.job.composition, composition)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                composition_model.objects.create(job=self.job)


@skipUnless(
    Path(__file__).parents[1].joinpath("migrations", "0008_video_composition_workflow.py").exists(),
    "Migration 0008 has not been created yet.",
)
class VideoCompositionMigrationTests(TransactionTestCase):
    migrate_from = ("compat", "0007_video_segment_persistent_storage")
    migrate_to = ("compat", "0008_video_composition_workflow")

    def setUp(self):
        super().setUp()
        executor = MigrationExecutor(connection)
        executor.migrate([self.migrate_from])
        old_apps = executor.loader.project_state([self.migrate_from]).apps
        user_model = old_apps.get_model("accounts", "User")
        job_model = old_apps.get_model("compat", "VideoGenerationJob")
        segment_model = old_apps.get_model("compat", "VideoGenerationSegment")
        user = user_model.objects.create(phone="13800009109", password="unused")
        job = job_model.objects.create(
            job_id="composition-migration-job",
            user_id=user.id,
            resource_pack_id="composition-migration-pack",
        )
        segment_model.objects.bulk_create(
            segment_model(
                job_id=job.id,
                index=index,
                title=f"Segment {index}",
                prompt=f"Migration test {index}",
            )
            for index in range(1, 502)
        )

        executor = MigrationExecutor(connection)
        with CaptureQueriesContext(connection) as queries:
            executor.migrate([self.migrate_to])
        self.backfill_update_queries = [
            query["sql"]
            for query in queries.captured_queries
            if query["sql"].lstrip().upper().startswith(
                'UPDATE "A3_VIDEO_GENERATION_SEGMENTS"'
            )
        ]
        self.apps = executor.loader.project_state([self.migrate_to]).apps

    def test_existing_segments_receive_distinct_audio_playback_ids(self):
        segment_model = self.apps.get_model("compat", "VideoGenerationSegment")
        playback_ids = list(
            segment_model.objects.order_by("index").values_list("audio_playback_id", flat=True)
        )

        self.assertEqual(len(playback_ids), 501)
        self.assertNotIn(None, playback_ids)
        self.assertEqual(len(set(playback_ids)), 501)
        self.assertGreaterEqual(len(self.backfill_update_queries), 1)
        self.assertLessEqual(len(self.backfill_update_queries), 3)
