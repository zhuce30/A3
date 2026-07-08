# Learning Product Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the A3 learner-facing experience around today tasks, study plan, report, and notifications so the product feels like a mature learning app with clear next actions and real backend-backed state.

**Architecture:** Reuse existing A3 pages, components, and Django APIs. Prefer service-level backend additions only when an existing API response lacks the fields needed for product-grade UX. Keep front-end changes inside focused feature view files and preserve current A3 design vocabulary.

**Tech Stack:** Next.js, React, TypeScript, Django, Python, existing A3 API client and A3 UI components.

---

### Task 1: Inspect Current Data Contracts

**Files:**
- Read: `OpenMAIC/components/a3/features/today-learning-view.tsx`
- Read: `OpenMAIC/components/a3/features/study-plan-view.tsx`
- Read: `OpenMAIC/components/a3/features/report-view.tsx`
- Read: `OpenMAIC/components/a3/features/notifications-view.tsx`
- Read: `OpenMAIC/lib/a3/api-client.ts`
- Read: `backend/apps/learning/services.py`
- Read: `backend/apps/learning/views.py`
- Read: `backend/apps/engagement/views.py`

- [ ] **Step 1: Read feature pages and API client**

Run:

```powershell
cmd /c type OpenMAIC\components\a3\features\today-learning-view.tsx
cmd /c type OpenMAIC\components\a3\features\study-plan-view.tsx
cmd /c type OpenMAIC\components\a3\features\report-view.tsx
cmd /c type OpenMAIC\components\a3\features\notifications-view.tsx
cmd /c type OpenMAIC\lib\a3\api-client.ts
```

- [ ] **Step 2: Read backend services and views**

Run:

```powershell
cmd /c type backend\apps\learning\services.py
cmd /c type backend\apps\learning\views.py
cmd /c type backend\apps\engagement\views.py
```

### Task 2: Add or Update Backend Tests First

**Files:**
- Modify or create tests under `backend/apps/learning/tests/` and `backend/apps/engagement/tests/`.

- [ ] **Step 1: Write failing tests for product fields**

Expected behaviors:
- Study plan response exposes next action, plan adjustment reason, delayed tasks, and review rhythm.
- Report response exposes weekly summary, weak trend, plan completion, and next week suggestions.
- Notifications can include action target metadata for today tasks, wrong notebook, and study plan.

- [ ] **Step 2: Run targeted tests and verify they fail for missing fields**

Run:

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test apps.learning.tests apps.engagement.tests
```

Expected: fail only because the new product fields are missing.

### Task 3: Implement Backend Product Fields

**Files:**
- Modify: `backend/apps/learning/services.py`
- Modify: `backend/apps/learning/views.py` if needed
- Modify: `backend/apps/engagement/services.py` or `backend/apps/engagement/views.py` if needed

- [ ] **Step 1: Add minimal service output fields**

Add computed fields using existing profile, study plan, wrong questions, and progress data. Do not add migrations in this batch unless required.

- [ ] **Step 2: Run backend tests until green**

Run:

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test apps.learning.tests apps.engagement.tests
```

### Task 4: Update Frontend Experience

**Files:**
- Modify: `OpenMAIC/components/a3/features/today-learning-view.tsx`
- Modify: `OpenMAIC/components/a3/features/study-plan-view.tsx`
- Modify: `OpenMAIC/components/a3/features/report-view.tsx`
- Modify: `OpenMAIC/components/a3/features/notifications-view.tsx`
- Modify: `OpenMAIC/lib/a3/api-client.ts` if types or helpers are missing

- [ ] **Step 1: Add clear next-action sections**

Today page must show what to learn next, remaining minutes, and completion feedback.

- [ ] **Step 2: Add study plan reasoning**

Study plan must show adjustment reason, delayed tasks, review rhythm, and plan health.

- [ ] **Step 3: Add report insight sections**

Report must show weekly summary, weak trend, plan completion, and next-week recommendations.

- [ ] **Step 4: Add actionable notifications**

Notifications must route back to today tasks, wrong notebook, study plan, report, or teacher tasks.

### Task 5: Verify

**Files:**
- No code changes expected.

- [ ] **Step 1: Frontend typecheck**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

- [ ] **Step 2: Frontend lint**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd lint
```

- [ ] **Step 3: Backend checks**

Run:

```powershell
cd D:\Download\A3
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py check
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

- [ ] **Step 4: Source mojibake scan**

Run the existing project mojibake scan against A3 source directories and manually inspect any hits.
