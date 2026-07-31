# A3 Wrong Notebook Export And Review Handout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated Word, Excel, and PDF wrong-question exports plus durable, cancellable personalized review-handout jobs backed by real assessment and knowledge-base evidence.

**Architecture:** Django owns scope filtering, immutable snapshots, weak-point ranking, document generation, job state, artifact storage, and authenticated downloads. A dedicated Celery task runs handout generation on `resource-generation` and protects cancelled terminal state from late workers. The existing Next.js wrong-notebook page calls the Django API directly through the shared A3 client and presents export controls and job history.

**Tech Stack:** Django, Celery, python-docx, openpyxl, ReportLab, Next.js, React, TypeScript, Vitest, Django TestCase, pypdf.

---

### Task 1: Export Scope And Snapshot Domain

**Files:**
- Create: `backend/apps/assessments/wrong_exports.py`
- Test: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing tests for `active`, `due`, `mastered`, and `all` scope filtering**

Create authenticated wrong-question fixtures with future, due, overdue, and mastered rows. Assert `select_wrong_questions(user, scope)` returns only the expected owner rows and rejects unknown scopes with `WrongExportRequestError`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_wrong_exports -v 2`
Expected: import failure because `wrong_exports.py` does not exist.

- [ ] **Step 3: Implement validated filtering and immutable JSON snapshots**

Add `select_wrong_questions`, `build_wrong_question_snapshot`, length limits, safe display-name handling, normalized option serialization, answer/explanation inclusion, and summary totals. Snapshot fields must be sufficient to generate all formats without querying mutable wrong-question rows again.

- [ ] **Step 4: Re-run the focused tests and verify GREEN**

Run the same Django test command.
Expected: all scope and snapshot tests pass.

- [ ] **Step 5: Commit the domain slice**

Run: `git add backend/apps/assessments/wrong_exports.py backend/apps/assessments/tests/test_wrong_exports.py && git commit -m "feat: add wrong question export snapshots"`

### Task 2: Real DOCX, XLSX, And PDF Export Files

**Files:**
- Modify: `backend/apps/assessments/wrong_exports.py`
- Modify: `backend/requirements.txt`
- Test: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing binary-content tests for all three formats**

Assert DOCX opens with `python-docx` and contains title, Chinese question text, answer, explanation, and source. Assert XLSX opens with `openpyxl`, has the exact headers and typed date cells. Assert PDF opens with `pypdf`, has at least one page, includes identifying metadata, and returns the correct MIME type and safe filename.

- [ ] **Step 2: Run tests and verify RED for missing builders**

Run the focused Django test command and confirm failures reference `build_wrong_export`.

- [ ] **Step 3: Implement bounded document builders**

Use `python-docx` for a compact reference-style Word document, `openpyxl` for one-row-per-question Excel output with wrapping/frozen headers/filters, and ReportLab with a Chinese CID font for PDF. Add `reportlab` to backend requirements. Return an `ExportArtifact(content, content_type, filename)` object and reject empty selections with a readable 409 error.

- [ ] **Step 4: Parse and render generated fixtures**

Run the focused tests, render the DOCX with the documents skill renderer, render the PDF with Poppler, and inspect the XLSX with `openpyxl`. Expected: no clipping, missing glyphs, malformed workbook, or unsafe path fragments.

- [ ] **Step 5: Commit real export generation**

Run: `git add backend/apps/assessments/wrong_exports.py backend/apps/assessments/tests/test_wrong_exports.py backend/requirements.txt && git commit -m "feat: generate wrong question export files"`

### Task 3: Authenticated Export API

**Files:**
- Modify: `backend/apps/assessments/views.py`
- Modify: `backend/apps/assessments/urls.py`
- Test: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing API tests**

Cover unauthenticated access, invalid JSON/scope/format, empty scope, owner isolation, `Content-Type`, RFC-safe `Content-Disposition`, and successful binary responses for `docx`, `xlsx`, and `pdf`.

- [ ] **Step 2: Run tests and verify RED with route-not-found responses**

Run the focused Django test command.
Expected: `/api/assessments/wrong-questions/export/` returns 404.

- [ ] **Step 3: Implement `POST wrong_question_export`**

Parse JSON through the existing helper, enforce login, call the export service, return `HttpResponse` with `nosniff` and attachment headers, and map request errors to readable 400/409 responses without tracebacks.

- [ ] **Step 4: Re-run API tests and verify GREEN**

Run the focused Django test command.
Expected: all export API tests pass.

- [ ] **Step 5: Commit the endpoint**

Run: `git add backend/apps/assessments/views.py backend/apps/assessments/urls.py backend/apps/assessments/tests/test_wrong_exports.py && git commit -m "feat: expose wrong question exports"`

### Task 4: Durable Review-Handout Jobs

**Files:**
- Modify: `backend/apps/assessments/models.py`
- Create: `backend/apps/assessments/migrations/0008_reviewhandoutjob.py`
- Create: `backend/apps/assessments/review_handouts.py`
- Test: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Write failing model/service tests**

Specify a `ReviewHandoutJob` with owner, scope, snapshot hash/data, status, progress, stage, message, trace ID, task ID, verification data, artifact paths, error, and timestamps. Test weak-point ranking from active count, wrong count, recency, due state, and profile `weak_points`; test idempotent reuse of queued/running identical snapshots.

- [ ] **Step 2: Run tests and verify RED because the model is absent**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_review_handouts -v 2`

