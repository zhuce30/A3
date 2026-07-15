# A3 Conversation-First Profile Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make natural-language conversation the default first-run profile builder, visibly extract at least six learner dimensions, preserve real Agent/API contracts, and prove that diagnosis and later learning signals continue updating the same profile.

**Architecture:** Keep `/a3/profile-setup` and every existing API path. Use the existing `profile_interview` workflow and `a3.profile-interview.profile.v2` response as the primary path; render service-returned profile dimensions live and confirm only from real `interviewComplete/profileCommitted` values. Keep the structured four-step flow as a secondary fallback using the additive `completionMode="diagnostic_ready"` contract, then let admission diagnostics generate the first formal path and plan.

**Tech Stack:** Django 5, Django TestCase, A3 AgentKernel, Next.js 15, React 19, TypeScript, Tailwind CSS, Vitest, Playwright.

---

## Contract Invariants

Do not rename, reorder, bypass, or mock these workflows:

```text
POST /api/profile/interview/
SafetyAgent -> ProfileInterviewAgent -> LearnerModelAgent -> MemoryCommitAgent -> PlannerAgent

POST /api/profiles/learning-profile/
ProfileNormalizeAgent -> ProfileCommitAgent -> PlannerAgent -> StudyPlanAgent

POST /api/learning/admission-diagnostic/
DiagnosticAgent -> ProfileUpdateAgent -> PlannerAgent -> StudyPlanAgent
```

The frontend continues to use `a3GetJson` and `a3PostJson`. It must never synthesize `interviewComplete`, `profileCommitted`, `generated`, `traceId`, profile values, or production option values.

## File Map

### Backend

- `backend/apps/profiles/services.py`: structured fallback validation and `setupReadiness`.
- `backend/apps/compat/agent_kernel.py`: propagate structured completion mode and record deferred planning without changing Agent order.
- `backend/apps/compat/profile_interview.py`: preserve the ten-dimension interview schema, humanize follow-ups, and defer formal planning until diagnosis.
- `backend/apps/profiles/profile_updates.py`: verify existing post-diagnostic and learning-signal updates; change only if a focused regression exposes a real gap.
- `backend/apps/profiles/tests/test_profile_settings.py`: strict/fallback compatibility.
- `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`: natural-language extraction, multi-turn memory, confirm, and deferred planning contracts.
- `backend/apps/compat/tests/test_agent_runtime.py`: sequence equality contracts.
- `backend/apps/learning/tests/test_path_planner.py`: diagnostic write-back.
- `backend/apps/profiles/tests/test_profile_updates.py`: later learning-signal update evidence, if the existing module uses this path; otherwise add the assertion to the closest existing profile-update test module.

### Frontend

- `OpenMAIC/lib/a3/auth-types.ts`: additive interview and fallback response types.
- `OpenMAIC/lib/a3/profile-setup.ts`: pure helpers for dimension display, fallback readiness, and submission routing.
- `OpenMAIC/components/a3/profile-setup/profile-interview-first-run.tsx`: primary conversation UI and live profile summary.
- `OpenMAIC/components/a3/profile-setup/profile-dimension-summary.tsx`: service-derived dimension state list.
- `OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx`: secondary structured fallback.
- `OpenMAIC/components/a3/profile-setup/profile-setup-example.tsx`: accessible inline conversation example.
- `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`: real session restore, message, confirm, fallback save, and routing orchestration.
- `OpenMAIC/tests/a3-profile-setup.test.ts`: pure helper tests.
- `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`: conversation-first and learner-language guardrails.
- `OpenMAIC/e2e/tests/a3-profile-setup-conversation-first.spec.ts`: real first-run, session, fallback, and responsive flow.

---

### Task 1: Keep Structured Fallback Diagnostic-Ready

**Status:** Implemented on this feature branch by commit `f39f6f1`; review it against the revised design before starting Task 2.

**Files:**
- Modify: `backend/apps/profiles/services.py`
- Modify: `backend/apps/profiles/tests/test_profile_settings.py`

- [x] **Step 1: Add failing fallback validation tests**

The tests prove that `completionMode="diagnostic_ready"` accepts real background/goal/time/preference inputs while leaving `foundationLevel`, `weakPoints`, and `pace` empty. The same payload without `completionMode` must still fail strict validation.

- [x] **Step 2: Implement mode-aware validation and setup readiness**

The additive response is:

