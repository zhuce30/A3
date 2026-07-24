# A3 Full Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, independently navigated A3 administrator console with nine operational modules and compact role entry links on the public homepage.

**Architecture:** Django owns all authorization, aggregation, state transitions, sensitive-data reveal, and audit logging under `/api/admin/*`. Next.js keeps the existing A3 session and API client, uses a pathname-aware workspace frame to choose the learning shell or admin shell, and renders real paginated data with ECharts only where charts add meaning.

**Tech Stack:** Django 5, MySQL, Redis/Celery, Next.js 16, React 19, TypeScript, Tailwind CSS 4, ECharts 6, Vitest, Playwright.

**Design:** `docs/superpowers/specs/2026-07-25-a3-full-admin-console-and-role-entry-design.md`

---

## File Map

### Backend

- Modify `backend/apps/system/models.py`: security review fields and generic audit targets.
- Create `backend/apps/system/migrations/0002_admin_console_governance.py`: compatible schema extension.
- Create `backend/apps/system/admin_audit.py`: one audited-operation helper with field allowlisting.
- Modify `backend/apps/system/admin_overview.py`: 7-day trends, alerts, activity feed, status totals, and cached aggregation.
- Create `backend/apps/system/admin_conversation_services.py`: safe coaching-session summaries and audited message reveal.
- Create `backend/apps/system/admin_catalog_services.py`: courses, resources, status transitions, and reindex dispatch.
- Create `backend/apps/system/admin_task_services.py`: cross-model task list, retry, and safe cancellation state machine.
- Create `backend/apps/system/admin_agent_services.py`: AgentRun list and trace detail with metadata redaction.
- Create `backend/apps/system/admin_configuration.py`: secret-free configuration status and explicit verification.
- Modify `backend/apps/system/admin_views.py`: thin HTTP handlers using the service modules.
- Modify `backend/apps/system/admin_urls.py`: all new `/api/admin/*` routes.
- Add focused tests under `backend/apps/system/tests/`.

### Frontend

- Modify `OpenMAIC/lib/a3/auth-navigation.ts`: role-aware post-login destinations.
- Modify `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx` and its CSS: top-level role links.
- Create `OpenMAIC/components/a3/layout/a3-workspace-frame.tsx`: pathname-aware shell selection.
- Modify `OpenMAIC/app/a3/layout.tsx`: keep auth at the root and delegate shell selection.
- Create `OpenMAIC/components/a3/features/admin/admin-console-layout.tsx`: independent responsive admin chrome.
- Create `OpenMAIC/components/a3/features/admin/admin-ui.tsx`: shared header, filters, status, pagination, skeleton, and drawer primitives.
- Expand `OpenMAIC/lib/a3/admin-types.ts` and `OpenMAIC/lib/a3/admin-api.ts`: typed contracts for all pages.
- Redesign existing overview/users views and create one focused view per new module.
- Create page routes under `OpenMAIC/app/a3/admin/`.
- Add unit/source-contract tests under `OpenMAIC/tests/admin/` and E2E coverage under `OpenMAIC/e2e/tests/`.

---

### Task 1: Governance Schema and Audit Helper

**Files:**
- Modify: `backend/apps/system/models.py`
- Create: `backend/apps/system/migrations/0002_admin_console_governance.py`
- Create: `backend/apps/system/admin_audit.py`
- Test: `backend/apps/system/tests/test_admin_governance.py`

- [ ] **Step 1: Write failing model and audit tests**

Test that a security event accepts `pending/confirmed/false_positive/resolved`, and that `record_admin_audit()` strips keys matching password, token, cookie, secret, authorization, and api-key patterns before persisting `before`, `after`, or metadata.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_governance
```

Expected: failure because the review fields and audit helper do not exist.

- [ ] **Step 3: Add compatible fields and helper**

Add `review_status`, `reviewer`, `reviewed_at`, `review_note` to `SecurityEvent`; add `target_type`, `target_id`, `summary`, and `metadata` to `AdminAuditLog`. Keep `target_user` and existing records valid. Implement a single helper that stores only recursively sanitized JSON values.

- [ ] **Step 4: Verify migration and tests GREEN**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_governance
```

- [ ] **Step 5: Commit the schema foundation**

```powershell
git add backend/apps/system/models.py backend/apps/system/migrations/0002_admin_console_governance.py backend/apps/system/admin_audit.py backend/apps/system/tests/test_admin_governance.py
git commit -m "feat(admin): add governance audit foundation"
```

### Task 2: Real Overview Aggregation

**Files:**
- Modify: `backend/apps/system/admin_overview.py`
- Modify: `backend/apps/system/admin_views.py`
- Test: `backend/apps/system/tests/test_admin_overview.py`

