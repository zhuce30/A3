# AI Classroom FollowUpAgent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real follow-up question Agent after every AI classroom answer, so students can continue learning with grounded, personalized next questions.

**Architecture:** Add `FollowUpAgent` as the final step of the existing `qa_interact` AgentKernel workflow. The Django text QA endpoint returns `followUps`, and the Next.js classroom proxy also attaches follow-ups to vision answers so every classroom answer has the same response contract. The classroom UI renders follow-up chips below assistant messages and sends the selected question through the existing ask flow.

**Tech Stack:** Django, AgentKernel, Next.js App Router, React, TypeScript, existing A3 API client, existing `npx.cmd tsc`, `pnpm.cmd lint`, `manage.py test/check/validate_demo_flow`.

---

## File Structure

- Modify `backend/apps/compat/agent_kernel.py`
  - Add `FollowUpAgent`.
  - Append it to `QA_WORKFLOW_SEQUENCE`.
  - Register it in `build_qa_kernel()`.
  - Keep output schema small: `followUps: [{ label, question, type, reason }]`.
- Modify `backend/apps/compat/views.py`
  - Include `followUps` in `qa_interact` JSON response.
  - Include follow-up endpoint in the demo API matrix if a standalone follow-up endpoint is added for vision.
- Modify `backend/apps/compat/agent_workflows.py`
  - Add `FollowUpAgent` to `qa_interact.requiredSteps`.
  - Add `followUps` to `qa_interact.outputSchema`.
  - Add a quality metric for grounded follow-up suggestions.
- Modify `backend/apps/compat/tests/test_agent_runtime.py`
  - Assert `qa_interact` contract includes `FollowUpAgent`.
  - Assert QA workflow traces persist `FollowUpAgent` metadata.
- Modify or create `backend/apps/compat/tests/test_qa_followups.py`
  - Test normal verified answer follow-ups.
  - Test missing evidence or unsafe answer follow-ups do not encourage unsupported factual claims.
- Modify `OpenMAIC/app/api/a3/coaching/respond/route.ts`
  - Add `followUps` to `BackendQaResponse`.
  - Pass through `followUps` from Django text QA.
  - For vision and visual-evidence paths, attach follow-ups using the same backend follow-up contract or a shared server helper that calls Django.
- Modify `OpenMAIC/components/a3/features/classroom-view.tsx`
  - Extend `ChatMessage` and `CoachingResponse` with `followUps`.
  - Save follow-ups in assistant messages and history.
  - Render chips below the answer, after verification but before save-note.
  - Clicking a chip calls `askQuestion(followUp.question)`.
- Modify `OpenMAIC/components/a3/features/capabilities-view.tsx`
  - Existing Agent trace waterfall should show `FollowUpAgent` automatically after backend trace changes.
  - Add a small metric in the Agent workflow card only if the existing data shape already exposes it.

## Data Contract

Backend and Next proxy should return this field:

```json
{
  "followUps": [
    {
      "label": "继续追问概念",
      "question": "能不能用一个控制系统例子解释根轨迹的作用？",
      "type": "concept",
      "reason": "围绕当前知识点继续讲清核心概念"
    }
  ]
}
```

Rules:
- Always return an array, never `null`.
- Return 2 to 3 items.
- `question` must be a complete student-facing question.
- If `verified=false`, `safety.safe=false`, or `refusalReason` is present, follow-ups must shift to clarification, source upload, or learning-method questions.
- Do not include citations, local file paths, API keys, or hidden trace metadata inside `followUps`.

## Task 1: Backend Tests for QA Follow-Ups

**Files:**
- Create: `backend/apps/compat/tests/test_qa_followups.py`
- Modify: `backend/apps/compat/tests/test_agent_runtime.py`

- [ ] **Step 1: Write the failing QA follow-up tests**

Create `backend/apps/compat/tests/test_qa_followups.py`:

```python
from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.compat.agent_kernel import build_qa_kernel, run_qa_workflow


class QaFollowUpAgentTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007771", password="TestPassword123")

    def test_qa_workflow_returns_followups(self):
        kernel = build_qa_kernel()
        kernel._circuit_breaker = lambda _context, _agent: {"open": False, "reason": "test"}

        result = run_qa_workflow(
            self.user,
            {"question": "根轨迹是什么？"},
            kernel=kernel,
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
        kernel = build_qa_kernel()
        kernel._circuit_breaker = lambda _context, _agent: {"open": False, "reason": "test"}

        result = run_qa_workflow(
            self.user,
            {"question": "请直接告诉我教材第 999 页的结论。"},
            kernel=kernel,
        )

        follow_ups = result.output.get("followUps") or []
        joined = " ".join(item.get("question", "") for item in follow_ups)
        self.assertNotIn("第999页", joined)
        self.assertTrue(any("资料" in item.get("question", "") or "证据" in item.get("question", "") for item in follow_ups))
```

- [ ] **Step 2: Update Agent runtime contract test**

In `backend/apps/compat/tests/test_agent_runtime.py`, update the QA workflow contract assertion so `qa_interact.requiredSteps` includes:

```python
["SafetyAgent", "RetrieverAgent", "TeacherAgent", "VerifierAgent", "FollowUpAgent"]
```

Add:

```python
self.assertIn("followUps", by_key["qa_interact"]["outputSchema"]["properties"])
```

- [ ] **Step 3: Run failing tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_qa_followups backend.apps.compat.tests.test_agent_runtime.CompatApiTests.test_agent_workflow_registry_describes_required_contracts --keepdb
```

Expected before implementation: tests fail because `FollowUpAgent` and `followUps` do not exist.

## Task 2: Implement FollowUpAgent in AgentKernel

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`

- [ ] **Step 1: Add constants and deterministic fallback builder**

Add near QA-related code:

```python
FOLLOW_UP_TYPES = {"concept", "example", "practice", "evidence", "clarify"}


def _normalize_follow_up_item(item: dict, index: int) -> dict:
    label = str(item.get("label") or "").strip()[:24] or ["继续追问", "换个例子", "做道练习"][index % 3]
    question = str(item.get("question") or "").strip()
    item_type = str(item.get("type") or "").strip() or "concept"
    if item_type not in FOLLOW_UP_TYPES:
        item_type = "concept"
    if question and not question.endswith(("？", "?")):
        question = f"{question}？"
    return {
        "label": label,
        "question": question,
        "type": item_type,
        "reason": str(item.get("reason") or "").strip()[:80],
    }


def build_follow_up_suggestions(question: str, answer: str, *, verified: bool, safe: bool, target_title: str, source_count: int) -> list[dict]:
    if not safe:
        raw_items = [
            {"label": "换个学习问题", "question": f"能不能围绕{target_title or '当前知识点'}问一个合规的学习问题", "type": "clarify", "reason": "当前问题触发安全边界"},
            {"label": "看基础概念", "question": f"请讲解{target_title or '当前知识点'}的基础概念", "type": "concept", "reason": "回到课堂目标"},
        ]
    elif not verified or source_count == 0:
        raw_items = [
            {"label": "补充证据", "question": "我需要上传哪类资料才能验证这个回答", "type": "evidence", "reason": "当前回答证据不足"},
            {"label": "换个问法", "question": f"能不能只基于已验证内容解释{target_title or '这个问题'}", "type": "clarify", "reason": "降低幻觉风险"},
            {"label": "学习方法", "question": f"如果资料不足，我该如何自学{target_title or '这个知识点'}", "type": "concept", "reason": "给出安全下一步"},
        ]
    else:
        raw_items = [
            {"label": "继续追问概念", "question": f"能不能用更直观的方式解释{target_title or '这个知识点'}", "type": "concept", "reason": "加深概念理解"},
            {"label": "看工程例子", "question": f"能不能给一个{target_title or '当前知识点'}的工程应用例子", "type": "example", "reason": "连接应用场景"},
            {"label": "来一道练习", "question": f"围绕{target_title or '这个知识点'}出一道带解析的练习题", "type": "practice", "reason": "转入测评闭环"},
        ]
    return [_normalize_follow_up_item(item, index) for index, item in enumerate(raw_items) if item.get("question")][:3]
```

- [ ] **Step 2: Add `FollowUpAgent`**

Add after `TeacherAgent` or near other QA agents:

```python
class FollowUpAgent(BaseAgent):
    name = "FollowUpAgent"
    role = "guided follow-up"
    detail = "Suggest grounded next questions after a classroom answer."
    max_retries = 0
    timeout_ms = 1000

    def run(self, context: AgentContext) -> AgentResult:
        question = str(context.payload.get("question") or "").strip()
        answer = str(context.state.get("draftAnswer") or "").strip()
        verification = context.state.get("verification") if isinstance(context.state.get("verification"), dict) else {}
        sources = context.state.get("sources") if isinstance(context.state.get("sources"), list) else []
        qa_context = context.state.get("classroomContext") if isinstance(context.state.get("classroomContext"), dict) else {}
        target = qa_context.get("target") if isinstance(qa_context.get("target"), dict) else {}
        safety = verification.get("safety") if isinstance(verification.get("safety"), dict) else {}
        follow_ups = build_follow_up_suggestions(
            question,
            answer,
            verified=bool(verification.get("verified")),
            safe=bool(safety.get("safe", True)),
            target_title=str(target.get("title") or ""),
            source_count=len(sources),
        )
        return AgentResult(
            output={"followUps": follow_ups},
            state_patch={"followUps": follow_ups},
            input_summary={"verified": bool(verification.get("verified")), "sourceCount": len(sources)},
            output_summary={"followUpCount": len(follow_ups), "types": [item["type"] for item in follow_ups]},
            state_diff={"ClassroomFollowUps": len(follow_ups)},
            evidence={
                "question": question[:120],
                "targetTitle": target.get("title") or "",
                "sourceCount": len(sources),
                "verified": bool(verification.get("verified")),
            },
            quality={
                "hasFollowUps": len(follow_ups) >= 2,
                "safeWhenUnverified": bool(verification.get("verified")) or all(item["type"] in {"evidence", "clarify", "concept"} for item in follow_ups),
            },
        )
```

- [ ] **Step 3: Register the Agent**

Change:

```python
QA_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "RetrieverAgent",
    "TeacherAgent",
    "VerifierAgent",
]
```

to:

```python
QA_WORKFLOW_SEQUENCE = [
    "SafetyAgent",
    "RetrieverAgent",
    "TeacherAgent",
    "VerifierAgent",
    "FollowUpAgent",
]
```

Change `build_qa_kernel()` to:

```python
def build_qa_kernel() -> AgentKernel:
    kernel = AgentKernel()
    for agent in (SafetyAgent(), RetrieverAgent(), TeacherAgent(), VerifierAgent(), FollowUpAgent()):
        kernel.register(agent)
    return kernel
```

- [ ] **Step 4: Run tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_qa_followups --keepdb
```

Expected: follow-up tests pass.

## Task 3: Return Follow-Ups From Django QA API

**Files:**
- Modify: `backend/apps/compat/views.py`
- Modify: `backend/apps/compat/agent_workflows.py`

- [ ] **Step 1: Add followUps to `qa_interact` response**

In `backend/apps/compat/views.py`, inside `qa_interact`, return:

```python
"followUps": kernel_result.output.get("followUps") or [],
```

Final response block should include:

```python
return JsonResponse({
    "success": kernel_result.success,
    "traceId": kernel_result.trace["traceId"],
    "answer": answer,
    "sources": kernel_result.output.get("sources") or [],
    "retrievalMode": kernel_result.output.get("retrievalMode") or "unknown",
    "followUps": kernel_result.output.get("followUps") or [],
    **verification,
})
```

- [ ] **Step 2: Update workflow contract**

In `backend/apps/compat/agent_workflows.py`, update `qa_interact`:

```python
required_steps=("SafetyAgent", "RetrieverAgent", "TeacherAgent", "VerifierAgent", "FollowUpAgent"),
```

Add to `output_schema.properties`:

```python
"followUps": {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "label": {"type": "string"},
            "question": {"type": "string"},
            "type": {"type": "string"},
            "reason": {"type": "string"},
        },
    },
},
```

Add to `quality_metrics`:

```python
{"key": "followUpCoverage", "target": ">=2 per answer"},
```

- [ ] **Step 3: Run backend contract tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_agent_runtime backend.apps.compat.tests.test_qa_followups --keepdb
```