```json
{
  "setupReadiness": {
    "status": "ready_for_diagnostic",
    "missingRequiredFields": [],
    "deferredDimensions": ["foundationLevel", "weakPoints", "pace"]
  }
}
```

This contract belongs only to the secondary structured fallback. It does not replace `/api/profile/interview/` as the default first-run path.

- [x] **Step 3: Verify strict compatibility and commit**

Focused new tests: `3/3` passed. Existing focused strict regressions: `7/7` passed. Commit: `f39f6f1 feat: support diagnostic-ready profile setup`.

---

### Task 2: Preserve Agent Steps While Deferring Pre-Diagnostic Planning

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Modify: `backend/apps/profiles/services.py`
- Modify: `backend/apps/profiles/tests/test_profile_settings.py`
- Modify: `backend/apps/compat/tests/test_agent_runtime.py`

- [ ] **Step 1: Write the profile-setup sequence contract test**

Add to `test_agent_runtime.py`:

```python
def test_profile_setup_workflow_contract_matches_kernel_agent_sequence(self):
    from backend.apps.compat.agent_kernel import PROFILE_SETUP_WORKFLOW_SEQUENCE
    from backend.apps.compat.agent_workflows import get_agent_workflow_contract

    contract = get_agent_workflow_contract("profile_setup")
    self.assertEqual(tuple(PROFILE_SETUP_WORKFLOW_SEQUENCE), contract.required_steps)
```

- [ ] **Step 2: Write the failing deferred-generation test**

Post `diagnostic_ready_payload()` and assert:

```python
self.assertEqual(data["generated"], {"path": False, "studyPlan": False})
self.assertFalse(LearningPath.objects.filter(user=self.user, status="active").exists())
run = AgentRun.objects.prefetch_related("steps").get(trace_id=data["traceId"])
steps = list(run.steps.order_by("order"))
self.assertEqual(
    [step.name for step in steps],
    ["ProfileNormalizeAgent", "ProfileCommitAgent", "PlannerAgent", "StudyPlanAgent"],
)
self.assertEqual(
    next(step for step in steps if step.name == "PlannerAgent").metadata["evidence"]["reason"],
    "awaiting_admission_diagnostic",
)
```

- [ ] **Step 3: Run RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_diagnostic_ready_profile_keeps_agent_steps_and_defers_generation --noinput
```

Expected: fail because the existing Agents still generate a path and plan.

- [ ] **Step 4: Propagate completion mode through Agent state**

`ProfileNormalizeAgent` must copy the request mode into state and evidence:

```python
completion_mode = str(payload.get("completionMode") or "complete")
planning_deferred = completion_mode == "diagnostic_ready"
state_patch = {
    "normalizedProfileInput": payload,
    "completionMode": completion_mode,
    "planningDeferred": planning_deferred,
    "weakPoints": payload.get("weakPoints") if isinstance(payload.get("weakPoints"), list) else [],
}
```

`ProfileCommitAgent` must copy the real `setupReadiness` returned by `_save_learning_profile_core` into output, state, evidence, and quality.

- [ ] **Step 5: Return explicit deferred Agent results**

In the `profile_setup` branches of `PlannerAgent` and `StudyPlanAgent`, keep both steps but return evidence with:

```python
{
    "reason": "awaiting_admission_diagnostic",
    "completionMode": "diagnostic_ready",
}
```

Set `pathGenerated=False` and `studyPlanGenerated=False`; do not create a `LearningPath` or `extra_profile.studyPlan`.

- [ ] **Step 6: Run GREEN and compatibility tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings backend.apps.compat.tests.test_agent_runtime --noinput
```

Existing complete-mode tests must still report `generated.path=true` and `generated.studyPlan=true`. Document the two pre-existing course-default drift failures rather than modifying them.

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/compat/agent_kernel.py backend/apps/compat/tests/test_agent_runtime.py backend/apps/profiles/services.py backend/apps/profiles/tests/test_profile_settings.py
git commit -m "feat: defer fallback planning until diagnosis"
```

---

### Task 3: Make the Existing Interview Contract Conversation-First

**Files:**
- Modify: `backend/apps/compat/profile_interview.py`
- Modify: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`

- [ ] **Step 1: Add a natural-language six-dimension extraction regression**

Use the existing mocked LLM pattern so the test is deterministic. A single message should merge at least these six real dimensions: `grade`, `majorDirection`, `learningGoals`, `learningHistory`, `dailyMinutes`, and `resourcePreferences`.

