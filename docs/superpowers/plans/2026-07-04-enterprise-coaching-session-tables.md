# Enterprise Coaching Session Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move face-to-face tutoring persistence from `LearnerProfile.extra_profile.coachingSession` into auditable `CoachingSession` and `CoachingMessage` tables without breaking the existing `/api/a3/coaching/session` frontend contract.

**Architecture:** Add first-class Django models in `backend/apps/learning/models.py`, then update `backend/apps/learning/services.py` so reads prefer relational rows and writes append to `CoachingMessage`. Keep a one-release compatibility fallback that imports existing `extra_profile.coachingSession` into the latest active session, then stop writing new coaching transcript data into `extra_profile`.

**Tech Stack:** Django ORM and migrations, Django TestCase, existing Next.js proxy route, existing React `/a3/coaching` page, MySQL indexes.

---

### Task 1: Add Relational Coaching Models

**Files:**
- Modify: `backend/apps/learning/models.py`
- Create: `backend/apps/learning/migrations/0008_coaching_session_models.py`
- Test: `backend/apps/learning/tests/test_coaching_session_models.py`

- [ ] **Step 1: Write the failing model test**

```python
from django.test import TestCase
from backend.apps.accounts.models import User
from backend.apps.learning.models import CoachingSession, CoachingMessage


class CoachingSessionModelTests(TestCase):
    def test_session_and_messages_are_ordered_for_latest_recovery(self):
        user = User.objects.create_user(phone="13800007101", password="TestPassword123")
        session = CoachingSession.objects.create(user=user, topic_title="反馈控制")
        CoachingMessage.objects.create(session=session, role="user", content="反馈控制是什么？")
        CoachingMessage.objects.create(session=session, role="assistant", content="反馈控制会回送输出。", verified=True)

        latest = CoachingSession.objects.filter(user=user, status="active").first()
        self.assertEqual(latest.id, session.id)
        self.assertEqual(list(latest.messages.values_list("role", flat=True)), ["user", "assistant"])
```

- [ ] **Step 2: Run test to verify RED**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session_models --keepdb`

Expected: FAIL with `ImportError` or `AttributeError` because `CoachingSession` and `CoachingMessage` do not exist.

- [ ] **Step 3: Add models**

Add to `backend/apps/learning/models.py`:

```python
class CoachingSessionStatus(models.TextChoices):
    ACTIVE = "active", "进行中"
    ENDED = "ended", "已结束"
    ARCHIVED = "archived", "已归档"


class CoachingSession(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="coaching_sessions")
    course = models.ForeignKey(Course, on_delete=models.SET_NULL, null=True, blank=True, related_name="coaching_sessions")
    knowledge_point = models.ForeignKey(KnowledgePoint, on_delete=models.SET_NULL, null=True, blank=True, related_name="coaching_sessions")
    status = models.CharField(max_length=16, choices=CoachingSessionStatus.choices, default=CoachingSessionStatus.ACTIVE)
    topic_title = models.CharField(max_length=160, blank=True)
    summary = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "a3_coaching_sessions"
        ordering = ["-updated_at", "-created_at"]
        indexes = [
            models.Index(fields=["user", "status", "-updated_at"], name="idx_coach_user_status"),
            models.Index(fields=["knowledge_point", "-updated_at"], name="idx_coach_point_time"),
        ]


class CoachingMessageRole(models.TextChoices):
    USER = "user", "学生"
    ASSISTANT = "assistant", "助教"


class CoachingMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    session = models.ForeignKey(CoachingSession, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=CoachingMessageRole.choices)
    content = models.TextField()
    verified = models.BooleanField(default=False)
    citations = models.JSONField(default=list, blank=True)
    claims = models.JSONField(default=list, blank=True)
    safety = models.JSONField(default=dict, blank=True)
    refusal_reason = models.CharField(max_length=500, blank=True)
    degraded = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "a3_coaching_messages"
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["session", "created_at"], name="idx_coach_msg_session"),
            models.Index(fields=["role", "verified"], name="idx_coach_msg_role_verified"),
        ]
