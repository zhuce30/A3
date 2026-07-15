# A3 Profile Setup Guidance Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `/a3/profile-setup` page immediately understandable for first-time students without replacing its current conversation area or manual editor.

**Architecture:** Keep the current page, API paths, profile interview workflow, manual fields, and dynamic profile services. Simplify only the upper information hierarchy and student-facing copy, keep the lower manual editor as the existing fallback, and make pre-diagnostic planning explicitly deferred while preserving legacy session evidence.

**Tech Stack:** Django 5, A3 AgentKernel, Django TestCase, Next.js 15, React 19, TypeScript, Tailwind CSS, Vitest, Playwright.

---

## Contract Invariants

```text
POST /api/profile/interview/
SafetyAgent -> ProfileInterviewAgent -> LearnerModelAgent -> MemoryCommitAgent -> PlannerAgent

POST /api/profiles/learning-profile/
ProfileNormalizeAgent -> ProfileCommitAgent -> PlannerAgent -> StudyPlanAgent

POST /api/learning/admission-diagnostic/
DiagnosticAgent -> ProfileUpdateAgent -> PlannerAgent -> StudyPlanAgent
```

Do not add a four-step wizard, a mode switch, a mock endpoint, or a second first-run route. Do not remove the existing lower manual editor.

## File Map

### Backend

- `backend/apps/profiles/services.py`: already provides additive structured fallback compatibility.
- `backend/apps/compat/agent_kernel.py`: already defers structured fallback planning.
- `backend/apps/compat/profile_interview.py`: one-question follow-up, deferred interview planning, and legacy session evidence compatibility.
- Backend tests: profile, Agent sequence, interview session, diagnostic write-back, and dynamic updates.

### Frontend

- `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`: in-place upper-page layout and copy polish; lower manual editor remains.
- `OpenMAIC/lib/a3/auth-types.ts`: additive deferred session fields only.
- `OpenMAIC/lib/a3/profile-setup.ts`: correct helper copy and no fabricated interview completion.
- `OpenMAIC/tests/a3-profile-setup.test.ts`: helper behavior.
- `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`: learner-language and no-wizard guardrails.
- `OpenMAIC/e2e/tests/a3-profile-setup-guidance.spec.ts`: first-use guidance, real conversation, manual editor, session restore, and responsive layout.

---

### Task 1: Structured Fallback Compatibility

**Status:** Completed by `f39f6f1` and `8f43a57`.

- [x] `completionMode="diagnostic_ready"` is additive and never the default natural-language path.
- [x] Strict callers remain strict.
- [x] Deferred fields stay empty instead of storing fake values.
- [x] Invalid explicit completion modes are rejected.

### Task 2: Preserve Structured Agent Steps While Deferring Planning

**Status:** Completed by `92fa279` and `f9c5215`.

- [x] All four profile-setup Agent steps remain in trace.
- [x] Diagnostic-ready Planner and StudyPlan steps return deferred evidence.
- [x] Explicit and implicit complete modes still generate path and plan.

### Task 3: Preserve Interview Contracts and Legacy Session Evidence

**Files:**
- Modify: `backend/apps/compat/profile_interview.py`
- Modify: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`

**Status:** Core behavior completed by `3a5b4d4` and `f6155c2`; legacy evidence quality fix is in progress.

- [x] Keep the ten-dimension interview schema and five-step Agent sequence.
- [x] Ask one concrete learner-friendly question per turn.
- [x] Do not generate formal path/plan during message or confirm.
- [x] Persist `planningDeferred` and `planningDeferredReason` for new sessions.
- [ ] Preserve historical `generated` and deferred fields for legacy sessions; infer defaults only when the old session lacks them.
- [ ] Keep deterministic tests honest about mocked LLM extraction and avoid brittle full-copy assertions.
- [ ] Run focused interview/session tests, `manage.py check`, `git diff --check`, then commit.

---

### Task 4: Simplify the Existing Upper Page

**Files:**
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`
- Modify: `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`

- [ ] **Step 1: Add failing source-level UX guardrails**

Add assertions that the profile page contains:

```typescript
expect(source).toContain('告诉我们你的学习情况');
expect(source).toContain('不用一次说全');
expect(source).toContain('系统会根据你的回答逐项追问');
expect(source).toContain('发送并整理');
expect(source).toContain('查看示例');
expect(source).toContain('确认并开始入学诊断');
expect(source).toContain('想自己修改？展开手动填写');
```

And does not add or retain first-viewport technical copy:

