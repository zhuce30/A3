# A3 Profile Setup Progressive Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the first-run profile dashboard with a four-step learner-friendly setup while preserving the real profile, interview, diagnostic, and AgentKernel contracts.

**Architecture:** Keep `/a3/profile-setup` and all existing API paths. Add an opt-in `completionMode="diagnostic_ready"` branch to the structured profile workflow so first-time users can defer foundation, weak-point, and pace judgments to admission diagnostics; all existing callers retain strict behavior. Render a new first-run wizard when `profileCompleted` is false, keep the existing detailed editor for returning users, and retain the existing interview workflow as an optional input mode without allowing the frontend to invent completion state.

**Tech Stack:** Django 5, Django TestCase, A3 AgentKernel, Next.js 15, React 19, TypeScript, Tailwind CSS, Vitest, Playwright.

---

## File Map

### Backend

- Modify `backend/apps/profiles/services.py`: completion-mode validation, `setupReadiness`, partial persistence, additive response fields.
- Modify `backend/apps/compat/agent_kernel.py`: propagate completion mode and emit Planner/StudyPlan deferred evidence without changing step order.
- Modify `backend/apps/compat/profile_interview.py`: human-readable follow-up copy and diagnostic-deferred planning while preserving response shape.
- Modify `backend/apps/profiles/tests/test_profile_settings.py`: strict-mode compatibility and diagnostic-ready contract tests.
- Modify `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`: interview confirm and deferred generation contract tests.
- Modify `backend/apps/compat/tests/test_agent_runtime.py`: explicit profile-setup workflow sequence contract.
- Modify `backend/apps/learning/tests/test_path_planner.py`: diagnostic still fills deferred profile dimensions and generates path/plan.

### Frontend

- Modify `OpenMAIC/lib/a3/auth-types.ts`: additive setup-readiness and response types.
- Modify `OpenMAIC/lib/a3/profile-setup.ts`: first-run readiness, payload construction, and submission decision pure functions.
- Create `OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx`: controlled four-step guided flow.
- Create `OpenMAIC/components/a3/profile-setup/profile-setup-example.tsx`: inline accessible example and reduced-motion behavior.
- Create `OpenMAIC/components/a3/profile-setup/profile-interview-first-run.tsx`: first-run presentation for the existing interview state and callbacks.
- Modify `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`: first-run/returning mode selection and real API orchestration.
- Modify `OpenMAIC/tests/a3-profile-setup.test.ts`: helper and payload tests.
- Modify `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`: learner-facing copy guardrails.
- Create `OpenMAIC/e2e/tests/a3-profile-setup-progressive.spec.ts`: real guided-flow and responsive checks.

## Contract Invariants

The implementation must preserve these paths and Agent sequences:

```text
POST /api/profiles/learning-profile/
ProfileNormalizeAgent -> ProfileCommitAgent -> PlannerAgent -> StudyPlanAgent

POST /api/profile/interview/
SafetyAgent -> ProfileInterviewAgent -> LearnerModelAgent -> MemoryCommitAgent -> PlannerAgent

POST /api/learning/admission-diagnostic/
DiagnosticAgent -> ProfileUpdateAgent -> PlannerAgent -> StudyPlanAgent
```

Do not add a Next.js mock route for any of these endpoints. Frontend requests continue through `a3GetJson` and `a3PostJson`.

---

### Task 1: Add Diagnostic-Ready Profile Validation

**Files:**
- Modify: `backend/apps/profiles/tests/test_profile_settings.py`
- Modify: `backend/apps/profiles/services.py:280-429`

- [ ] **Step 1: Add a reusable test payload helper**

Add this method to `ProfileSettingsTests`:

```python
def diagnostic_ready_payload(self) -> dict:
    options = self.client.get("/api/profiles/options/").json()["options"]
    return {
        "completionMode": "diagnostic_ready",
        "displayName": "渐进学习者",
        "majorDirection": options["majorDirections"][0],
        "grade": options["grades"][0],
        "dailyStudyTime": options["dailyStudyTimes"][0],
        "learningGoals": [options["learningGoals"][0]],
        "learningPreferences": [options["learningPreferences"][0]],
        "expectedResources": [options["expectedResources"][0]],
    }
```

- [ ] **Step 2: Write failing compatibility and partial-profile tests**

Add these tests:

```python
def test_diagnostic_ready_profile_accepts_deferred_dimensions_without_fake_values(self):
    response = self.client.post(
        "/api/profiles/learning-profile/",
        data=json.dumps(self.diagnostic_ready_payload()),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 200, response.content)
    data = response.json()
    self.assertEqual(data["setupReadiness"]["status"], "ready_for_diagnostic")
    self.assertEqual(
        data["setupReadiness"]["deferredDimensions"],
        ["foundationLevel", "weakPoints", "pace"],
    )
    profile = LearnerProfile.objects.get(user=self.user)
    self.assertEqual(profile.foundation_level, "")
    self.assertEqual(profile.weak_points, [])
    self.assertEqual(profile.pace, "")
    self.user.refresh_from_db()
    self.assertTrue(self.user.profile_completed)
    self.assertEqual(self.user.onboarding_step, "complete")

def test_strict_profile_mode_still_rejects_the_same_partial_payload(self):
    payload = self.diagnostic_ready_payload()
    payload.pop("completionMode")

    response = self.client.post(
        "/api/profiles/learning-profile/",
        data=json.dumps(payload),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 400)
    self.assertIn("基础水平", response.json()["error"])

def test_diagnostic_ready_profile_still_requires_real_learning_inputs(self):
    payload = self.diagnostic_ready_payload()
    payload["learningPreferences"] = []

    response = self.client.post(
        "/api/profiles/learning-profile/",
        data=json.dumps(payload),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 400)
    self.assertIn("学习偏好", response.json()["error"])
```

- [ ] **Step 3: Run the tests and verify they fail**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_diagnostic_ready_profile_accepts_deferred_dimensions_without_fake_values backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_strict_profile_mode_still_rejects_the_same_partial_payload backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_diagnostic_ready_profile_still_requires_real_learning_inputs
```

Expected: FAIL because `completionMode` is ignored and strict validation rejects the partial payload.

- [ ] **Step 4: Implement mode-aware validation and setup readiness**

In `backend/apps/profiles/services.py`, replace the single strict validator with mode-aware helpers:

```python
PROFILE_COMPLETION_MODE_COMPLETE = "complete"
PROFILE_COMPLETION_MODE_DIAGNOSTIC_READY = "diagnostic_ready"


def _profile_completion_mode(payload: dict) -> str:
    mode = str(payload.get("completionMode") or PROFILE_COMPLETION_MODE_COMPLETE).strip()
    if mode not in {PROFILE_COMPLETION_MODE_COMPLETE, PROFILE_COMPLETION_MODE_DIAGNOSTIC_READY}:
        raise ValueError("completionMode 不受支持")
    return mode


