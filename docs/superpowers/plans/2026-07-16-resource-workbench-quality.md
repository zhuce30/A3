# A3 Professional Resource Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic stacked-card rendering for practice sets, case studies, and code labs with professional interactive workbenches, while upgrading ResourceSynthesisAgent with type-specific prompts, repair, quality validation, and complete fallbacks.

**Architecture:** Keep the existing resource-pack APIs and `ResourceSynthesisAgent` workflow. Split the three interactive resource views into focused frontend components behind a shared responsive workbench shell. On the backend, retain one LLM call but route the request through type-specific specialist contracts, normalize output with type-specific repair functions, assess content with structured quality reports, and fall back to complete deterministic content when quality fails.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Vitest, Django, Celery, Python unittest.

---

### Task 1: Lock the backend specialist contracts with failing tests

**Files:**
- Modify: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`

- [ ] Add tests asserting `_resource_llm_requirements()` exposes type-specific requirements:
  - practice questions include `knowledgePoint`, `difficulty`, `distractorAnalysis`, `commonMistake`, `evaluationRubric`, and `sourceIds`;
  - case studies include `role`, `constraints`, `materials`, `decisionPoints`, `analysisSteps`, `expertAnalysis`, `rubric`, and `sourceIds`;
  - code labs force `language=Python` and include `concepts`, `hints`, `commonFailures`, executable `testCases`, and observable `checkpoints`.
- [ ] Add tests for incomplete LLM output repair for all three types.
- [ ] Add tests for quality reports rejecting shallow practice, case, and code content.
- [ ] Run the focused tests and confirm they fail because the specialist repair and quality functions do not exist yet.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test `
  backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_resource_specialist_prompts_define_professional_contracts `
  backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_specialist_repair_completes_partial_resource_content `
  backend.apps.compat.tests.test_a3_requirements_deep_fill.A3RequirementsDeepFillTests.test_specialist_quality_rejects_shallow_resource_content `
  --keepdb -v 2
```

### Task 2: Implement backend specialist prompts, repair, and quality gates

**Files:**
- Modify: `backend/apps/compat/resource_generation.py`
- Test: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`

- [ ] Add `_resource_specialist_instructions(resource_type)` with a role, learning design rules, forbidden behavior, and type-specific quality checklist.
- [ ] Include the specialist instructions in the single `chat_completion()` request without adding another model call.
- [ ] Replace the mind-map-only repair branch with dispatch to:
  - `_repair_practice_set_content()`;
  - `_repair_case_study_content()`;
  - `_repair_code_lab_content()`;
  - existing mind-map repair.
- [ ] Add `_resource_content_quality(resource_type, content)` returning:

```python
{
    "passed": bool,
    "score": int,
    "checks": [{"name": str, "passed": bool, "detail": str}],
}
```

- [ ] Require the quality report to pass before accepting LLM content.
- [ ] Store the quality report under `synthesis["quality"]` for both LLM and fallback paths.
- [ ] Upgrade deterministic fallbacks:
  - practice questions include IDs, knowledge points, difficulty, distractor analysis, common mistakes, rubrics, and evidence;
  - cases include role, constraints, decision points, expert analysis, rubric, and student prompt;
  - code labs include concepts, hints, common failures, Python-only environment, runner-compatible tests, and checkpoints.
- [ ] Run the focused backend tests until green.

### Task 3: Lock the frontend interaction and layout contracts with failing tests

**Files:**
- Create: `OpenMAIC/tests/a3-resource-workbench.test.ts`

- [ ] Assert the standalone resource view delegates to three dedicated workbench components.
- [ ] Assert the shared shell contains a responsive two-column layout and sticky desktop learning rail.
- [ ] Assert practice answers render only after per-question submission.
- [ ] Assert case expert analysis renders only after the learner submits a judgment.
- [ ] Assert code editor and output use a desktop split layout and mobile single-column fallback.
- [ ] Assert old resources are normalized through shared workbench utilities.
- [ ] Run the test and confirm it fails because the workbench modules do not exist.

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-resource-workbench.test.ts
```

### Task 4: Build the shared workbench shell and compatibility utilities

**Files:**
- Create: `OpenMAIC/components/a3/features/resource-workbench/resource-workbench-shell.tsx`
- Create: `OpenMAIC/components/a3/features/resource-workbench/resource-learning-rail.tsx`
- Create: `OpenMAIC/components/a3/features/resource-workbench/resource-workbench-utils.ts`
- Modify: `OpenMAIC/components/a3/features/resource-standalone-view.tsx`

