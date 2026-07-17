# A3 Student Learning Report Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/a3/report` as a student-readable, actionable stage review while preserving all existing report data, APIs, exports, charts, profile evidence, and learning-effect evidence.

**Architecture:** Extend the existing assessment report additively with deterministic `studentSummary`, `comparisons`, `knowledgePointInsights`, and `dataQuality` fields. Add a pure frontend adapter that prefers those fields and deterministically falls back to the legacy report, then render five core student sections plus one default-collapsed details area. Keep `ReportView` responsible only for fetching, period switching, local supplemental states, and orchestration.

**Tech Stack:** Django, Django ORM, Next.js 16, React 19, TypeScript, Tailwind CSS, ECharts, Vitest, Playwright.

---

### Task 1: Add the backward-compatible student report summary contract

**Files:**
- Create: `backend/apps/assessments/tests/test_learning_report_v2.py`
- Modify: `backend/apps/assessments/services.py`
- Modify: `OpenMAIC/lib/a3/assessment-types.ts`

- [ ] **Step 1: Write failing backend tests**

Add tests that create answers in the current and previous equal-length windows and assert:

```python
report = build_learning_report(user, "7d")
assert report["studentSummary"]["schemaVersion"] == "a3.student-report-summary.v1"
assert report["studentSummary"]["primaryAction"]["href"].startswith("/a3/")
assert report["comparisons"]["accuracy"]["comparable"] is True
assert report["comparisons"]["accuracy"]["percentagePointChange"] == 25.0
assert report["knowledgePointInsights"][0]["knowledgePoint"] == "进程调度"
assert report["dataQuality"]["evidenceState"] in {"ready", "partial", "insufficient"}
```

Also assert that fewer than three answers in either window produces `comparable: false`, no percentage-point change, and readable Chinese `reason`; empty data must return structurally complete fields without invented improvement.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_learning_report_v2 --keepdb --verbosity 2
```

Expected: failures because the four additive fields do not exist.

- [ ] **Step 3: Implement deterministic helpers in `services.py`**

Add private helpers with these contracts:

```python
def _report_comparisons(user, *, period_key: str, start, end) -> dict: ...
def _knowledge_point_insights(user, *, start, limit: int = 3) -> list[dict]: ...
def _student_report_summary(*, period: dict, metrics: dict, comparisons: dict, knowledge_points: list[dict], weekly_prescription: dict, wrong_review_insight: dict) -> dict: ...
def _report_data_quality(*, answered_questions: int, comparisons: dict, knowledge_points: list[dict], updated_at: str) -> dict: ...
```

Rules:
- Current and previous windows must be equal length for `7d` and `30d`.
- Accuracy comparison requires at least three answers in each window.
- Accuracy differences use percentage points.
- `term` reports comparison as unavailable unless a real prior term window exists.
- Knowledge point insight fields: `knowledgePoint`, `answeredCount`, `wrongCount`, `latestResult`, `status`, `reason`, `action`.
- Primary action priority: active wrong questions, current study-plan task, assessment, then today page.
- No LLM call and no database migration.

Return the new fields from `build_learning_report()` without changing any existing field or wrapper.

- [ ] **Step 4: Extend TypeScript types additively**

Add optional interfaces to `LearningReport`:

```ts
studentSummary?: StudentReportSummary;
comparisons?: StudentReportComparisons;
knowledgePointInsights?: KnowledgePointInsight[];
dataQuality?: StudentReportDataQuality;
```

Use explicit unions for evidence state and comparison availability; do not expose backend enum text directly in UI.

- [ ] **Step 5: Verify backend contract**

Run the focused test plus `backend\.venv\Scripts\python.exe backend\manage.py check`.

### Task 2: Build the pure student report view-model adapter

**Files:**
- Create: `OpenMAIC/lib/a3/report-view-model.ts`
- Create: `OpenMAIC/tests/a3-report-view-model.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Cover complete data, empty data, insufficient comparison samples, no wrong questions, no study plan, no effect report, and `30d`/`term` period labels. Assert that serialized output excludes:

```text
eventStream decisionHistory schemaVersion v2 事件 候选数 决策分 assessment pending
```

Assert there is exactly one `overview.primaryAction`, at most three changes, at most three weak knowledge points, and the plan title is always `从今天开始的 7 天行动`.

- [ ] **Step 2: Run tests and verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-report-view-model.test.ts
```

Expected: module not found.

- [ ] **Step 3: Implement the view model**

Export these types and function:

```ts
export type StudentReportViewModel = {
  period: { key: '7d' | '30d' | 'term'; label: string; start: string; end: string; updatedAt: string };
  overview: { headline: string; summary: string; progressSignal: string; primaryRisk: string; primaryAction: ReportAction };
  changes: ReportChange[];
  weakKnowledgePoints: WeakKnowledgePointInsight[];
  sevenDayPlan: SevenDayReportPlan;
  effectiveMethods: LearningMethodEffect[];
  evidenceState: 'ready' | 'partial' | 'insufficient';
};

