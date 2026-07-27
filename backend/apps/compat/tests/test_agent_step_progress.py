"""验证 kernel on_step 回调：顺序、状态配对、异常隔离与任务持久化。"""
import importlib
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase

from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent
from backend.apps.compat.models import ResourceGenerationJob
from backend.apps.compat.views import serialize_resource_generation_job


class _A(BaseAgent):
    name = "AgentA"
    role = "role a"
    detail = "d"

    def run(self, context):
        return AgentResult(output={"a": 1}, output_summary={"sourceCount": 3, "big": list(range(50))})


class _B(BaseAgent):
    name = "AgentB"
    role = "role b"
    detail = "d"

    def run(self, context):
        return AgentResult(output={"b": 2}, output_summary={"resourceCount": 7})


class _Failing(BaseAgent):
    name = "FailingAgent"
    role = "failure test"
    detail = "d"

    def run(self, context):
        raise RuntimeError("agent failed")


class OnStepTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(phone="13900004321", password="test-password")

    def _kernel(self):
        k = AgentKernel()
        k.register(_A())
        k.register(_B())
        k.register(_Failing())
        return k

    def test_emits_started_and_completed_in_order(self):
        events = []
        ctx = AgentContext(user=self.user, workflow="wf_test", goal="g", payload={})
        res = self._kernel().run(ctx, ["AgentA", "AgentB"], on_step=events.append)
        self.assertTrue(res.success)
        seq = [(e["phase"], e["order"], e["name"]) for e in events]
        self.assertEqual(seq, [
            ("started", 1, "AgentA"), ("completed", 1, "AgentA"),
            ("started", 2, "AgentB"), ("completed", 2, "AgentB"),
        ])
        self.assertTrue(all(e["total"] == 2 for e in events))
        self.assertEqual(events[0]["status"], "running")
        self.assertEqual(events[1]["status"], "completed")
        # 每个事件都带完整流水线计划，前端才能一开始就列出全部步骤名
        for event in events:
            self.assertEqual(event["sequence"], ["AgentA", "AgentB"])

    def test_summary_is_compacted(self):
        events = []
        ctx = AgentContext(user=self.user, workflow="wf_test", goal="g", payload={})
        self._kernel().run(ctx, ["AgentA"], on_step=events.append)
        summary = events[1]["outputSummary"]
        self.assertEqual(summary["sourceCount"], 3)
        # 列表被压成长度，不会把整个输出塞进 job 状态
        self.assertEqual(summary["big"], 50)

    def test_callback_exception_does_not_break_workflow(self):
        def boom(event):
            raise RuntimeError("callback exploded")
        ctx = AgentContext(user=self.user, workflow="wf_test", goal="g", payload={})
        res = self._kernel().run(ctx, ["AgentA", "AgentB"], on_step=boom)
        self.assertTrue(res.success)
        self.assertEqual(res.output.get("b"), 2)

    def test_fatal_agent_failure_emits_terminal_failed_event(self):
        events = []
        ctx = AgentContext(user=self.user, workflow="wf_test", goal="g", payload={})

        result = self._kernel().run(ctx, ["FailingAgent"], on_step=events.append)

        self.assertFalse(result.success)
        self.assertEqual([event["phase"] for event in events], ["started", "completed"])
        self.assertEqual(events[-1]["status"], "failed")
        self.assertEqual(events[-1]["outputSummary"]["error"], "agent failed")

    def test_no_callback_still_works(self):
        ctx = AgentContext(user=self.user, workflow="wf_test", goal="g", payload={})
        res = self._kernel().run(ctx, ["AgentA"])
        self.assertTrue(res.success)

class AgentProgressPersistenceTests(TransactionTestCase):
    """验证 on_step -> job.metadata.agentProgress -> serializer 这条链。"""

    def setUp(self):
        self.user = get_user_model().objects.create_user(phone="13900005555", password="test-password")

    @patch("backend.apps.compat.resource_generation.generate_resource_pack_v2")
    def test_agent_progress_lands_in_metadata_and_payload(self, generate):
        def fake_generate(user, *, goal, top_k, resource_type, on_step=None):
            seq = ["RetrieverAgent", "VerifierAgent"]
            on_step({"phase": "started", "order": 1, "total": 2, "name": "RetrieverAgent",
                     "role": "knowledge retrieval", "status": "running", "traceId": "t1", "sequence": seq})
            on_step({"phase": "completed", "order": 1, "total": 2, "name": "RetrieverAgent",
                     "role": "knowledge retrieval", "status": "completed", "traceId": "t1",
                     "outputSummary": {"sourceCount": 6}, "sequence": seq})
            on_step({"phase": "started", "order": 2, "total": 2, "name": "VerifierAgent",
                     "role": "verification", "status": "running", "traceId": "t1", "sequence": seq})
            on_step({"phase": "completed", "order": 2, "total": 2, "name": "VerifierAgent",
                     "role": "verification", "status": "completed", "traceId": "t1",
                     "outputSummary": {"citationCount": 4}, "sequence": seq})
            return {"success": True, "traceId": "t1",
                    "resourcePack": {"resourcePackId": "p1", "traceId": "t1", "resources": [{"type": "mind_map"}]}}
        generate.side_effect = fake_generate

        job = ResourceGenerationJob.objects.create(
            job_id="job-agent-progress-001", user=self.user,
            goal="生成思维导图", top_k=3, resource_type="mind_map",
        )
        importlib.import_module("backend.apps.compat.tasks").run_resource_generation_job.run(job.job_id)

        job.refresh_from_db()
        entries = job.metadata.get("agentProgress")
        self.assertIsInstance(entries, list)
        self.assertEqual([e["order"] for e in entries], [1, 2])
        self.assertEqual([e["label"] for e in entries], ["知识检索", "引用与安全校验"])
        self.assertEqual([e["status"] for e in entries], ["completed", "completed"])
        self.assertEqual(entries[0]["outputSummary"]["sourceCount"], 6)
        # 每个 Agent 只保留最新一条（started 被 completed 覆盖，不是追加）
        self.assertEqual(len(entries), 2)

        plan = job.metadata.get("agentPlan")
        self.assertEqual([e["order"] for e in plan], [1, 2])
        self.assertEqual([e["label"] for e in plan], ["知识检索", "引用与安全校验"])

        payload = serialize_resource_generation_job(job)
        self.assertEqual(len(payload["agentPlan"]), 2)
        self.assertEqual(payload["agentPlan"][1]["label"], "引用与安全校验")
        self.assertEqual(len(payload["agentProgress"]), 2)
        self.assertEqual(payload["agentProgress"][1]["label"], "引用与安全校验")
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.progress, 100)