- [ ] **Step 3: Implement model, migration, ranking, serialization, and safe artifact paths**

Store files below a configured assessment artifact root using generated job IDs only. Limit snapshot rows, ranked points, citations, and generated length. Serialize only authenticated download URLs, never server paths.

- [ ] **Step 4: Re-run tests and verify GREEN**

Run the focused handout tests and `backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run`.

- [ ] **Step 5: Commit durable job state**

Run: `git add backend/apps/assessments/models.py backend/apps/assessments/migrations/0008_reviewhandoutjob.py backend/apps/assessments/review_handouts.py backend/apps/assessments/tests/test_review_handouts.py && git commit -m "feat: add review handout jobs"`

### Task 5: Evidence-Constrained Handout Worker

**Files:**
- Modify: `backend/apps/assessments/review_handouts.py`
- Modify: `backend/apps/assessments/tasks.py`
- Test: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Write failing worker tests**

Test local knowledge retrieval per ranked point, verified citation serialization, deterministic fallback when retrieval/model synthesis is unavailable, DOCX/PDF artifact creation, progress updates, user-facing failures, cancellation before start, cancellation during work, and late-worker refusal to overwrite `cancelled`.

- [ ] **Step 2: Run tests and verify RED for the missing task**

Run the focused handout test command.

- [ ] **Step 3: Implement retrieval, synthesis, verification, and document output**

Use existing local KB retrieval interfaces without triggering global indexing. Build chapters from server-ranked weak points and snapshot questions; include concept summary, prerequisites, error patterns, checklist, variants, review advice, citations, and a final answer section. When evidence/model output is unavailable, create an explicitly degraded but useful outline from trusted question explanations.

- [ ] **Step 4: Implement terminal-state-safe Celery execution**

Register `assessments.generate_review_handout` with `acks_late`, time limits, transactionally guarded state writes, cleanup of partial artifacts, and `ResourceGenerationCancelled`-equivalent behavior. Dispatch it explicitly to `resource-generation`.

- [ ] **Step 5: Run tests and inspect generated DOCX/PDF**

Run focused tests, render every generated page, and verify citations, answer placement, Chinese glyphs, and no leaked local paths.

- [ ] **Step 6: Commit worker behavior**

Run: `git add backend/apps/assessments/review_handouts.py backend/apps/assessments/tasks.py backend/apps/assessments/tests/test_review_handouts.py && git commit -m "feat: generate evidence based review handouts"`

### Task 6: Handout CRUD, Cancel, Retry, And Download APIs

**Files:**
- Modify: `backend/apps/assessments/views.py`
- Modify: `backend/apps/assessments/urls.py`
- Test: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Write failing endpoint tests**

