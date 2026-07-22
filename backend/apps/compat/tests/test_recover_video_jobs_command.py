from datetime import timedelta
from io import StringIO
from types import SimpleNamespace
from unittest.mock import ANY, call, patch

from celery import current_app
from django.contrib.auth import get_user_model
from django.core.management import call_command, get_commands
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment


class RecoverVideoJobsCommandRegistrationTests(SimpleTestCase):
    def test_recover_video_jobs_command_is_registered(self):
        self.assertIn("recover_video_jobs", get_commands())


class RecoverVideoJobsCommandTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            phone="13800139991",
            password="secure-pass-123",
        )

    def _create_job(self, *, job_id: str, job_status: str, segment_status: str, provider_task_id: str = ""):
        job = VideoGenerationJob.objects.create(
            job_id=job_id,
            user=self.user,
            resource_pack_id=f"pack-{job_id}",
            status=job_status,
        )
        segment = VideoGenerationSegment.objects.create(
            job=job,
            index=1,
            title="第一段",
            prompt="讲解进程调度",
            status=segment_status,
            provider_task_id=provider_task_id,
        )
        return job, segment

    def _make_stale(self, job: VideoGenerationJob, segment: VideoGenerationSegment):
        stale_at = timezone.now() - timedelta(minutes=10)
        VideoGenerationJob.objects.filter(pk=job.pk).update(updated_at=stale_at)
        VideoGenerationSegment.objects.filter(pk=segment.pk).update(
            updated_at=stale_at,
            last_polled_at=stale_at if segment.provider_task_id else None,
        )

    def test_redispatches_only_stale_active_jobs_without_resubmitting_provider_tasks(self):
        pending_job, pending_segment = self._create_job(
            job_id="video-pending",
            job_status="queued",
            segment_status="pending",
        )
        polling_job, polling_segment = self._create_job(
            job_id="video-polling",
            job_status="running",
            segment_status="polling",
            provider_task_id="seedance-task-existing",
        )
        completed_job, completed_segment = self._create_job(
            job_id="video-completed",
            job_status="succeeded",
            segment_status="succeeded",
            provider_task_id="seedance-task-completed",
        )
        fresh_job, _fresh_segment = self._create_job(
            job_id="video-fresh",
            job_status="running",
            segment_status="polling",
            provider_task_id="seedance-task-active",
        )
        for job, segment in [
            (pending_job, pending_segment),
            (polling_job, polling_segment),
            (completed_job, completed_segment),
        ]:
            self._make_stale(job, segment)

        stdout = StringIO()
        with patch.object(
            current_app,
            "send_task",
            return_value=SimpleNamespace(id="recovered-celery-task"),
        ) as send_task:
            call_command("recover_video_jobs", "--stale-minutes", "5", stdout=stdout)

        self.assertCountEqual(
            send_task.call_args_list,
            [
                call("compat.advance_video_generation_job", args=[pending_job.job_id], task_id=ANY),
                call(
                    "compat.poll_video_generation_segment",
                    args=[polling_job.job_id, polling_segment.index],
                    task_id=ANY,
                ),
            ],
        )
        polling_segment.refresh_from_db()
        pending_job.refresh_from_db()
        self.assertEqual(polling_segment.provider_task_id, "seedance-task-existing")
        scheduled_ids = {item.kwargs["task_id"] for item in send_task.call_args_list}
        self.assertIn(polling_segment.celery_task_id, scheduled_ids)
        self.assertIn(pending_job.celery_task_id, scheduled_ids)
        self.assertIn("恢复派发 2 个视频任务", stdout.getvalue())
        self.assertNotIn(fresh_job.job_id, stdout.getvalue())

    def test_redispatches_stale_running_job_when_all_segments_are_terminal(self):
        job, segment = self._create_job(
            job_id="video-finalize-pending",
            job_status="running",
            segment_status="succeeded",
            provider_task_id="seedance-task-completed",
        )
        segment.video_url = "https://example.invalid/completed.mp4"
        segment.save(update_fields=["video_url", "updated_at"])
        self._make_stale(job, segment)

        with patch.object(
            current_app,
            "send_task",
            return_value=SimpleNamespace(id="finalize-celery-task"),
        ) as send_task:
            call_command("recover_video_jobs", "--stale-minutes", "5")

        send_task.assert_called_once_with(
            "compat.advance_video_generation_job",
            args=[job.job_id],
            task_id=ANY,
        )
