# AgentSpec ToolRegistry Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an auditable A3 agent runtime where every agent has a declared spec, every core backend capability is called through a ToolRegistry, and provider/tool calls are captured as nested trace spans.

**Architecture:** Keep the current `AgentKernel` sequential workflow model. Add a typed `AgentSpec` registry beside the kernel, add a `ToolRegistry` wrapper around existing service calls, and extend `AgentRun` with nested `AgentSpan` records for LLM/RAG/VLM/OCR/visual embedding/realtime provider events. Do not rewrite existing learning workflows; migrate tool calls incrementally behind compatibility wrappers.

**Tech Stack:** Django, Django ORM, existing A3 `AgentRun/AgentStep`, Next.js API routes, DashScope/OpenAI-compatible providers, existing RAG/multimodal parser modules.

---

## File Structure

- Create `backend/apps/compat/agent_specs.py`: agent declarations, input/output schema references, prompt version, allowed tools, timeout/retry/fallback policy.
- Create `backend/apps/compat/tool_registry.py`: `ToolSpec`, registry, `execute_tool()`, error normalization, trace span integration.
- Create `backend/apps/compat/prompt_registry.py`: prompt IDs, versions, hashes, raw prompt redaction helpers.
- Create `backend/apps/compat/trace_spans.py`: span normalization helpers used by backend tools and provider wrappers.
- Modify `backend/apps/compat/models.py`: add `AgentSpan`.
- Add migration `backend/apps/compat/migrations/00xx_agent_span.py`.
- Modify `backend/apps/compat/agent_runtime.py`: persist, serialize, and export nested spans.
- Modify `backend/apps/compat/agent_kernel.py`: load `AgentSpec`, enforce allowed tools, record agent spec metadata, migrate direct RAG/Verifier/question-generation calls.
- Modify `backend/apps/compat/llm.py`: emit LLM spans with provider/model/latency/tokens/fallback/promptHash.
- Modify `backend/domains/knowledge_base/retriever.py`: expose RAG as registered tool while keeping public function compatibility.
- Modify `backend/domains/knowledge_base/visual_retriever.py`: record visual embedding spans.
- Modify `backend/domains/knowledge_base/multimodal_parser.py`: record OCR/VLM spans.
- Modify `backend/apps/assessments/generation.py`: route question generation through registered tool and prompt registry.
- Modify `backend/apps/compat/views.py`: expose agent architecture maturity and span summaries in `/api/demo/status/` and trace detail/export.
- Modify `OpenMAIC/lib/server/a3-realtime-provider.ts` and `OpenMAIC/scripts/a3-dashscope-realtime-proxy.mjs`: attach realtime provider span metadata without exposing keys.
- Add tests:
  - `backend/apps/compat/tests/test_agent_specs.py`
  - `backend/apps/compat/tests/test_tool_registry.py`
  - `backend/apps/compat/tests/test_trace_spans.py`
  - Extend `backend/apps/compat/tests/test_agent_runtime.py`
  - Extend `backend/apps/compat/tests/test_demo_status.py`
  - Extend `backend/apps/compat/tests/test_verification_safety.py`
  - Extend `backend/apps/assessments/tests/test_question_generation.py`
  - Extend existing OpenMAIC realtime contract tests

---

### Task 1: Add AgentSpan Data Model And Trace Serialization

**Files:**
- Modify: `backend/apps/compat/models.py`
- Modify: `backend/apps/compat/agent_runtime.py`
- Create: `backend/apps/compat/trace_spans.py`
- Create: `backend/apps/compat/tests/test_trace_spans.py`
- Create: `backend/apps/compat/migrations/00xx_agent_span.py`

- [ ] **Step 1: Write failing model/runtime tests**

```python
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
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_trace_spans
```

Expected: FAIL because `AgentSpan` and `AgentRun.span()` do not exist.

- [ ] **Step 3: Implement `AgentSpan`**

Add model:

