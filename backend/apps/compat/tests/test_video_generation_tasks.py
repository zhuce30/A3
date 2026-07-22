from __future__ import annotations

from datetime import timedelta
from unittest.mock import ANY, patch

from django.test import TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_provider_client import VideoProviderNetworkError
from backend.apps.compat.video_storage import VideoStorageError
from backend.apps.compat.video_tasks import advance_video_generation_job, poll_video_generation_segment


class VideoGenerationTaskTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009902", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="video-job-task-001",
            user=self.user,
            resource_pack_id="pack-task-001",
            provider="seedance",
            requested_duration=20,
        )
        self.first = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="第一段",
            status="polling",
            provider_task_id="seedance-task-existing",
            submission_attempts=1,
            submitted_at=timezone.now() - timedelta(minutes=6),
        )
        self.second = VideoGenerationSegment.objects.create(
            job=self.job,
            index=2,
            title="概念",
            prompt="第二段",
        )

    @patch("backend.apps.compat.video_tasks.poll_video_provider_task", return_value={"status": "running"})
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_running_after_six_minutes_reschedules_same_provider_task(self, apply_async, poll_provider):
        poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        poll_provider.assert_called_once_with("seedance", "seedance-task-existing")
        self.assertEqual(self.first.provider_task_id, "seedance-task-existing")
        self.assertEqual(self.first.status, "polling")
        self.assertEqual(self.first.celery_task_id, apply_async.call_args.kwargs["task_id"])
        self.assertTrue(self.first.celery_task_id)
        apply_async.assert_called_once_with(
            args=[self.job.job_id, 1],
            countdown=5,
            task_id=ANY,
        )

    @patch("backend.apps.compat.video_tasks.poll_video_provider_task")
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_redelivered_old_poll_generation_does_not_fork_polling(self, apply_async, poll_provider):
        self.first.celery_task_id = "current-poll-task"
        self.first.save(update_fields=["celery_task_id", "updated_at"])
        poll_video_generation_segment.push_request(id="old-poll-task")
        try:
            result = poll_video_generation_segment.run(self.job.job_id, 1)
        finally:
            poll_video_generation_segment.pop_request()

        self.assertEqual(result["status"], "stale")
        poll_provider.assert_not_called()
        apply_async.assert_not_called()

    @patch("backend.apps.compat.video_tasks.poll_video_provider_task", side_effect=VideoProviderNetworkError("reset"))
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_network_error_retries_poll_without_resubmitting(self, apply_async, _poll_provider):
        poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        self.assertEqual(self.first.provider_task_id, "seedance-task-existing")
        self.assertEqual(self.first.network_retry_count, 1)
        apply_async.assert_called_once_with(args=[self.job.job_id, 1], countdown=10, task_id=ANY)

    @patch("backend.apps.compat.video_tasks.poll_video_provider_task", return_value={"status": "failed", "error": "provider failed"})
    @patch("backend.apps.compat.video_tasks.advance_video_generation_job.delay")
    def test_explicit_provider_failure_allows_one_resubmission(self, advance_delay, _poll_provider):
        poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        self.assertEqual(self.first.status, "pending")
        self.assertEqual(self.first.provider_task_id, "")
        self.assertEqual(self.first.submission_attempts, 1)
        advance_delay.assert_called_once_with(self.job.job_id)

    @patch("backend.apps.compat.video_tasks.submit_video_provider_task", return_value="seedance-task-second-attempt")
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_pending_retry_submits_once_and_persists_task_id_before_polling(self, apply_async, submit_provider):
        self.first.status = "pending"
        self.first.provider_task_id = ""
        self.first.save(update_fields=["status", "provider_task_id", "updated_at"])

        advance_video_generation_job.run(self.job.job_id)

        self.first.refresh_from_db()
        submit_provider.assert_called_once()
        self.assertEqual(self.first.provider_task_id, "seedance-task-second-attempt")
        self.assertEqual(self.first.submission_attempts, 2)
        apply_async.assert_called_once_with(args=[self.job.job_id, 1], countdown=5, task_id=ANY)

    @patch("backend.apps.compat.video_tasks.submit_video_provider_task")
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_existing_provider_task_is_never_submitted_again(self, apply_async, submit_provider):
        advance_video_generation_job.run(self.job.job_id)

        submit_provider.assert_not_called()
        apply_async.assert_called_once_with(args=[self.job.job_id, 1], countdown=5, task_id=ANY)

    @patch("backend.apps.compat.video_tasks.submit_video_provider_task")
    @patch("backend.apps.compat.video_tasks.advance_video_generation_job.apply_async")
    def test_recent_submitting_segment_is_not_failed_by_duplicate_advance(self, apply_async, submit_provider):
        self.first.status = "submitting"
        self.first.provider_task_id = ""
        self.first.save(update_fields=["status", "provider_task_id", "updated_at"])

        advance_video_generation_job.run(self.job.job_id)

        self.first.refresh_from_db()
        submit_provider.assert_not_called()
        self.assertEqual(self.first.status, "submitting")
        self.assertEqual(self.first.error_code, "")
        apply_async.assert_called_once_with(args=[self.job.job_id], countdown=30)

    @patch("backend.apps.compat.video_tasks.poll_video_provider_task")
    @patch("backend.apps.compat.video_tasks.advance_video_generation_job.delay")
    def test_provider_task_stops_only_after_two_hour_safety_limit(self, advance_delay, poll_provider):
        self.first.submitted_at = timezone.now() - timedelta(hours=2, minutes=1)
        self.first.save(update_fields=["submitted_at", "updated_at"])

        poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        poll_provider.assert_not_called()
        self.assertEqual(self.first.status, "failed")
        self.assertEqual(self.first.error_code, "provider_timeout")
        self.assertEqual(self.first.provider_task_id, "seedance-task-existing")
        advance_delay.assert_called_once_with(self.job.job_id)

    @patch(
        "backend.apps.compat.video_tasks.poll_video_provider_task",
        return_value={"status": "succeeded", "result": {"url": "https://provider.invalid/signed.mp4"}},
    )
    @patch("backend.apps.compat.video_tasks.persist_segment_video", side_effect=VideoStorageError("download failed"))
    @patch("backend.apps.compat.video_tasks.poll_video_generation_segment.apply_async")
    def test_provider_success_is_not_marked_succeeded_until_file_is_persisted(
        self,
        apply_async,
        _persist,
        _poll_provider,
    ):
        result = poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        self.assertEqual(result["status"], "persisting")
        self.assertEqual(self.first.status, "polling")
        self.assertEqual(self.first.storage_attempts, 1)
        self.assertEqual(self.first.video_url, "")
        apply_async.assert_called_once_with(args=[self.job.job_id, 1], countdown=30, task_id=ANY)

    @patch(
        "backend.apps.compat.video_tasks.poll_video_provider_task",
        return_value={"status": "succeeded", "result": {"url": "https://provider.invalid/signed.mp4"}},
    )
    @patch("backend.apps.compat.video_tasks.advance_video_generation_job.delay")
    def test_provider_success_publishes_only_local_playback_url(self, advance_delay, _poll_provider):
        def persist(segment, _remote_url):
            segment.video_url = f"/api/a3/resources/video-playback/{segment.playback_id}"
            segment.stored_path = "1/job/segment.mp4"
            segment.content_type = "video/mp4"
            segment.file_size = 140
            segment.sha256 = "a" * 64
            segment.save()

        with patch("backend.apps.compat.video_tasks.persist_segment_video", side_effect=persist):
            result = poll_video_generation_segment.run(self.job.job_id, 1)

        self.first.refresh_from_db()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.first.status, "succeeded")
        self.assertTrue(self.first.video_url.startswith("/api/a3/resources/video-playback/"))
        self.assertNotIn("provider.invalid", self.first.video_url)
        advance_delay.assert_called_once_with(self.job.job_id)

    @patch("backend.apps.compat.resource_generation.record_openmaic_video_artifact")
    def test_terminal_segments_write_one_partial_artifact_with_stable_job_id(self, record_artifact):
        record_artifact.return_value = {"artifact": {}, "resourcePack": {"resourcePackId": self.job.resource_pack_id}}
        self.first.status = "succeeded"
        self.first.video_url = "https://example.invalid/segment-1.mp4"
        self.first.duration = 10
        self.first.width = 1920
        self.first.height = 1080
        self.first.finished_at = timezone.now()
        self.first.save()
        self.second.status = "failed"
        self.second.error_message = "provider failed"
        self.second.submission_attempts = 2
        self.second.finished_at = timezone.now()
        self.second.save()

        advance_video_generation_job.run(self.job.job_id)

        self.job.refresh_from_db()
        self.assertEqual(self.job.status, "partial")
        self.assertEqual(self.job.artifact["jobId"], self.job.job_id)
        self.assertEqual(self.job.artifact["status"], "partial")
        self.assertEqual(len(self.job.artifact["segments"]), 2)
        record_artifact.assert_called_once()
