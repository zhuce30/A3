import json
from unittest.mock import patch

from django.test import SimpleTestCase

from backend.apps.assessments.personal_question_llm import generate_grounded_personal_candidates


class GroundedPersonalQuestionLlmTests(SimpleTestCase):
    def setUp(self):
        self.profile_signals = {
            "foundationLevel": "基础较弱",
            "weakPoints": ["处理机调度算法"],
            "recentErrorCauses": ["混淆响应时间和周转时间"],
        }
        self.evidence = [
            {"blockId": "block-1", "resourceTitle": "调度讲义.pdf", "quote": "时间片轮转强调交互响应。"},
            {"blockId": "block-2", "resourceTitle": "调度实验.pdf", "quote": "时间片过大会退化为先来先服务。"},
        ]

    @patch.dict("os.environ", {"A3_LLM_API_KEY": "test-key"})
    @patch("backend.apps.assessments.personal_question_llm.chat_completion")
    def test_accepts_only_structured_candidates_bound_to_allowed_evidence(self, chat):
        chat.return_value = {
            "content": json.dumps({
                "questions": [{
                    "variantIndex": 7,
                    "questionKind": "scenario",
                    "stem": "某交互系统将时间片从 20ms 调整为 200ms，最可能出现什么变化？",
                    "options": [
                        {"key": "A", "text": "响应通常变慢，并更接近先来先服务"},
                        {"key": "B", "text": "响应一定更快"},
                        {"key": "C", "text": "吞吐量必然归零"},
                        {"key": "D", "text": "不会产生任何影响"},
                    ],
                    "correctAnswer": "A",
                    "explanation": "证据 block-2 指出时间片过大会退化为先来先服务。",
                    "errorCause": "忽略时间片大小对响应性的影响",
                    "evidenceBlockIds": ["block-2"],
                    "reasoningForm": "parameter_change",
                }]
            }, ensure_ascii=False),
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        result = generate_grounded_personal_candidates(
            point_title="处理机调度算法",
            variant_indexes=[7],
            profile_signals=self.profile_signals,
            evidence_rows=self.evidence,
        )

        self.assertEqual(len(result.candidates), 1)
        self.assertEqual(result.candidates[0]["evidenceBlockIds"], ["block-2"])
        self.assertEqual(result.candidates[0]["variantIndex"], 7)
        self.assertEqual(result.provider, "dashscope")
        prompt = json.loads(chat.call_args.args[0][1]["content"])
        self.assertEqual(prompt["allowedEvidence"][1]["blockId"], "block-2")
        self.assertIn("recentErrorCauses", prompt["profileSignals"])
        option_schema = prompt["outputSchema"]["questions"][0]["options"]
        self.assertEqual(option_schema[0], {"key": "A", "text": "选项文本"})

    @patch.dict("os.environ", {"A3_LLM_API_KEY": "test-key"})
    @patch("backend.apps.assessments.personal_question_llm.chat_completion")
    def test_rejects_candidates_with_unlisted_evidence_or_invalid_variant(self, chat):
        base = {
            "questionKind": "application",
            "stem": "根据证据判断调度策略。",
            "options": [
                {"key": "A", "text": "A"}, {"key": "B", "text": "B"},
                {"key": "C", "text": "C"}, {"key": "D", "text": "D"},
            ],
            "correctAnswer": "A",
            "explanation": "依据证据判断。",
            "errorCause": "未读取证据",
            "reasoningForm": "evidence_application",
        }
        chat.return_value = {
            "content": json.dumps({"questions": [
                {**base, "variantIndex": 8, "evidenceBlockIds": ["outside-block"]},
                {**base, "variantIndex": 999, "evidenceBlockIds": ["block-1"]},
            ]}),
            "provider": "dashscope",
            "model": "qwen-plus",
        }

        result = generate_grounded_personal_candidates(
            point_title="处理机调度算法",
            variant_indexes=[8],
            profile_signals=self.profile_signals,
            evidence_rows=self.evidence,
        )

        self.assertEqual(result.candidates, [])
        self.assertEqual(result.rejected_count, 2)

    @patch.dict("os.environ", {"A3_LLM_API_KEY": "", "DASHSCOPE_API_KEY": "", "OPENAI_API_KEY": ""})
    def test_missing_key_returns_rule_fallback_without_calling_provider(self):
        result = generate_grounded_personal_candidates(
            point_title="处理机调度算法",
            variant_indexes=[1, 2],
            profile_signals=self.profile_signals,
            evidence_rows=self.evidence,
        )

        self.assertEqual(result.candidates, [])
        self.assertTrue(result.fallback)
        self.assertEqual(result.error, "llm_not_configured")