export function buildStudentReportViewModel(input: {
  report: LearningReport;
  studyPlan?: StudyPlan | null;
  effectReport?: LearningEffectReport | null;
}): StudentReportViewModel;
```

Prefer backend summary fields. If missing, derive deterministic Chinese conclusions from legacy `metrics`, `weeklyPrescription`, `wrongReviewInsight`, `resourcePackEffect`, and study-plan tasks. Never treat zero samples as zero accuracy or invent a trend.

- [ ] **Step 4: Verify adapter tests**

Run the focused Vitest file and `npx.cmd tsc --noEmit`.

### Task 3: Implement the five student-facing core sections

**Files:**
- Create: `OpenMAIC/components/a3/features/report/report-overview-panel.tsx`
- Create: `OpenMAIC/components/a3/features/report/report-change-summary.tsx`
- Create: `OpenMAIC/components/a3/features/report/report-weak-points.tsx`
- Create: `OpenMAIC/components/a3/features/report/report-seven-day-plan.tsx`
- Create: `OpenMAIC/components/a3/features/report/report-method-effect.tsx`
- Create: `OpenMAIC/tests/a3-student-report-redesign-contract.test.ts`
- Modify: `OpenMAIC/components/a3/features/report-view.tsx`

- [ ] **Step 1: Write failing component-contract tests**

Assert dedicated components exist, `ReportView` calls `buildStudentReportViewModel`, the overview has one primary CTA, weak points render at most three actionable items, the seven-day plan has ordered actions with duration/completion/effect, and internal audit labels no longer appear in the student core surface.

- [ ] **Step 2: Run tests and verify RED**

```powershell
pnpm.cmd vitest run tests/a3-student-report-redesign-contract.test.ts
```

- [ ] **Step 3: Implement accessible core components**

Use unframed page sections or individual cards only; no nested cards. Desktop core content must stay within 3-5 viewport heights and mobile must be single-column without horizontal overflow. Use icons plus text for progress/risk, and keep the primary action visible in the first viewport.

- [ ] **Step 4: Refactor `ReportView` orchestration**

Preserve all existing requests, period switching, real routes, CSV/PDF export handlers, Markdown summary generation, ECharts data, and `data-testid` contracts required by existing tests. Replace the old 16-section flat render with the five new core components followed by a details component placeholder. Period switching must retain the previous report until the new period succeeds and show a local updating state.

- [ ] **Step 5: Verify component and existing report tests**

Run:

```powershell
pnpm.cmd vitest run tests/a3-student-report-redesign-contract.test.ts tests/a3-report-export.test.ts tests/a3-report-delta.test.ts tests/a3-report-markdown-summary.test.ts tests/a3-report-weakness-trends.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

### Task 4: Move charts, summaries, exports, profile evidence, and audit evidence into details

**Files:**
- Create: `OpenMAIC/components/a3/features/report/report-details.tsx`
- Modify: `OpenMAIC/components/a3/features/report-view.tsx`
- Modify: `OpenMAIC/components/a3/features/capabilities-view.tsx`
- Modify: `OpenMAIC/tests/a3-student-report-redesign-contract.test.ts`

- [ ] **Step 1: Extend failing contract tests**

Assert the details section uses native `details/summary` or a correct `aria-expanded` control, is closed by default, contains trend/radar/profile/AI summary/export tools, and has independent loading/error placeholders. Assert technical labels appear only in capabilities evidence, not the report core.

- [ ] **Step 2: Run tests and verify RED**

Run the report redesign contract test.

- [ ] **Step 3: Implement details disclosure**

Move existing trend chart, capability radar, dynamic profile, profile timeline, AI summary/history, CSV/PDF export, data coverage, and calculation explanation into `report-details.tsx`. On mobile, use separate nested disclosure items so expanding one tool does not create the entire long page. Keep ECharts registration and chart option creation in one place.

- [ ] **Step 4: Migrate technical audit presentation**

Add a default-collapsed `学习报告计算与策略证据` section to `/a3/capabilities` using existing runtime/effect data. Do not delete audit fields from backend responses; only remove them from the student report presentation.

- [ ] **Step 5: Verify details and capabilities regression**

Run report contract tests, capabilities text-quality/page-ownership tests that reference the touched component, TypeScript, and ESLint.

### Task 5: Add browser-level report workflow and responsive verification

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-student-report.spec.ts`
- Modify: `OpenMAIC/tests/a3-student-report-redesign-contract.test.ts` only if browser findings require a contract regression

- [ ] **Step 1: Write Playwright scenarios**

Mock only network transport with realistic report payloads. Verify:
- overview and one primary action are visible in the first desktop viewport;
- clicking the primary action navigates to the real route;
- `7d`, `30d`, and `term` update headline and evidence together;
- details are closed by default and reveal charts/tools on demand;
- no internal audit labels appear in the student surface;
- 390px viewport has no horizontal overflow;
- empty and insufficient-evidence payloads show readable next actions without fake percentages.

- [ ] **Step 2: Run Playwright and verify RED/GREEN**

```powershell
npx.cmd playwright test e2e/tests/a3-student-report.spec.ts --project=chromium
```

Capture desktop and mobile screenshots and inspect them for clipping, overlap, excessive empty areas, and text overflow.

- [ ] **Step 3: Run final verification**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_learning_report_v2 --keepdb
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-report-view-model.test.ts tests/a3-student-report-redesign-contract.test.ts tests/a3-report-export.test.ts tests/a3-report-delta.test.ts tests/a3-report-markdown-summary.test.ts tests/a3-report-weakness-trends.test.ts
npx.cmd playwright test e2e/tests/a3-student-report.spec.ts --project=chromium
```

- [ ] **Step 4: Review scope and commit**

Run `git diff --check`, stage only report redesign files and this plan, then commit with a focused message. Leave `control/*`, `outputs/*.docx`, and `.superpowers/brainstorm/*` untouched.