```python
def test_profile_interview_natural_language_extracts_at_least_six_dimensions(self):
    extracted = {
        "grade": "大二",
        "majorDirection": "软件工程",
        "learningGoals": ["掌握操作系统并准备期末考试"],
        "learningHistory": "学过 C 语言和数据结构",
        "dailyMinutes": 40,
        "resourcePreferences": ["逐步例题", "视频课程"],
    }
    with patch("backend.apps.compat.profile_interview._llm_extract_profile_dimensions", return_value=extracted):
        response = self.client.post(
            "/api/profile/interview/",
            data=json.dumps({"message": "我是大二软件工程学生，学过 C 和数据结构，每天能学 40 分钟……"}),
            content_type="application/json",
        )
    self.assertEqual(response.status_code, 200, response.content)
    payload = response.json()
    self.assertGreaterEqual(payload["profileReadiness"]["dimensionCount"], 6)
    for field in extracted:
        self.assertTrue(payload["profile"].get(field))
```

- [ ] **Step 2: Update confirm expectations to pre-diagnostic defer**

Rename the existing confirm test to `test_profile_interview_confirm_commits_profile_and_defers_plan_until_diagnostic`. Keep assertions for `profileCommitted`, `confirmedAt`, user flags, workflow name, and the five-step sequence. Replace generation assertions with:

```python
self.assertFalse(payload["generated"]["path"])
self.assertFalse(payload["generated"]["studyPlan"])
self.assertTrue(payload["planningDeferred"])
self.assertEqual(payload["planningDeferredReason"], "awaiting_admission_diagnostic")
```

- [ ] **Step 3: Run RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_profile_interview_natural_language_extracts_at_least_six_dimensions backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_profile_interview_confirm_commits_profile_and_defers_plan_until_diagnostic --noinput
```

- [ ] **Step 4: Preserve the ten-dimension schema and humanize questions**

Do not remove fields from `_public_interview_profile` or `_profile_dimension_checks`. Correct user-visible labels to valid UTF-8 Chinese and map internal concepts to concrete language:

```python
USER_VISIBLE_DIMENSION_LABELS = {
    "grade": "年级阶段",
    "majorDirection": "专业方向",
    "foundationLevel": "当前基础",
    "dailyMinutes": "每天可用时间",
    "learningGoals": "学习目标",
    "weakPoints": "容易卡住的内容",
    "resourcePreferences": "希望获得的资料",
    "cognitiveStyle": "更容易理解的讲解方式",
    "learningHistory": "学习经历",
    "motivationRisk": "坚持学习时的困难",
}
```

`_next_question()` must ask only the first `askField`. Use specific questions, not internal field names. Keep `missingDimensions`, `askFields`, `nextQuestion`, `interviewComplete`, session schema, and response shape.

- [ ] **Step 5: Defer interview planning without removing PlannerAgent**

`ProfileInterviewPlannerAgent` remains the fifth step. Before admission diagnosis, it returns compatible `generated` fields set to false plus:

```python
planning_deferred = True
planning_deferred_reason = "awaiting_admission_diagnostic"
```

Both message and confirm responses retain existing fields. Only the server may set `profileCommitted` and confirm state.

- [ ] **Step 6: Run interview contract tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_a3_requirements_deep_fill --noinput
```

Verify multi-turn session persistence, sparse-turn merge, LLM provider evidence, rule fallback, one-question follow-up, incomplete-confirm rejection, and complete-confirm success.

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/compat/profile_interview.py backend/apps/compat/tests/test_a3_requirements_deep_fill.py
git commit -m "feat: align profile interview with diagnostic flow"
```

---

### Task 4: Add Frontend Dimension Types and Pure Helpers

**Files:**
- Modify: `OpenMAIC/lib/a3/auth-types.ts`
- Modify: `OpenMAIC/lib/a3/profile-setup.ts`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`

- [ ] **Step 1: Write failing helper tests**

Add tests for these behaviors:

```typescript
expect(getProfileDimensionRows({
  profile: { grade: '大二', majorDirection: '软件工程' },
  missingDimensions: [{ field: 'foundationLevel', label: '当前基础' }],
})).toEqual(expect.arrayContaining([
  expect.objectContaining({ field: 'grade', status: 'identified' }),
  expect.objectContaining({ field: 'foundationLevel', status: 'missing' }),
]));

expect(getProfileDimensionRows({ profile: {}, missingDimensions: [] }))
  .toHaveLength(10);

expect(resolveFirstRunSubmission({ interviewComplete: true })).toBe('interview_confirm');
expect(resolveFirstRunSubmission({ interviewComplete: false })).toBe('continue_interview');
expect(buildDiagnosticReadyProfilePayload(profile, '学生')).toMatchObject({
  completionMode: 'diagnostic_ready',
});
```