def _profile_payload_checks(payload: dict, mode: str) -> list[tuple[str, str, bool]]:
    checks = [
        ("majorDirection", "专业方向", bool(str(payload.get("majorDirection") or "").strip())),
        ("grade", "年级", bool(str(payload.get("grade") or "").strip())),
        ("learningGoals", "学习目标", isinstance(payload.get("learningGoals"), list) and bool(payload.get("learningGoals"))),
        ("learningPreferences", "学习偏好", isinstance(payload.get("learningPreferences"), list) and bool(payload.get("learningPreferences"))),
        ("dailyStudyTime", "每日时间", bool(str(payload.get("dailyStudyTime") or "").strip())),
        ("expectedResources", "资源类型", isinstance(payload.get("expectedResources"), list) and bool(payload.get("expectedResources"))),
    ]
    if mode == PROFILE_COMPLETION_MODE_COMPLETE:
        checks.extend([
            ("foundationLevel", "基础水平", bool(str(payload.get("foundationLevel") or "").strip())),
            ("weakPoints", "薄弱知识点", isinstance(payload.get("weakPoints"), list) and bool(payload.get("weakPoints"))),
            ("pace", "学习节奏", bool(str(payload.get("pace") or "").strip())),
        ])
    return checks


def _validate_learning_profile_payload(payload: dict) -> str:
    mode = _profile_completion_mode(payload)
    missing = [label for _field, label, ready in _profile_payload_checks(payload, mode) if not ready]
    if missing:
        raise ValueError(f"请先补齐：{'、'.join(missing)}")
    return mode


def setup_readiness(profile: LearnerProfile | None) -> dict:
    checks = [
        ("majorDirection", bool(profile and profile.major_direction)),
        ("grade", bool(profile and profile.grade)),
        ("learningGoals", bool(profile and profile.learning_goals)),
        ("learningPreferences", bool(profile and profile.learning_preferences)),
        ("dailyStudyTime", bool(profile and profile.daily_study_time)),
        ("expectedResources", bool(profile and profile.expected_resources)),
    ]
    missing = [field for field, ready in checks if not ready]
    deferred = []
    if not profile or not profile.foundation_level:
        deferred.append("foundationLevel")
    if not profile or not profile.weak_points:
        deferred.append("weakPoints")
    if not profile or not profile.pace:
        deferred.append("pace")
    return {
        "status": "ready_for_diagnostic" if not missing else "incomplete",
        "missingRequiredFields": missing,
        "deferredDimensions": deferred,
    }
```

Update `profile_next_action` so diagnostic-ready profiles are not sent back to the setup page:

```python
def profile_next_action(user: User, profile: LearnerProfile | None) -> dict:
    if not user.privacy_accepted:
        return {"label": "完成隐私授权", "href": "/a3/privacy", "reason": "未授权前不进行个性化画像处理"}
    setup = setup_readiness(profile)
    if setup["status"] == "ready_for_diagnostic":
        return {"label": "开始入学诊断", "href": "/a3/admission-diagnostic", "reason": "学习设置已保存，诊断会补齐基础和薄弱点"}
    return {"label": "补齐学习设置", "href": "/a3/profile-setup", "reason": "进入诊断所需的学习设置仍不完整"}
```

Update `_save_learning_profile_core` to call `_validate_learning_profile_payload(payload)`, preserve absent optional fields, and set `profile_completed` only when `setup_readiness(profile)` is ready. Add `setupReadiness` to the returned payload. Update `save_learning_profile` to call the new validator and include `setupReadiness` in its final response.

- [ ] **Step 5: Run the focused profile tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings
```

Expected: PASS, including the existing strict save and invalid-domain tests.

- [ ] **Step 6: Commit the validation contract**

```powershell
git add backend/apps/profiles/services.py backend/apps/profiles/tests/test_profile_settings.py
git commit -m "feat: support diagnostic-ready profile setup"
```

---

### Task 2: Preserve Agent Steps While Deferring Planning

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py:886-962,352-427,1927-2018`
- Modify: `backend/apps/profiles/services.py:408-429`
- Modify: `backend/apps/profiles/tests/test_profile_settings.py`
- Modify: `backend/apps/compat/tests/test_agent_runtime.py`

- [ ] **Step 1: Add a workflow-sequence contract test**

Add to `backend/apps/compat/tests/test_agent_runtime.py`:

```python
def test_profile_setup_workflow_contract_matches_kernel_agent_sequence(self):
    from backend.apps.compat.agent_kernel import PROFILE_SETUP_WORKFLOW_SEQUENCE
    from backend.apps.compat.agent_workflows import get_agent_workflow_contract

    contract = get_agent_workflow_contract("profile_setup")
    self.assertEqual(tuple(PROFILE_SETUP_WORKFLOW_SEQUENCE), contract.required_steps)
```

The existing `profile_setup` contract in `agent_workflows.py` is the source of truth; this task only adds the missing sequence-equality regression test.

- [ ] **Step 2: Add a failing deferred-trace test**

Add to `ProfileSettingsTests`:

```python
def test_diagnostic_ready_profile_keeps_agent_steps_and_defers_generation(self):
    response = self.client.post(
        "/api/profiles/learning-profile/",
        data=json.dumps(self.diagnostic_ready_payload()),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 200, response.content)
    data = response.json()
    self.assertEqual(data["generated"], {"path": False, "studyPlan": False})
    self.assertFalse(LearningPath.objects.filter(user=self.user, status="active").exists())
    run = AgentRun.objects.prefetch_related("steps").get(trace_id=data["traceId"])
    steps = list(run.steps.order_by("order"))
    self.assertEqual(
        [step.name for step in steps],
        ["ProfileNormalizeAgent", "ProfileCommitAgent", "PlannerAgent", "StudyPlanAgent"],
    )
    planner = next(step for step in steps if step.name == "PlannerAgent")
    study_plan = next(step for step in steps if step.name == "StudyPlanAgent")
    self.assertEqual(planner.metadata["evidence"]["reason"], "awaiting_admission_diagnostic")
    self.assertEqual(study_plan.metadata["evidence"]["reason"], "awaiting_admission_diagnostic")
```

- [ ] **Step 3: Run and verify the deferred test fails**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_diagnostic_ready_profile_keeps_agent_steps_and_defers_generation
```

Expected: FAIL because PlannerAgent and StudyPlanAgent currently generate path and plan.

- [ ] **Step 4: Propagate completion mode through Agent state**

Update `ProfileNormalizeAgent.run`:

```python
completion_mode = str(payload.get("completionMode") or "complete")
planning_deferred = completion_mode == "diagnostic_ready"
return AgentResult(
    output={"normalizedProfileInput": payload, "completionMode": completion_mode},
    state_patch={
        "normalizedProfileInput": payload,
        "completionMode": completion_mode,
        "planningDeferred": planning_deferred,
        "weakPoints": payload.get("weakPoints") if isinstance(payload.get("weakPoints"), list) else [],
    },
    evidence={
        "source": "structured_profile_setup_form",
        "completionMode": completion_mode,
        "planningDeferred": planning_deferred,
        "scalarFieldCount": len(scalar_fields),
        "multiFieldCounts": selected_counts,
    },
    quality={"hasRequiredProfileSignals": bool(scalar_fields)},
)
```