Cover create/list/detail/cancel/retry/download, owner isolation, invalid job IDs/formats, idempotent cancellation, Celery revoke calls, successful file responses, missing-artifact errors, and cancelled late-worker protection.

- [ ] **Step 2: Run tests and verify RED with 404 routes**

Run the focused handout test command.

- [ ] **Step 3: Implement API functions and routes**

Add authenticated collection/detail/cancel/retry/download endpoints. Creation snapshots current rows before dispatch; retry creates a fresh job from the saved snapshot; download rechecks ownership and serves only known artifact fields.

- [ ] **Step 4: Re-run tests and verify GREEN**

Run both wrong-export and handout backend test modules.

- [ ] **Step 5: Commit handout APIs**

Run: `git add backend/apps/assessments/views.py backend/apps/assessments/urls.py backend/apps/assessments/tests/test_review_handouts.py && git commit -m "feat: expose review handout jobs"`

### Task 7: Wrong-Notebook Export And Handout UI

**Files:**
- Modify: `OpenMAIC/lib/a3/api-client.ts`
- Modify: `OpenMAIC/lib/a3/assessment-types.ts`
- Create: `OpenMAIC/components/a3/features/wrong-notebook-actions.tsx`
- Modify: `OpenMAIC/components/a3/features/wrong-notebook-view.tsx`
- Create: `OpenMAIC/tests/a3-wrong-notebook-exports.test.ts`

- [ ] **Step 1: Write failing frontend contract tests**

Assert the page exposes the four scope options, three export formats, real CSRF-protected binary POST helper, create/list/cancel/retry handout calls, download links, loading/error/empty/success states, and mobile-safe controls.

- [ ] **Step 2: Run Vitest and verify RED**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-wrong-notebook-exports.test.ts`

- [ ] **Step 3: Add binary POST support and shared response types**

Add `a3PostDownload` to reuse CSRF handling and parse JSON errors before triggering a browser download. Define `WrongExportScope`, `WrongExportFormat`, and `ReviewHandoutJob` types matching Django serialization.

- [ ] **Step 4: Build the actions component and integrate it above the queue**

Use a scope select, format segmented buttons, an export command, a generate-handout command, and a compact job history. Poll only while a job is queued/running; cancel polling on unmount. Show explicit retry/cancel/download actions and disable generation for empty scopes.

- [ ] **Step 5: Run Vitest, TypeScript, and lint**

Run the focused Vitest test, `npx.cmd tsc --noEmit`, and `pnpm.cmd lint`.
Expected: new tests pass; only documented historical warnings remain.

- [ ] **Step 6: Commit the UI**

Run: `git add OpenMAIC/lib/a3/api-client.ts OpenMAIC/lib/a3/assessment-types.ts OpenMAIC/components/a3/features/wrong-notebook-actions.tsx OpenMAIC/components/a3/features/wrong-notebook-view.tsx OpenMAIC/tests/a3-wrong-notebook-exports.test.ts && git commit -m "feat: add wrong notebook exports and handouts UI"`

### Task 8: Integrated Verification, Push, And Deployment

**Files:**
- Modify only files required by failures found in verification.

- [ ] **Step 1: Run backend checks and focused tests**

Run assessment export/handout tests, `backend\.venv\Scripts\python.exe backend\manage.py check`, and `backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict`.

- [ ] **Step 2: Run frontend regression checks**

Run focused Vitest, TypeScript, lint, and the wrong-notebook browser path in Playwright at desktop and mobile sizes.

- [ ] **Step 3: Perform real artifact QA**

Generate one export of every format and one completed review handout from test fixtures. Parse all files, render all DOCX/PDF pages to PNG, inspect them, and verify Excel headers/content/column widths.

- [ ] **Step 4: Review the final diff and repository state**

Run `git diff --check`, focused secret/path scans, and `git status --short --branch`. Do not stage runtime pidbox files, caches, outputs, or unrelated documents.

- [ ] **Step 5: Push and deploy using the repository's established production procedure**

Push `codex/a3-latest-integration`, deploy the exact tested commit, run migrations before workers serve handout jobs, restart backend/resource-generation/frontend services as required, and verify production health and the authenticated wrong-notebook API.

