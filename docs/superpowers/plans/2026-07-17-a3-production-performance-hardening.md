# A3 Production Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce production request amplification, bound report SQL work, add matching database indexes, and make backend readiness and log growth observable and bounded.

**Architecture:** Keep all existing browser and Django response contracts. Make the existing SSE endpoint adapt its refresh interval to active work, consolidate report statistics into bounded aggregate queries, expose separate public liveness/readiness probes, and apply production-only Docker health and log policies. Each area ships as an independent commit so frontend load shedding can deploy even if a backend migration is held.

**Tech Stack:** Next.js 15 route handlers, React, Vitest, Django 5, Django ORM, MySQL 8.4, Redis, Docker Compose, Caddy.

---

## File Map

- Modify `OpenMAIC/app/api/a3/tasks/stream/route.ts`: adaptive serialized task snapshots.
- Modify `OpenMAIC/components/a3/layout/a3-top-actions.tsx`: fallback polling only when SSE is unavailable.
- Modify `OpenMAIC/tests/a3-unified-tasks-api.test.ts`: task scheduler contract coverage.
- Modify `OpenMAIC/tests/a3-top-task-center.test.ts`: browser fallback contract coverage.
- Modify `backend/apps/assessments/services.py`: bounded aggregate report queries.
- Modify `backend/apps/assessments/tests/test_learning_report_v2.py`: behavior and query-budget regression tests.
- Modify `backend/apps/assessments/models.py`: assessment-answer report index.
- Create `backend/apps/assessments/migrations/0005_assessmentanswer_report_index.py`: assessment index migration.
- Modify `backend/apps/learning/models.py`: wrong-question-independent learning indexes.
- Create `backend/apps/learning/migrations/0013_learning_report_indexes.py`: learning index migration.
- Modify `backend/apps/system/views.py`: public liveness and readiness views.
- Modify `backend/apps/system/urls.py`: probe routes.
- Modify `backend/apps/system/tests/test_health.py`: probe success and dependency-failure tests.
- Modify `docker-compose.prod.yml`: healthchecks, health-aware dependencies and log rotation.
- Modify `OpenMAIC/tests/a3-ghcr-backend-deployment.test.ts`: production Compose contract assertions.
- Create `backend/apps/assessments/management/commands/benchmark_learning_report.py`: safe report latency/query benchmark.
- Create `backend/apps/assessments/tests/test_benchmark_learning_report.py`: benchmark command output and privacy tests.

### Task 1: Adaptive Task Stream Load Shedding

**Files:**
- Modify: `OpenMAIC/tests/a3-unified-tasks-api.test.ts`
- Modify: `OpenMAIC/tests/a3-top-task-center.test.ts`
- Modify: `OpenMAIC/app/api/a3/tasks/stream/route.ts`
- Modify: `OpenMAIC/components/a3/layout/a3-top-actions.tsx`

- [ ] **Step 1: Write failing scheduler contract tests**

Add source-contract assertions that require three explicit intervals and payload-driven scheduling:

```ts
expect(source).toContain('const ACTIVE_TASK_INTERVAL_MS = 5_000');
expect(source).toContain('const IDLE_TASK_INTERVAL_MS = 60_000');
expect(source).toContain('const TASK_SNAPSHOT_RETRY_MS = 30_000');
expect(source).toContain("return running > 0 ? 'active' : 'idle'");
expect(source).toContain("state === 'active' ? ACTIVE_TASK_INTERVAL_MS : IDLE_TASK_INTERVAL_MS");
```

Add top-action assertions requiring an imperative live-state guard:

```ts
expect(source).toContain('let streamLive = false');
expect(source).toContain('if (!streamLive) void loadTasks()');
expect(source).toContain('streamLive = true');
expect(source).toContain('streamLive = false');
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-unified-tasks-api.test.ts tests/a3-top-task-center.test.ts
```

Expected: the new active/idle interval and `streamLive` assertions fail while existing tests pass.

- [ ] **Step 3: Implement adaptive serialized scheduling**

In the SSE route, replace the fixed success interval with:

```ts
const ACTIVE_TASK_INTERVAL_MS = 5_000;
const IDLE_TASK_INTERVAL_MS = 60_000;
const TASK_SNAPSHOT_RETRY_MS = 30_000;

type SnapshotState = 'active' | 'idle' | 'error';

function snapshotState(payload: unknown): SnapshotState {
  if (!payload || typeof payload !== 'object') return 'error';
  const source = payload as { success?: boolean; summary?: { running?: number } };
  if (!source.success) return 'error';
  const running = Number(source.summary?.running ?? 0);
  return running > 0 ? 'active' : 'idle';
}
```

Make `pushTasks()` return `SnapshotState`. Schedule only after the prior request resolves:

```ts
const state = await pushTasks();
const delay = state === 'error'
  ? TASK_SNAPSHOT_RETRY_MS
  : state === 'active'
    ? ACTIVE_TASK_INTERVAL_MS
    : IDLE_TASK_INTERVAL_MS;
scheduleSnapshot(delay);
```

In `a3-top-actions.tsx`, keep `streamLive` inside the effect. Set it to true on `open` and valid `tasks` events, false on `error`, and guard the 15-second fallback timer with `if (!streamLive)`.

- [ ] **Step 4: Run frontend verification**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-unified-tasks-api.test.ts tests/a3-top-task-center.test.ts
npx.cmd tsc --noEmit
pnpm.cmd exec eslint app/api/a3/tasks/stream/route.ts components/a3/layout/a3-top-actions.tsx tests/a3-unified-tasks-api.test.ts tests/a3-top-task-center.test.ts
```

Expected: all focused tests pass, TypeScript exits 0, ESLint reports no errors.

- [ ] **Step 5: Commit the frontend load-shedding change**

```powershell
git add OpenMAIC/app/api/a3/tasks/stream/route.ts OpenMAIC/components/a3/layout/a3-top-actions.tsx OpenMAIC/tests/a3-unified-tasks-api.test.ts OpenMAIC/tests/a3-top-task-center.test.ts
git commit -m "perf: reduce idle task stream load"
```

### Task 2: Bound Student Report SQL Work

**Files:**
- Modify: `backend/apps/assessments/tests/test_learning_report_v2.py`
- Modify: `backend/apps/assessments/services.py`

- [ ] **Step 1: Add failing query-budget tests**

Extend `LearningReportV2Tests` with a populated 30-day report test:

```python
def test_report_uses_bounded_queries_independent_of_trend_bucket_count(self):
    self._create_answers(days_ago=1, correctness=[True, False, True, False])
    self._create_answers(days_ago=8, correctness=[True, True, False, False])
    WrongQuestion.objects.create(
        user=self.user,
        question=self.questions[1],
        wrong_count=1,
        last_wrong_answer="B",
    )

    with CaptureQueriesContext(connection) as queries:
        report = build_learning_report(self.user, "30d")

    assessment_queries = [
        item["sql"] for item in queries.captured_queries
        if "a3_assessment_answers" in item["sql"].lower()
    ]
    self.assertEqual(len(report["trends"]), 5)
    self.assertLessEqual(len(assessment_queries), 6, assessment_queries)
    self.assertLessEqual(len(queries), 22, [item["sql"] for item in queries.captured_queries])
```

Add a behavior test proving 7-day and 30-day bucket totals/accuracy remain unchanged at date boundaries.

- [ ] **Step 2: Run report tests and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_learning_report_v2 -v 2
```

Expected: query-budget test fails because trend and comparison windows issue repeated count queries.

- [ ] **Step 3: Consolidate report aggregates**

In `build_learning_report()`:

```python
answer_totals = answers.aggregate(
    total=models.Count("id"),
    correct=models.Count("id", filter=models.Q(is_correct=True)),
)
total_answers = int(answer_totals["total"] or 0)
correct_answers = int(answer_totals["correct"] or 0)
path_items = list(path.items.all()) if path else []
total_path_items = len(path_items)
wrong_active_count = wrong_active.count()
wrong_active_top = list(wrong_active[:3])
```