Keep the existing summaries and state-diff metadata around this code; only add the mode fields and stop requiring a weak point for the quality signal in diagnostic-ready mode.

Update `ProfileCommitAgent` so `setupReadiness` from `_save_learning_profile_core` is copied into output, state, evidence, and quality.

- [ ] **Step 5: Add explicit deferred Agent results**

At the start of the `profile_setup` branch in `PlannerAgent.run`, before calling `generate_learning_path`, add:

```python
if context.state.get("planningDeferred"):
    return AgentResult(
        output={"path": None, "pathGenerated": False, "planningDeferred": True},
        state_patch={"pathGenerated": False, "planningDeferred": True},
        state_diff={"LearningPath": "deferred"},
        evidence={"reason": "awaiting_admission_diagnostic", "completionMode": "diagnostic_ready"},
        quality={"deferredSafely": True, "hasPathItems": False},
        detail="Defer formal learning path generation until admission diagnostic evidence is available.",
    )
```

At the start of the `profile_setup` branch in `StudyPlanAgent.run`, add:

```python
if context.state.get("planningDeferred"):
    return AgentResult(
        output={"studyPlan": None, "studyPlanGenerated": False, "studyPlanDeferred": True},
        state_patch={"studyPlanGenerated": False, "studyPlanDeferred": True},
        state_diff={"studyPlan": "deferred"},
        evidence={"reason": "awaiting_admission_diagnostic", "completionMode": "diagnostic_ready"},
        quality={"deferredSafely": True, "hasTodayTasks": False},
        detail="Defer formal study plan generation until admission diagnostic evidence is available.",
    )
```

Do not remove either agent from `PROFILE_SETUP_WORKFLOW_SEQUENCE`.

- [ ] **Step 6: Run Agent and profile contract tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings backend.apps.compat.tests.test_agent_runtime
```

Expected: PASS. Existing complete-mode tests must still assert `generated.path == true` and `generated.studyPlan == true`.

- [ ] **Step 7: Commit the Agent defer behavior**

```powershell
git add backend/apps/compat/agent_kernel.py backend/apps/compat/tests/test_agent_runtime.py backend/apps/profiles/services.py backend/apps/profiles/tests/test_profile_settings.py
git commit -m "feat: defer first-run planning until diagnosis"
```

---

### Task 3: Keep Interview Contracts and Humanize Follow-Ups

**Files:**
- Modify: `backend/apps/compat/profile_interview.py:39-64,200-298,791-811`
- Modify: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py:502-593`

- [ ] **Step 1: Change the existing confirm test to the intended diagnostic-deferred contract**

Rename `test_profile_interview_confirm_commits_profile_and_refreshes_plan` to `test_profile_interview_confirm_commits_profile_and_defers_plan_until_diagnostic`, then replace its generated assertions with:

```python
self.assertFalse(payload["generated"]["path"])
self.assertFalse(payload["generated"]["studyPlan"])
self.assertTrue(payload["planningDeferred"])
self.assertEqual(payload["planningDeferredReason"], "awaiting_admission_diagnostic")
refreshed = LearnerProfile.objects.get(user=self.user)
self.assertFalse(bool(refreshed.extra_profile.get("studyPlan")))
```

Keep the assertions for `profileCommitted`, `confirmedAt`, `profile_completed`, workflow name, and the five-step sequence. Immediately after the test assigns `steps = list(run.steps.order_by("order"))`, add:

```python
planner = next(step for step in steps if step.name == "PlannerAgent")
self.assertEqual(planner.metadata["evidence"]["reason"], "awaiting_admission_diagnostic")
```

- [ ] **Step 2: Add a user-facing follow-up-copy test**

Add:

```python
def test_profile_interview_hides_internal_dimension_labels_from_student_prompt(self):
    profile = LearnerProfile.objects.get(user=self.user)
    profile.grade = "大二"
    profile.major_direction = "软件工程"
    profile.foundation_level = "基础一般"
    profile.daily_study_time = 40
    profile.learning_goals = ["课程同步"]
    profile.weak_points = ["进程调度"]
    profile.expected_resources = ["视频课程"]
    profile.save()

    response = self.client.post(
        "/api/profile/interview/",
        data=json.dumps({"message": "我以前断断续续学过，最近容易拖延。"}),
        content_type="application/json",
    )

    self.assertEqual(response.status_code, 200)
    prompt = response.json()["nextQuestion"]
    self.assertNotIn("动机风险", prompt)
    self.assertNotIn("认知风格", prompt)
    self.assertIn("学习", prompt)
```

- [ ] **Step 3: Run and verify the interview tests fail**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_profile_interview_confirm_commits_profile_and_defers_plan_until_diagnostic backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_profile_interview_hides_internal_dimension_labels_from_student_prompt
```

Expected: FAIL because the interview Planner still generates assets and `_next_question` exposes raw labels.

- [ ] **Step 4: Defer interview planning without changing response keys**

In `ProfileInterviewPlannerAgent.run`, remove the early calls to `generate_learning_path` and `generate_study_plan`. Keep `path_payload = None` and `plan_payload = None` for both `message` and `confirm`, and add to the returned output:

```python
"generated": {"path": None, "studyPlan": False},
"planningDeferred": True,
"planningDeferredReason": "awaiting_admission_diagnostic",
```

Add the same reason to Agent evidence and quality:

```python
evidence={
    "pathGenerated": False,
    "planGenerated": False,
    "reason": "awaiting_admission_diagnostic",
},
quality={"readyForDiagnostic": bool(context.state.get("profileCommitted"))},
```

Do not change `PROFILE_INTERVIEW_WORKFLOW_SEQUENCE`, session schema version, `traceId`, `profileCommitted`, or `interviewComplete` behavior.

- [ ] **Step 5: Map internal fields to concrete student questions**

Add near `ASK_PRIORITY_ORDER`:

```python
INTERVIEW_QUESTION_COPY = {
    "learningGoals": "你学习这门课最想解决什么，例如跟上课程、准备考试或完成项目？",
    "weakPoints": "目前哪些知识点或题型最容易卡住？不确定也可以直接说明。",
    "dailyMinutes": "你每天通常能安排多少分钟学习？",
    "foundationLevel": "你现在更接近刚开始、听过但不会做题，还是能独立完成基础题？",
    "resourcePreferences": "视频、图解、例题、讲义或实验中，哪些形式更容易帮助你理解？",
    "cognitiveStyle": "遇到新概念时，你更喜欢先看直观例子，还是先看原理再练习？",
    "majorDirection": "你的专业方向是什么？",
    "grade": "你目前是哪个年级？",
    "learningHistory": "你以前是否学过相关内容，大概学到哪里？",
    "motivationRisk": "最近坚持学习时最容易遇到什么困难，例如时间不固定、容易拖延或缺少反馈？",
}
```

Replace `_next_question` with:

```python
def _next_question(ask_fields: list[dict]) -> str:
    if not ask_fields:
        return "学习情况已经比较完整。确认后可以进入入学诊断。"
    prompts = [
        INTERVIEW_QUESTION_COPY.get(str(item.get("field") or ""), "请继续补充你的学习情况。")
        for item in ask_fields
    ]
    return " ".join(prompts)