- [ ] **Step 1: Write failing overview contract tests**

Seed users, CoachingSession, ResourcePackLog, AgentRun, job records, SecurityEvent, and AdminAuditLog across Shanghai-local dates. Assert `schemaVersion = a3.admin-overview.v2`, seven continuous trend buckets, task status totals, alerts, activity items, and `dataStatus` values.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_overview
```

- [ ] **Step 3: Implement bounded aggregation**

Accept only `24h`, `7d`, or `30d`; use Django truncation in `Asia/Shanghai`; map existing job statuses into the shared six-state vocabulary; cache the complete overview for 30 seconds by range; catch individual noncritical probe failures and return `dataStatus: partial` instead of failing the whole endpoint.

- [ ] **Step 4: Verify GREEN and query bounds**

Add `assertNumQueries` coverage so seven-day aggregation does not query per day or per user.

- [ ] **Step 5: Commit overview v2**

```powershell
git add backend/apps/system/admin_overview.py backend/apps/system/admin_views.py backend/apps/system/tests/test_admin_overview.py
git commit -m "feat(admin): add real operational overview"
```

### Task 3: Read-side Business Administration APIs

**Files:**
- Create: `backend/apps/system/admin_conversation_services.py`
- Create: `backend/apps/system/admin_catalog_services.py`
- Create: `backend/apps/system/admin_task_services.py`
- Create: `backend/apps/system/admin_agent_services.py`
- Modify: `backend/apps/system/admin_views.py`
- Modify: `backend/apps/system/admin_urls.py`
- Test: `backend/apps/system/tests/test_admin_business_views.py`

- [ ] **Step 1: Write failing permission, pagination, and redaction tests**

For conversations, catalog, tasks, and agent runs assert: unauthenticated returns 401, student/teacher returns 403, admin returns paginated results, no unbounded `all`, and serialized payloads omit message bodies, stored paths, provider URLs, tokens, and unknown metadata keys.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_business_views
```

- [ ] **Step 3: Implement list/detail services**

Use `select_related`, bounded prefetch, annotations, and shared `page/pageSize` validation. Conversation detail returns metadata without content; `POST reveal` returns one paginated message page and records `conversation.reveal`. Agent detail returns steps/spans with metadata keys restricted to an explicit allowlist.

- [ ] **Step 4: Verify GREEN and no N+1 regressions**

Run the focused test with seeded multi-row lists and query-count assertions.

- [ ] **Step 5: Commit read-side APIs**

```powershell
git add backend/apps/system/admin_*_services.py backend/apps/system/admin_views.py backend/apps/system/admin_urls.py backend/apps/system/tests/test_admin_business_views.py
git commit -m "feat(admin): expose audited operations data"
```

### Task 4: Controlled Actions, Safety Review, and Configuration Checks

**Files:**
- Modify: `backend/apps/system/admin_catalog_services.py`
- Modify: `backend/apps/system/admin_task_services.py`
- Create: `backend/apps/system/admin_configuration.py`
- Modify: `backend/apps/system/admin_views.py`
- Modify: `backend/apps/system/admin_urls.py`
- Test: `backend/apps/system/tests/test_admin_actions.py`

- [ ] **Step 1: Write failing state-machine tests**

Cover course activation, resource publish/offline and reindex, failed-job retry, queued-job cancellation, unsupported running cancellation, safety review transitions, and secret-free configuration responses. Every successful or failed sensitive action must create an audit row with actor, target, reason, success, and sanitized fields.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_actions
```

- [ ] **Step 3: Implement minimal valid transitions**

Use database transactions and row locks for state changes. Reuse existing task dispatch functions rather than duplicating generation logic. Revoke a Celery task only when the model has a persisted task id and the task kind is explicitly marked cancellable. Configuration checks return labels, status, message, last evidence, and no secret values.

- [ ] **Step 4: Verify GREEN plus existing system tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests
backend\.venv\Scripts\python.exe backend\manage.py check
```

- [ ] **Step 5: Commit controlled actions**

```powershell
git add backend/apps/system backend/apps/system/tests
git commit -m "feat(admin): add controlled management actions"
```

### Task 5: Role-aware Login and Independent Workspace Frame

**Files:**
- Modify: `OpenMAIC/lib/a3/auth-navigation.ts`
- Modify: `OpenMAIC/app/a3/layout.tsx`
- Create: `OpenMAIC/components/a3/layout/a3-workspace-frame.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-console-layout.tsx`
- Test: `OpenMAIC/tests/admin/admin-workspace-routing.test.ts`

- [ ] **Step 1: Write failing routing tests**

