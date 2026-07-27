from __future__ import annotations

import json
from unittest.mock import patch

from backend.apps.compat.intent_router import classify_intent
from backend.apps.compat.tests.common import CompatApiTestCase


class IntentRouterRuleTests(CompatApiTestCase):
    """规则层分类（不依赖 LLM，allow_llm=False）。"""

    def test_generate_resource_detects_type(self):
        cases = {
            "生成一个讲解视频": "micro_video_script",
            "给我做份讲义": "lecture_doc",
            "整理一份速记卡": "knowledge_card",
            "画个思维导图": "mind_map",
            "帮我做一个代码实验": "code_lab",
        }
        for text, expected_type in cases.items():
            result = classify_intent(text, context={"goal": "死锁"}, allow_llm=False)
            self.assertEqual(result["intent"], "generate_resource", text)
            self.assertEqual(result["params"].get("resourceType"), expected_type, text)
            # goal 应从 context 带入
            self.assertEqual(result["params"].get("goal"), "死锁", text)

    def test_start_practice_intent(self):
        result = classify_intent("出几道练习题", context={"goal": "进程调度"}, allow_llm=False)
        self.assertEqual(result["intent"], "start_practice")
        self.assertEqual(result["params"].get("topic"), "进程调度")

    def test_explain_concept_intent(self):
        result = classify_intent("什么是银行家算法", context={}, allow_llm=False)
        self.assertEqual(result["intent"], "explain_concept")

    def test_navigate_intent_maps_route(self):
        result = classify_intent("打开我的学习报告", context={}, allow_llm=False)
        self.assertEqual(result["intent"], "navigate")
        self.assertEqual(result["params"].get("route"), "/a3/report")

    def test_review_wrong_intent(self):
        result = classify_intent("复习我的错题", context={}, allow_llm=False)
        self.assertEqual(result["intent"], "review_wrong")

    def test_plain_question_falls_back_to_ask(self):
        # 无生成动词、无其他意图信号 → 兜底问答
        result = classify_intent("你好", context={}, allow_llm=False)
        self.assertEqual(result["intent"], "ask_question")

    def test_resource_name_without_generate_verb_is_not_generate(self):
        # 只提到"视频"但没有生成动词，不应误判为生成
        result = classify_intent("这个视频讲得怎么样", context={}, allow_llm=False)
        self.assertNotEqual(result["intent"], "generate_resource")

    @patch("backend.apps.compat.llm.chat_completion")
    def test_low_confidence_llm_result_falls_back_to_question(self, mocked_completion):
        mocked_completion.return_value = {
            "content": json.dumps({
                "intent": "generate_resource",
                "confidence": 0.2,
                "params": {"resourceType": "lecture_doc"},
            })
        }

        result = classify_intent("帮我看看这个", context={"goal": "死锁"})

        self.assertEqual(result["intent"], "ask_question")
        self.assertEqual(result["source"], "fallback")

    def test_empty_text_falls_back(self):
        result = classify_intent("", context={}, allow_llm=False)
        self.assertEqual(result["intent"], "ask_question")


class IntentClassifyApiTests(CompatApiTestCase):
    def test_endpoint_classifies_generate_resource(self):
        response = self.client.post(
            "/api/intent/classify/",
            data=json.dumps({"text": "生成一个讲解视频", "context": {"goal": "死锁"}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["intent"], "generate_resource")
        self.assertEqual(payload["params"]["resourceType"], "micro_video_script")

    def test_endpoint_rejects_empty_text(self):
        response = self.client.post(
            "/api/intent/classify/",
            data=json.dumps({"text": ""}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_endpoint_rejects_oversized_text(self):
        response = self.client.post(
            "/api/intent/classify/",
            data=json.dumps({"text": "问" * 2001}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "text 不能超过 2000 个字符")

    def test_endpoint_requires_auth(self):
        client = self.client_class()
        response = client.post(
            "/api/intent/classify/",
            data=json.dumps({"text": "生成讲义"}),
            content_type="application/json",
        )
        self.assertIn(response.status_code, (401, 403))
