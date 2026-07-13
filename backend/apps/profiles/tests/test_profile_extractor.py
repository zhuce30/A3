from unittest.mock import patch

from django.test import TestCase

from backend.apps.profiles.extractor import extract_profile_from_text, map_extracted_to_profile_fields


class ProfileExtractorFallbackTests(TestCase):
    def test_fallback_does_not_invent_time_or_pace_when_unmentioned(self):
        with patch("backend.apps.profiles.extractor._get_client", side_effect=RuntimeError("llm unavailable")):
            extracted = extract_profile_from_text("I want to understand operating systems better.")

        fields = map_extracted_to_profile_fields(extracted)
        self.assertNotIn("daily_study_time", fields)
        self.assertNotIn("pace", fields)

    def test_extract_profile_uses_rule_fallback_when_llm_unavailable(self):
        text = (
            "I am a sophomore automation student. "
            "My foundation is weak, I can study 45 minutes daily, "
            "and I struggle with root locus and frequency response. "
            "I want practice questions and examples."
        )

        with patch("backend.apps.profiles.extractor._get_client", side_effect=RuntimeError("llm unavailable")):
            extracted = extract_profile_from_text(text)

        fields = map_extracted_to_profile_fields(extracted)
        self.assertEqual(fields["grade"], "大二")
        self.assertEqual(fields["major_direction"], "自动化专业")
        self.assertEqual(fields["foundation_level"], "基础较弱")
        self.assertEqual(fields["daily_study_time"], 45)
        self.assertIn("根轨迹", fields["weak_points"])
        self.assertIn("频率响应", fields["weak_points"])
        self.assertIn("练习题库", fields["expected_resources"])
