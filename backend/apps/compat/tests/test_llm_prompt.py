import os
from django.test import SimpleTestCase
from unittest.mock import patch

from backend.apps.compat.llm import chat_completion, generate_tutoring_answer


class TutoringLLMPromptTests(SimpleTestCase):
    @patch("backend.apps.compat.llm.requests.post")
    def test_chat_completion_accepts_coaching_model_environment_aliases(self, post):
        post.return_value.raise_for_status.return_value = None
        post.return_value.json.return_value = {
            "choices": [{"message": {"content": "模型回答"}, "finish_reason": "stop"}],
        }

        with patch.dict(
            os.environ,
            {
                "A3_LLM_API_KEY": "",
                "A3_LLM_BASE_URL": "",
                "A3_LLM_MODEL": "",
                "DASHSCOPE_API_KEY": "",
                "DASHSCOPE_BASE_URL": "",
                "OPENAI_API_KEY": "",
                "AI_MODEL": "",
                "A3_COACHING_API_KEY": "coaching-key",
                "A3_COACHING_BASE_URL": "https://coaching.example/v1",
                "A3_COACHING_MODEL": "qwen-coach",
            },
            clear=False,
        ):
            result = chat_completion([{"role": "user", "content": "你好"}])

        self.assertEqual(result["content"], "模型回答")
        request = post.call_args
        self.assertEqual(request.args[0], "https://coaching.example/v1/chat/completions")
        self.assertEqual(request.kwargs["headers"]["Authorization"], "Bearer coaching-key")
        self.assertEqual(request.kwargs["json"]["model"], "qwen-coach")

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