Replace `_report_trends()` with one date-grouped query using `TruncDate` and conditional `Count`, then construct 7-day/30-day/term buckets from the resulting date map in Python. Replace each `_report_comparisons.window_stats()` pair of `.count()` calls with one conditional aggregate.

Change `_wrong_review_insight()` to accept `active_count` and the already-loaded top-three records so it does not query the same queryset again. Reuse `total_path_items` and `wrong_active_count` throughout the report.

- [ ] **Step 4: Verify report behavior and query budget**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_learning_report_v2 -v 2
backend\.venv\Scripts\python.exe backend\manage.py check
```

Expected: all report tests pass and the populated 30-day report stays within 6 assessment-table queries and 22 total queries.

- [ ] **Step 5: Commit report aggregation**

```powershell
git add backend/apps/assessments/services.py backend/apps/assessments/tests/test_learning_report_v2.py
git commit -m "perf: bound student report queries"
```

### Task 3: Add Report Access-Path Indexes

**Files:**
- Modify: `backend/apps/assessments/models.py`
- Create: `backend/apps/assessments/migrations/0005_assessmentanswer_report_index.py`
- Modify: `backend/apps/learning/models.py`
- Create: `backend/apps/learning/migrations/0013_learning_report_indexes.py`

- [ ] **Step 1: Add failing model metadata assertions**

Add assertions to the report test module:

```python
def test_report_models_define_production_access_path_indexes(self):
    answer_indexes = {index.name: tuple(index.fields) for index in AssessmentAnswer._meta.indexes}
    wrong_indexes = {index.name: tuple(index.fields) for index in WrongQuestion._meta.indexes}
    self.assertEqual(answer_indexes["a3_ans_sess_time_ok_idx"], ("session", "answered_at", "is_correct"))
    self.assertEqual(wrong_indexes["a3_wrong_user_master_idx"], ("user", "mastered", "-last_wrong_at"))
```

Add equivalent assertions for `LearningPath(user, status, -created_at)` and
`ResourcePackLog(user, -completed_at, -created_at)` in the owned model metadata tests.

- [ ] **Step 2: Run tests and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_learning_report_v2 backend.apps.learning.tests.test_resource_pack_log_model -v 2
```

Expected: index-name lookups fail before model metadata is changed.

- [ ] **Step 3: Add model indexes and generate migrations**

Add these `Meta.indexes` entries:

```python
models.Index(fields=["session", "answered_at", "is_correct"], name="a3_ans_sess_time_ok_idx")
models.Index(fields=["user", "mastered", "-last_wrong_at"], name="a3_wrong_user_master_idx")
models.Index(fields=["user", "status", "-created_at"], name="a3_path_user_status_idx")
models.Index(fields=["user", "-completed_at", "-created_at"], name="a3_pack_user_done_idx")
```

Generate deterministic migrations:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations assessments learning
```

Confirm the generated filenames are exactly `0005_assessmentanswer_report_index.py` and `0013_learning_report_indexes.py`, and contain only the four `AddIndex` operations.

- [ ] **Step 4: Verify migrations**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py migrate --plan
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_learning_report_v2 backend.apps.learning.tests.test_resource_pack_log_model -v 2
```

Expected: no ungenerated changes, migration plan contains four indexes, tests pass.

- [ ] **Step 5: Commit indexes**

```powershell
git add backend/apps/assessments/models.py backend/apps/assessments/migrations/0005_assessmentanswer_report_index.py backend/apps/learning/models.py backend/apps/learning/migrations/0013_learning_report_indexes.py backend/apps/assessments/tests/test_learning_report_v2.py backend/apps/learning/tests/test_resource_pack_log_model.py docs/superpowers/specs/2026-07-17-a3-production-performance-architecture-design.md docs/superpowers/plans/2026-07-17-a3-production-performance-hardening.md
git commit -m "perf: cover report index ordering"
```

### Task 4: Add Public Liveness and Readiness Probes