```typescript
expect(source).not.toContain('画像与规划输入');
expect(source).not.toContain('先用一句话完成画像');
expect(source).not.toContain('对话生成画像');
expect(source).not.toContain('确认画像并生成诊断任务');
expect(source).not.toContain('Agent 决策证据');
expect(source).not.toContain('逐项确认');
expect(source).not.toContain('ProfileSetupWizard');
```

- [ ] **Step 2: Run RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-real-user-polish-regressions.test.ts tests/a3-profile-setup.test.ts
```

- [ ] **Step 3: Replace the upper heading and helper copy in place**

Keep the route and component. Replace the current title block with:

```tsx
<p className="text-sm font-semibold text-blue-600">学习设置</p>
<h1 className="mt-2 text-4xl font-semibold text-slate-950 md:text-5xl">
  告诉我们你的学习情况
</h1>
<p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
  不用一次说全。可以先说学习目标、以前学过什么或每天能学多久，
  系统会根据你的回答逐项追问，并把关键信息整理出来。
</p>
```

Keep the course title as a compact badge beside or below the heading. Remove “已同步/同步中” status copy from the first attention area.

- [ ] **Step 4: Replace the four planning cards with one compact three-step hint**

This is static guidance, not a wizard state machine:

```tsx
<ol aria-label="操作步骤" className="grid gap-2 sm:grid-cols-3">
  <li>1. 说说情况</li>
  <li>2. 回答追问</li>
  <li>3. 确认并开始诊断</li>
</ol>
```

Remove the `planningStages` array and the local `ProfilePlanningStage` component if no call sites remain.

- [ ] **Step 5: Make the current question and input the primary content**

Initial assistant copy becomes:

```text
先说说你学习这门课最想解决什么问题？
```

Supporting copy:

```text
可以只回答一个方面，不需要一次把所有信息写完整。
```

Keep the existing textarea, message thread, API callbacks, and scroll behavior. Rename buttons:

```text
对话生成画像 -> 发送并整理
填入当前课程示例 -> 查看示例
确认画像并生成诊断任务 -> 确认并开始入学诊断
```

Do not add another input mode or another form.

- [ ] **Step 6: Reduce first-viewport technical panels**

Remove the student-facing `Agent 决策证据` disclosure and `evidenceOpen` state from this page. Keep `/a3/capabilities` unchanged. Rename visible summary titles:

```text
动态画像摘要 -> 系统已了解
画像变化确认 -> 最近整理的信息
```

Do not display `traceId`, `Agent`, `认知风格`, or `动机风险` in the upper section. Existing update and dynamic data may remain below or in the side column with learner-friendly labels.

- [ ] **Step 7: Keep and relabel the existing manual editor**

Do not change its fields, options, or submit callback. Only change the disclosure copy:

```text
想自己修改？展开手动填写
可以补充或修改系统刚才整理的信息。
```

- [ ] **Step 8: Run GREEN and commit**

```powershell
pnpm.cmd vitest run tests/a3-real-user-polish-regressions.test.ts tests/a3-profile-setup.test.ts
npx.cmd tsc --noEmit
```

```powershell
git add OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/tests/a3-real-user-polish-regressions.test.ts OpenMAIC/tests/a3-profile-setup.test.ts
git commit -m "feat: clarify first-use profile guidance"
```

---

### Task 5: Align Frontend Session and Confirmation Semantics

**Files:**
- Modify: `OpenMAIC/lib/a3/auth-types.ts`
- Modify: `OpenMAIC/lib/a3/profile-setup.ts`
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`
- Modify: `OpenMAIC/tests/a3-profile-interview-submit.test.ts`

- [ ] **Step 1: Add deferred session fields without renaming existing fields**

```typescript
planningDeferred?: boolean;
planningDeferredReason?: string;
```

Add them to interview result/session types only. Keep every current server field optional and compatible.

- [ ] **Step 2: Preserve real session restoration**

`GET /api/profile/interview/session/` remains the only restoration source. Do not derive completion from local message count or profile field count.

- [ ] **Step 3: Keep message and confirm requests exact**

```typescript
await a3PostJson('/api/profile/interview/', { message: messageText });
await a3PostJson('/api/profile/interview/', { action: 'confirm' });
```

Only enable confirm from server `interviewComplete`. Only proceed when confirm returns `success` and `profileCommitted`.

- [ ] **Step 4: Correct post-confirm copy for deferred planning**

Replace any claim that the path or 14-day plan was refreshed during interview with:

```text
学习情况已保存，接下来通过几道题确认你的学习起点。
```

The next action remains `/a3/admission-diagnostic`. Do not show `generated.path/studyPlan=false` as an error; it is expected before diagnosis.

- [ ] **Step 5: Humanize errors**

Use:

```text
请先回答当前问题。
暂时无法整理这次回答，请稍后重试。
还需要补充一项信息，请先回答上方问题。
```

Do not mention “表单模式”, Agent, provider, schema, trace, or internal missing field names.

- [ ] **Step 6: Run and commit**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-profile-interview-submit.test.ts tests/a3-real-user-polish-regressions.test.ts
npx.cmd tsc --noEmit
```

```powershell
git add OpenMAIC/lib/a3/auth-types.ts OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/tests/a3-profile-setup.test.ts OpenMAIC/tests/a3-profile-interview-submit.test.ts
git commit -m "fix: align profile confirmation with diagnosis"
```

---

### Task 6: Verify First-Use Guidance and Responsive Behavior

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-profile-setup-guidance.spec.ts`
- Modify: `OpenMAIC/e2e/tests/a3-profile-interview-loop.spec.ts` only when selectors or expected copy changed.

- [ ] **Step 1: Reset only the demo student's onboarding profile**

Use the existing `runManage`/login patterns. Do not delete shared course or assessment fixtures.

- [ ] **Step 2: Verify the first viewport**

```typescript
await page.goto('/a3/profile-setup');
await expect(page.getByRole('heading', { name: '告诉我们你的学习情况' })).toBeVisible();
await expect(page.getByTestId('a3-profile-interview-input')).toBeVisible();
await expect(page.getByRole('button', { name: '发送并整理' })).toBeVisible();
await expect(page.getByText('想自己修改？展开手动填写')).toBeVisible();
await expect(page.getByText('Agent 决策证据')).toHaveCount(0);
```

- [ ] **Step 3: Exercise the real conversation**

Send a natural-language answer through the UI, wait for the real API response, assert one follow-up is shown, and reload to prove the session restores. Do not intercept the endpoint with a mock.

- [ ] **Step 4: Verify the manual editor remains**

Open the existing disclosure and assert grade, major, goals, daily time, preferences, resources, weak points, and pace controls remain accessible.

- [ ] **Step 5: Verify responsive behavior**

At 390, 768, 1100, and 1440 widths, assert horizontal overflow is at most 1px, the message thread scrolls, and the input/buttons are not covered.

- [ ] **Step 6: Run and commit**

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-profile-setup-guidance.spec.ts e2e/tests/a3-profile-interview-loop.spec.ts --project=chromium --trace on
```

```powershell
git add OpenMAIC/e2e/tests/a3-profile-setup-guidance.spec.ts OpenMAIC/e2e/tests/a3-profile-interview-loop.spec.ts
git commit -m "test: cover profile setup guidance"
```

---

### Task 7: Verify Diagnosis and Dynamic Updates

**Files:**
- Modify: `backend/apps/learning/tests/test_path_planner.py`
- Modify: the existing focused profile-update test module only if coverage is missing.

- [ ] Clear `foundation_level`, `weak_points`, and `pace` before the existing admission diagnostic request.
- [ ] Assert the same request fills real profile values, creates an active path, creates the study plan, and keeps the exact four-step diagnostic Agent sequence.
- [ ] Verify one existing wrong-question or assessment signal produces a dynamic profile update without creating a parallel update mechanism.
- [ ] Run focused backend tests and commit only necessary test changes.

---

### Task 8: Full Verification and Deployment Readiness

- [ ] Frontend: `npx.cmd tsc --noEmit`, `pnpm.cmd lint`, focused Vitest.
- [ ] Backend: focused profile/interview/Agent/diagnostic tests, `manage.py check`, `validate_demo_flow --skip-seed --strict`.
- [ ] E2E: profile guidance, interview loop, mobile flow.
- [ ] Inspect Playwright trace at 390 and 1440 widths.
- [ ] Run `git diff --check`, secret scan, and final independent code review.
- [ ] Do not push or deploy until all feature-caused failures are fixed.

## Deployment Gate

After verification, push one full SHA and wait for backend/frontend GHCR images for that same SHA. Pin both image digests and recreate only backend, celery, celery-beat, frontend, realtime-proxy, and caddy. Post-deployment smoke must cover the upper guidance, real interview, manual editor, admission diagnostic, and three Agent traces.
