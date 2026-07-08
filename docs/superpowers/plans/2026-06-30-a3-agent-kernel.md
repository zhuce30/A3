# A3 Agent Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real backend Agent Kernel for A3 so the recommendation workflow is executed by composable agents, not by ad-hoc trace labels inside views.

**Architecture:** Add a focused `backend/apps/compat/agent_kernel.py` module that defines executable agent contracts, context, results, registry, and orchestrator. The first migrated workflow is `recommend`: `LearningStateAgent -> RetrieverAgent -> RankerAgent -> VerifierAgent -> ResourcePackAgent`, with persisted `AgentRun/AgentStep` trace through the existing runtime.

**Tech Stack:** Django, Python dataclasses, existing `AgentRun` persistence, existing recommendation service, Django `TestCase`.

---

## File Structure

- Create: `backend/apps/compat/agent_kernel.py`
  - Owns `AgentContext`, `AgentResult`, `AgentKernel`, `BaseAgent`, registry, schema validation helpers, and workflow execution.
- Modify: `backend/apps/compat/recommendations.py`
  - Extract reusable recommendation sub-steps if current payload generation is too monolithic.
- Modify: `backend/apps/compat/views.py`
  - Replace manual recommend trace steps with `AgentKernel.run_workflow("recommend", ...)`.
- Modify: `backend/apps/compat/agent_workflows.py`
  - Align `recommend` contract required steps with the kernel workflow.
- Modify: `backend/apps/compat/tests.py`
  - Add TDD tests for kernel registration, workflow execution, fallback behavior, and recommend integration.

## Task 1: Agent Kernel Core Types And Registry

**Files:**
- Create: `backend/apps/compat/agent_kernel.py`
- Test: `backend/apps/compat/tests.py`

- [ ] **Step 1: Write the failing test**

Add this test method to `CompatApiTests` in `backend/apps/compat/tests.py`:

```python
def test_agent_kernel_registers_and_runs_named_agents_in_order(self):
    from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

    class FirstAgent(BaseAgent):
        name = "FirstAgent"

        def run(self, context):
            return AgentResult(
                output={"first": True},
                state_patch={"order": ["first"]},
                evidence={"source": "unit"},
                quality={"ok": True},
            )

    class SecondAgent(BaseAgent):
        name = "SecondAgent"

        def run(self, context):
            return AgentResult(
                output={"second": context.state["first"]},
                state_patch={"order": [*context.state["order"], "second"]},
            )

    kernel = AgentKernel()
    kernel.register(FirstAgent())
    kernel.register(SecondAgent())

    result = kernel.run(
        AgentContext(user=self.user, workflow="unit", goal="test kernel", payload={}),
        ["FirstAgent", "SecondAgent"],
    )

    self.assertTrue(result.success)
    self.assertEqual(result.state["order"], ["first", "second"])
    self.assertEqual([step["name"] for step in result.trace["steps"]], ["FirstAgent", "SecondAgent"])
    self.assertEqual(result.trace["workflow"], "unit")
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.CompatApiTests.test_agent_kernel_registers_and_runs_named_agents_in_order --keepdb
```

Expected: FAIL with `ModuleNotFoundError: No module named 'backend.apps.compat.agent_kernel'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/apps/compat/agent_kernel.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.apps.compat.agent_runtime import AgentRun


@dataclass
class AgentContext:
    user: Any
    workflow: str
    goal: str = ""
    payload: dict = field(default_factory=dict)
    state: dict = field(default_factory=dict)


@dataclass
class AgentResult:
    output: dict = field(default_factory=dict)
    state_patch: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    quality: dict = field(default_factory=dict)
    detail: str = ""


@dataclass
class KernelRunResult:
    success: bool
    state: dict
    trace: dict
    output: dict = field(default_factory=dict)


class BaseAgent:
    name = "BaseAgent"
    role = "agent"
    detail = "Run agent step."

    def run(self, context: AgentContext) -> AgentResult:
        raise NotImplementedError


class AgentKernel:
    def __init__(self):
        self._agents: dict[str, BaseAgent] = {}

    def register(self, agent: BaseAgent):
        if not agent.name:
            raise ValueError("agent.name is required")
        self._agents[agent.name] = agent

    def run(self, context: AgentContext, sequence: list[str]) -> KernelRunResult:
        run = AgentRun(context.user, context.workflow, context.goal)
        state = dict(context.state)
        output: dict = {}
        for name in sequence:
            agent = self._agents.get(name)
            if agent is None:
                raise ValueError(f"Unknown agent: {name}")
            step_context = AgentContext(
                user=context.user,
                workflow=context.workflow,
                goal=context.goal,
                payload=context.payload,
                state=state,
            )
            result = agent.run(step_context)
            state.update(result.output)
            state.update(result.state_patch)
            output.update(result.output)
            run.step(
                agent.name,
                agent.role,
                result.detail or agent.detail,
                output_summary=result.output,
                state_diff=result.state_patch,
                evidence=result.evidence,
                quality=result.quality,
            )
        run.complete()
        return KernelRunResult(success=True, state=state, output=output, trace=run.as_dict())
```