Assert completed student, teacher, and admin users resolve to `/a3/dashboard`, `/a3/teacher`, and `/a3/admin/overview`; onboarding steps still take priority; a safe explicit `next` is accepted only if compatible with the authenticated role; `/a3/admin/*` selects the admin shell.

- [ ] **Step 2: Verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/admin/admin-workspace-routing.test.ts
```

- [ ] **Step 3: Implement workspace routing and admin chrome**

Keep `A3AuthGate` at the root. `A3WorkspaceFrame` checks pathname and renders `AdminConsoleLayout` for `/a3/admin/*`, otherwise `A3Shell` with the guided-tour provider. The admin shell has responsive collapse, active route, return-to-learning command, and no student navigation.

- [ ] **Step 4: Verify GREEN and typecheck**

```powershell
pnpm.cmd vitest run tests/admin/admin-workspace-routing.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 5: Commit workspace separation**

```powershell
git add OpenMAIC/lib/a3/auth-navigation.ts OpenMAIC/app/a3/layout.tsx OpenMAIC/components/a3/layout/a3-workspace-frame.tsx OpenMAIC/components/a3/features/admin/admin-console-layout.tsx OpenMAIC/tests/admin/admin-workspace-routing.test.ts
git commit -m "feat(admin): add independent workspace shell"
```

### Task 6: Compact Homepage Role Entry

**Files:**
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-mobile-nav.tsx`
- Test: `OpenMAIC/tests/admin/homepage-role-entry.test.ts`

- [ ] **Step 1: Write failing source/route tests**

Assert the three visible labels and exact workspace URLs are present, no role-description section is added, and mobile navigation exposes the same destinations without changing role state.

- [ ] **Step 2: Verify RED**

```powershell
pnpm.cmd vitest run tests/admin/homepage-role-entry.test.ts
```

- [ ] **Step 3: Implement the approved top navigation rail**

Add icon plus one-word role links immediately beside the brand on desktop. Put the same three links in the existing mobile menu. Remove redundant generic workspace action if it conflicts, retain login and student self-registration, and preserve the existing hero composition.

- [ ] **Step 4: Verify GREEN and responsive E2E**

Run unit tests and capture desktop/mobile screenshots with Playwright; verify no text overflow at 390px and 1440px.

- [ ] **Step 5: Commit role entry**

```powershell
git add OpenMAIC/components/a3/marketing OpenMAIC/tests/admin/homepage-role-entry.test.ts
git commit -m "feat(home): add role workspace entry"
```

### Task 7: Admin Client Contracts and Shared UI

**Files:**
- Modify: `OpenMAIC/lib/a3/admin-types.ts`
- Modify: `OpenMAIC/lib/a3/admin-api.ts`
- Create: `OpenMAIC/components/a3/features/admin/admin-ui.tsx`
- Test: `OpenMAIC/tests/admin/admin-client-contracts.test.ts`

- [ ] **Step 1: Write failing API construction tests**

Assert each typed client uses the exact route, query keys, HTTP method, and action body from the design. Include safe pagination defaults and reason fields on writes.

- [ ] **Step 2: Verify RED**

```powershell
pnpm.cmd vitest run tests/admin/admin-client-contracts.test.ts
```

- [ ] **Step 3: Add contracts and reusable operational primitives**

Define explicit response types rather than `Record<string, unknown>`. Shared UI includes page header, refresh controls, filter bar, data status badge, compact table wrapper, pagination, skeleton, empty/error state, confirmation dialog, and detail drawer.

- [ ] **Step 4: Verify GREEN and accessibility names**

```powershell
pnpm.cmd vitest run tests/admin/admin-client-contracts.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 5: Commit shared frontend foundation**

```powershell
git add OpenMAIC/lib/a3/admin-* OpenMAIC/components/a3/features/admin/admin-ui.tsx OpenMAIC/tests/admin/admin-client-contracts.test.ts
git commit -m "feat(admin): add typed console foundation"
```

### Task 8: Overview, Users, and Audit Pages

**Files:**
- Modify: `OpenMAIC/components/a3/features/admin/admin-overview-view.tsx`
- Modify: `OpenMAIC/components/a3/features/admin/admin-users-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-audit-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-charts.tsx`
- Create: `OpenMAIC/app/a3/admin/audit/page.tsx`
- Test: `OpenMAIC/tests/admin/admin-core-pages.test.ts`

- [ ] **Step 1: Write failing page-state tests**

Cover real data rendering, status distinctions, filters, pagination, empty/error/loading, stale generatedAt, 7-day chart input, task totals, IP reveal audit flow, and no misleading zero for `not_collected`.

- [ ] **Step 2: Verify RED**

```powershell
pnpm.cmd vitest run tests/admin/admin-core-pages.test.ts
```

- [ ] **Step 3: Implement the approved warm operational UI**

Use ECharts SVG renderer for line and donut charts. Keep services and metrics in stable responsive grids; use compact table rows and a right-side detail drawer. Replace `window.prompt/confirm` with the shared confirmation dialog requiring a reason.

- [ ] **Step 4: Verify GREEN, typecheck, and screenshot layout**

Run the focused tests, `tsc`, and Playwright at desktop/mobile sizes.

- [ ] **Step 5: Commit core pages**

```powershell
git add OpenMAIC/components/a3/features/admin OpenMAIC/app/a3/admin/audit OpenMAIC/tests/admin/admin-core-pages.test.ts
git commit -m "feat(admin): redesign core operations pages"
```

### Task 9: Conversations, Catalog, Tasks, and Agent Pages

**Files:**
- Create: `OpenMAIC/components/a3/features/admin/admin-conversations-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-catalog-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-tasks-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-agents-view.tsx`
- Create: corresponding `OpenMAIC/app/a3/admin/*/page.tsx` files
- Test: `OpenMAIC/tests/admin/admin-business-pages.test.ts`

- [ ] **Step 1: Write failing interaction tests**

Cover list/filter/detail states, audited conversation reveal, course/resource status actions, reindex, retry/cancel eligibility, Agent trace waterfall, redacted metadata, and action error feedback.

- [ ] **Step 2: Verify RED**

```powershell
pnpm.cmd vitest run tests/admin/admin-business-pages.test.ts
```

- [ ] **Step 3: Implement four focused pages**

Each page owns only its data hook and domain-specific columns/actions while reusing admin primitives. Do not add nested cards, fake rows, fake traces, or client-side status transitions before the API succeeds.

- [ ] **Step 4: Verify GREEN and typecheck**

```powershell
pnpm.cmd vitest run tests/admin/admin-business-pages.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 5: Commit business pages**

