from __future__ import annotations

from .common import *
from backend.apps.compat.agent_runtime import AgentRun as RuntimeAgentRun
from backend.apps.compat.models import AgentRun


class AgentTraceSpanTests(CompatApiTestCase):
    def test_agent_run_persists_nested_span(self):
        run = RuntimeAgentRun(self.user, "qa_interact", "trace span smoke")
        run.step("RetrieverAgent", "retrieval", "Retrieve sources")
        run.span(
            name="rag.search",
            kind="tool",
            parent_step="RetrieverAgent",
            status="completed",
            metadata={
                "provider": "a3_hybrid_retriever",
                "model": "",
                "latencyMs": 12,
                "tokenUsage": {},
                "fallbackReason": "",
                "promptHash": "",
            },
        )
        run.complete()

        persisted = AgentRun.objects.prefetch_related("spans").get(trace_id=run.trace_id)
        self.assertEqual(persisted.spans.first().name, "rag.search")
        self.assertEqual(run.as_dict()["spans"][0]["parentStep"], "RetrieverAgent")