```

- [ ] **Step 6: Run the full interview test module**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_a3_requirements_deep_fill
```

Expected: PASS with unchanged message, confirm, session, trace, and step-order contracts.

- [ ] **Step 7: Commit interview compatibility changes**

```powershell
git add backend/apps/compat/profile_interview.py backend/apps/compat/tests/test_a3_requirements_deep_fill.py
git commit -m "fix: make profile interview learner friendly"
```

---

### Task 4: Add Frontend Setup Types and Pure Functions

**Files:**
- Modify: `OpenMAIC/lib/a3/auth-types.ts:11-87`
- Modify: `OpenMAIC/lib/a3/profile-setup.ts`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`

- [ ] **Step 1: Write failing payload and readiness tests**

Extend imports in `a3-profile-setup.test.ts`, then add:

```typescript
it('builds diagnostic-ready payload without deferred fake values', () => {
  const profile = {
    ...current,
    foundationLevel: '',
    weakPoints: [],
    pace: '',
  };

  expect(buildDiagnosticReadyProfilePayload(profile, '测试同学')).toEqual({
    completionMode: 'diagnostic_ready',
    displayName: '测试同学',
    majorDirection: '自动化专业',
    grade: '大二',
    learningGoals: ['掌握自动控制原理'],
    learningPreferences: ['课堂讲解'],
    dailyStudyTime: '60',
    expectedResources: ['视频课程'],
  });
});

it('reports only fields required before admission diagnostic', () => {
  expect(getMissingDiagnosticReadyFields(createEmptyLearningProfile())).toEqual([
    '专业方向',
    '年级',
    '学习目标',
    '学习偏好',
    '每日时间',
    '资源类型',
  ]);
});

it('does not mix learning preferences with resource types', () => {
  const payload = buildDiagnosticReadyProfilePayload(current, '测试同学');
  expect(payload.learningPreferences).toEqual(['课堂讲解']);
  expect(payload.expectedResources).toEqual(['视频课程']);
});
```

- [ ] **Step 2: Run and verify the Vitest file fails**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-setup.test.ts
```

Expected: FAIL because the helper functions do not exist.

- [ ] **Step 3: Add additive response types**

Add to `auth-types.ts`:

```typescript
export type ProfileSetupReadiness = {
  status: 'ready_for_diagnostic' | 'incomplete';
  missingRequiredFields: string[];
  deferredDimensions: Array<'foundationLevel' | 'weakPoints' | 'pace' | string>;
};

export type DiagnosticReadyProfilePayload = {
  completionMode: 'diagnostic_ready';
  displayName: string;
  majorDirection: string;
  grade: string;
  learningGoals: string[];
  learningPreferences: string[];
  dailyStudyTime: string;
  expectedResources: string[];
  foundationLevel?: string;
  weakPoints?: string[];
};
```

Extend the local `ApiResult` in `a3-auth-pages.tsx` with `setupReadiness?: ProfileSetupReadiness`; do not remove existing fields. Also extend the local `ProfileInterviewResult` type without removing existing keys:

```typescript
planningDeferred?: boolean;
planningDeferredReason?: string;
```

- [ ] **Step 4: Implement pure helpers**

Add to `profile-setup.ts`:

```typescript
import type {
  A3LearningProfile,
  DiagnosticReadyProfilePayload,
  LearningProfileOptions,
} from '@/lib/a3/auth-types';

export function getMissingDiagnosticReadyFields(profile: A3LearningProfile): string[] {
  const checks: Array<[string, boolean]> = [
    ['专业方向', Boolean(profile.majorDirection)],
    ['年级', Boolean(profile.grade)],
    ['学习目标', profile.learningGoals.length > 0],
    ['学习偏好', profile.learningPreferences.length > 0],
    ['每日时间', Boolean(profile.dailyStudyTime)],
    ['资源类型', profile.expectedResources.length > 0],
  ];
  return checks.filter(([, ready]) => !ready).map(([label]) => label);
}

export function buildDiagnosticReadyProfilePayload(
  profile: A3LearningProfile,
  displayName: string,
): DiagnosticReadyProfilePayload {
  const payload: DiagnosticReadyProfilePayload = {
    completionMode: 'diagnostic_ready',
    displayName: displayName.trim(),
    majorDirection: profile.majorDirection,
    grade: profile.grade,
    learningGoals: [...profile.learningGoals],
    learningPreferences: [...profile.learningPreferences],
    dailyStudyTime: profile.dailyStudyTime,
    expectedResources: [...profile.expectedResources],
  };
  if (profile.foundationLevel) payload.foundationLevel = profile.foundationLevel;
  if (profile.weakPoints.length) payload.weakPoints = [...profile.weakPoints];
  return payload;
}
```

- [ ] **Step 5: Run focused frontend tests and typecheck**

Run:

```powershell
pnpm.cmd vitest run tests/a3-profile-setup.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit frontend domain helpers**

```powershell
git add OpenMAIC/lib/a3/auth-types.ts OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/tests/a3-profile-setup.test.ts OpenMAIC/components/a3/auth/a3-auth-pages.tsx
git commit -m "feat: add progressive profile setup state"
```

---

### Task 5: Build the Four-Step Guided Wizard

**Files:**
- Create: `OpenMAIC/components/a3/profile-setup/profile-setup-example.tsx`
- Create: `OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx`
- Modify: `OpenMAIC/tests/a3-real-user-polish-regressions.test.ts`

- [ ] **Step 1: Add source-level copy and structure guards**

Update `a3-real-user-polish-regressions.test.ts` to read the new wizard source and add:

```typescript
const profileWizard = readFileSync(
  join(root, 'components/a3/profile-setup/profile-setup-wizard.tsx'),
  'utf8',
);

it('uses learner language and one diagnostic-ready primary action', () => {
  expect(profileWizard).toContain('设置你的学习方式');
  expect(profileWizard).toContain('第 {step} / 4 步');
  expect(profileWizard).toContain('不确定，让入学诊断判断');
  expect(profileWizard).toContain('保存并开始入学诊断');
  expect(profileWizard).not.toContain('动机风险');
  expect(profileWizard).not.toContain('认知风格');
  expect(profileWizard).not.toContain('Agent 决策证据');
  expect(profileWizard).not.toContain('trace');
  expect(authPages).not.toContain('Agent 决策证据');
});
```

- [ ] **Step 2: Run and verify the test fails**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-real-user-polish-regressions.test.ts
```

Expected: FAIL because the wizard file does not exist.

- [ ] **Step 3: Create the inline example component**

Implement `profile-setup-example.tsx` with this complete public contract:

