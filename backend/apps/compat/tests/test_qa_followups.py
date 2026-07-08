from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, FollowUpAgent


class QaFollowUpAgentTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007771", password="TestPassword123")

    def test_qa_workflow_returns_followups(self):
        kernel = AgentKernel(circuit_breaker=lambda _context, _agent: {"open": False, "reason": "test"})
        kernel.register(FollowUpAgent())

        result = kernel.run(
            AgentContext(
                user=self.user,
                workflow="qa_interact",
                goal="follow-up test",
                payload={"question": "根轨迹是什么？"},
                state={
                    "draftAnswer": "根轨迹用于观察闭环极点随开环增益变化的轨迹。",
                    "verification": {"verified": True, "safety": {"safe": True}},
                    "sources": [{"title": "自动控制原理"}],
                    "classroomContext": {"target": {"title": "根轨迹"}},
                },
            ),
            ["FollowUpAgent"],
        )

        follow_ups = result.output.get("followUps")
        self.assertIsInstance(follow_ups, list)
        self.assertGreaterEqual(len(follow_ups), 2)
        for item in follow_ups:
            self.assertIn("label", item)
            self.assertIn("question", item)
            self.assertIn("type", item)
            self.assertTrue(str(item["question"]).strip().endswith(("？", "?")))

    def test_followups_are_conservative_when_answer_is_unverified(self):
        kernel = AgentKernel(circuit_breaker=lambda _context, _agent: {"open": False, "reason": "test"})
        kernel.register(FollowUpAgent())

        result = kernel.run(
            AgentContext(
                user=self.user,
                workflow="qa_interact",
                goal="follow-up unverified test",
                payload={"question": "请直接告诉我教材第 999 页的结论。"},
                state={
                    "draftAnswer": "证据不足，不能确认教材第 999 页内容。",
                    "verification": {"verified": False, "safety": {"safe": True}, "refusalReason": "missing_evidence"},
                    "sources": [],
                    "classroomContext": {"target": {"title": "根轨迹"}},
                },
            ),
            ["FollowUpAgent"],
        )

        follow_ups = result.output.get("followUps") or []
        joined = " ".join(item.get("question", "") for item in follow_ups)
        self.assertNotIn("第999页", joined)
        self.assertTrue(
            any("资料" in item.get("question", "") or "证据" in item.get("question", "") for item in follow_ups)
        )