- [ ] **Step 2: Run RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-setup.test.ts
```

- [ ] **Step 3: Add additive types**

Extend the existing interview types without renaming server fields:

```typescript
export type ProfileInterviewDimensionField =
  | 'grade' | 'majorDirection' | 'foundationLevel' | 'dailyMinutes'
  | 'learningGoals' | 'weakPoints' | 'resourcePreferences'
  | 'cognitiveStyle' | 'learningHistory' | 'motivationRisk';

export type ProfileDimensionRow = {
  field: ProfileInterviewDimensionField;
  label: string;
  value: string;
  status: 'identified' | 'missing' | 'deferred';
};
```

Keep `ProfileInterviewResult.profile`, `profileReadiness`, `missingDimensions`, `askFields`, `nextQuestion`, `interviewComplete`, `profileCommitted`, `interviewSession`, `generated`, and `traceId` optional exactly as the backend currently returns them.

- [ ] **Step 4: Implement pure display and routing helpers**

`getProfileDimensionRows()` must use a fixed field-to-friendly-label definition but use only server-returned values and missing fields for status. It may format arrays with `、` and `dailyMinutes` with ` 分钟`; it must not infer a field value from message text.

`resolveFirstRunSubmission()` returns only:

```typescript
type FirstRunSubmission = 'interview_confirm' | 'continue_interview' | 'structured_fallback';
```

Use `structured_fallback` only when the user explicitly selected the fallback mode and its required fields are ready.

- [ ] **Step 5: Run GREEN and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-profile-setup.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 6: Commit**

```powershell
git add OpenMAIC/lib/a3/auth-types.ts OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/tests/a3-profile-setup.test.ts
git commit -m "feat: model conversation-first profile state"
```

---

### Task 5: Build the Primary Conversation UI and Secondary Fallback

**Files:**
- Create: `OpenMAIC/components/a3/profile-setup/profile-dimension-summary.tsx`
- Create: `OpenMAIC/components/a3/profile-setup/profile-interview-first-run.tsx`
- Create: `OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx`
- Create: `OpenMAIC/components/a3/profile-setup/profile-setup-example.tsx`
- Modify: `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`

- [ ] **Step 1: Add source-level UX guardrail tests**

Assert the first-run component includes:

```typescript
expect(source).toContain('用几句话介绍你的学习情况');
expect(source).toContain('data-testid="a3-profile-interview-first-run"');
expect(source).toContain('data-testid="a3-profile-dimension-summary"');
expect(source).toContain('我不想打字，逐项确认');
expect(source).not.toContain('Agent 决策证据');
expect(source).not.toContain('动机风险');
expect(source).not.toContain('认知风格');
```

- [ ] **Step 2: Run RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-real-user-polish-regressions.test.ts
```

- [ ] **Step 3: Implement `ProfileDimensionSummary`**

Props are controlled and contain no API calls:

```typescript
type Props = {
  rows: ProfileDimensionRow[];
  dimensionCount: number;
  collapsible?: boolean;
};
```

Render all ten rows with stable dimensions. Use `CheckCircle2` for identified, `CircleDashed` for missing, and `ClipboardCheck` for deferred. Desktop shows the list; mobile uses an accessible disclosure with `aria-expanded`. Do not put cards inside a parent card.

- [ ] **Step 4: Implement `ProfileInterviewFirstRun`**

The component is controlled by these props:

```typescript
type Props = {
  value: string;
  messages: Array<{ role: 'agent' | 'user'; content: string }>;
  loading: boolean;
  nextQuestion: string;
  rows: ProfileDimensionRow[];
  dimensionCount: number;
  interviewComplete: boolean;
  message: string;
  onValueChange(value: string): void;
  onSend(): void;
  onConfirm(): void;
  onExample(): void;
  onUseStructuredFallback(): void;
};
```

The textarea and send button are the primary first viewport controls. The confirm button appears only when the real `interviewComplete` prop is true. Message history uses `max-h` plus `overflow-y-auto`; the grid switches to one column below 960px.