```python
class AgentSpan(models.Model):
    run = models.ForeignKey(AgentRun, on_delete=models.CASCADE, related_name="spans")
    parent_step = models.CharField(max_length=80, blank=True)
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=40)
    status = models.CharField(max_length=32, default="completed")
    latency_ms = models.PositiveIntegerField(default=1)
    started_at = models.DateTimeField()
    completed_at = models.DateTimeField(null=True, blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_agent_spans"
        ordering = ["started_at", "id"]
        indexes = [
            models.Index(fields=["run", "parent_step"], name="a3_agent_span_run_parent_idx"),
            models.Index(fields=["kind", "status"], name="a3_agent_span_kind_status_idx"),
        ]
```

- [ ] **Step 4: Implement runtime span APIs**

Add a dataclass `AgentSpan` in `agent_runtime.py`, add `AgentRun.span(...)`, include `spans` in `as_dict()`, and persist related rows in `_persist_models()`.

- [ ] **Step 5: Run migration and tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations compat
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_trace_spans
```

Expected: PASS.

---

### Task 2: Add AgentSpec Registry

**Files:**
- Create: `backend/apps/compat/agent_specs.py`
- Modify: `backend/apps/compat/agent_kernel.py`
- Create: `backend/apps/compat/tests/test_agent_specs.py`

- [ ] **Step 1: Write failing spec coverage test**

```python
def test_every_kernel_agent_has_spec(self):
    from backend.apps.compat.agent_kernel import build_qa_kernel, QA_WORKFLOW_SEQUENCE
    from backend.apps.compat.agent_specs import get_agent_spec

    kernel = build_qa_kernel()
    for name in QA_WORKFLOW_SEQUENCE:
        spec = get_agent_spec(name)
        self.assertEqual(spec.name, name)
        self.assertTrue(spec.role)
        self.assertIsInstance(spec.allowed_tools, tuple)
        self.assertGreaterEqual(spec.timeout_ms, 0)
```

- [ ] **Step 2: Run the failing test**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_agent_specs
```

Expected: FAIL because `agent_specs.py` does not exist.

- [ ] **Step 3: Implement `AgentSpec`**

```python
@dataclass(frozen=True)
class AgentSpec:
    name: str
    role: str
    prompt_version: str
    input_schema: str
    output_schema: str
    allowed_tools: tuple[str, ...]
    timeout_ms: int | None
    max_retries: int
    fallback: str
    context_scope: str = "workflow_shared_state"
```

Seed specs for all current agents in `agent_kernel.py`, including `SafetyAgent`, `RetrieverAgent`, `TeacherAgent`, `VerifierAgent`, `FollowUpAgent`, `QuestionGeneratorAgent`, `QuestionVerifierAgent`, `PlannerAgent`, `StudyPlanAgent`, and bridge agents.

- [ ] **Step 4: Attach spec metadata to every AgentStep**

In `AgentKernel.run()`, merge into step metadata:

```python
metadata["agentSpec"] = {
    "role": spec.role,
    "promptVersion": spec.prompt_version,
    "inputSchema": spec.input_schema,
    "outputSchema": spec.output_schema,
    "allowedTools": list(spec.allowed_tools),
    "contextScope": spec.context_scope,
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_agent_specs
```

Expected: PASS.

---

### Task 3: Add ToolRegistry Core

**Files:**
- Create: `backend/apps/compat/tool_registry.py`
- Modify: `backend/apps/compat/agent_runtime.py`
- Create: `backend/apps/compat/tests/test_tool_registry.py`

- [ ] **Step 1: Write failing ToolRegistry tests**

```python
def test_tool_registry_records_success_span(self):
    registry = ToolRegistry()
    registry.register(ToolSpec(name="rag.search", owner="RetrieverAgent", timeout_ms=3000, side_effects=False), lambda **kw: {"items": []})
    run = RuntimeAgentRun(self.user, "qa_interact", "tool trace")
    result = registry.execute("rag.search", run=run, parent_step="RetrieverAgent", query="根轨迹")
    self.assertEqual(result, {"items": []})
    self.assertEqual(run.as_dict()["spans"][0]["name"], "rag.search")
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_tool_registry
```

