from __future__ import annotations

from django.db import IntegrityError
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_jobs import serialize_video_job
from backend.apps.compat.resource_generation import record_openmaic_video_artifact
from backend.apps.profiles.models import LearnerProfile


class VideoGenerationJobModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009901", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="video-job-001",
            user=self.user,
            resource_pack_id="pack-001",
            provider="seedance",
            requested_duration=60,
        )

    def test_job_owns_ordered_unique_segments_and_persists_provider_state(self):
        VideoGenerationSegment.objects.create(
            job=self.job,
            index=2,
            title="概念",
            prompt="第二段提示词",
            provider_task_id="seedance-task-002",
            status="polling",
            submission_attempts=1,
        )
        VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="第一段提示词",
            status="succeeded",
            video_url="https://example.invalid/segment-1.mp4",
            width=1920,
            height=1080,
        )

        self.assertEqual(list(self.job.segments.values_list("index", flat=True)), [1, 2])
        polling = self.job.segments.get(index=2)
        self.assertEqual(polling.provider_task_id, "seedance-task-002")
        self.assertEqual(polling.submission_attempts, 1)
        with self.assertRaises(IntegrityError):
            VideoGenerationSegment.objects.create(job=self.job, index=1, title="重复", prompt="重复")

    def test_public_serializer_omits_secret_provider_and_prompt_fields(self):
        VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="不能返回给浏览器的完整提示词",
            provider_task_id="seedance-secret-task-id",
            celery_task_id="celery-secret-task-id",
            status="succeeded",
            video_url="https://example.invalid/segment-1.mp4",
            duration=10,
        )

        payload = serialize_video_job(VideoGenerationJob.objects.prefetch_related("segments").get(id=self.job.id))
        segment = payload["segments"][0]

        self.assertEqual(payload["jobId"], "video-job-001")
        self.assertEqual(payload["resourcePackId"], "pack-001")
        self.assertEqual(segment["status"], "succeeded")
        self.assertEqual(segment["videoUrl"], "https://example.invalid/segment-1.mp4")
        self.assertNotIn("prompt", segment)
        self.assertNotIn("providerTaskId", segment)
        self.assertNotIn("celeryTaskId", segment)

    def test_public_serializer_keeps_epoch_millisecond_time_contract(self):
        self.job.started_at = timezone.now()
        self.job.finished_at = timezone.now()
        self.job.save(update_fields=["started_at", "finished_at", "updated_at"])
        VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="第一段",
        )

        payload = serialize_video_job(VideoGenerationJob.objects.prefetch_related("segments").get(id=self.job.id))

        for key in ["createdAt", "startedAt", "finishedAt", "updatedAt"]:
            self.assertIsInstance(payload[key], int)
            self.assertGreater(payload[key], 1_000_000_000_000)
        self.assertIsInstance(payload["segments"][0]["updatedAt"], int)


class VideoGenerationJobApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009903", password="Password123")
        self.other = User.objects.create_user(phone="13800009904", password="Password123")
        LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "resourcePacks": [
                    {"resourcePackId": "pack-api-001", "goal": "进程同步", "resources": [], "multimodalArtifacts": []}
                ]
            },
        )
        self.client = Client()
        self.client.force_login(self.user)

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_create_list_and_detail_persist_durable_segments(self, send_task):
        send_task.return_value.id = "celery-video-001"
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/resources/packs/pack-api-001/video-jobs/",
                data={
                    "jobId": "video-job-api-001",
                    "provider": "seedance",
                    "resourceType": "micro_video_script",
                    "duration": 20,
                    "aspectRatio": "16:9",
                    "resolution": "1080p",
                    "segments": [
                        {"index": 1, "title": "导入", "prompt": "第一段", "duration": 10},
                        {"index": 2, "title": "概念", "prompt": "第二段", "duration": 10},
                    ],
                },
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["job"]["jobId"], "video-job-api-001")
        self.assertEqual(len(payload["job"]["segments"]), 2)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=["video-job-api-001"])

        detail = self.client.get("/api/resources/video-jobs/video-job-api-001/")
        listing = self.client.get("/api/resources/video-jobs/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(listing.json()["jobs"][0]["jobId"], "video-job-api-001")

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_retry_failed_resets_only_failed_segments(self, send_task):
        send_task.return_value.id = "celery-video-retry-001"
        job = VideoGenerationJob.objects.create(
            job_id="video-job-api-retry",
            user=self.user,
            resource_pack_id="pack-api-001",
            status="partial",
        )
        succeeded = VideoGenerationSegment.objects.create(
            job=job,
            index=1,
            title="导入",
            prompt="第一段",
            status="succeeded",
            video_url="https://example.invalid/success.mp4",
        )
        failed = VideoGenerationSegment.objects.create(
            job=job,
            index=2,
            title="概念",
            prompt="第二段",
            status="failed",
            provider_task_id="failed-provider-task",
            submission_attempts=2,
        )

        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                "/api/resources/video-jobs/video-job-api-retry/retry-failed/",
                data={},
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 202)
        succeeded.refresh_from_db()
        failed.refresh_from_db()
        self.assertEqual(succeeded.status, "succeeded")
        self.assertEqual(succeeded.video_url, "https://example.invalid/success.mp4")
        self.assertEqual(failed.status, "pending")
        self.assertEqual(failed.provider_task_id, "")
        self.assertEqual(failed.submission_attempts, 0)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[job.job_id])

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_replayed_client_job_id_is_idempotent(self, send_task):
        send_task.return_value.id = "celery-video-idempotent"
        body = {
            "jobId": "video-job-idempotent-001",
            "provider": "seedance",
            "duration": 10,
            "segments": [{"index": 1, "title": "导入", "prompt": "第一段", "duration": 10}],
        }
        with self.captureOnCommitCallbacks(execute=True):
            first = self.client.post(
                "/api/resources/packs/pack-api-001/video-jobs/",
                data=body,
                content_type="application/json",
            )
        with self.captureOnCommitCallbacks(execute=True):
            replay = self.client.post(
                "/api/resources/packs/pack-api-001/video-jobs/",
                data=body,
                content_type="application/json",
            )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(replay.status_code, 200)
        self.assertFalse(replay.json()["created"])
        self.assertEqual(VideoGenerationJob.objects.filter(job_id=body["jobId"]).count(), 1)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[body["jobId"]])

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_replayed_client_job_id_cannot_move_to_another_resource_pack(self, send_task):
        send_task.return_value.id = "celery-video-pack-scope"
        body = {
            "jobId": "video-job-pack-scope-001",
            "provider": "seedance",
            "duration": 10,
            "segments": [{"index": 1, "title": "导入", "prompt": "第一段", "duration": 10}],
        }
        with self.captureOnCommitCallbacks(execute=True):
            first = self.client.post(
                "/api/resources/packs/pack-api-001/video-jobs/",
                data=body,
                content_type="application/json",
            )
        profile = self.user.learner_profile
        profile.extra_profile["resourcePacks"].append(
            {"resourcePackId": "pack-api-002", "goal": "内存管理", "resources": [], "multimodalArtifacts": []}
        )
        profile.save(update_fields=["extra_profile", "updated_at"])

        replay = self.client.post(
            "/api/resources/packs/pack-api-002/video-jobs/",
            data=body,
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(replay.status_code, 400)
        self.assertIn("资源包", replay.json()["error"])
        self.assertEqual(VideoGenerationJob.objects.filter(job_id=body["jobId"]).count(), 1)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[body["jobId"]])

    def test_openmaic_video_writeback_preserves_durable_job_id(self):
        result = record_openmaic_video_artifact(
            self.user,
            "pack-api-001",
            {
                "jobId": "video-job-artifact-001",
                "status": "partial",
                "provider": "seedance",
                "resourceType": "micro_video_script",
                "segments": [
                    {
                        "index": 1,
                        "title": "导入",
                        "status": "failed",
                        "videoUrl": "",
                        "duration": 10,
                    }
                ],
            },
        )

        self.assertEqual(result["artifact"]["jobId"], "video-job-artifact-001")
        self.assertEqual(result["resourcePack"]["multimodalArtifacts"][0]["jobId"], "video-job-artifact-001")

    def test_other_user_cannot_read_or_retry_job(self):
        VideoGenerationJob.objects.create(
            job_id="video-job-private",
            user=self.user,
            resource_pack_id="pack-api-001",
        )
        self.client.force_login(self.other)

        self.assertEqual(self.client.get("/api/resources/video-jobs/video-job-private/").status_code, 404)
        self.assertEqual(
            self.client.post("/api/resources/video-jobs/video-job-private/retry-failed/", data={}, content_type="application/json").status_code,
            404,
        )