- [ ] Implement `ResourceWorkbenchShell` with `xl:grid-cols-[minmax(0,1fr)_320px]`, stable gaps, and a rail that uses `xl:sticky xl:top-24` without creating nested cards.
- [ ] Implement `ResourceLearningRail` sections for progress, steps/checkpoints, evidence, synthesis state, and feedback actions.
- [ ] Move safe record/array/text normalization needed by the three workbenches into `resource-workbench-utils.ts`.
- [ ] Keep generic resource types and existing `EvidencePanel` behavior unchanged until the three new workbenches are integrated.
- [ ] Run the frontend contract test and TypeScript.

### Task 5: Implement the interactive practice and case workbenches

**Files:**
- Create: `OpenMAIC/components/a3/features/resource-workbench/practice-set-workbench.tsx`
- Create: `OpenMAIC/components/a3/features/resource-workbench/case-study-workbench.tsx`
- Modify: `OpenMAIC/components/a3/features/resource-standalone-view.tsx`
- Test: `OpenMAIC/tests/a3-resource-workbench.test.ts`

- [ ] Practice workbench:
  - maintain active question, draft answer, and submitted question IDs;
  - render one question at a time with a stable question navigator;
  - hide answer, explanation, distractor analysis, common mistake, rubric, and sources before submission;
  - preserve submitted answers when navigating between questions;
  - support choice and open-answer modes;
  - expose completed count in the learning rail.
- [ ] Case workbench:
  - render scenario, role, constraints, materials, task, and decision points;
  - provide a learner judgment textarea;
  - hide analysis steps, expert analysis, rubric, and reflection until submission;
  - preserve the learner judgment while the page remains mounted;
  - expose the analysis path and completion state in the rail.
- [ ] Use familiar buttons, textarea, numbered steps, progress, and source references. Avoid decorative nested cards.
- [ ] Run focused tests and TypeScript.

### Task 6: Extract and redesign the code lab workbench

**Files:**
- Create: `OpenMAIC/components/a3/features/resource-workbench/code-lab-workbench.tsx`
- Modify: `OpenMAIC/components/a3/features/resource-standalone-view.tsx`
- Test: `OpenMAIC/tests/a3-resource-workbench.test.ts`

- [ ] Move existing real runner behavior, copy/download, stdin, judge mode, result rendering, and checkpoint state into the new component without changing the endpoint.
- [ ] Build a desktop `lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]` editor/result split.
- [ ] Keep mobile as a single column with editor before output.
- [ ] Place objective and current hint above the split; place steps, checkpoints, common failures, extension, and evidence in the shared rail.
- [ ] Keep user code after run errors and timeouts.
- [ ] Disable judge mode with a readable reason when no tests exist.
- [ ] Run code runner tests, frontend workbench tests, and TypeScript.

### Task 7: Integrate feedback and preserve existing resource routes

**Files:**
- Modify: `OpenMAIC/components/a3/features/resource-standalone-view.tsx`
- Modify only if needed: `OpenMAIC/lib/a3/recommendation-types.ts`
- Test: `OpenMAIC/tests/a3-resource-workbench.test.ts`
- Test: `OpenMAIC/e2e/tests/a3-resource-feedback-loop.spec.ts`

- [ ] Route only `practice_set`, `case_study`, and `code_lab` through the new shell.
- [ ] Keep lecture documents, cards, mind maps, PPT, videos, feedback API, route slugs, and resource-pack loading unchanged.
- [ ] Ensure completed/favorited/skipped actions still call the existing feedback endpoint.
- [ ] Ensure all new display text is normal Chinese and no internal prompt/schema text is exposed.
- [ ] Run focused regression tests.

### Task 8: Full verification and visual QA

**Files:**
- Modify only if verification finds defects.

- [ ] Run backend checks and focused resource tests.
- [ ] Run frontend TypeScript, ESLint, resource tests, and existing resource feedback E2E.
- [ ] Start the local dev server if none is running.
- [ ] Use Playwright to capture practice, case, and code workbench screenshots at desktop and mobile widths.
- [ ] Verify no large unused right-side area, no overlapping controls, no clipped text, and no horizontal overflow.
- [ ] Verify code runner interaction remains real and error states preserve user input.
- [ ] Review `git diff`, stage only scoped files, commit, and push `codex/a3-latest-integration`.

Required verification:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_a3_requirements_deep_fill --keepdb
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_code_lab_runner --keepdb

cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd exec eslint components/a3/features/resource-workbench components/a3/features/resource-standalone-view.tsx tests/a3-resource-workbench.test.ts
pnpm.cmd vitest run tests/a3-resource-workbench.test.ts tests/a3-resource-pack-detail-content-rendering.test.ts
npx.cmd playwright test e2e/tests/a3-resource-feedback-loop.spec.ts --project=chromium
```