Expected: all pass.

## Task 4: Pass Follow-Ups Through Next Coaching Proxy

**Files:**
- Modify: `OpenMAIC/app/api/a3/coaching/respond/route.ts`
- If needed, modify: `OpenMAIC/lib/server/a3-vision-answer.ts`

- [ ] **Step 1: Add TypeScript types**

In `route.ts`, add:

```ts
type FollowUpSuggestion = {
  label: string;
  question: string;
  type: 'concept' | 'example' | 'practice' | 'evidence' | 'clarify' | string;
  reason?: string;
};
```

Extend `BackendQaResponse`:

```ts
followUps?: FollowUpSuggestion[];
```

- [ ] **Step 2: Pass through text QA follow-ups**

In the final `apiSuccess` block for text QA, add:

```ts
followUps: normalizeFollowUps(result.followUps),
```

Add helper:

```ts
function normalizeFollowUps(items?: FollowUpSuggestion[]) {
  return Array.isArray(items)
    ? items
        .filter((item) => item && typeof item.question === 'string' && item.question.trim())
        .slice(0, 3)
        .map((item) => ({
          label: String(item.label || '继续追问').slice(0, 24),
          question: item.question.trim(),
          type: item.type || 'concept',
          reason: item.reason || '',
        }))
    : [];
}
```

- [ ] **Step 3: Ensure vision branches also return followUps**

Inspect `OpenMAIC/lib/server/a3-vision-answer.ts`. If `answerA3VisionQuestion()` and `answerA3TextQuestionWithVisualEvidence()` return `apiSuccess(...)` directly, update both success payloads to include:

```ts
followUps: buildVisionFollowUps({ verified, citations, message }),
```

Add helper in that file:

```ts
function buildVisionFollowUps({ verified, citations, message }: { verified?: boolean; citations?: unknown[]; message: string }) {
  if (!verified || !Array.isArray(citations) || citations.length === 0) {
    return [
      { label: '补充资料', question: '我需要补充哪类图片或课件才能验证这道题？', type: 'evidence', reason: '视觉回答证据不足' },
      { label: '换个问法', question: '能不能只根据图片中可见的信息讲解解题思路？', type: 'clarify', reason: '降低误识别风险' },
    ];
  }
  return [
    { label: '讲关键步骤', question: '能不能把这道题的关键步骤再拆细一点？', type: 'concept', reason: '巩固图片题解题流程' },
    { label: '换一道同类题', question: '能不能基于这道题生成一道同类练习？', type: 'practice', reason: '进入练习闭环' },
    { label: '查易错点', question: `这类题最容易错在哪里？原问题：${message.slice(0, 80)}`, type: 'example', reason: '定位错因' },
  ];
}
```

This keeps every classroom answer contract consistent. The text path remains the authoritative AgentKernel path; the vision path gets conservative follow-ups until a dedicated vision FollowUpAgent endpoint is added.

- [ ] **Step 4: Run TypeScript check**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: no TypeScript errors.