- [ ] **Step 5: Implement inline example and fallback wizard**

The example is an inline disclosure containing a natural student paragraph, not a modal and not a fake successful conversation. The four-step wizard remains controlled, sources all choices from `LearningProfileOptions`, supports explicit “交给入学诊断判断”, and never writes that display string to the profile payload.

- [ ] **Step 6: Run component tests and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-real-user-polish-regressions.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 7: Commit**

```powershell
git add OpenMAIC/components/a3/profile-setup OpenMAIC/tests/a3-real-user-polish-regressions.test.ts
git commit -m "feat: build conversation-first profile onboarding"
```

---

### Task 6: Integrate Real Interview APIs as the Default First-Run Path

**Files:**
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`
- Modify: `OpenMAIC/lib/a3/profile-setup.ts`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`

- [ ] **Step 1: Add first-run mode and error state**

Use conversation as the initial state:

```typescript
const [firstRunMode, setFirstRunMode] = useState<'conversation' | 'structured'>('conversation');
const [interviewSessionError, setInterviewSessionError] = useState('');
const [interviewMessageError, setInterviewMessageError] = useState('');
const [optionsError, setOptionsError] = useState('');
```

Do not use `guided` as the default and do not automatically switch modes after an Agent error.

- [ ] **Step 2: Keep session restore and message calls real**

On first-run mount, call `GET /api/profile/interview/session/`. Sending calls `POST /api/profile/interview/` with exactly `{message}`. Merge no local image values; pass `result.profile`, `result.profileReadiness`, and `result.missingDimensions` to `getProfileDimensionRows()`.

Preserve the existing session messages and next question. On failure, keep the typed message and expose retry plus the structured fallback link.

- [ ] **Step 3: Confirm only from server completion state**

```typescript
async function confirmFirstRunInterview() {
  const complete = Boolean(
    interviewResult?.interviewComplete || interviewResult?.interviewSession?.interviewComplete,
  );
  if (!complete) return null;
  const result = await a3PostJson<ProfileInterviewResult>('/api/profile/interview/', {
    action: 'confirm',
  });
  if (!result.success || !result.profileCommitted) return result;
  syncA3User(result.user);
  router.push('/a3/admission-diagnostic');
  return result;
}
```

Do not set `interviewComplete`, `profileCommitted`, or `generated` in local state.

- [ ] **Step 4: Load structured options only when needed**

The initial conversation view must not block on `/api/profiles/options/`. Load options when the user chooses “逐项确认”, retain the existing normalization against backend options, and show retry on failure.

Fallback submit posts `buildDiagnosticReadyProfilePayload()` to `/api/profiles/learning-profile/`, syncs only the returned real user, and follows `nextAction.href`.

- [ ] **Step 5: Render first-run before the returning editor**

When `!currentUser?.profileCompleted`, render:

```tsx
firstRunMode === 'conversation' ? (
  <ProfileInterviewFirstRun {...realInterviewProps} />
) : (
  <ProfileSetupWizard {...realStructuredProps} />
)
```

Returning users keep the detailed editor. Remove the student-facing `Agent 决策证据` section from this page only; `/a3/capabilities` remains unchanged.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-profile-interview-submit.test.ts tests/a3-real-user-polish-regressions.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 7: Commit**

```powershell
git add OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/tests/a3-profile-setup.test.ts
git commit -m "feat: integrate real conversational profile setup"
```

---

### Task 7: Prove Diagnostic and Later Learning Updates

**Files:**
- Modify: `backend/apps/learning/tests/test_path_planner.py`
- Modify: the existing focused test module for `backend/apps/profiles/profile_updates.py`
- Create: `OpenMAIC/e2e/tests/a3-profile-setup-conversation-first.spec.ts`

- [ ] **Step 1: Strengthen diagnostic write-back coverage**

Before the existing admission-diagnostic request, clear:

```python
profile.foundation_level = ""
profile.weak_points = []
profile.pace = ""
profile.save(update_fields=["foundation_level", "weak_points", "pace", "updated_at"])
```

After the same request, assert foundation and weak points are non-empty, an active path exists, `extra_profile.studyPlan` exists, and the Agent sequence is exactly:

```python
["DiagnosticAgent", "ProfileUpdateAgent", "PlannerAgent", "StudyPlanAgent"]
```

- [ ] **Step 2: Add one post-onboarding dynamic update regression**