**Files:**
- Modify: `backend/apps/system/tests/test_health.py`
- Modify: `backend/apps/system/views.py`
- Modify: `backend/apps/system/urls.py`
- Modify: `docker-compose.prod.yml`
- Modify: `OpenMAIC/tests/a3-ghcr-backend-deployment.test.ts`

- [ ] **Step 1: Write failing probe tests**

Add tests that do not require authentication:

```python
def test_liveness_is_public_and_dependency_free(self):
    with patch("backend.apps.system.views.connection") as database, patch("backend.apps.system.views.caches") as caches:
        response = self.client.get("/api/system/live/")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json(), {"success": True, "status": "alive"})
    database.assert_not_called()
    caches.assert_not_called()

def test_readiness_returns_503_when_database_fails(self):
    with patch("backend.apps.system.views._database_ready", return_value=False), patch(
        "backend.apps.system.views._cache_ready", return_value=True
    ):
        response = self.client.get("/api/system/ready/")
    self.assertEqual(response.status_code, 503)
    self.assertEqual(response.json()["dependencies"], {"database": "error", "redis": "ok"})
```

Add success and Redis-failure cases. In the Compose contract test, require a backend healthcheck containing `/api/system/ready/`, and health-aware frontend/realtime dependencies.

- [ ] **Step 2: Run tests and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_health -v 2
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-backend-deployment.test.ts
```

Expected: new routes and Compose healthcheck assertions fail.

- [ ] **Step 3: Implement probes**

Add public `liveness` and `readiness` views. `_database_ready()` executes `SELECT 1`; `_cache_ready()` writes and reads a short-lived random probe key through `caches["default"]`. Catch exceptions and return only dependency status names, never exception text.

Register:

```python
path("live/", views.liveness),
path("ready/", views.readiness),
```

Add to the production backend service:

```yaml
healthcheck:
  test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/system/ready/', timeout=3)"]
  interval: 15s
  timeout: 5s
  retries: 6
  start_period: 45s
```

Use `condition: service_healthy` for production frontend and realtime-proxy backend dependencies.

- [ ] **Step 4: Run probe and Compose verification**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_health -v 2
backend\.venv\Scripts\python.exe backend\manage.py check
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-backend-deployment.test.ts
docker compose --env-file ..\.env.example -f ..\docker-compose.yml -f ..\docker-compose.prod.yml config --quiet
```

If `.env.example` intentionally lacks required production secrets, use a temporary process environment for Compose interpolation; do not write real secrets into the repository.

- [ ] **Step 5: Commit health probes**

```powershell
git add backend/apps/system/views.py backend/apps/system/urls.py backend/apps/system/tests/test_health.py docker-compose.prod.yml OpenMAIC/tests/a3-ghcr-backend-deployment.test.ts
git commit -m "ops: add backend readiness checks"
```

### Task 5: Bound Docker Logs and Add a Safe Benchmark

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `OpenMAIC/tests/a3-ghcr-backend-deployment.test.ts`
- Create: `backend/apps/assessments/management/commands/benchmark_learning_report.py`
- Create: `backend/apps/assessments/tests/test_benchmark_learning_report.py`

- [ ] **Step 1: Write failing deployment and benchmark tests**

Require a shared production logging anchor and its use by every service:

```ts
expect(compose).toContain('x-a3-logging: &a3-logging');
expect(compose).toContain('driver: json-file');
expect(compose).toContain('max-size: "10m"');
expect(compose).toContain('max-file: "3"');
expect((compose.match(/logging: \*a3-logging/g) ?? []).length).toBeGreaterThanOrEqual(8);
```

The benchmark command test must assert that output contains `period`, `elapsedMs`, `queryCount` and `success`, and does not contain the user's phone, report contents, password or session data.

- [ ] **Step 2: Run tests and verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-ghcr-backend-deployment.test.ts
cd ..
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_benchmark_learning_report -v 2
```

Expected: logging anchor and command import assertions fail.

- [ ] **Step 3: Configure log rotation**

Add at the top of `docker-compose.prod.yml`:

```yaml
x-a3-logging: &a3-logging
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Add `logging: *a3-logging` to mysql, redis, backend, celery, celery-beat, frontend, realtime-proxy and caddy.

