# A3 Production Performance Architecture Design

## 1. Background

A3 production currently runs Django/Uvicorn, Next.js, Celery, Celery Beat, MySQL, Redis and Caddy on one Alibaba Cloud VPS. The host exposes two logical CPUs backed by one physical core with SMT, 3.4 GiB usable RAM and 4 GiB swap.

The July 17 incident showed the characteristic failure mode:

```text
multiple browser task streams
-> fixed 2.5-second polling
-> overlapping requests when upstream slows
-> Uvicorn workers become unresponsive and are recycled
-> memory pressure and swap activity increase
-> Caddy returns 502 after long waits
```

The immediate overlapping-poll fix is already deployed. This design defines the first production-hardening batch that prevents the same class of failure without changing user-facing API contracts.

## 2. Goals

1. Keep idle task monitoring inexpensive and prevent request amplification across slow upstream calls.
2. Reduce repeated SQL work in the student report path before assessment data grows.
3. Add indexes matching the report's real filtering and ordering patterns.
4. Give Docker and Caddy an explicit backend readiness signal.
5. Bound container log growth so disk exhaustion cannot silently take down MySQL and the application.
6. Add repeatable performance checks so future changes are evaluated with measurements rather than worker-count guesses.

## 3. Non-goals

The first batch will not:

- increase Uvicorn or Celery concurrency;
- introduce Kubernetes;
- move MySQL or Celery to another server;
- implement a complete Redis Pub/Sub task event bus;
- add a report cache whose invalidation cannot yet cover every report data source;
- change the response schema of report, task, authentication or learning APIs.

Those changes require separate capacity or architecture work after the first batch establishes reliable measurements.

## 4. Chosen Approach

### 4.1 Adaptive serialized task snapshots

The SSE route remains the browser-facing contract. Each connection may have only one task snapshot request in flight.

Polling policy:

- active tasks: refresh every 5 seconds;
- no active tasks: refresh every 60 seconds;
- upstream error: retry after 30 seconds;
- closed or aborted stream: cancel all future timers;
- browser fallback polling: run only when SSE is not live.

The task payload continues to emit `event: tasks`; no consumer changes are required. A future Redis Pub/Sub implementation can replace the scheduler behind the same SSE contract.

### 4.2 Report query consolidation

`build_learning_report()` currently performs repeated `.count()` queries for total/correct answers and repeated queries per trend bucket. The implementation will use conditional aggregation and grouped date/bucket data so each logical dataset is read once.

The report remains computed from authoritative database data. No production cache is added in this batch, avoiding stale learning feedback after an assessment or wrong-question review.

The implementation must preserve the existing JSON schema and current behavior for empty, partial and sufficient evidence states.

### 4.3 Database indexes

A Django migration will add indexes for the dominant production access paths:

```text
a3_ans_sess_time_ok_idx: AssessmentAnswer(session_id, answered_at, is_correct)
a3_wrong_user_master_idx: WrongQuestion(user_id, mastered, -last_wrong_at)
a3_path_user_status_idx: LearningPath(user_id, status, -created_at)
a3_pack_user_done_idx: ResourcePackLog(user_id, -completed_at, -created_at)
```

Index names will be explicit and within MySQL's identifier limits. Migration verification must use Django's migration executor and production-compatible MySQL SQL generation where available.

### 4.4 Health and readiness

The backend will expose two lightweight checks:

- liveness: process can serve HTTP without touching external dependencies;
- readiness: database and Redis respond within a bounded timeout.

Docker Compose will use readiness for the backend healthcheck. Caddy must continue to return normal authentication responses and must not proxy traffic to a backend that has not completed startup.

Health responses contain only status and dependency names. They must not expose environment values, credentials, host paths or tracebacks.

### 4.5 Log and disk protection

Production services will use Docker `json-file` rotation:

```text
max-size: 10m
max-file: 3
```

Database volumes and uploaded resources are not pruned automatically. Image cleanup remains an explicit deployment operation because deleting a rollback image without checking active digests is unsafe.

### 4.6 Performance feedback loop

Tests will record report query count and verify that trend generation does not issue two queries per bucket. A lightweight authenticated benchmark command will measure report latency without printing credentials or report contents.

Production acceptance metrics:

- no overlapping task snapshot requests per SSE connection;
- idle task polling no more than once per 60 seconds per active connection;
- authenticated demo report returns successfully in under 1 second at steady state;
- no Uvicorn child deaths during a 10-minute single-user report/dashboard observation;
- no new Caddy 502 responses during the observation window;
- Docker logs are bounded by configured rotation;
- all existing report and task API contract tests remain green.

## 5. Data Flow

```text
Browser
  -> Next.js SSE /api/a3/tasks/stream
      -> serialized snapshot scheduler
          -> Next.js /api/a3/tasks
              -> Django resource jobs + knowledge jobs

Browser
  -> Django /api/assessments/report/?period=...
      -> bounded aggregate queries
      -> indexed assessment/wrong-question/path/resource-log reads
      -> unchanged report JSON

Caddy
  -> backend readiness
      -> Django process + MySQL + Redis
```

## 6. Failure Handling

- Task snapshot failure emits the existing degraded task payload and backs off for 30 seconds.
- A readiness dependency failure returns HTTP 503 with a generic Chinese-safe response.
- Report aggregation failures use the existing API error envelope; tracebacks remain server-side.
- A failed migration blocks backend readiness and deployment verification rather than serving partial behavior.
- Deployment continues to use immutable image digests. Rollback restores the previous `.env.production` backup and recreates only affected services.

## 7. Testing Strategy

Frontend:

- Vitest contract tests for serialized scheduling, active/idle intervals, error backoff and timer cleanup.
- Tests proving fallback polling is disabled while SSE is live.
- TypeScript and ESLint validation.

Backend:

- Existing learning report behavior tests.
- Query-count regression tests using `CaptureQueriesContext`.
- Index migration tests and `manage.py check`.
- Liveness/readiness authentication and dependency-failure tests.

Deployment:

- `docker compose config --quiet` with production overlays.
- Docker health status after recreation.
- Authenticated report timing against production.
- Caddy/backend logs checked for worker deaths and 502 responses.

## 8. Rollout Order

1. Adaptive task scheduling and fallback suppression.
2. Report aggregation and index migration.
3. Health endpoints and Docker healthcheck.
4. Log rotation configuration.
5. Local regression suite and query benchmark.
6. GitHub Actions immutable images.
7. Production deployment and 10-minute observation.

Each step must be independently testable and committed separately. If report behavior or migrations fail, task scheduling may still ship independently while the failing backend batch is held back.

## 9. Later Capacity Work

After this batch, capacity decisions should use measured p95 latency, RSS, swap-in rate, SQL time and Celery queue depth. The expected next infrastructure step is `4 vCPU / 8 GiB RAM`. Splitting Celery and MySQL becomes preferable when knowledge parsing and concurrent student traffic must run at the same time.
