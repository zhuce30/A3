from django.test import SimpleTestCase
from unittest.mock import patch

from backend.apps.compat.llm import generate_tutoring_answer


class TutoringLLMPromptTests(SimpleTestCase):
    @patch("backend.apps.compat.llm.chat_completion")
    def test_tutoring_prompt_is_course_agnostic_and_markdown_first(self, chat_completion):
        captured = {}

        def fake_chat(messages, **kwargs):
            captured["messages"] = messages
            captured["kwargs"] = kwargs
            return {
                "content": "### 回答\n\n使用 $a^2+b^2=c^2$ 说明。",
                "provider": "dashscope",
                "model": "qwen-plus",
                "fallback": False,
            }

        chat_completion.side_effect = fake_chat

        result = generate_tutoring_answer(
            "这个公式怎么用？",
            target={"title": "勾股定理"},
            sources=[{"title": "几何讲义", "location": "第 2 节", "snippet": "直角三角形两直角边平方和等于斜边平方。"}],
        )

        prompt_text = "\n".join(message["content"] for message in captured["messages"])
        self.assertEqual(result["answer"], "### 回答\n\n使用 $a^2+b^2=c^2$ 说明。")
        self.assertNotIn("自动控制", prompt_text)
        self.assertIn("勾股定理", prompt_text)
        self.assertIn("Markdown", prompt_text)
        self.assertIn("$$...$$", prompt_text)
        self.assertGreaterEqual(captured["kwargs"]["max_tokens"], 1400)
        self.assertIn("标准 Markdown 表格", prompt_text)
        self.assertIn("| 列名 | 列名 |", prompt_text)