```powershell
git add OpenMAIC/components/a3/features/admin OpenMAIC/app/a3/admin OpenMAIC/tests/admin/admin-business-pages.test.ts
git commit -m "feat(admin): add business operations pages"
```

### Task 10: Safety and Configuration Pages

**Files:**
- Create: `OpenMAIC/components/a3/features/admin/admin-safety-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-settings-view.tsx`
- Create: corresponding route pages
- Test: `OpenMAIC/tests/admin/admin-governance-pages.test.ts`

- [ ] **Step 1: Write failing governance UI tests**

Cover safety filters/review transitions/reason requirements, configuration states, explicit verification, no secret values, and correct `已配置 · 未监控` labels.

- [ ] **Step 2: Verify RED**

```powershell
pnpm.cmd vitest run tests/admin/admin-governance-pages.test.ts
```

- [ ] **Step 3: Implement governance pages**

Keep checks grouped by runtime, providers, notifications, and storage. Verification buttons are commands with clear pending/success/error feedback. Safety review writes the result only after API success.

- [ ] **Step 4: Verify GREEN and typecheck**

- [ ] **Step 5: Commit governance pages**

```powershell
git add OpenMAIC/components/a3/features/admin OpenMAIC/app/a3/admin OpenMAIC/tests/admin/admin-governance-pages.test.ts
git commit -m "feat(admin): add safety and configuration governance"
```

### Task 11: Full Regression, Review, and Production Release

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-admin-console.spec.ts`
- Modify deployment files only if migration execution is not already guaranteed.

- [ ] **Step 1: Add end-to-end admin and role-entry coverage**

Test public role links, student/teacher denial, admin navigation across nine routes, overview content, one safe read action, one audited write action, and mobile sidebar behavior against real seeded backend data.

- [ ] **Step 2: Run complete fresh verification**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/admin
npx.cmd tsc --noEmit
pnpm.cmd lint
npx.cmd playwright test e2e/tests/a3-admin-console.spec.ts --project=chromium --workers=1

cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

- [ ] **Step 3: Review the complete diff against the design**

Confirm no unrelated local files, no mock admin data, no exposed secrets, no unbounded lists, no N+1 query regressions, and all nine routes have loading/empty/error/success states.

- [ ] **Step 4: Commit remaining E2E and integration work**

```powershell
git add OpenMAIC/e2e/tests/a3-admin-console.spec.ts
git commit -m "test(admin): cover operations console flow"
```

- [ ] **Step 5: Push and deploy immutable images**

Push `codex/a3-latest-integration`, wait for both fixed-SHA images, run Django migration, update only `A3_BACKEND_IMAGE` and `A3_FRONTEND_IMAGE`, and recreate backend, celery, celery-beat, frontend, realtime-proxy, and caddy. Verify image revision labels, container health/restarts, public homepage, admin route, role protection, and a basic student API after deployment.

