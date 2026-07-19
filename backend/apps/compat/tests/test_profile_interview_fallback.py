from unittest.mock import patch

from django.test import SimpleTestCase

from backend.apps.compat.profile_interview import (
    _extract_profile_dimensions,
    _llm_extract_profile_dimensions,
    _rule_extract_profile_dimensions,
)


class ProfileInterviewFallbackTests(SimpleTestCase):
    def test_short_motivation_follow_up_is_extracted_without_llm(self):
        extracted = _rule_extract_profile_dimensions("遇到的困难是对基础知识的深入掌握")

        self.assertEqual(extracted["motivationRisk"], "对基础知识的深入掌握")

    @patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions")
    def test_llm_failure_reason_is_retained_in_fallback_metadata(self, extract):
        extract.side_effect = TimeoutError("profile provider timeout")

        extracted = _extract_profile_dimensions("每天可以学习45分钟")

        self.assertTrue(extracted["_llm"]["fallback"])
        self.assertEqual(extracted["_llm"]["provider"], "rules")
        self.assertIn("profile provider timeout", extracted["_llm"]["error"])

    @patch("backend.apps.compat.profile_interview.chat_completion")
    def test_llm_prompt_maps_short_answer_to_last_follow_up_field(self, chat):
        chat.return_value = {
            "content": "{}",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        _llm_extract_profile_dimensions(
            "对基础知识的深入掌握",
            recent_messages=[
                {"role": "agent", "content": "最近坚持学习时最容易遇到什么困难？"},
            ],
        )

        system_prompt = chat.call_args.args[0][0]["content"]
        self.assertIn("最后一条追问", system_prompt)
        self.assertIn("按该追问对应的画像字段抽取", system_prompt)