## Task 5: Render Follow-Up Chips in Classroom UI

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`

- [ ] **Step 1: Extend front-end message types**

Add:

```ts
type FollowUpSuggestion = {
  label: string;
  question: string;
  type: string;
  reason?: string;
};
```

Extend `ChatMessage`:

```ts
followUps?: FollowUpSuggestion[];
```

Extend `CoachingResponse`:

```ts
followUps?: FollowUpSuggestion[];
```

- [ ] **Step 2: Store followUps on assistant messages**

In `askQuestion`, add to `assistantMessage`:

```ts
followUps: Array.isArray(result.followUps) ? result.followUps : [],
```

- [ ] **Step 3: Pass click handler into ChatBubble**

Where chat messages are rendered, pass:

```tsx
onFollowUp={(question) => void askQuestion(question)}
```

Update `ChatBubble` props:

```ts
onFollowUp: (question: string) => void;
```

- [ ] **Step 4: Render chips**

Inside `ChatBubble`, after `VerificationBadge` and before speech/save-note controls:

```tsx
{item.role === 'assistant' && item.followUps?.length ? (
  <div data-testid="a3-classroom-followups" className="mt-3 flex flex-wrap gap-2">
    {item.followUps.slice(0, 3).map((followUp) => (
      <button
        key={`${item.id}-${followUp.type}-${followUp.question}`}
        type="button"
        onClick={() => onFollowUp(followUp.question)}
        className="rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title={followUp.reason || followUp.question}
      >
        {followUp.label}
      </button>
    ))}
  </div>
) : null}
```

- [ ] **Step 5: Preserve history compatibility**

In `normalizeClassroomMessages`, keep:

```ts
followUps: Array.isArray(item.followUps) ? item.followUps : [],
```

If the function currently strips unknown fields, update it explicitly so old history without follow-ups still loads.

- [ ] **Step 6: Run front-end checks**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: `tsc` passes. `lint` has 0 errors and only the known historical warnings listed in `AGENTS.md`.

## Task 6: Capabilities and Metrics

**Files:**
- Modify: `backend/apps/compat/management/commands/evaluate_agent_workflows.py` only if generated trace coverage needs explicit QA regeneration.
- Modify: `OpenMAIC/components/a3/features/capabilities-view.tsx` only if the current Agent trace waterfall does not display the new step clearly.

- [ ] **Step 1: Generate one real QA trace**

Run a Django shell command after implementation:

```powershell
$script = @'
from django.contrib.auth import get_user_model
from backend.apps.compat.agent_kernel import run_qa_workflow
User = get_user_model()
user = User.objects.filter(phone="13800000001").first() or User.objects.first()
result = run_qa_workflow(user, {"question": "根轨迹是什么？"})
print({"traceId": result.trace.get("traceId"), "followUps": result.output.get("followUps")})
'@
backend\.venv\Scripts\python.exe backend\manage.py shell -c $script
```

Expected: output includes a traceId and at least 2 follow-ups.

- [ ] **Step 2: Regenerate Agent workflow metrics**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_agent_workflows --json --output backend\tmp\agent_workflow_metrics.json
```

Expected:
- `overallStatus` remains `pass`.
- `qa_interact.requiredSteps` includes `FollowUpAgent`.
- `/a3/capabilities` Agent trace waterfall shows `FollowUpAgent`.

- [ ] **Step 3: Test demo status**

Run:

```powershell
$script = @'
from django.test import Client
from django.contrib.auth import get_user_model
User = get_user_model()
user = User.objects.filter(phone="13800000001").first() or User.objects.first()
client = Client(HTTP_HOST="localhost")
client.force_login(user)
response = client.get("/api/demo/status/", HTTP_HOST="localhost")
data = response.json()
print({"status": response.status_code, "success": data.get("success"), "agentWorkflowOverall": data.get("agentWorkflowMetrics", {}).get("overallStatus")})
'@
backend\.venv\Scripts\python.exe backend\manage.py shell -c $script
```

Expected: status `200`, success `True`.

## Task 7: Full Verification

**Files:**
- No code changes unless a verification command fails.

- [ ] **Step 1: Backend checks**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_qa_followups backend.apps.compat.tests.test_agent_runtime --keepdb
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected:
- `check`: no issues.
- tests: OK.
- validate demo flow: pass.

- [ ] **Step 2: Frontend checks**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:
- `tsc`: pass.
- `lint`: 0 errors, only known historical warnings.

- [ ] **Step 3: Manual product check**

Start existing dev servers or use the already running ones. In `/a3/classroom`:
- Ask: `根轨迹是什么？`
- Confirm the answer displays verification.
- Confirm 2 to 3 follow-up chips appear below the assistant answer.
- Click one follow-up chip.
- Confirm it sends as a new user question and receives another answer.
- Upload an image question.
- Confirm the vision answer also displays follow-up chips.

## Self-Review

- Spec coverage: The plan covers text QA, vision QA, backend AgentKernel, Next proxy, classroom UI, capabilities trace, and verification.
- Placeholder scan: No task uses TBD, TODO, or unspecified implementation steps.
- Type consistency: The shared type name is `FollowUpSuggestion`; response field is always `followUps`.
- Scope check: This is one scoped feature. It does not change retrieval, grading, question bank generation, or OpenMAIC artifact writeback.

