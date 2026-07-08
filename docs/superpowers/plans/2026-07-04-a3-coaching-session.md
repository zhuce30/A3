# A3 Coaching Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/a3/coaching` a real persisted face-to-face tutoring flow with recoverable transcript, grounded answers, clean Chinese UI copy, and visible knowledge-base access.

**Architecture:** Reuse the project's existing `LearnerProfile.extra_profile` persistence pattern for a scoped `coachingSession` object, exposed through Django `/api/learning/coaching/session/` and proxied by Next `/api/a3/coaching/session`. The React page loads the session on mount, appends messages after text or vision Q&A, and keeps verification metadata with each assistant reply.

**Tech Stack:** Django, Django TestCase, Next.js route handlers, React, Vitest, TypeScript, existing A3 API helpers.

---

### Task 1: Backend Coaching Session API

**Files:**
- Modify: `backend/apps/learning/services.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`
- Test: `backend/apps/learning/tests/test_path_planner.py`

- [ ] Add failing tests for `GET/POST /api/learning/coaching/session/`.
- [ ] Verify the tests fail because the endpoint does not exist.
- [ ] Add service helpers that serialize coaching messages, store the latest 60 messages under `extra_profile.coachingSession`, and record a learning event.
- [ ] Add the Django view and URL.
- [ ] Re-run the targeted backend tests and confirm they pass.

### Task 2: Next API Proxy and Route Behavior

**Files:**
- Create: `OpenMAIC/app/api/a3/coaching/session/route.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/respond/route.ts`
- Test: `OpenMAIC/tests/a3-coaching-session.test.ts`

- [ ] Add failing Vitest tests for session proxying and respond history forwarding.
- [ ] Verify the tests fail before implementation.
- [ ] Implement GET/POST proxy to Django `/api/learning/coaching/session/`.
- [ ] Include bounded conversation `history` in the text coaching upstream call.
- [ ] Re-run the targeted Vitest tests and confirm they pass.

### Task 3: Coaching Page Persistence and Copy Cleanup

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/use-coaching-media.ts`
- Modify: `OpenMAIC/lib/a3/navigation.ts`

- [ ] Load persisted coaching messages on mount before inserting the welcome message.
- [ ] Persist user and assistant messages after text and photo questions.
- [ ] Replace visible mojibake strings with normal Chinese.
- [ ] Add clear loading, retry, media permission, saving, and persisted-session status copy.
- [ ] Show `/a3/knowledge-base` in the student sidebar while keeping management-only behavior in backend APIs.

### Task 4: Verification

**Files:**
- No production files.

- [ ] Run targeted backend tests.
- [ ] Run targeted Vitest tests.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py check`.
- [ ] Run `cd OpenMAIC; npx.cmd tsc --noEmit`.
- [ ] Run `cd OpenMAIC; pnpm.cmd lint`.