Expected: FAIL because registry does not exist.

- [ ] **Step 3: Implement registry**

```python
@dataclass(frozen=True)
class ToolSpec:
    name: str
    owner: str
    timeout_ms: int | None
    side_effects: bool
    input_schema: str = "a3.tool-input.v1"
    output_schema: str = "a3.tool-output.v1"
    provider: str = "local"
```

`execute()` must record span metadata: `provider`, `model`, `latencyMs`, `tokenUsage`, `fallbackReason`, `promptHash`, `inputSummary`, `outputSummary`, `errorType`.

- [ ] **Step 4: Add allowed-tool enforcement helper**

Add `assert_agent_can_use_tool(agent_name, tool_name)` using `AgentSpec.allowed_tools`. The first migration can warn through metadata; later migrations can raise.

- [ ] **Step 5: Verify**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_tool_registry
```

Expected: PASS.

---

### Task 4: Migrate RAG And Verifier To ToolRegistry

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Modify: `backend/domains/knowledge_base/retriever.py`
- Modify: `backend/apps/compat/verification.py`
- Extend: `backend/apps/compat/tests/test_verification_safety.py`

- [ ] **Step 1: Write failing QA trace test**

```python
def test_qa_trace_contains_rag_and_verifier_tool_spans(self):
    result = run_qa_workflow(self.user, {"question": "根轨迹是什么？"})
    self.assertTrue(result.success)
    span_names = [span["name"] for span in result.trace["spans"]]
    self.assertIn("rag.search", span_names)
    self.assertIn("verifier.verify_answer", span_names)
```

- [ ] **Step 2: Register tools**

Register:

```python
ToolSpec(name="rag.search", owner="RetrieverAgent", provider="a3_hybrid_retriever", timeout_ms=5000, side_effects=False)
ToolSpec(name="verifier.verify_answer", owner="VerifierAgent", provider="a3_verifier", timeout_ms=3000, side_effects=False)
```

- [ ] **Step 3: Replace direct calls**

In `RetrieverAgent.run()`, replace direct `search_knowledge_base(...)` with `tool_registry.execute("rag.search", ...)`.

In `VerifierAgent.run()`, replace direct `verify_answer(...)` with `tool_registry.execute("verifier.verify_answer", ...)`.

- [ ] **Step 4: Verify no behavior regression**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_verification_safety
```

Expected: PASS and trace includes both spans.

---

### Task 5: Centralize Prompts And Instrument LLM Calls

**Files:**
- Create: `backend/apps/compat/prompt_registry.py`
- Modify: `backend/apps/compat/llm.py`
- Modify: `backend/apps/profiles/extractor.py`
- Modify: `backend/apps/assessments/generation.py`
- Extend: `backend/apps/compat/tests/test_llm_prompt.py`

- [ ] **Step 1: Write failing prompt hash test**

```python
def test_tutoring_llm_span_records_prompt_version_and_hash(self):
    result = generate_tutoring_answer("解释根轨迹", target={"title": "根轨迹"}, sources=[])
    self.assertIn("promptVersion", result)
    self.assertIn("promptHash", result)
    self.assertNotIn("rawPrompt", result)
```

- [ ] **Step 2: Add prompt specs**

Create prompt IDs:

```python
PROMPTS = {
    "teacher.tutoring_answer": PromptSpec(version="teacher.tutoring_answer.v2", ...),
    "planner.adjustment": PromptSpec(version="planner.adjustment.v1", ...),
    "profile.extract": PromptSpec(version="profile.extract.v1", ...),
    "question.generate": PromptSpec(version="question.generate.v1", ...),
}
```

- [ ] **Step 3: Record LLM spans**

Update `chat_completion()` to accept optional `trace_context` and `prompt_meta`. Span metadata must include provider, model, latency, approximate token usage if provider returns it, fallback reason, and prompt hash.

- [ ] **Step 4: Preserve prompt privacy**

