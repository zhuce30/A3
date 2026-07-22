from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoComposition, VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_composition_storage import persist_segment_audio


class VideoCompositionApiTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = override_settings(A3_VIDEO_STORAGE_ROOT=Path(self.temp.name))
        self.settings.enable()
        self.addCleanup(self.settings.disable)
        self.addCleanup(self.temp.cleanup)
        self.user = User.objects.create_user(phone="13800009923", password="Password123")
        self.other = User.objects.create_user(phone="13800009924", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="compose-api",
            user=self.user,
            resource_pack_id="pack-1",
            status="succeeded",
        )
        self.first = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="prompt",
            visual="状态转换动画",
            narration="第一段旁白",
            narration_estimated_ms=1250,
            narration_fits=True,
            duration=3,
            status="succeeded",
        )
        self.second = VideoGenerationSegment.objects.create(
            job=self.job,
            index=2,
            title="总结",
            prompt="prompt",
            visual="总结画面",
            narration="第二段旁白",
            narration_estimated_ms=1250,
            narration_fits=True,
            duration=4,
            status="succeeded",
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.base = f"/api/resources/video-jobs/{self.job.job_id}/composition/"

    def test_get_creates_and_serializes_four_stage_composition(self):
        response = self.client.get(self.base)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual([stage["id"] for stage in body["composition"]["stages"]], [
            "storyboard", "segments", "narration", "compose"
        ])
        self.assertEqual(len(body["composition"]["segments"]), 2)
        self.assertTrue(VideoComposition.objects.filter(job=self.job).exists())

    def test_other_user_cannot_read_composition(self):
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(self.base).status_code, 404)

    def test_invalid_audio_range_returns_standard_content_range(self):
        persist_segment_audio(self.first, b"RIFFxxxxWAVEdata", duration_ms=500)
        self.first.refresh_from_db()

        response = self.client.get(
            f"/api/resources/video-audio/{self.first.audio_playback_id}/",
            HTTP_RANGE="bytes=9999-10000",
        )

        self.assertEqual(response.status_code, 416)
        self.assertEqual(response["Content-Range"], f"bytes */{self.first.audio_file_size}")

    def test_patch_updates_narration_and_invalidates_only_changed_audio(self):
        composition = VideoComposition.objects.create(
            job=self.job,
            status="succeeded",
            final_video_path="1/compose-api/composition/final.mp4",
        )
        for segment in (self.first, self.second):
            segment.audio_status = "succeeded"
            segment.audio_path = f"audio-{segment.index}.wav"
            segment.audio_file_size = 12
            segment.save()

        response = self.client.patch(
            self.base,
            data={"segments": [{"index": 1, "narration": "修改后的旁白"}]},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.first.refresh_from_db()
        self.second.refresh_from_db()
        composition.refresh_from_db()
        self.assertEqual(self.first.narration, "修改后的旁白")
        self.assertEqual(self.first.audio_status, "pending")
        self.assertEqual(self.first.audio_path, "")
        self.assertEqual(self.second.audio_status, "succeeded")
        self.assertEqual(self.second.audio_path, "audio-2.wav")
        self.assertEqual(composition.final_video_path, "")

    def test_patch_speed_revalidates_all_narration(self):
        VideoComposition.objects.create(job=self.job)
        response = self.client.patch(
            self.base,
            data={"speed": 2.0, "voice": "Serena"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.first.refresh_from_db()
        self.assertEqual(self.first.narration_estimated_ms, 625)
        self.assertTrue(self.first.narration_fits)
        self.assertEqual(response.json()["composition"]["voice"], "Serena")

    def test_patch_rejects_changes_while_a_composition_task_is_active(self):
        VideoComposition.objects.create(
            job=self.job,
            status="generating_narration",
            stage="narration",
        )

        response = self.client.patch(
            self.base,
            data={"segments": [{"index": 1, "narration": "不应在运行时写入"}]},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("进行中", response.json()["error"])
        self.first.refresh_from_db()
        self.assertEqual(self.first.narration, "第一段旁白")

    @patch("backend.apps.compat.video_compositions.current_app.send_task")
    def test_generate_narration_dispatches_to_dedicated_queue(self, send_task):
        send_task.return_value.id = "tts-task-1"
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(
                f"{self.base}generate-narration/",
                data={"segmentIndexes": [1]},
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 202)
        send_task.assert_called_once()
        self.assertEqual(send_task.call_args.args, ("compat.generate_video_narration",))
        self.assertEqual(send_task.call_args.kwargs["args"], [self.job.job_id, [1]])
        self.assertEqual(send_task.call_args.kwargs["queue"], "video-compose")
        self.assertRegex(send_task.call_args.kwargs["task_id"], r"^[0-9a-f]{32}$")

    def test_generate_narration_rejects_overlong_script_before_dispatch(self):
        self.first.narration_fits = False
        self.first.save(update_fields=["narration_fits", "updated_at"])
        response = self.client.post(
            f"{self.base}generate-narration/", data={}, content_type="application/json"
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("时长", response.json()["error"])

    @patch("backend.apps.compat.video_compositions.current_app.send_task")
    def test_generate_narration_does_not_dispatch_a_duplicate_active_task(self, send_task):
        VideoComposition.objects.create(
            job=self.job,
            status="queued",
            stage="narration",
            celery_task_id="existing-task",
        )

        response = self.client.post(
            f"{self.base}generate-narration/",
            data={"segmentIndexes": [1]},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["composition"]["celeryTaskId"], "existing-task")
        send_task.assert_not_called()

    @patch("backend.apps.compat.video_compositions.current_app.send_task")
    def test_compose_dispatches_to_dedicated_queue(self, send_task):
        send_task.return_value.id = "compose-task-1"
        for segment in (self.first, self.second):
            segment.stored_path = f"video-{segment.index}.mp4"
            segment.audio_status = "succeeded"
            segment.audio_path = f"audio-{segment.index}.wav"
            segment.save()
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client.post(f"{self.base}compose/", data={}, content_type="application/json")
        self.assertEqual(response.status_code, 202)
        send_task.assert_called_once()
        self.assertEqual(send_task.call_args.args, ("compat.compose_final_video",))
        self.assertEqual(send_task.call_args.kwargs["args"], [self.job.job_id])
        self.assertEqual(send_task.call_args.kwargs["queue"], "video-compose")
        self.assertRegex(send_task.call_args.kwargs["task_id"], r"^[0-9a-f]{32}$")
