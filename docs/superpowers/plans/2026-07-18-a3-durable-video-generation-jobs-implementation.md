# A3 Durable Video Generation Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace process-memory video jobs with restart-safe MySQL/Celery jobs that persist Seedance task IDs and retry only failed segments.

**Architecture:** Django owns durable job and segment state. Celery runs short idempotent submit/poll transitions and reschedules polling with countdown, while a token-protected Next route reuses the existing Seedance adapter. The existing public Next route remains the browser contract and proxies Django.

**Tech Stack:** Django 5, MySQL, Celery, Redis, Next.js 15 route handlers, TypeScript, Vitest.

---

### Task 1: Persist video jobs and segments

**Files:**
- Modify: `backend/apps/compat/models.py`
- Create: `backend/apps/compat/migrations/0005_video_generation_jobs.py`
- Test: `backend/apps/compat/tests/test_video_generation_jobs.py`

- [ ] **Step 1: Write failing model tests**

Create tests that assert a job owns ordered segments, `(job, index)` is unique, provider task IDs and successful URLs survive reload, and public serialization omits provider task IDs.

- [ ] **Step 2: Verify RED**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test --keepdb backend.apps.compat.tests.test_video_generation_jobs.VideoGenerationJobModelTests
```

Expected: import/model failure because `VideoGenerationJob` and `VideoGenerationSegment` do not exist.

- [ ] **Step 3: Add models and migration**

Implement `VideoGenerationJob` and `VideoGenerationSegment` with the fields and states from the approved design. Add indexes for `(user, -created_at)`, `(status, updated_at)`, `(job, index)`, and `(status, last_polled_at)`.

- [ ] **Step 4: Add focused serializer module**

Create `backend/apps/compat/video_jobs.py` with:

```python
def serialize_video_job(job, *, include_segments=True) -> dict: ...
def create_video_job(user, pack_id: str, payload: dict) -> VideoGenerationJob: ...
def retry_failed_video_segments(job: VideoGenerationJob) -> VideoGenerationJob: ...
```

The serializer returns `jobId/status/progress/stage/message/done/resourcePackId/segments/artifact/error`, but never returns prompt, provider task ID, Celery ID, or full provider response.

- [ ] **Step 5: Verify GREEN and migration integrity**

Run model tests, `makemigrations --check`, and `manage.py check`.

### Task 2: Add the internal Seedance submit/poll bridge

**Files:**
- Create: `OpenMAIC/app/api/internal/a3-video-provider/route.ts`
- Modify: `OpenMAIC/lib/media/adapters/seedance-adapter.ts`
- Modify: `OpenMAIC/.env.example`
- Test: `OpenMAIC/tests/a3-video-provider-bridge.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover missing/incorrect `x-a3-video-worker-token` returning 403, submit returning `providerTaskId`, poll returning `queued/running/succeeded/failed`, and responses never returning API keys.

- [ ] **Step 2: Verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-video-provider-bridge.test.ts
```

- [ ] **Step 3: Export one-shot Seedance operations**

Reuse `submitSeedanceTask` and `pollSeedanceTask`; do not call `generateWithSeedance` from the bridge. Normalize request options with `normalizeVideoOptions` and resolve the key/base URL through existing provider config.

- [ ] **Step 4: Implement token-protected route**

Accept only `seedance`, validate action and bounded input lengths, compare the token with `A3_VIDEO_WORKER_TOKEN` using constant-time comparison, and return normalized provider statuses.

- [ ] **Step 5: Verify GREEN**

Run the focused route test and provider-config tests.

### Task 3: Implement an idempotent Celery state machine

**Files:**
- Create: `backend/apps/compat/video_provider_client.py`
- Create: `backend/apps/compat/video_tasks.py`
- Modify: `backend/config/celery.py` only if discovery requires it
- Test: `backend/apps/compat/tests/test_video_generation_tasks.py`

- [ ] **Step 1: Write failing state transition tests**

Test: existing task ID is polled without submit; running after 6 minutes reschedules; one network error retains task ID; explicit provider failure resubmits once; second failure becomes terminal; succeeded segments are skipped; all terminal segments write one merged artifact.

- [ ] **Step 2: Verify RED**

Run the new test module and confirm missing task/service failures.

- [ ] **Step 3: Implement short provider client calls**

Use `A3_INTERNAL_FRONTEND_BASE_URL` and `A3_VIDEO_WORKER_TOKEN`, 30-second HTTP request timeouts, redacted errors, and no cookies. Submit and poll are separate methods.

- [ ] **Step 4: Implement Celery tasks**

Define:

```python
@shared_task(name="compat.advance_video_generation_job", acks_late=True)
def advance_video_generation_job(job_id: str): ...