Trace export must include `promptId`, `promptVersion`, and `promptHash`; it must not expose raw system/user prompt content or API keys.

- [ ] **Step 5: Verify**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_llm_prompt
```

Expected: PASS.

---

### Task 6: Migrate Question Generation To ToolRegistry

**Files:**
- Modify: `backend/apps/assessments/generation.py`
- Modify: `backend/apps/compat/agent_kernel.py`
- Extend: `backend/apps/assessments/tests/test_question_generation.py`

- [ ] **Step 1: Write failing trace test**

```python
def test_question_generation_trace_has_tool_and_llm_spans(self):
    payload = run_question_bank_workflow(self.user, {"jobId": str(self.job.id)}).output
    span_names = [span["name"] for span in payload["trace"]["spans"]]
    self.assertIn("question.generate_candidates", span_names)
    self.assertIn("llm.chat_completion", span_names)
```

- [ ] **Step 2: Register tool**

Register:

```python
ToolSpec(name="question.generate_candidates", owner="QuestionGeneratorAgent", provider="a3_question_generator", timeout_ms=25000, side_effects=True)
```

- [ ] **Step 3: Replace direct call**

In `QuestionGeneratorAgent.run()`, call ToolRegistry instead of `run_question_generation_job(job)` directly.

- [ ] **Step 4: Verify**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_question_generation
```

Expected: PASS.

---

### Task 7: Instrument OCR, VLM, And Visual Embedding

**Files:**
- Modify: `backend/domains/knowledge_base/multimodal_parser.py`
- Modify: `backend/domains/knowledge_base/visual_retriever.py`
- Create: `backend/domains/knowledge_base/tests/test_multimodal_tool_trace.py`

- [ ] **Step 1: Write failing multimodal trace test**

```python
def test_multimodal_backfill_records_ocr_vlm_visual_embedding_spans(self):
    result = parse_multimodal_resource(self.resource)
    span_names = [span["name"] for span in result.trace.get("spans", [])]
    self.assertIn("ocr.extract_image_text", span_names)
    self.assertIn("visual_embedding.embed_image", span_names)
```

- [ ] **Step 2: Register tools**

Register:

```python
ToolSpec(name="ocr.extract_image_text", owner="KnowledgeBaseIndexer", provider="rapidocr_or_api", timeout_ms=15000, side_effects=False)
ToolSpec(name="vlm.describe_image", owner="KnowledgeBaseIndexer", provider="openai_compatible_vlm", timeout_ms=30000, side_effects=False)
ToolSpec(name="visual_embedding.embed_image", owner="KnowledgeBaseIndexer", provider="dashscope_or_local_clip", timeout_ms=20000, side_effects=False)
ToolSpec(name="visual_embedding.embed_text", owner="KnowledgeBaseRetriever", provider="dashscope_or_local_clip", timeout_ms=10000, side_effects=False)
```

- [ ] **Step 3: Wrap existing parser functions**

Wrap `_ocr_image_with_openai_compatible_provider()`, `_ocr_image_local()`, VLM understanding call path, `_dashscope_multimodal_embedding()`, `_embed_image()`, and `_embed_text()` with tool spans.

- [ ] **Step 4: Verify multimodal RAG metrics still work**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_demo_status
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

Expected: PASS and visual index metrics unchanged except added span evidence.

---

### Task 8: Add Realtime Provider Span Metadata

**Files:**
- Modify: `OpenMAIC/lib/server/a3-realtime-provider.ts`
- Modify: `OpenMAIC/scripts/a3-dashscope-realtime-proxy.mjs`
- Modify: `backend/apps/learning/services.py`
- Extend: existing OpenMAIC realtime contract tests
- Extend: `backend/apps/learning/tests/test_coaching_session.py`

- [ ] **Step 1: Write failing realtime metadata test**

