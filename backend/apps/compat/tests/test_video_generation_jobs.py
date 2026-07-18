from __future__ import annotations

from django.db import IntegrityError
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_jobs import create_legacy_video_retry_job, serialize_video_job
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

    @staticmethod
    def _legacy_video_pack(*, segments=None, **artifact_overrides):
        artifact = {
            "type": "openmaic_video",
            "status": "partial",
            "createdAt": "2026-07-18T00:00:00Z",
            "segments": segments
            or [
                {"index": 1, "title": "Intro", "status": "failed", "videoUrl": "", "duration": 10},
                {
                    "index": 2,
                    "title": "Concept",
                    "status": "succeeded",
                    "videoUrl": "https://server.invalid/kept.mp4",
                    "duration": 10,
                    "width": 1920,
                    "height": 1080,
                },
            ],
        }
        artifact.update(artifact_overrides)
        return {"resourcePackId": "pack-api-001", "multimodalArtifacts": [artifact]}

    @staticmethod
    def _legacy_video_payload(*, segments=None):
        return {
            "provider": "seedance",
            "segments": segments
            or [
                {"index": 1, "title": "Intro", "prompt": "First segment prompt", "duration": 10},
                {"index": 2, "title": "Concept", "prompt": "Second segment prompt", "duration": 10},
            ],
        }

    def _store_legacy_video_pack(self, *, pack=None):
        profile = self.user.learner_profile
        extra_profile = dict(profile.extra_profile or {})
        extra_profile["resourcePacks"] = [pack or self._legacy_video_pack()]
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_import_legacy_video_endpoint_creates_job_and_replay_is_idempotent(self, send_task):
        send_task.return_value.id = "celery-legacy-api"
        self._store_legacy_video_pack()
        path = "/api/resources/packs/pack-api-001/video-jobs/import-legacy/"
        payload = self._legacy_video_payload()

        with self.captureOnCommitCallbacks(execute=True):
            created = self.client.post(path, data=payload, content_type="application/json")
        with self.captureOnCommitCallbacks(execute=True):
            replay = self.client.post(path, data=payload, content_type="application/json")

        self.assertEqual(created.status_code, 201)
        self.assertTrue(created.json()["success"])
        self.assertTrue(created.json()["created"])
        self.assertEqual(created.json()["importedSucceeded"], 1)
        self.assertEqual(created.json()["queuedFailed"], 1)
        job_id = created.json()["job"]["jobId"]
        self.assertTrue(job_id.startswith("a3_legacy_video_"))
        self.assertEqual(replay.status_code, 200)
        self.assertFalse(replay.json()["created"])
        self.assertEqual(replay.json()["job"]["jobId"], job_id)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[job_id])

    def test_import_legacy_video_endpoint_rejects_unauthenticated_request(self):
        self.client.logout()

        response = self.client.post(
            "/api/resources/packs/pack-api-001/video-jobs/import-legacy/",
            data=self._legacy_video_payload(),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(response.json()["success"])

    def test_import_legacy_video_endpoint_hides_another_users_pack(self):
        self._store_legacy_video_pack()
        self.client.force_login(self.other)

        response = self.client.post(
            "/api/resources/packs/pack-api-001/video-jobs/import-legacy/",
            data=self._legacy_video_payload(),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"success": False, "error": "资源包不存在"})

    def test_import_legacy_video_endpoint_returns_readable_error_for_invalid_artifact(self):
        self._store_legacy_video_pack(pack={
            "resourcePackId": "pack-api-001",
            "multimodalArtifacts": [],
        })

        response = self.client.post(
            "/api/resources/packs/pack-api-001/video-jobs/import-legacy/",
            data=self._legacy_video_payload(),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.assertEqual(response.json()["error"], "当前视频不需要旧任务迁移")

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_import_legacy_video_preserves_success_and_queues_only_failures(self, send_task):
        send_task.return_value.id = "celery-legacy-001"
        pack = self._legacy_video_pack()
        payload = self._legacy_video_payload(
            segments=[
                {
                    "index": 1,
                    "title": "Intro",
                    "prompt": "First segment prompt",
                    "duration": 10,
                    "status": "succeeded",
                    "videoUrl": "https://attacker.invalid/failed.mp4",
                    "width": 3840,
                    "height": 2160,
                },
                {
                    "index": 2,
                    "title": "Concept",
                    "prompt": "Second segment prompt",
                    "duration": 10,
                    "status": "failed",
                    "videoUrl": "https://attacker.invalid/fake.mp4",
                    "width": 1,
                    "height": 1,
                },
            ]
        )

        with self.captureOnCommitCallbacks(execute=True):
            job, created, imported, queued = create_legacy_video_retry_job(
                self.user, "pack-api-001", pack, payload
            )

        self.assertTrue(created)
        self.assertEqual((imported, queued), (1, 1))
        failed = job.segments.get(index=1)
        self.assertEqual(failed.status, "pending")
        self.assertEqual(failed.video_url, "")
        self.assertEqual((failed.width, failed.height), (0, 0))
        kept = job.segments.get(index=2)
        self.assertEqual(kept.status, "succeeded")
        self.assertEqual(kept.video_url, "https://server.invalid/kept.mp4")
        self.assertEqual((kept.width, kept.height), (1920, 1080))
        self.assertNotEqual(kept.video_url, payload["segments"][1]["videoUrl"])
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[job.job_id])

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_import_legacy_video_replay_is_deterministic_and_dispatches_once(self, send_task):
        send_task.return_value.id = "celery-legacy-replay"
        pack = self._legacy_video_pack()
        payload = self._legacy_video_payload()

        with self.captureOnCommitCallbacks(execute=True):
            first, first_created, first_imported, first_queued = create_legacy_video_retry_job(
                self.user, "pack-api-001", pack, payload
            )
        with self.captureOnCommitCallbacks(execute=True):
            replay, replay_created, replay_imported, replay_queued = create_legacy_video_retry_job(
                self.user, "pack-api-001", pack, payload
            )

        self.assertTrue(first_created)
        self.assertFalse(replay_created)
        self.assertEqual(first.job_id, replay.job_id)
        self.assertTrue(first.job_id.startswith("a3_legacy_video_"))
        self.assertNotIn("server.invalid", first.job_id)
        self.assertEqual((first_imported, first_queued), (1, 1))
        self.assertEqual((replay_imported, replay_queued), (1, 1))
        self.assertEqual(VideoGenerationJob.objects.filter(job_id=first.job_id).count(), 1)
        self.assertEqual(VideoGenerationSegment.objects.filter(job=first).count(), 2)
        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[first.job_id])

    def test_import_legacy_video_rejects_artifact_with_job_id(self):
        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(
                self.user,
                "pack-api-001",
                self._legacy_video_pack(jobId="existing-video-job"),
                self._legacy_video_payload(),
            )

    def test_import_legacy_video_rejects_artifact_without_successful_segment(self):
        pack = self._legacy_video_pack(
            segments=[
                {"index": 1, "title": "Intro", "status": "failed", "videoUrl": ""},
                {"index": 2, "title": "Concept", "status": "failed", "videoUrl": ""},
            ]
        )
        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(self.user, "pack-api-001", pack, self._legacy_video_payload())

    def test_import_legacy_video_rejects_artifact_without_failed_segment(self):
        pack = self._legacy_video_pack(
            segments=[
                {
                    "index": 1,
                    "title": "Intro",
                    "status": "succeeded",
                    "videoUrl": "https://server.invalid/one.mp4",
                },
                {
                    "index": 2,
                    "title": "Concept",
                    "status": "succeeded",
                    "videoUrl": "https://server.invalid/two.mp4",
                },
            ]
        )
        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(self.user, "pack-api-001", pack, self._legacy_video_payload())

    def test_import_legacy_video_rejects_duplicate_request_indexes(self):
        payload = self._legacy_video_payload(
            segments=[
                {"index": 1, "title": "Intro", "prompt": "First segment prompt"},
                {"index": 1, "title": "Concept", "prompt": "Second segment prompt"},
            ]
        )
        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(self.user, "pack-api-001", self._legacy_video_pack(), payload)

    def test_import_legacy_video_rejects_request_indexes_that_differ_from_artifact(self):
        payload = self._legacy_video_payload(
            segments=[
                {"index": 1, "title": "Intro", "prompt": "First segment prompt"},
                {"index": 3, "title": "Concept", "prompt": "Third segment prompt"},
            ]
        )
        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(self.user, "pack-api-001", self._legacy_video_pack(), payload)

    def test_import_legacy_video_rejects_invalid_artifact_indexes(self):
        for invalid_segments in [
            [
                {"index": 1, "status": "failed"},
                {"index": 1, "status": "succeeded", "videoUrl": "https://server.invalid/kept.mp4"},
            ],
            [
                {"index": 0, "status": "failed"},
                {"index": 2, "status": "succeeded", "videoUrl": "https://server.invalid/kept.mp4"},
            ],
        ]:
            with self.subTest(invalid_segments=invalid_segments), self.assertRaises(ValueError):
                create_legacy_video_retry_job(
                    self.user,
                    "pack-api-001",
                    self._legacy_video_pack(segments=invalid_segments),
                    self._legacy_video_payload(),
                )

    @patch("backend.apps.compat.video_jobs.current_app.send_task")
    def test_import_legacy_video_replay_rejects_ownership_mismatch(self, send_task):
        send_task.return_value.id = "celery-legacy-owner"
        pack = self._legacy_video_pack()
        payload = self._legacy_video_payload()
        with self.captureOnCommitCallbacks(execute=True):
            job, _, _, _ = create_legacy_video_retry_job(self.user, "pack-api-001", pack, payload)
        job.user = self.other
        job.save(update_fields=["user", "updated_at"])

        with self.assertRaises(ValueError):
            create_legacy_video_retry_job(self.user, "pack-api-001", pack, payload)

        send_task.assert_called_once_with("compat.advance_video_generation_job", args=[job.job_id])

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