```tsx
'use client';

import { useState } from 'react';
import { ChevronDown, PlayCircle } from 'lucide-react';

export function ProfileSetupExample() {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-5 border-t border-slate-200 pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 text-sm font-semibold text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <PlayCircle className="size-4" aria-hidden="true" />
        查看填写示例
        <ChevronDown className={open ? 'size-4 rotate-180 transition-transform motion-reduce:transition-none' : 'size-4 transition-transform motion-reduce:transition-none'} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mt-3 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 sm:grid-cols-3">
          <div><strong className="block text-slate-950">目标</strong>准备期末考试，补齐基础</div>
          <div><strong className="block text-slate-950">时间</strong>每天 30 分钟</div>
          <div><strong className="block text-slate-950">方式</strong>图解流程、逐步例题</div>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Create the controlled wizard**

Implement `profile-setup-wizard.tsx` with these exported props and behaviors:

```tsx
'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProfileSetupExample } from './profile-setup-example';
import { getMissingDiagnosticReadyFields } from '@/lib/a3/profile-setup';
import type { A3LearningProfile, LearningProfileOptions, ProfileOption } from '@/lib/a3/auth-types';

type WizardProps = {
  profile: A3LearningProfile;
  options: LearningProfileOptions;
  courseTitle: string;
  submitting: boolean;
  message: string;
  step: 1 | 2 | 3 | 4;
  onStepChange: (step: 1 | 2 | 3 | 4) => void;
  onProfileChange: (profile: A3LearningProfile) => void;
  onSubmit: () => void;
};

