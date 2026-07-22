from __future__ import annotations

from django.test import SimpleTestCase

from backend.apps.compat.video_director import VideoDirectorAgent, direct_video_segments, estimate_narration_ms


class EstimateNarrationTests(SimpleTestCase):
    def test_estimates_chinese_at_four_readable_characters_per_second(self):
        self.assertEqual(estimate_narration_ms("你好世界"), 1000)

    def test_estimates_english_at_two_and_a_half_words_per_second(self):
        self.assertEqual(estimate_narration_ms("one two three four five"), 2000)

    def test_adds_chinese_and_english_estimates(self):
        self.assertEqual(estimate_narration_ms("你好 world"), 900)

    def test_clamps_supported_speech_speed(self):
        self.assertEqual(estimate_narration_ms("你好世界", speed=0.1), 2000)
        self.assertEqual(estimate_narration_ms("你好世界", speed=3.0), 500)

    def test_ignores_punctuation_and_whitespace(self):
        self.assertEqual(estimate_narration_ms("  ，。！？ "), 0)


class DirectVideoSegmentTests(SimpleTestCase):
    def test_agent_name_and_direct_method_are_explicit(self):
        agent = VideoDirectorAgent()
        self.assertEqual(agent.name, "VideoDirectorAgent")
        self.assertEqual(agent.direct([{"prompt": "A scene"}])[0]["index"], 1)

    def test_normalizes_storyboard_fields_and_deduplicates_source_ids(self):
        segments = direct_video_segments(
            [
                {
                    "index": "2",
                    "title": " 概念 ",
                    "prompt": " Explain the concept ",
                    "visual": " Use arrows and shapes ",
                    "narration": " 你好 world ",
                    "duration": 2,
                    "sourceIds": ["kb-1", "kb-1", " kb-2 ", ""],
                }
            ]
        )

        self.assertEqual(
            segments,
            [
                {
                    "index": 2,
                    "title": "概念",
                    "prompt": "Explain the concept",
                    "visual": "Use arrows and shapes",
                    "narration": "你好 world",
                    "duration": 2,
                    "sourceIds": ["kb-1", "kb-2"],
                    "narrationEstimatedMs": 900,
                    "narrationFits": True,
                }
            ],
        )

    def test_defaults_fields_and_clamps_provider_duration(self):
        segments = direct_video_segments(
            [{"prompt": "First scene", "duration": 0}, {"prompt": "Second scene", "duration": 30}]
        )

        self.assertEqual(segments[0]["title"], "片段 1")
        self.assertEqual(segments[0]["duration"], 10)
        self.assertEqual(segments[0]["sourceIds"], [])
        self.assertEqual(segments[1]["duration"], 10)

    def test_marks_narration_that_exceeds_segment_duration(self):
        segment = direct_video_segments(
            [{"prompt": "A scene", "narration": "你好世界你好", "duration": 1}]
        )[0]

        self.assertEqual(segment["narrationEstimatedMs"], 1500)
        self.assertFalse(segment["narrationFits"])

    def test_accepts_legacy_snake_case_source_ids(self):
        segment = direct_video_segments([{"prompt": "A scene", "source_ids": ["source-1"]}])[0]
        self.assertEqual(segment["sourceIds"], ["source-1"])

    def test_rejects_invalid_segment_shapes_and_structured_fields(self):
        invalid_values = [
            None,
            [],
            [{}] * 7,
            [{"prompt": ""}],
            [{"prompt": "x", "visual": "v" * 4001}],
            [{"prompt": "x", "narration": "n" * 2001}],
            [{"prompt": "x", "sourceIds": [str(index) for index in range(21)]}],
        ]
        for value in invalid_values:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "[\u4e00-\u9fff]"):
                direct_video_segments(value)