```

- [ ] **Step 4: Create migration**

Run: `backend\.venv\Scripts\python.exe backend\manage.py makemigrations learning`

Expected: creates `0008_coaching_session_models.py` with both tables and indexes.

- [ ] **Step 5: Run model test to verify GREEN**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session_models --keepdb`

Expected: PASS.

### Task 2: Read/Write Service Migration

**Files:**
- Modify: `backend/apps/learning/services.py`
- Test: `backend/apps/learning/tests/test_coaching_session.py`

- [ ] **Step 1: Extend existing tests with relational assertions**

Add assertions to `test_coaching_session_persists_verified_messages`:

```python
from backend.apps.learning.models import CoachingSession, CoachingMessage

session = CoachingSession.objects.get(user=self.user)
self.assertEqual(session.summary, "解释了反馈控制的基本闭环结构。")
self.assertEqual(CoachingMessage.objects.filter(session=session).count(), 2)
self.assertTrue(CoachingMessage.objects.get(session=session, role="assistant").verified)
```

- [ ] **Step 2: Add compatibility import test**

```python
def test_legacy_extra_profile_session_is_imported_once(self):
    profile = self.user.learner_profile
    profile.extra_profile = {
        "coachingSession": {
            "messages": [{"id": "legacy-user", "role": "user", "content": "旧记录"}],
            "summary": "旧摘要",
            "updatedAt": "2026-07-04T10:00:00+08:00",
        }
    }
    profile.save(update_fields=["extra_profile", "updated_at"])

    response = self.client.get("/api/learning/coaching/session/")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json()["session"]["messages"][0]["id"], "legacy-user")
    self.assertEqual(CoachingMessage.objects.filter(session__user=self.user).count(), 1)

    self.client.get("/api/learning/coaching/session/")
    self.assertEqual(CoachingMessage.objects.filter(session__user=self.user).count(), 1)
```

- [ ] **Step 3: Run tests to verify RED**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb`

Expected: FAIL because service still stores only `extra_profile`.

- [ ] **Step 4: Implement service functions**

Update `coaching_session(user)` to:
- get or create latest active `CoachingSession`
- import legacy `extra_profile.coachingSession` only when no relational messages exist
- return serialized relational messages in the same response shape currently used by the frontend

Update `append_coaching_messages(user, raw_messages, summary="")` to:
- write each message as a `CoachingMessage`
- update `CoachingSession.summary`, `topic_title`, and `updated_at`
- keep existing `append_learning_event(...)`
- stop writing transcript messages back to `extra_profile`

- [ ] **Step 5: Run service tests to verify GREEN**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb`

Expected: PASS.

### Task 3: Session Lifecycle and Query Surface

**Files:**
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`
- Modify: `backend/apps/learning/services.py`
- Test: `backend/apps/learning/tests/test_coaching_session.py`

- [ ] **Step 1: Add failing lifecycle tests**

```python
def test_user_can_end_current_coaching_session(self):
    self.client.post(
        "/api/learning/coaching/session/",
        data=json.dumps({"messages": [{"role": "user", "content": "结束前的问题"}]}),
        content_type="application/json",
    )
    response = self.client.post("/api/learning/coaching/session/end/")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json()["session"]["status"], "ended")


def test_new_append_after_end_creates_new_active_session(self):
    self.client.post(
        "/api/learning/coaching/session/",
        data=json.dumps({"messages": [{"role": "user", "content": "第一场"}]}),
        content_type="application/json",
    )
    self.client.post("/api/learning/coaching/session/end/")
    self.client.post(
        "/api/learning/coaching/session/",
        data=json.dumps({"messages": [{"role": "user", "content": "第二场"}]}),
        content_type="application/json",
    )
    self.assertEqual(CoachingSession.objects.filter(user=self.user).count(), 2)
```

- [ ] **Step 2: Run tests to verify RED**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb`

Expected: FAIL because `/api/learning/coaching/session/end/` does not exist.

- [ ] **Step 3: Add lifecycle service and route**

Add `end_coaching_session(user)` in `backend/apps/learning/services.py`.

