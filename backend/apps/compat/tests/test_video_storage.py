from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from backend.apps.accounts.models import User
from backend.apps.compat.models import VideoGenerationJob, VideoGenerationSegment
from backend.apps.compat.video_storage import VideoStorageError, persist_segment_video


class _StreamingResponse:
    def __init__(self, body: bytes, *, content_type: str = "video/mp4", status_code: int = 200):
        self.body = body
        self.status_code = status_code
        self.headers = {
            "content-type": content_type,
            "content-length": str(len(body)),
        }

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def iter_content(self, chunk_size: int):
        yield from (self.body[index : index + chunk_size] for index in range(0, len(self.body), chunk_size))


class VideoStorageTests(TestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory()
        self.addCleanup(self.storage.cleanup)
        self.settings_override = override_settings(
            A3_VIDEO_STORAGE_ROOT=Path(self.storage.name),
            A3_VIDEO_STORAGE_MAX_BYTES=1024 * 1024,
        )
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.user = User.objects.create_user(phone="13800009101", password="Password123")
        self.other = User.objects.create_user(phone="13800009102", password="Password123")
        self.job = VideoGenerationJob.objects.create(
            job_id="video-storage-job",
            user=self.user,
            resource_pack_id="pack-storage",
        )
        self.segment = VideoGenerationSegment.objects.create(
            job=self.job,
            index=1,
            title="导入",
            prompt="演示进程调度",
            provider_task_id="seedance-task-persisted",
            status="polling",
        )
        self.mp4 = b"\x00\x00\x00\x18ftypmp42" + (b"\x00" * 128)

    @patch("backend.apps.compat.video_storage.requests.get")
    def test_successful_provider_video_is_downloaded_and_replaced_with_local_playback_url(self, get):
        get.return_value = _StreamingResponse(self.mp4)

        persist_segment_video(self.segment, "https://provider.invalid/signed-video.mp4?signature=secret")

        self.segment.refresh_from_db()
        self.assertEqual(self.segment.provider_task_id, "seedance-task-persisted")
        self.assertTrue(self.segment.video_url.startswith("/api/a3/resources/video-playback/"))
        self.assertNotIn("provider.invalid", self.segment.video_url)
        self.assertEqual(self.segment.content_type, "video/mp4")
        self.assertEqual(self.segment.file_size, len(self.mp4))
        self.assertEqual(len(self.segment.sha256), 64)
        stored = Path(self.storage.name, self.segment.stored_path)
        self.assertEqual(stored.read_bytes(), self.mp4)
        self.assertFalse(stored.with_suffix(stored.suffix + ".part").exists())

    @patch("backend.apps.compat.video_storage.requests.get")
    def test_invalid_provider_response_is_not_persisted(self, get):
        get.return_value = _StreamingResponse(b"not-a-video", content_type="text/html")

        with self.assertRaises(VideoStorageError):
            persist_segment_video(self.segment, "https://provider.invalid/error-page")

        self.segment.refresh_from_db()
        self.assertEqual(self.segment.video_url, "")
        self.assertEqual(self.segment.stored_path, "")
        self.assertEqual(list(Path(self.storage.name).rglob("*.mp4")), [])

    @patch("backend.apps.compat.video_storage.requests.get")
    def test_authenticated_owner_can_stream_a_byte_range(self, get):
        get.return_value = _StreamingResponse(self.mp4)
        persist_segment_video(self.segment, "https://provider.invalid/video.mp4")
        self.segment.refresh_from_db()

        client = Client()
        client.force_login(self.user)
        response = client.get(
            f"/api/resources/video-playback/{self.segment.playback_id}/",
            HTTP_RANGE="bytes=4-11",
        )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response["Content-Range"], f"bytes 4-11/{len(self.mp4)}")
        self.assertEqual(response["Accept-Ranges"], "bytes")
        self.assertEqual(b"".join(response.streaming_content), self.mp4[4:12])

        client.force_login(self.other)
        hidden = client.get(f"/api/resources/video-playback/{self.segment.playback_id}/")
        self.assertEqual(hidden.status_code, 404)