- [ ] **Step 4: Implement the benchmark command**

Command arguments:

```text
--user-id <uuid-or-integer>
--period 7d|30d|term (default 30d)
--repeat <1-20> (default 3)
--json
```

Measure `build_learning_report()` with `time.perf_counter()` and `CaptureQueriesContext`. Emit only aggregate timing/query metrics. Return a command error for a missing user and never accept or print a password, phone number or report payload.

JSON shape:

```json
{
  "success": true,
  "period": "30d",
  "repeat": 3,
  "elapsedMs": {"min": 12.1, "average": 13.4, "max": 15.0},
  "queryCount": {"min": 18, "average": 18.0, "max": 18}
}
```

- [ ] **Step 5: Run full batch verification**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_learning_report_v2 backend.apps.assessments.tests.test_benchmark_learning_report backend.apps.learning.tests.test_resource_pack_log_model backend.apps.system.tests.test_health -v 2
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
cd OpenMAIC
pnpm.cmd vitest run tests/a3-unified-tasks-api.test.ts tests/a3-top-task-center.test.ts tests/a3-ghcr-backend-deployment.test.ts
npx.cmd tsc --noEmit
pnpm.cmd exec eslint app/api/a3/tasks/stream/route.ts components/a3/layout/a3-top-actions.tsx tests/a3-unified-tasks-api.test.ts tests/a3-top-task-center.test.ts tests/a3-ghcr-backend-deployment.test.ts
```

Expected: all tests pass, Django checks pass, no pending migrations, TypeScript and ESLint exit 0.

- [ ] **Step 6: Commit operational safeguards**

```powershell
git add docker-compose.prod.yml OpenMAIC/tests/a3-ghcr-backend-deployment.test.ts backend/apps/assessments/management/commands/benchmark_learning_report.py backend/apps/assessments/tests/test_benchmark_learning_report.py
git commit -m "ops: bound logs and benchmark reports"
```

### Task 6: Integrate, Build and Observe Production

**Files:**
- No new source files; deployment uses committed artifacts and immutable images.

- [ ] **Step 1: Review commit scope**

```powershell
git status --short --branch
git log --oneline --decorate -6
git diff codex/a3-latest-integration...HEAD --stat
```

Expected: only files named in this plan differ; local control files, brainstorm output and generated documents are absent.

- [ ] **Step 2: Push and wait for fixed-SHA images**

Push the implementation branch, merge or fast-forward it into `codex/a3-latest-integration`, and wait for both required GitHub Actions jobs. Record immutable backend and frontend repo digests.

- [ ] **Step 3: Back up production configuration and deploy**

On `/opt/A3`, back up `.env.production`, update the repository to the exact commit, pull fixed images, write `A3_BACKEND_IMAGE` and `A3_FRONTEND_IMAGE` as repo digests, then run:

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --no-build --force-recreate \
  backend celery celery-beat frontend realtime-proxy caddy
```

MySQL and Redis must remain on their existing volumes. Confirm migrations complete before readiness becomes healthy.

- [ ] **Step 4: Verify production behavior**

Check:

```text
GET https://api.zhuce.work/api/system/live/  -> 200
GET https://api.zhuce.work/api/system/ready/ -> 200
authenticated GET /api/assessments/report/?period=30d -> success under 1 second at steady state
backend Docker health -> healthy
realtime-proxy Docker health -> healthy
all containers restart_count -> 0
```

Observe 10 minutes while loading dashboard and report. Count Caddy 502 responses, Uvicorn child deaths, task job requests and swap-in activity. Acceptance requires zero new 502s, zero child deaths, serialized task polls and no sustained swap-in.

- [ ] **Step 5: Roll back on failed acceptance**

Restore the timestamped `.env.production` backup, pull the prior immutable image digests if absent, and recreate only affected application services. Do not roll back database volumes. Django index migrations are additive and may remain applied unless migration itself caused the failure.