- [ ] **Step 4: Run test to verify it passes**

Run the same test command. Expected: PASS.

- [ ] **Step 5: Verify no syntax errors**

Run:

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe -m py_compile backend\apps\compat\agent_kernel.py
```

Expected: exit code 0.

## Task 2: Kernel Failure, Retry, And Fallback Semantics

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Test: `backend/apps/compat/tests.py`

- [ ] **Step 1: Write the failing test**

Add:

```python
def test_agent_kernel_uses_agent_fallback_and_marks_degraded_step(self):
    from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

    class FailingAgent(BaseAgent):
        name = "FailingAgent"
        role = "fallback test"
        detail = "Primary operation fails."

        def run(self, context):
            raise RuntimeError("primary unavailable")

        def fallback(self, context, error):
            return AgentResult(
                output={"fallbackUsed": True},
                state_patch={"degraded": True},
                evidence={"error": str(error)},
                quality={"fallback": "used"},
                detail="Fallback result used.",
            )

    kernel = AgentKernel()
    kernel.register(FailingAgent())

    result = kernel.run(
        AgentContext(user=self.user, workflow="fallback_unit", goal="test fallback", payload={}),
        ["FailingAgent"],
    )

    self.assertTrue(result.success)
    self.assertTrue(result.state["fallbackUsed"])
    self.assertEqual(result.trace["fallbackStrategy"], "fallback_result")
    self.assertEqual(result.trace["steps"][0]["status"], "degraded")
    self.assertEqual(result.trace["steps"][0]["metadata"]["evidence"]["error"], "primary unavailable")
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL because `BaseAgent.fallback` and degraded kernel execution do not exist.

- [ ] **Step 3: Implement fallback path**

Update `backend/apps/compat/agent_kernel.py`:

```python
class BaseAgent:
    name = "BaseAgent"
    role = "agent"
    detail = "Run agent step."

    def run(self, context: AgentContext) -> AgentResult:
        raise NotImplementedError

    def fallback(self, context: AgentContext, error: Exception) -> AgentResult | None:
        return None
```

Replace the per-agent execution body in `AgentKernel.run` with:

```python
            try:
                result = agent.run(step_context)
                status = "completed"
            except Exception as exc:
                fallback_result = agent.fallback(step_context, exc)
                if fallback_result is None:
                    run.fail(str(exc))
                    return KernelRunResult(success=False, state=state, output=output, trace=run.as_dict())
                run.fallback_strategy = "fallback_result"
                result = fallback_result
                status = "degraded"
            state.update(result.output)
            state.update(result.state_patch)
            output.update(result.output)
            run.step(
                agent.name,
                agent.role,
                result.detail or agent.detail,
                status=status,
                output_summary=result.output,
                state_diff=result.state_patch,
                evidence=result.evidence,
                quality=result.quality,
            )
```

- [ ] **Step 4: Run test to verify it passes**

Run the new fallback test. Expected: PASS.

## Task 3: Recommend Workflow Agents

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Modify: `backend/apps/compat/recommendations.py`
- Test: `backend/apps/compat/tests.py`

- [ ] **Step 1: Write failing integration test**

Add:

```python
def test_recommend_workflow_kernel_runs_learning_retrieval_rank_verify_pack_agents(self):
    from backend.apps.compat.agent_kernel import build_recommendation_kernel, run_recommendation_workflow

    kernel = build_recommendation_kernel()
    result = run_recommendation_workflow(
        self.user,
        payload={"goal": "root locus", "topK": 3, "mode": "fast"},
        kernel=kernel,
    )

    self.assertTrue(result.success)
    payload = result.output["recommendationPayload"]
    self.assertGreaterEqual(len(payload["recommendations"]), 1)
    self.assertIn("resourcePack", payload)
    step_names = [step["name"] for step in result.trace["steps"]]
    self.assertEqual(
        step_names,
        ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
    )
    verifier_step = next(step for step in result.trace["steps"] if step["name"] == "VerifierAgent")
    self.assertIn("quality", verifier_step["metadata"])
    self.assertIn("citationCoverage", verifier_step["metadata"]["quality"])
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL because `build_recommendation_kernel` and `run_recommendation_workflow` do not exist.

- [ ] **Step 3: Implement recommendation agents**

Add to `backend/apps/compat/agent_kernel.py`:

```python
from backend.apps.compat.recommendations import build_recommendation_payload


