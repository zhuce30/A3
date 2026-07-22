from __future__ import annotations

import tempfile
import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoComposition, VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_composition_tasks import (
    _hash_file,
    _run_ffmpeg,
    build_segment_ffmpeg_args,
    compose_final_video,
    generate_video_narration,
)


def make_wav(duration_ms: int = 500) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8_000)
        wav.writeframes(b"\x00\x00" * (8_000 * duration_ms // 1_000))
    return output.getvalue()


class VideoCompositionTaskTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = override_settings(A3_VIDEO_STORAGE_ROOT=Path(self.temp.name))
        self.settings.enable()
        self.addCleanup(self.settings.disable)
        self.addCleanup(self.temp.cleanup)
        user = User.objects.create_user(phone="13800009922", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="compose-task",
            user=user,
            resource_pack_id="pack-1",
            status="succeeded",
        )
        self.first = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="prompt",
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
            narration="第二段旁白",
            narration_estimated_ms=1250,
            narration_fits=True,
            duration=4,
            status="succeeded",
        )
        self.composition = VideoComposition.objects.create(job=self.job)

    @patch("backend.apps.compat.video_composition_tasks.synthesize_qwen_audio")
    def test_generates_only_missing_segment_audio(self, synthesize):
        synthesize.return_value = make_wav(500)
        self.first.audio_status = "succeeded"
        self.first.audio_path = "existing.wav"
        self.first.audio_file_size = 1
        self.first.save()

        result = generate_video_narration.run(self.job.job_id)

        self.assertEqual(result["generated"], 1)
        synthesize.assert_called_once()
        self.second.refresh_from_db()
        self.composition.refresh_from_db()
        self.assertEqual(self.second.audio_status, "succeeded")
        self.assertEqual(self.second.audio_duration_ms, 500)
        self.assertEqual(self.composition.status, "narration_ready")
        self.assertTrue(self.composition.subtitles_path)

    @patch("backend.apps.compat.video_composition_tasks.synthesize_qwen_audio")
    def test_can_retry_only_selected_segment_audio(self, synthesize):
        synthesize.return_value = make_wav(500)
        self.first.audio_status = "failed"
        self.first.save(update_fields=["audio_status", "updated_at"])
        self.second.audio_status = "succeeded"
        self.second.audio_path = "kept.wav"
        self.second.audio_file_size = 1
        self.second.save()

        result = generate_video_narration.run(self.job.job_id, [1])

        self.assertEqual(result["generated"], 1)
        synthesize.assert_called_once_with(
            "第一段旁白",
            model="qwen3-tts-flash",
            voice="Cherry",
            speed=1.0,
        )
        self.second.refresh_from_db()
        self.assertEqual(self.second.audio_path, "kept.wav")

    def test_refuses_narration_that_does_not_fit(self):
        self.first.narration_fits = False
        self.first.save(update_fields=["narration_fits", "updated_at"])
        with self.assertRaisesRegex(ValueError, "时长"):
            generate_video_narration.run(self.job.job_id)

    @patch("backend.apps.compat.video_composition_tasks.synthesize_qwen_audio")
    def test_rejects_audio_whose_real_duration_exceeds_segment(self, synthesize):
        self.first.duration = 1
        self.first.save(update_fields=["duration", "updated_at"])
        synthesize.return_value = make_wav(1_500)

        with self.assertRaisesRegex(ValueError, "实际旁白时长"):
            generate_video_narration.run(self.job.job_id, [1])

        self.first.refresh_from_db()
        self.assertEqual(self.first.audio_status, "failed")

    @patch("backend.apps.compat.video_composition_tasks.synthesize_qwen_audio")
    def test_stale_narration_task_does_not_write_audio(self, synthesize):
        self.composition.status = "queued"
        self.composition.stage = "narration"
        self.composition.celery_task_id = "current-task"
        self.composition.save()
        generate_video_narration.push_request(id="stale-task")
        try:
            result = generate_video_narration.run(self.job.job_id, [1])
        finally:
            generate_video_narration.pop_request()

        self.assertTrue(result["stale"])
        synthesize.assert_not_called()

    def test_worker_loss_requeues_long_video_tasks(self):
        self.assertTrue(generate_video_narration.reject_on_worker_lost)
        self.assertTrue(compose_final_video.reject_on_worker_lost)

    def test_ffmpeg_builder_returns_argument_list_without_shell_syntax(self):
        args = build_segment_ffmpeg_args(
            Path("input.mp4"), Path("audio.wav"), Path("output.mp4"), duration=10
        )
        self.assertIsInstance(args, list)
        self.assertEqual(args[0], "ffmpeg")
        self.assertNotIn("shell=True", " ".join(args))

    @patch("backend.apps.compat.video_composition_tasks.subprocess.run")
    def test_ffmpeg_runner_never_enables_a_shell(self, run):
        args = ["ffmpeg", "-version"]
        _run_ffmpeg(args)
        self.assertEqual(run.call_args.args[0], args)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_hashes_final_video_in_streaming_chunks(self):
        path = Path(self.temp.name) / "final.mp4"
        path.write_bytes(b"a" * (2 * 1024 * 1024 + 17))

        digest, size = _hash_file(path, chunk_size=1024 * 1024)

        self.assertEqual(size, path.stat().st_size)
        self.assertEqual(
            digest,
            "c2273a45bd6d19d2714b8279b1fd1123bb746e7f7f6331085fb6ecaa30164546",
        )

    def test_compose_requires_all_video_segments_and_audio(self):
        with self.assertRaisesRegex(ValueError, "片段视频"):
            compose_final_video.run(self.job.job_id)