Use the existing profile-update service invoked by wrong-question or assessment signals. Assert the update candidate/event has source `wrong_question` or the repository's existing equivalent, changes `weakPoints`, and appears in the dynamic profile update history. Do not create a parallel update mechanism.

- [ ] **Step 3: Run backend dynamic tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner backend.apps.profiles.tests --noinput
```

If broad profile tests include the documented course-default drift, run and report the exact focused classes proving Tasks 1 and 7 rather than changing course fixtures.

- [ ] **Step 4: Create the real Playwright flow**

The E2E test resets only the demo student's onboarding/profile state, logs in through the real UI, and verifies:

```typescript
await expect(page.getByTestId('a3-profile-interview-first-run')).toBeVisible();
await expect(page.getByTestId('a3-profile-guided-wizard')).toHaveCount(0);
await page.getByRole('textbox').fill('我是大二软件工程学生，学过 C 和数据结构，每天能学 40 分钟，想准备操作系统期末考试。');
await page.getByRole('button', { name: '发送', exact: true }).click();
await expect(page.getByTestId('a3-profile-dimension-summary')).toContainText(/已识别/);
```

Continue through real server follow-ups until `interviewComplete`; confirm through the real endpoint and assert navigation to `/a3/admission-diagnostic`. Add a separate test that switches to “逐项确认” and submits the real fallback.

- [ ] **Step 5: Verify responsive behavior and session restoration**

At 390, 768, 1100, and 1440 widths, assert document horizontal overflow is at most 1px. Send one message, reload, and assert the server-restored message and dimension count remain visible.

- [ ] **Step 6: Run E2E**

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-profile-setup-conversation-first.spec.ts e2e/tests/a3-profile-interview-loop.spec.ts --project=chromium
```

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/learning/tests/test_path_planner.py backend/apps/profiles/tests OpenMAIC/e2e/tests/a3-profile-setup-conversation-first.spec.ts
git commit -m "test: prove conversational and dynamic profile flow"
```

---

### Task 8: Full Verification and Deployment Readiness

**Files:** Verify only; modify feature-owned files solely to fix failures caused by Tasks 1-7.

- [ ] **Step 1: Frontend checks**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-profile-interview-submit.test.ts tests/a3-real-user-polish-regressions.test.ts tests/a3-planning-workspace-personalization.test.ts
```

Expected: no TypeScript or ESLint errors; only warnings listed in `AGENTS.md` may remain.

- [ ] **Step 2: Backend contract checks**

```powershell
cd ..
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings backend.apps.compat.tests.test_a3_requirements_deep_fill backend.apps.compat.tests.test_agent_runtime backend.apps.learning.tests.test_path_planner --noinput
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

- [ ] **Step 3: End-to-end checks**

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-profile-setup-conversation-first.spec.ts e2e/tests/a3-profile-interview-loop.spec.ts e2e/tests/a3-mobile-flow.spec.ts --project=chromium --trace on
```

Inspect the generated trace at 390 and 1440 widths for input/summary overlap, non-scrollable messages, and covered controls.

- [ ] **Step 4: Diff and secret review**

```powershell
cd ..
git status --short --branch
git diff --check
git diff --stat codex/a3-latest-integration...HEAD
git grep -n -I -E '(API_KEY|SECRET_KEY|SMTP_PASSWORD|ghp_)' -- ':!*.example' ':!docs/**'
```

Do not stage `control/`, `outputs/`, `.env*`, uploaded resources, local indexes, or runtime files.

- [ ] **Step 5: Final independent review**

The reviewer must verify all of the following from code and test evidence:

- conversation is the first-run default;
- at least six service-derived dimensions are visible;
- structured selection is secondary;
- no frontend completion/profile fabrication exists;
- all three Agent sequences remain exact;
- diagnosis and later learning signals update the same profile;
- no API path or core response field was renamed.

Fix every finding and rerun the affected checks before declaring the branch complete.

## Deployment Gate

Do not push or deploy until Task 8 passes. After push, backend and frontend GHCR workflows must finish for the same full Git SHA. Pin both resulting image digests in production and recreate only:

```text
backend
celery
celery-beat
frontend
realtime-proxy
caddy
```

Post-deployment smoke coverage:

```text
/a3/profile-setup default conversation
/a3/profile-setup structured fallback
/a3/profile-setup returning-user editor
/a3/admission-diagnostic write-back
profile_interview Agent trace
profile_setup Agent trace
admission_diagnostic Agent trace
dynamic profile update evidence
```