```python
def test_realtime_message_metadata_contains_provider_spans(self):
    message = save_coaching_message(..., metadata={
        "realtime": {
            "provider": "dashscope_qwen_omni_realtime",
            "spans": [{"name": "realtime.audio.delta", "latencyMs": 80, "fallbackReason": ""}],
        }
    })
    self.assertEqual(message.metadata["realtime"]["spans"][0]["name"], "realtime.audio.delta")
```

- [ ] **Step 2: Normalize realtime spans in Next server layer**

Record these span names without API keys:

```text
realtime.session.create
realtime.ws.connect
realtime.input_audio_buffer.append
realtime.response.audio.delta
realtime.response.transcript.delta
realtime.frame.analyze
```

- [ ] **Step 3: Persist summary in Django coaching metadata**

Keep detailed realtime spans in message/session metadata and expose aggregate counts on `/a3/capabilities`.

- [ ] **Step 4: Verify**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
npx.cmd playwright test e2e/tests/a3-realtime-coaching.spec.ts --project=chromium
cd ..
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session
```

Expected: PASS.

---

### Task 9: Expose Architecture Readiness In Capabilities And Export

**Files:**
- Modify: `backend/apps/compat/views.py`
- Modify: `OpenMAIC/app/a3/capabilities/page.tsx`
- Modify: `OpenMAIC/lib/a3/*capabilities*`
- Extend: `backend/apps/compat/tests/test_demo_status.py`

- [ ] **Step 1: Write failing capabilities test**

```python
def test_demo_status_exposes_agent_architecture_maturity(self):
    response = self.client.get("/api/demo/status/")
    payload = response.json()
    maturity = payload["agentArchitecture"]
    self.assertTrue(maturity["agentSpecRegistry"])
    self.assertTrue(maturity["toolRegistry"])
    self.assertIn("nestedSpanCount", maturity)
```

- [ ] **Step 2: Add backend summary**

Expose:

```json
{
  "agentSpecRegistry": true,
  "registeredAgentCount": 24,
  "toolRegistry": true,
  "registeredToolCount": 10,
  "nestedSpanCount": 0,
  "promptVersionCoverage": 0.0,
  "latestTraceId": ""
}
```

- [ ] **Step 3: Update frontend capabilities UI**

Show a compact checklist:

```text
AgentSpec 覆盖
ToolRegistry 覆盖
Prompt 版本化
Nested provider spans
Realtime span metadata
```

- [ ] **Step 4: Verify**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_demo_status
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: backend tests PASS; frontend typecheck PASS; lint only existing historical warnings.

---

## Final Validation

Run after all tasks:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_agent_workflows --recent 80
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
```

Expected:

- Agent workflow traces include `agentSpec`.
- QA traces include `rag.search`, `llm.chat_completion`, `verifier.verify_answer`.
- Multimodal indexing traces include OCR/VLM/visual embedding spans when those providers run.
- Realtime coaching metadata includes provider spans for session/audio/transcript/frame.
- `/a3/capabilities` exposes agent architecture maturity.
- No API key, raw prompt, signed URL, or local absolute resource path is exposed in frontend or trace export.

---

## Rollout Order

1. Tasks 1-3 are infrastructure and must land first.
2. Tasks 4-6 migrate current high-value agent workflows.
3. Task 7 upgrades multimodal RAG observability.
4. Task 8 upgrades realtime observability.
5. Task 9 makes the work visible for demo, audit, and答辩.

## Risks And Controls

- **Risk:** Trace payload grows too large.  
  **Control:** Store raw prompt nowhere; store prompt hash/version and summarized input/output only.

- **Risk:** ToolRegistry migration changes behavior.  
  **Control:** Keep public service functions unchanged and wrap calls internally first.

- **Risk:** Provider calls hang despite timeout metadata.  
  **Control:** Keep existing provider-level request timeout and mark span failed/degraded when exceptions occur.

- **Risk:** Realtime WebSocket events produce too many spans.  
  **Control:** Aggregate high-frequency audio chunks into count/duration spans per message window.

- **Risk:** Existing tests patch direct functions.  
  **Control:** Add compatibility wrappers so old patch paths continue working during first migration.