class LearningStateAgent(BaseAgent):
    name = "LearningStateAgent"
    role = "learning state"
    detail = "Read learner profile, goals, weak points, and current path signals."

    def run(self, context: AgentContext) -> AgentResult:
        return AgentResult(
            output={"learningStateReady": True},
            state_patch={"learningState": {"goal": context.payload.get("goal") or context.goal}},
            quality={"stateAvailable": True},
        )


class RetrieverAgent(BaseAgent):
    name = "RetrieverAgent"
    role = "knowledge retrieval"
    detail = "Prepare retrieval mode and evidence requirements for recommendation."

    def run(self, context: AgentContext) -> AgentResult:
        mode = "deep" if context.payload.get("mode") == "deep" else "fast"
        top_k = max(1, min(int(context.payload.get("topK") or 6), 12))
        return AgentResult(
            output={"retrievalConfig": {"mode": mode, "topK": top_k}},
            state_patch={"retrievalConfig": {"mode": mode, "topK": top_k}},
            evidence={"mode": mode, "topK": top_k},
            quality={"retrievalConfigured": True},
        )


class RankerAgent(BaseAgent):
    name = "RankerAgent"
    role = "personalized ranking"
    detail = "Build grounded recommendation payload with profile, path, and KB evidence."

    def run(self, context: AgentContext) -> AgentResult:
        config = context.state.get("retrievalConfig") or {}
        payload = build_recommendation_payload(
            context.user,
            goal=str(context.payload.get("goal") or ""),
            top_k=int(config.get("topK") or 6),
            retrieval_mode=str(config.get("mode") or "fast"),
        )
        return AgentResult(
            output={"recommendationPayload": payload},
            state_patch={"recommendationCount": len(payload.get("recommendations") or [])},
            evidence={"sourceCount": len(payload.get("sources") or [])},
            quality={"hasRecommendations": bool(payload.get("recommendations"))},
        )


class VerifierAgent(BaseAgent):
    name = "VerifierAgent"
    role = "recommendation verification"
    detail = "Check citation coverage and profile-match transparency."

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.state.get("recommendationPayload") or {}
        recommendations = payload.get("recommendations") or []
        sources = payload.get("sources") or []
        citation_coverage = round(min(1.0, len(sources) / max(1, len(recommendations))), 3)
        return AgentResult(
            output={"recommendationVerified": citation_coverage > 0},
            state_patch={"recommendationQuality": {"citationCoverage": citation_coverage}},
            evidence={"sourceCount": len(sources), "recommendationCount": len(recommendations)},
            quality={"citationCoverage": citation_coverage},
        )


class ResourcePackAgent(BaseAgent):
    name = "ResourcePackAgent"
    role = "resource pack synthesis"
    detail = "Validate executable resource pack and next learning action."

    def run(self, context: AgentContext) -> AgentResult:
        payload = context.state.get("recommendationPayload") or {}
        pack = payload.get("resourcePack") if isinstance(payload.get("resourcePack"), dict) else {}
        return AgentResult(
            output={"resourcePackReady": bool(pack.get("resources"))},
            state_patch={"resourcePackReady": bool(pack.get("resources"))},
            evidence={"resources": len(pack.get("resources") or [])},
            quality={"hasPracticeAction": bool((pack.get("practice") or {}).get("href"))},
        )


def build_recommendation_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (LearningStateAgent(), RetrieverAgent(), RankerAgent(), VerifierAgent(), ResourcePackAgent()):
        kernel.register(agent)
    return kernel


