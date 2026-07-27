from __future__ import annotations

from unittest.mock import patch

from backend.apps.learning.models import TutorPersonaConfiguration
from backend.apps.learning.tutor_persona_operations import invalidate_tutor_persona_overlay_cache

from .common import CompatApiTestCase


class TutorPersonaQATests(CompatApiTestCase):
    def _classroom_context(self):
        return {
            "target": {"title": "进程调度"},
            "sources": [
                {
                    "id": "source-1",
                    "title": "操作系统讲义",
                    "location": "进程管理章节",
                    "type": "课程资料",
                    "score": 0.94,
                    "snippet": "进程调度根据调度策略从就绪队列中选择进程运行。",
                }
            ],
        }

    @patch("backend.apps.compat.llm.chat_completion")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_persona_changes_controlled_strategy_without_removing_verification(
        self,
        classroom_context,
        chat_completion,
    ):
        classroom_context.return_value = self._classroom_context()
        system_prompts = []

        def fake_chat(messages, **_kwargs):
            system_prompts.append(messages[0]["content"])
            return {
                "content": "进程调度会从就绪队列中选择进程运行。[1]",
                "provider": "dashscope",
                "model": "qwen-plus",
                "fallback": False,
                "finishReason": "stop",
            }

        chat_completion.side_effect = fake_chat

        responses = [
            self.client.get(
                "/api/v1/qa/interact/",
                {"q": "什么是进程调度？", "persona_id": persona_id},
            )
            for persona_id in ("structured-teacher", "socratic-guide")
        ]

        for response in responses:
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["success"])
            for field in ("verified", "citations", "claims", "safety", "resolvedPersona"):
                self.assertIn(field, payload)
            self.assertNotIn("instruction", payload["resolvedPersona"])
            self.assertNotIn("voice", payload["resolvedPersona"])

        self.assertEqual(responses[0].json()["resolvedPersona"]["id"], "structured-teacher")
        self.assertEqual(responses[1].json()["resolvedPersona"]["id"], "socratic-guide")
        self.assertIn("先确认学习目标，再按框架分步讲解", system_prompts[0])
        self.assertIn("一次只提出一个关键问题", system_prompts[1])
        self.assertNotEqual(system_prompts[0], system_prompts[1])

    @patch("backend.apps.compat.llm.chat_completion")
    def test_unknown_persona_is_rejected_before_model_call(self, chat_completion):
        response = self.client.get(
            "/api/v1/qa/interact/",
            {"q": "什么是进程调度？", "persona_id": "invented-tutor"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"success": False, "error": "不支持该辅导风格"})
        chat_completion.assert_not_called()

    @patch("backend.apps.compat.llm.chat_completion")
    def test_all_disabled_personas_return_controlled_unavailable_response(self, chat_completion):
        self.addCleanup(invalidate_tutor_persona_overlay_cache)
        TutorPersonaConfiguration.objects.update(enabled=False)
        invalidate_tutor_persona_overlay_cache()

        response = self.client.get(
            "/api/v1/qa/interact/",
            {"q": "什么是进程调度？", "persona_id": "structured-teacher"},
        )

        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(
            response.json(),
            {"success": False, "error": "当前没有可用的辅导风格"},
        )
        chat_completion.assert_not_called()
