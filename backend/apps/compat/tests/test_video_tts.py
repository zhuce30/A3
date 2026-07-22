from __future__ import annotations

import wave
from io import BytesIO
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from backend.apps.compat.video_tts import (
    TTSConfigurationError,
    resolve_tts_api_key,
    synthesize_qwen_audio,
    wav_duration_ms,
)


def make_wav(duration_ms: int = 500) -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8_000)
        wav.writeframes(b"\x00\x00" * (8_000 * duration_ms // 1_000))
    return output.getvalue()


class VideoTtsTests(SimpleTestCase):
    @patch.dict(
        "os.environ",
        {
            "A3_VIDEO_TTS_API_KEY": "video-key",
            "TTS_QWEN_API_KEY": "tts-key",
            "DASHSCOPE_API_KEY": "dashscope-key",
            "QWEN_API_KEY": "qwen-key",
            "A3_LLM_API_KEY": "llm-key",
        },
        clear=True,
    )
    def test_resolves_dedicated_server_key_first(self):
        self.assertEqual(resolve_tts_api_key(), "video-key")

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_key_has_readable_error(self):
        with self.assertRaisesRegex(TTSConfigurationError, "语音合成"):
            resolve_tts_api_key()

    @patch("backend.apps.compat.video_tts.requests.get")
    @patch("backend.apps.compat.video_tts.requests.post")
    @patch.dict("os.environ", {"A3_VIDEO_TTS_API_KEY": "server-only-key"}, clear=True)
    def test_qwen_request_uses_fixed_endpoint_and_downloads_wav(self, post, get):
        wav = make_wav(500)
        post_response = Mock(status_code=200)
        post_response.json.return_value = {"output": {"audio": {"url": "https://cdn.example/audio.wav"}}}
        post.return_value = post_response
        get_response = Mock(
            status_code=200,
            headers={"content-type": "audio/wav", "content-length": str(len(wav))},
        )
        get_response.iter_content.return_value = [wav[:100], wav[100:]]
        get.return_value = get_response

        audio = synthesize_qwen_audio("测试旁白", model="qwen3-tts-flash", voice="Cherry", speed=1.2)

        self.assertEqual(audio, wav)
        self.assertEqual(wav_duration_ms(audio), 500)
        url = post.call_args.args[0]
        kwargs = post.call_args.kwargs
        self.assertEqual(
            url,
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        )
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer server-only-key")
        self.assertEqual(kwargs["json"]["input"]["voice"], "Cherry")
        self.assertEqual(kwargs["json"]["parameters"]["rate"], 100)
        get.assert_called_once_with(
            "https://cdn.example/audio.wav",
            timeout=(10, 120),
            stream=True,
            allow_redirects=False,
        )

    @patch("backend.apps.compat.video_tts.requests.post")
    @patch.dict("os.environ", {"A3_VIDEO_TTS_API_KEY": "server-only-key"}, clear=True)
    def test_rejects_non_https_audio_download(self, post):
        response = Mock(status_code=200)
        response.json.return_value = {"output": {"audio": {"url": "http://127.0.0.1/private"}}}
        post.return_value = response

        with self.assertRaisesRegex(RuntimeError, "下载地址"):
            synthesize_qwen_audio("测试")