@shared_task(name="compat.poll_video_generation_segment", acks_late=True)
def poll_video_generation_segment(job_id: str, index: int): ...
```

Use `transaction.atomic()` and `select_for_update()` around each transition. Polling schedules the next task with `countdown=5` and exits immediately. A job can poll for two hours from segment submission.

- [ ] **Step 5: Implement artifact finalization**

Build `a3.openmaic-video-artifact.v1` from persisted segments, set `succeeded/partial/failed`, include stable `jobId`, and call existing `record_openmaic_video_artifact` once per terminal state transition.

- [ ] **Step 6: Verify GREEN**

Run state-machine tests, existing OpenMAIC artifact tests, and Django check.

### Task 4: Add authenticated Django job APIs

**Files:**
- Modify: `backend/apps/compat/urls.py`
- Modify: `backend/apps/compat/views.py`
- Modify: `backend/apps/compat/video_jobs.py`
- Test: `backend/apps/compat/tests/test_video_generation_jobs.py`

- [ ] **Step 1: Write failing API tests**

Cover login, ownership, pack existence, create idempotency, list/detail, retry failed only, duplicate retry prevention, and broker failure leaving a recoverable queued job.

- [ ] **Step 2: Verify RED**

Run API test class and observe 404/missing view failures.

- [ ] **Step 3: Add API routes**

Implement the four approved endpoints. Creation accepts prebuilt segment requests from Next, validates exactly 1-6 segments, persists them atomically, then dispatches Celery after commit.

- [ ] **Step 4: Add retry behavior**

`retry-failed` resets only failed segments, preserves succeeded URLs, clears stale provider task IDs only for failed segments, increments a manual retry generation, and dispatches one advance task.

- [ ] **Step 5: Verify GREEN**

Run API, permission, and artifact tests.

### Task 5: Replace the Next in-memory public route

**Files:**
- Modify: `OpenMAIC/app/api/a3/resources/openmaic-video/route.ts`
- Modify: `OpenMAIC/lib/a3/recommendation-types.ts`
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx`
- Modify: `OpenMAIC/components/a3/features/resource-video-view.tsx`
- Test: `OpenMAIC/tests/a3-openmaic-video-job-status.test.ts`
- Test: `OpenMAIC/tests/a3-resource-video-segments.test.ts`

- [ ] **Step 1: Rewrite tests to require durable proxying**

Assert the route has no process `Map`, POST proxies job creation, GET proxies list/detail, retry calls `retry-failed`, and UI labels jobs beyond five minutes as still running.

- [ ] **Step 2: Verify RED**

Run both focused Vitest files.

- [ ] **Step 3: Implement public proxy route**

Keep authentication via Django cookies. POST builds the existing six segment prompts and sends them to Django. GET forwards optional `jobId`. PATCH/POST retry action forwards the failed-only retry endpoint.

- [ ] **Step 4: Implement recovery and retry UI**

On recommendations load, restore recent active jobs. On partial artifact/video page, show a retry button with failed count, disable while dispatching, preserve playable segments, and refresh artifact after completion.

- [ ] **Step 5: Verify GREEN**

Run all video tests, `tsc`, and lint.

### Task 6: Configure and document production runtime

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `.env.production.template`
- Modify: `docs/A3_GHCR前端镜像部署.md`
- Test: `OpenMAIC/tests/a3-ghcr-deployment.test.ts`

- [ ] **Step 1: Add failing deployment assertions**

Require frontend, backend, and Celery to receive the same worker token; require Celery to use `http://frontend:3000` as internal frontend base.

- [ ] **Step 2: Add environment wiring**

Document generating a 32-byte random token. Never commit the real value.

- [ ] **Step 3: Add stale job recovery command**

Create `backend/apps/compat/management/commands/recover_video_jobs.py` to redispatch queued/polling jobs without duplicating submitted provider tasks.

- [ ] **Step 4: Verify complete video subsystem**

Run migrations check, Django tests, focused Vitest, TypeScript, lint, and Compose config merge.