Add `coaching_end(request)` in `backend/apps/learning/views.py`.

Add URL:

```python
path("coaching/session/end/", views.coaching_end, name="learning-coaching-session-end"),
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb`

Expected: PASS.

### Task 4: Frontend Contract Stays Stable

**Files:**
- Modify: `OpenMAIC/app/api/a3/coaching/session/route.ts`
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Test: `OpenMAIC/tests/a3-coaching-session.test.ts`

- [ ] **Step 1: Add test for end-session proxy**

```ts
it('ends the active coaching session through Django', async () => {
  postA3DjangoJson.mockResolvedValue({
    success: true,
    session: { schemaVersion: 'a3.coaching-session.v1', messages: [], summary: '', updatedAt: '2026-07-04T10:02:00+08:00', status: 'ended' },
  });
  const { POST } = await import('@/app/api/a3/coaching/session/end/route');
  const response = await POST(new Request('http://localhost/api/a3/coaching/session/end', {
    method: 'POST',
    headers: { cookie: 'sessionid=test' },
  }) as never);
  expect(response.status).toBe(200);
  expect(postA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/session/end/', 'sessionid=test', {});
});
```

- [ ] **Step 2: Run Vitest to verify RED**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-coaching-session.test.ts`

Expected: FAIL because the Next route does not exist.

- [ ] **Step 3: Add proxy route**

Create `OpenMAIC/app/api/a3/coaching/session/end/route.ts` that posts `{}` to `/api/learning/coaching/session/end/` and returns the same `session` payload.

- [ ] **Step 4: Wire end button**

Update `endConversation()` in `OpenMAIC/components/a3/features/coaching-view.tsx` to call `/api/a3/coaching/session/end` after stopping local media. Keep the current UI behavior if the network call fails, but show a normal Chinese warning.

- [ ] **Step 5: Run Vitest and TypeScript**

Run:
- `cd OpenMAIC; pnpm.cmd vitest run tests/a3-coaching-session.test.ts`
- `cd OpenMAIC; npx.cmd tsc --noEmit`

Expected: PASS.

### Task 5: Backfill and Operational Safety

**Files:**
- Create: `backend/apps/learning/migrations/0009_backfill_coaching_sessions.py`
- Test: `backend/apps/learning/tests/test_coaching_session.py`

- [ ] **Step 1: Add migration behavior test at service level**

The service compatibility import test from Task 2 covers the same transformation. Keep migration logic small and deterministic.

- [ ] **Step 2: Write data migration**

Data migration should:
- iterate `LearnerProfile` rows with `extra_profile.coachingSession`
- create one ended `CoachingSession` per profile when no relational session exists
- create `CoachingMessage` rows preserving `id`, `role`, `content`, `verified`, `citations`, `claims`, `safety`, `refusalReason`, `degraded`, and `createdAt`
- set `metadata["legacyExtraProfileImport"] = True`

- [ ] **Step 3: Run migration check**

Run: `backend\.venv\Scripts\python.exe backend\manage.py migrate --plan`

Expected: shows `learning.0008_coaching_session_models` and `learning.0009_backfill_coaching_sessions` in order.

- [ ] **Step 4: Run full backend checks**

Run:
- `backend\.venv\Scripts\python.exe backend\manage.py check`
- `backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict`

Expected: PASS.

### Task 6: Final Verification

**Files:**
- No production files.

- [ ] Run backend targeted tests:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session backend.apps.learning.tests.test_coaching_session_models --keepdb
```

- [ ] Run frontend targeted tests:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-session.test.ts
```

- [ ] Run baseline checks:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected:
- Backend tests pass.
- Vitest passes.
- `tsc` passes.
- `lint` has no new warnings beyond the existing AGENTS.md allowed warnings.
- `validate_demo_flow` passes.

### Self-Review

- Spec coverage: model persistence, compatibility import, endpoint contract stability, session lifecycle, migration, and verification are covered.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: `CoachingSession`, `CoachingMessage`, `coaching_session`, `append_coaching_messages`, and session response fields are consistent across tasks.