function optionItem(option: string | ProfileOption) {
  return typeof option === 'string' ? { value: option, label: option } : option;
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function ChoiceGroup({
  testId,
  label,
  options,
  selected,
  multiple = false,
  onChange,
}: {
  testId: string;
  label: string;
  options: Array<string | ProfileOption>;
  selected: string[];
  multiple?: boolean;
  onChange: (values: string[]) => void;
}) {
  const [help, setHelp] = useState('选择最接近你当前情况的一项，没有标准答案。');
  return (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend className="text-base font-semibold text-slate-950">{label}</legend>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {options.map((source) => {
          const item = optionItem(source);
          const active = selected.includes(item.value);
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={active}
              onFocus={() => setHelp(item.chapter || `选择“${item.label}”`) }
              onMouseEnter={() => setHelp(item.chapter || `选择“${item.label}”`) }
              onClick={() => onChange(multiple ? toggle(selected, item.value) : [item.value])}
              className={active
                ? 'flex min-h-12 items-center justify-between rounded-lg border border-blue-500 bg-blue-50 px-4 py-3 text-left text-sm font-semibold text-blue-800'
                : 'flex min-h-12 items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 hover:border-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'}
            >
              <span className="min-w-0 break-words">{item.label}</span>
              {active ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <p className="mt-2 min-h-5 text-xs leading-5 text-slate-500" aria-live="polite">{help}</p>
    </fieldset>
  );
}

export function ProfileSetupWizard(props: WizardProps) {
  const { profile, options, courseTitle, submitting, message, step, onStepChange, onProfileChange, onSubmit } = props;
  const [foundationDecision, setFoundationDecision] = useState<'unset' | 'selected' | 'deferred'>(profile.foundationLevel ? 'selected' : 'unset');
  const [weakPointDecision, setWeakPointDecision] = useState<'unset' | 'selected' | 'deferred'>(profile.weakPoints.length ? 'selected' : 'unset');
  const missing = useMemo(() => getMissingDiagnosticReadyFields(profile), [profile]);
  const canContinue = step === 1
    ? Boolean(profile.grade && profile.majorDirection && profile.learningGoals.length)
    : step === 2
      ? foundationDecision !== 'unset' && weakPointDecision !== 'unset'
      : step === 3
        ? Boolean(profile.dailyStudyTime && profile.learningPreferences.length && profile.expectedResources.length)
        : missing.length === 0;

  return (
    <section className="mx-auto max-w-[1120px]" data-testid="a3-profile-guided-wizard">
      <header className="grid gap-3 border-b border-slate-200 pb-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <h1 className="text-3xl font-semibold text-slate-950">设置你的学习方式</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">用约 2 分钟回答几组问题，我们会据此安排入学诊断和后续学习。</p>
        </div>
        <div className="text-sm font-semibold text-blue-700">第 {step} / 4 步</div>
      </header>

      <div className="grid gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {step === 1 ? (
            <>
              <ChoiceGroup testId="a3-profile-step-grade" label="你现在是哪个年级？" options={options.grades} selected={[profile.grade]} onChange={([grade]) => onProfileChange({ ...profile, grade })} />
              <ChoiceGroup testId="a3-profile-step-major" label="你的专业方向是什么？" options={options.majorDirections} selected={[profile.majorDirection]} onChange={([majorDirection]) => onProfileChange({ ...profile, majorDirection })} />
              <ChoiceGroup testId="a3-profile-step-goals" label={`学习${courseTitle}最想解决什么？`} options={options.learningGoals} selected={profile.learningGoals} multiple onChange={(learningGoals) => onProfileChange({ ...profile, learningGoals })} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <ChoiceGroup testId="a3-profile-step-foundation" label="你目前学到什么程度？" options={options.foundationLevels} selected={[profile.foundationLevel]} onChange={([foundationLevel]) => { setFoundationDecision('selected'); onProfileChange({ ...profile, foundationLevel }); }} />
              <button type="button" aria-pressed={foundationDecision === 'deferred'} onClick={() => { setFoundationDecision('deferred'); onProfileChange({ ...profile, foundationLevel: '' }); }} className="min-h-11 text-sm font-semibold text-blue-700">不确定，让入学诊断判断</button>
              <ChoiceGroup testId="a3-profile-step-weak-points" label="哪些内容最容易卡住？" options={options.weakPoints} selected={profile.weakPoints} multiple onChange={(weakPoints) => { setWeakPointDecision('selected'); onProfileChange({ ...profile, weakPoints }); }} />
              <button type="button" aria-pressed={weakPointDecision === 'deferred'} onClick={() => { setWeakPointDecision('deferred'); onProfileChange({ ...profile, weakPoints: [] }); }} className="min-h-11 text-sm font-semibold text-blue-700">不确定，让入学诊断判断</button>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <ChoiceGroup testId="a3-profile-step-daily-time" label="每天通常能投入多少时间？" options={options.dailyStudyTimes.map((value) => ({ value, label: `${value} 分钟` }))} selected={[profile.dailyStudyTime]} onChange={([dailyStudyTime]) => onProfileChange({ ...profile, dailyStudyTime })} />
              <ChoiceGroup testId="a3-profile-step-learning-preferences" label="哪种讲解方式更容易看懂？" options={options.learningPreferences} selected={profile.learningPreferences} multiple onChange={(learningPreferences) => onProfileChange({ ...profile, learningPreferences })} />
              <ChoiceGroup testId="a3-profile-step-resources" label="希望优先收到哪类资料？" options={options.expectedResources} selected={profile.expectedResources} multiple onChange={(expectedResources) => onProfileChange({ ...profile, expectedResources })} />
            </>
          ) : null}

          {step === 4 ? (
            <div className="space-y-3" data-testid="a3-profile-guided-summary">
              <h2 className="text-2xl font-semibold text-slate-950">我理解的是</h2>
              {[
                ['年级与专业', `${profile.grade} · ${profile.majorDirection}`, 1],
                ['学习目标', profile.learningGoals.join('、'), 1],
                ['当前基础', profile.foundationLevel || '待入学诊断判断', 2],
                ['薄弱点', profile.weakPoints.join('、') || '待入学诊断判断', 2],
                ['每日时间', `${profile.dailyStudyTime} 分钟`, 3],
                ['学习方式', profile.learningPreferences.join('、'), 3],
                ['资源类型', profile.expectedResources.join('、'), 3],
              ].map(([label, value, targetStep]) => <div key={label} className="grid gap-2 border-b border-slate-100 py-3 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-center"><span className="text-sm text-slate-500">{label}</span><strong className="break-words text-sm text-slate-950">{value}</strong><button type="button" className="min-h-10 text-left text-sm font-semibold text-blue-700" onClick={() => onStepChange(targetStep as 1 | 2 | 3)}>修改</button></div>)}
            </div>
          ) : null}

          <ProfileSetupExample />
          {message ? <p className="text-sm text-red-600" role="alert">{message}</p> : null}
          <div className="sticky bottom-0 flex gap-3 border-t border-slate-200 bg-white py-4">
            {step > 1 ? <Button type="button" variant="outline" onClick={() => onStepChange((step - 1) as 1 | 2 | 3)}><ChevronLeft className="size-4" />上一步</Button> : null}
            {step < 4 ? <Button type="button" disabled={!canContinue} onClick={() => onStepChange((step + 1) as 2 | 3 | 4)}>下一步<ChevronRight className="size-4" /></Button> : <Button type="button" data-testid="a3-profile-setup-submit" disabled={!canContinue || submitting} onClick={onSubmit}>{submitting ? '正在保存...' : '保存并开始入学诊断'}</Button>}
          </div>
        </div>

        <aside className="hidden min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-5 lg:block">
          <div className="text-sm font-semibold text-slate-950">当前答案</div>
          <div className="mt-3 space-y-2 text-sm text-slate-600"><div>{profile.learningGoals.join('、') || '目标待选择'}</div><div>{profile.dailyStudyTime ? `${profile.dailyStudyTime} 分钟/天` : '时间待选择'}</div><div>{profile.expectedResources.join('、') || '资料类型待选择'}</div></div>
        </aside>
      </div>
    </section>
  );
}
```

After adding the files, run:

```powershell
pnpm.cmd exec prettier --write components/a3/profile-setup/profile-setup-example.tsx components/a3/profile-setup/profile-setup-wizard.tsx
```

The formatter may wrap JSX but must not change behavior or replace API-derived options with local fallback choices.

- [ ] **Step 5: Run source guards and typecheck**

Run:

```powershell
pnpm.cmd vitest run tests/a3-real-user-polish-regressions.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit the guided wizard**

```powershell
git add OpenMAIC/components/a3/profile-setup/profile-setup-example.tsx OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx OpenMAIC/tests/a3-real-user-polish-regressions.test.ts
git commit -m "feat: add guided learner profile setup"
```

---

### Task 6: Integrate First-Run Modes With Real APIs

**Files:**
- Create: `OpenMAIC/components/a3/profile-setup/profile-interview-first-run.tsx`
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx:847-1450`
- Modify: `OpenMAIC/tests/a3-profile-setup.test.ts`

- [ ] **Step 1: Add submission-decision unit tests**

Add a pure helper to `profile-setup.ts` and tests first:

```typescript
it('confirms only a server-complete interview', () => {
  expect(resolveProfileSubmissionRoute({ interviewComplete: true, profileCommitted: false })).toBe('interview_confirm');
  expect(resolveProfileSubmissionRoute({ interviewComplete: false, profileCommitted: false })).toBe('structured_save');
});
```

The implementation is:

```typescript
export function resolveProfileSubmissionRoute(result?: { interviewComplete?: boolean }) {
  return result?.interviewComplete ? 'interview_confirm' : 'structured_save';
}
```

- [ ] **Step 2: Run and verify the helper test fails, then passes after implementation**

Run before and after adding the helper:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-setup.test.ts
```

Expected before: FAIL with missing export. Expected after: PASS.

- [ ] **Step 3: Create the first-run interview presentation component**

Create a controlled component with no network calls of its own. It receives the existing server-backed state from `ProfileSetupPage`:

```tsx
'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Message = { role: 'agent' | 'user'; content: string };

export function ProfileInterviewFirstRun({
  value,
  messages,
  loading,
  nextQuestion,
  onValueChange,
  onSend,
  onExample,
  onReview,
}: {
  value: string;
  messages: Message[];
  loading: boolean;
  nextQuestion: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onExample: () => void;
  onReview: () => void;
}) {
  return (
    <section className="mx-auto max-w-3xl" data-testid="a3-profile-interview-first-run">
      <h2 className="text-2xl font-semibold text-slate-950">直接描述你的学习情况</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">可以分几次说，每次只回答当前这个具体问题。</p>
      <div className="mt-5 max-h-[360px] space-y-3 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={message.role === 'user' ? 'ml-auto max-w-[85%] rounded-lg bg-blue-600 px-4 py-3 text-sm text-white' : 'max-w-[85%] rounded-lg bg-white px-4 py-3 text-sm text-slate-700'}>{message.content}</div>
        ))}
      </div>
      {nextQuestion ? <p className="mt-4 text-sm font-medium text-slate-700">{nextQuestion}</p> : null}
      <textarea value={value} onChange={(event) => onValueChange(event.target.value)} className="mt-3 min-h-28 w-full rounded-lg border border-slate-300 bg-white p-4 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" placeholder="例如：我是大二软件工程学生，每天能学 30 分钟……" />
      <div className="mt-4 flex flex-wrap gap-3">
        <Button type="button" disabled={loading || !value.trim()} onClick={onSend}>{loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}发送</Button>
        <Button type="button" variant="outline" onClick={onExample}>填入示例</Button>
        <Button type="button" variant="outline" onClick={onReview}>查看并确认已识别的信息</Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add first-run mode and step state to `ProfileSetupPage`**

Add state:

```typescript
const [firstRunMode, setFirstRunMode] = useState<'guided' | 'describe'>('guided');
const [guidedStep, setGuidedStep] = useState<1 | 2 | 3 | 4>(1);
const [reviewingInterview, setReviewingInterview] = useState(false);
const [optionsError, setOptionsError] = useState('');
```

Move the existing options request into a retryable callback. It must keep the existing normalization logic:

```typescript
const loadProfileOptions = useCallback(async () => {
  setLoadingOptions(true);
  setOptionsError('');
  const result = await a3GetJson<LearningProfileOptionsResponse>('/api/profiles/options/');
  setLoadingOptions(false);
  if (!result.success) {
    setOptionsError(result.error ?? '暂时无法加载学习选项，请稍后重试。');
    return;
  }
  setOptions(result.options);
  setOptionsCourse(result.course?.title ?? '当前课程');
  const storedProfile = currentUser?.learningProfile;
  setProfile((current) => normalizeLearningProfileForOptions({
    ...current,
    ...storedProfile,
    learningGoals: normalizeMultiSelection(storedProfile?.learningGoals ?? current.learningGoals, result.options.learningGoals),
    learningPreferences: normalizeMultiSelection(storedProfile?.learningPreferences ?? current.learningPreferences, result.options.learningPreferences),
    weakPoints: normalizeMultiSelection(storedProfile?.weakPoints ?? current.weakPoints, result.options.weakPoints.map((item) => item.value)),
    expectedResources: normalizeMultiSelection(storedProfile?.expectedResources ?? current.expectedResources, result.options.expectedResources),
    dailyStudyTime: String(storedProfile?.dailyStudyTime ?? current.dailyStudyTime ?? ''),
  }, result.options));
}, [currentUser?.learningProfile]);

useEffect(() => {
  void loadProfileOptions();
}, [loadProfileOptions]);
```

Delete the old nested `loadOptions()` effect so only one options request runs.

Add a dedicated first-run submit function:

```typescript
async function submitDiagnosticReadyProfile() {
  setMessage('');
  const missing = getMissingDiagnosticReadyFields(profile);
  if (missing.length) {
    setMessage(`请先补齐：${missing.join('、')}`);
    return;
  }
  setSubmitting(true);
  const result = await postJson(
    '/api/profiles/learning-profile/',
    buildDiagnosticReadyProfilePayload(profile, displayName),
  );
  setSubmitting(false);
  if (!result.success) {
    setMessage(result.error ?? '学习设置保存失败，请稍后重试。');
    return;
  }
  syncA3User(result.user);
  router.push(result.nextAction?.href ?? '/a3/admission-diagnostic');
}
```

Do not reuse the existing strict `submit()` for first-run guided mode.

- [ ] **Step 5: Render first-run mode before the returning-user JSX**

After hooks and handlers, before the existing return, add:

```tsx
if (!currentUser?.profileCompleted) {
  return (
    <SimpleFlowFrame>
      <div data-testid="a3-profile-setup-view">
        {loadingOptions ? <div className="mx-auto h-[520px] max-w-[1120px] animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" aria-label="正在加载学习选项" /> : null}
        {!loadingOptions && optionsError ? <div className="mx-auto max-w-xl py-20 text-center"><p role="alert" className="text-sm text-red-700">{optionsError}</p><Button type="button" className="mt-4" onClick={() => void loadProfileOptions()}>重新加载</Button></div> : null}
        {!loadingOptions && !optionsError ? <>
        <div className="mb-6 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1" role="group" aria-label="填写方式">
          <button type="button" aria-pressed={firstRunMode === 'guided'} onClick={() => { setReviewingInterview(false); setFirstRunMode('guided'); }} className={firstRunMode === 'guided' ? 'min-h-10 rounded-md bg-white px-4 text-sm font-semibold text-blue-700 shadow-sm' : 'min-h-10 rounded-md px-4 text-sm text-slate-600'}>逐步选择</button>
          <button type="button" aria-pressed={firstRunMode === 'describe'} onClick={() => { setReviewingInterview(true); setFirstRunMode('describe'); }} className={firstRunMode === 'describe' ? 'min-h-10 rounded-md bg-white px-4 text-sm font-semibold text-blue-700 shadow-sm' : 'min-h-10 rounded-md px-4 text-sm text-slate-600'}>直接描述</button>
        </div>
        {firstRunMode === 'guided' ? (
          <ProfileSetupWizard profile={profile} options={options} courseTitle={optionsCourse} submitting={submitting} message={message} step={guidedStep} onStepChange={setGuidedStep} onProfileChange={setProfile} onSubmit={submitDiagnosticReadyProfile} />
        ) : (
          <ProfileInterviewFirstRun value={interviewText} messages={interviewMessages} loading={interviewLoading} nextQuestion={interviewResult?.nextQuestion ?? ''} onValueChange={setInterviewText} onSend={runProfileInterview} onExample={() => setInterviewText(buildProfileInterviewExample(optionsCourse))} onReview={() => { setReviewingInterview(true); setFirstRunMode('guided'); setGuidedStep(4); }} />
        )}
        </> : null}
      </div>
    </SimpleFlowFrame>
  );
}
```

Import the new components and helpers explicitly. Keep the existing detailed profile JSX as the return for `profileCompleted === true`.

- [ ] **Step 6: Preserve interview confirm semantics**

When the direct-description review reaches Step 4:

- If `resolveProfileSubmissionRoute(interviewResult) === 'interview_confirm'`, call the existing `confirmProfileInterview()` and route using the real result.
- Otherwise call `submitDiagnosticReadyProfile()` after required structured fields are complete.
- Never set `interviewComplete`, `profileCommitted`, or `generated` in local state to force success.

Implement one wrapper:

```typescript
async function submitFirstRunProfile() {
  if (reviewingInterview && resolveProfileSubmissionRoute(interviewResult) === 'interview_confirm') {
    const result = await confirmProfileInterview();
    if (result?.success) router.push('/a3/admission-diagnostic');
    return;
  }
  await submitDiagnosticReadyProfile();
}
```

Update `confirmProfileInterview()` to return its `ProfileInterviewResult` on success and failure, and `null` when no request is sent. Keep its existing state updates. Pass `submitFirstRunProfile` to the wizard.

- [ ] **Step 7: Run focused tests and typecheck**

Before running tests, remove the returning profile page's collapsible `Agent 决策证据` section and its `evidenceOpen` state from `a3-auth-pages.tsx`. Remove `AgentDecisionEvidence`, `ProfileSnapshotEvidenceBlock`, and `AgentExtractionPanel` imports only when `rg` confirms they have no other call site in that file. The existing `/a3/capabilities` evidence surface remains unchanged.

Run:

```powershell
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-real-user-polish-regressions.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit real API integration**

```powershell
git add OpenMAIC/components/a3/profile-setup/profile-interview-first-run.tsx OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/tests/a3-profile-setup.test.ts
git commit -m "feat: integrate progressive profile onboarding"
```

---

### Task 7: Verify Diagnostic Write-Back and End-to-End Flow

**Files:**
- Modify: `backend/apps/learning/tests/test_path_planner.py:790-885`
- Create: `OpenMAIC/e2e/tests/a3-profile-setup-progressive.spec.ts`

- [ ] **Step 1: Strengthen the backend diagnostic regression test**

At the start of `test_admission_diagnostic_updates_profile_and_generates_plan`, before the POST, add:

```python
profile = self.user.learner_profile
profile.foundation_level = ""
profile.weak_points = []
profile.pace = ""
profile.save(update_fields=["foundation_level", "weak_points", "pace", "updated_at"])
```

After the existing response assertions, add:

```python
profile.refresh_from_db()
self.assertTrue(profile.foundation_level)
self.assertTrue(profile.weak_points)
self.assertTrue(LearningPath.objects.filter(user=self.user, status="active").exists())
self.assertTrue(profile.extra_profile.get("studyPlan"))
self.assertEqual(
    list(run.steps.order_by("order").values_list("name", flat=True)),
    ["DiagnosticAgent", "ProfileUpdateAgent", "PlannerAgent", "StudyPlanAgent"],
)
```

Reuse the `payload` and `run` variables already created by the existing test; do not issue a second diagnostic request.

- [ ] **Step 2: Run the focused diagnostic test**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner.LearningPathTests.test_admission_diagnostic_updates_profile_and_generates_plan
```

Expected: PASS.

- [ ] **Step 3: Create a real Playwright first-run test**

Create `a3-profile-setup-progressive.spec.ts` using the existing `runManage` and `loginAsStudent` patterns. Reset only the demo student's profile and onboarding flags, then exercise API-derived options:

```typescript
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const PHONE = '13800000001';
const PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const root = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(root, 'backend', '.venv', 'Scripts', 'python.exe');
  execFileSync(python, [path.join(root, 'backend', 'manage.py'), command, ...args], { cwd: root, encoding: 'utf8' });
}

function resetFirstRun() {
  runManage('seed_demo_data');
  runManage('shell', ['-c', `
from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile
user = User.objects.get(phone="${PHONE}")
user.profile_completed = False
user.onboarding_step = "profile"
user.save(update_fields=["profile_completed", "onboarding_step", "updated_at"])
profile, _ = LearnerProfile.objects.get_or_create(user=user)
profile.grade = ""
profile.major_direction = ""
profile.foundation_level = ""
profile.daily_study_time = 0
profile.pace = ""
profile.learning_goals = []
profile.learning_preferences = []
profile.weak_points = []
profile.expected_resources = []
profile.save()
`]);
}

async function login(page: Page) {
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(PHONE);
  await inputs.nth(1).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

test.describe.serial('progressive profile setup', () => {
  test.setTimeout(180_000);
  test.beforeEach(resetFirstRun);

  test('completes guided setup without inventing foundation or weak points', async ({ page }) => {
    await login(page);
    await page.goto('/a3/profile-setup');
    const wizard = page.getByTestId('a3-profile-guided-wizard');
    await expect(wizard).toBeVisible();

    await wizard.getByTestId('a3-profile-step-grade').locator('button').first().click();
    await wizard.getByTestId('a3-profile-step-major').locator('button').first().click();
    await wizard.getByTestId('a3-profile-step-goals').locator('button').first().click();
    await wizard.getByRole('button', { name: /下一步/ }).click();

    await wizard.getByRole('button', { name: '不确定，让入学诊断判断' }).first().click();
    await wizard.getByRole('button', { name: '不确定，让入学诊断判断' }).last().click();
    await wizard.getByRole('button', { name: /下一步/ }).click();

    await wizard.getByTestId('a3-profile-step-daily-time').locator('button').first().click();
    await wizard.getByTestId('a3-profile-step-learning-preferences').locator('button').first().click();
    await wizard.getByTestId('a3-profile-step-resources').locator('button').first().click();
    await wizard.getByRole('button', { name: /下一步/ }).click();

    await expect(page.getByTestId('a3-profile-guided-summary')).toContainText('待入学诊断判断');
    await page.getByTestId('a3-profile-setup-submit').click();
    await expect(page).toHaveURL(/\/a3\/admission-diagnostic/, { timeout: 60_000 });
  });

  test('has no horizontal overflow at mobile and desktop widths', async ({ page }) => {
    await login(page);
    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/a3/profile-setup');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 4: Run the real first-run Playwright test**

Run:

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-profile-setup-progressive.spec.ts --project=chromium
npx.cmd playwright test e2e/tests/a3-profile-setup-progressive.spec.ts --project=chromium --trace on
```

Expected: both runs PASS. Open the generated trace and inspect the 390 and 1440 pixel snapshots for overlap before accepting the task:

```powershell
$trace = (Get-ChildItem test-results -Recurse -Filter trace.zip | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
npx.cmd playwright show-trace "$trace"
```

- [ ] **Step 5: Run the existing interview loop test**

Run:

```powershell
npx.cmd playwright test e2e/tests/a3-profile-interview-loop.spec.ts --project=chromium
```

Expected: PASS with the same real profile interview API and session restoration.

- [ ] **Step 6: Commit diagnostic and E2E coverage**

```powershell
git add backend/apps/learning/tests/test_path_planner.py OpenMAIC/e2e/tests/a3-profile-setup-progressive.spec.ts OpenMAIC/components/a3/profile-setup/profile-setup-wizard.tsx
git commit -m "test: cover progressive profile onboarding"
```

---

### Task 8: Full Verification and Deployment Readiness

**Files:**
- Verify only; modify files only to fix failures caused by Tasks 1-7.

- [ ] **Step 1: Run frontend type and lint checks**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: zero TypeScript errors and zero ESLint errors. Only warnings already allowed by `AGENTS.md` may remain.

- [ ] **Step 2: Run focused frontend tests**

```powershell
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-real-user-polish-regressions.test.ts tests/a3-planning-workspace-personalization.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run profile and Agent backend tests**

```powershell
cd ..
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings backend.apps.compat.tests.test_a3_requirements_deep_fill backend.apps.compat.tests.test_agent_runtime backend.apps.learning.tests.test_path_planner
```

Expected: PASS.

- [ ] **Step 4: Run system checks**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: both commands exit 0.

- [ ] **Step 5: Run first-run and mobile E2E checks**

```powershell
cd OpenMAIC
npx.cmd playwright test e2e/tests/a3-profile-setup-progressive.spec.ts e2e/tests/a3-profile-interview-loop.spec.ts e2e/tests/a3-mobile-flow.spec.ts --project=chromium
```

Expected: PASS at desktop and mobile viewports with no horizontal overflow or covered controls.

- [ ] **Step 6: Inspect the final diff and commit any verification-only fixes**

```powershell
cd ..
git status --short --branch
git diff --check
git diff --stat
```

When verification required code changes, stage only the feature-owned paths and commit:

```powershell
git add backend/apps/profiles/services.py backend/apps/profiles/tests/test_profile_settings.py backend/apps/compat/agent_kernel.py backend/apps/compat/profile_interview.py backend/apps/compat/tests/test_agent_runtime.py backend/apps/compat/tests/test_a3_requirements_deep_fill.py backend/apps/learning/tests/test_path_planner.py OpenMAIC/lib/a3/auth-types.ts OpenMAIC/lib/a3/profile-setup.ts OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/components/a3/profile-setup OpenMAIC/tests/a3-profile-setup.test.ts OpenMAIC/tests/a3-real-user-polish-regressions.test.ts OpenMAIC/e2e/tests/a3-profile-setup-progressive.spec.ts
git commit -m "fix: harden progressive profile onboarding"
```

Do not stage `control/`, `outputs/`, `.env*`, uploaded resources, or generated runtime files.

## Deployment Gate

Do not push or deploy until all Task 8 checks pass. After push, both GHCR workflows must complete for the same full Git SHA. Production deployment must pin the resulting backend and frontend image digests, then recreate only:

```text
backend
celery
celery-beat
frontend
realtime-proxy
caddy
```

Post-deployment verification must cover:

```text
/a3/profile-setup first-run guided mode
/a3/profile-setup returning-user editor
/a3/admission-diagnostic
profile_setup Agent trace
profile_interview Agent trace
admission_diagnostic Agent trace and profile write-back
```
