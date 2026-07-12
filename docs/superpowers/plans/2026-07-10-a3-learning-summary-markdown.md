# A3 Learning Summary Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build authenticated Markdown learning-summary generation, persistence, history, and `/a3/report` rendering.

**Architecture:** Add a Django model plus a focused report-summary service. Expose list/create/detail endpoints under `backend.apps.learning`. Extend the existing report page to consume the real API and render Markdown with `A3Markdown`.

**Tech Stack:** Django, Django TestCase, Next.js React, TypeScript, Vitest source-contract tests.

---

### Task 1: Backend Contract

**Files:**
- Create: `backend/apps/learning/tests/test_report_summaries.py`
- Modify: `backend/apps/learning/models.py`
- Create: `backend/apps/learning/migrations/0012_learning_summary_document.py`
- Create: `backend/apps/learning/report_summaries.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`

- [ ] Write failing API tests for auth, creation, naming, history, and ownership.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_report_summaries`.
- [ ] Implement model, migration, service, views, and URLs.
- [ ] Re-run the report-summary tests.

### Task 2: Frontend Report UI

**Files:**
- Modify: `OpenMAIC/components/a3/features/report-view.tsx`
- Create: `OpenMAIC/tests/a3-report-markdown-summary.test.ts`

- [ ] Write a source-contract test proving `/a3/report` calls `/api/learning/report-summaries/`, posts prompts, renders with `A3Markdown`, and exposes test ids.
- [ ] Run `cd OpenMAIC && pnpm.cmd vitest run tests/a3-report-markdown-summary.test.ts`.
- [ ] Add summary state, fetch/create handlers, and UI module.
- [ ] Re-run the frontend test.

### Task 3: Verification

- [ ] Run backend focused tests.
- [ ] Run frontend focused tests.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py check`.
- [ ] Run `cd OpenMAIC && npx.cmd tsc --noEmit`.