def run_recommendation_workflow(user, payload: dict, *, kernel: AgentKernel | None = None) -> KernelRunResult:
    kernel = kernel or build_recommendation_kernel()
    goal = str(payload.get("goal") or "基于画像推荐资源")
    return kernel.run(
        AgentContext(user=user, workflow="recommend", goal=goal, payload=payload),
        ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run the new recommendation kernel test. Expected: PASS.

## Task 4: Migrate `/api/recommend/` To Kernel

**Files:**
- Modify: `backend/apps/compat/views.py`
- Test: `backend/apps/compat/tests.py`

- [ ] **Step 1: Write failing API test**

Add:

```python
def test_recommend_alias_uses_kernel_trace_agents(self):
    response = self.client.post(
        "/api/recommend/",
        data=json.dumps({"goal": "root locus", "topK": 3}),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 200)
    payload = response.json()
    self.assertTrue(payload["success"])
    run = AgentRun.objects.get(trace_id=payload["traceId"])
    step_names = list(run.steps.order_by("order").values_list("name", flat=True))
    self.assertEqual(
        step_names,
        ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
    )
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL because `/api/recommend/` still writes manual `RetrievalAgent` and `RankerAgent` steps.

- [ ] **Step 3: Replace manual recommend trace with kernel**

In `backend/apps/compat/views.py`, import:

```python
from backend.apps.compat.agent_kernel import run_recommendation_workflow
```

Replace the body after `top_k` and `retrieval_mode` are parsed with:

```python
    kernel_result = run_recommendation_workflow(
        request.user,
        {"goal": goal, "topK": top_k, "mode": retrieval_mode},
    )
    recommendation_payload = kernel_result.output.get("recommendationPayload") or {}
    return JsonResponse({"success": kernel_result.success, "traceId": kernel_result.trace["traceId"], **recommendation_payload})
```

Remove the old manual `AgentRun` creation and manual `run.step(...)` blocks from `recommend`.

- [ ] **Step 4: Run API test to verify it passes**

Run the new API test. Expected: PASS.

- [ ] **Step 5: Run existing recommendation tests**

Run:

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.CompatApiTests.test_recommend_alias_returns_recommendations_and_sources backend.apps.compat.tests.CompatApiTests.test_recommend_alias_returns_executable_resource_pack backend.apps.compat.tests.CompatApiTests.test_demo_status_exposes_agent_workflow_readiness --keepdb
```

Expected: all PASS.

## Task 5: Contract Alignment And Verification

**Files:**
- Modify: `backend/apps/compat/agent_workflows.py`
- Test: `backend/apps/compat/tests.py`

- [ ] **Step 1: Write failing contract test**

Add:

```python
def test_recommend_workflow_contract_matches_kernel_agent_sequence(self):
    from backend.apps.compat.agent_kernel import RECOMMEND_WORKFLOW_SEQUENCE
    from backend.apps.compat.agent_workflows import get_agent_workflow_contract

    contract = get_agent_workflow_contract("recommend")

    self.assertEqual(tuple(RECOMMEND_WORKFLOW_SEQUENCE), contract.required_steps)
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL because current contract only requires `RetrievalAgent` and `RankerAgent`.

- [ ] **Step 3: Export sequence and update contract**

In `backend/apps/compat/agent_kernel.py`, add:

```python
RECOMMEND_WORKFLOW_SEQUENCE = [
    "LearningStateAgent",
    "RetrieverAgent",
    "RankerAgent",
    "VerifierAgent",
    "ResourcePackAgent",
]
```

Use that constant inside `run_recommendation_workflow`.

In `backend/apps/compat/agent_workflows.py`, update the `recommend` contract:

```python
required_steps=("LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"),
target_steps=("ReviewSchedulerAgent", "TeacherInterventionAgent"),
```

- [ ] **Step 4: Run contract test**

Expected: PASS.

## Task 6: Final Verification

**Files:**
- No code changes unless failures require fixes.

- [ ] **Step 1: Run focused backend tests**

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.CompatApiTests.test_agent_kernel_registers_and_runs_named_agents_in_order backend.apps.compat.tests.CompatApiTests.test_agent_kernel_uses_agent_fallback_and_marks_degraded_step backend.apps.compat.tests.CompatApiTests.test_recommend_workflow_kernel_runs_learning_retrieval_rank_verify_pack_agents backend.apps.compat.tests.CompatApiTests.test_recommend_alias_uses_kernel_trace_agents backend.apps.compat.tests.CompatApiTests.test_recommend_workflow_contract_matches_kernel_agent_sequence --keepdb
```

Expected: all PASS.

- [ ] **Step 2: Run existing A3 backend validation**

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py check
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py migrate --check
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: all PASS.

- [ ] **Step 3: Run frontend type check because API trace shape is consumed by capabilities page**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

Expected: exit code 0.

## Self-Review

- Spec coverage: This plan implements the first real Agent Kernel layer and migrates one high-value A3 workflow, `recommend`, to executable multi-agent orchestration.
- Scope control: QA, assessment, profile extraction, and teacher workflows are intentionally not migrated in this batch. They should be separate follow-up plans after the kernel proves stable.
- Placeholder scan: No TBD/TODO placeholders remain.
- Type consistency: `AgentContext`, `AgentResult`, `KernelRunResult`, `AgentKernel`, and `RECOMMEND_WORKFLOW_SEQUENCE` are consistently named across tasks.

