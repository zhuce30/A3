# A3 Tutor Persona P3/P4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add controlled tutor voice previews, authenticated OpenMAIC tutor handoff, a licensed multi-VRM asset framework, student feedback, and an admin tutor operations and analytics center without exposing private prompts, provider voices, credentials, or local paths.

**Architecture:** Keep the four private tutor strategies in code as the authority, and add a Django database overlay for enablement and allowlisted avatar bindings. Django owns authentication, public persona resolution, feedback, audit, and analytics; Next.js owns TTS provider execution, cached audio delivery, OpenMAIC generation, and browser VRM rendering. Existing sessions and classrooms retain immutable public snapshots, while new work resolves current configuration and records explicit fallback evidence.

**Tech Stack:** Django 5, MySQL 8, Django cache, Next.js 15 App Router, TypeScript, React, Vitest, Three.js/VRM runtime, OpenAI or DashScope/Qwen TTS, Docker Compose.

---

## File Structure

### Backend

- Create `backend/apps/learning/tutor_persona_operations.py`: database overlay resolution, avatar validation, public snapshots, cache invalidation, and default seeding helpers.
- Create `backend/apps/learning/tutor_feedback.py`: fixed-tag validation and user-owned session feedback writes.
- Create `backend/apps/learning/migrations/0014_tutor_persona_operations.py`: three tables, indexes, constraints, and four persona/default-asset seed records.
- Create `backend/apps/learning/tests/test_tutor_persona_operations.py`: migration-facing model invariants and runtime overlay tests.
- Create `backend/apps/learning/tests/test_tutor_persona_feedback.py`: ownership, validation, update, and serialization tests.
- Modify `backend/apps/learning/models.py`: `TutorAvatarAsset`, `TutorPersonaConfiguration`, and `TutorPersonaFeedback`.
- Modify `backend/apps/learning/tutor_personas.py`: merge code allowlist with database configuration without exposing private fields.
- Modify `backend/apps/learning/views.py`: feedback endpoint only; keep coaching message handling unchanged.
- Modify `backend/apps/learning/urls.py`: feedback route.
- Create `backend/apps/system/admin_tutor_services.py`: admin overview, mutations, provider-status projection, cache, and analytics.
- Create `backend/apps/system/tests/test_admin_tutors.py`: permissions, audit, invariants, redaction, query count, and metrics.
- Modify `backend/apps/system/admin_views.py`: thin GET/PATCH handlers.
- Modify `backend/apps/system/admin_urls.py`: tutor admin routes.
- Modify `backend/apps/compat/resource_generation.py`: preserve the server-resolved public tutor snapshot in every OpenMAIC artifact state.
- Modify `backend/apps/compat/views.py`: expose the authenticated public tutor selection to the Next bridge through a controlled backend read.

### Frontend and OpenMAIC

- Create `OpenMAIC/lib/server/a3-tutor-config-client.ts`: authenticated Django tutor configuration lookup and response validation.
- Create `OpenMAIC/lib/server/a3-tutor-voice-preview.ts`: fixed copy, provider selection, cache key, in-flight deduplication, timeout, and binary response.
- Create `OpenMAIC/app/api/a3/tutors/voice-preview/route.ts`: authenticated binary voice-preview endpoint.
- Create `OpenMAIC/tests/a3-tutor-voice-preview.test.ts`: auth, allowlist, provider priority, timeout, cache, and secret-redaction tests.
- Create `OpenMAIC/components/a3/features/tutor-persona/use-tutor-voice-preview.ts`: one-audio playback lifecycle.
- Modify `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx`: preview controls and loading/error states.
- Modify `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`: preview UI contract.
- Modify `OpenMAIC/lib/a3/tutor-persona-types.ts`: public avatar and availability fields only.
- Modify `OpenMAIC/app/api/a3/resources/openmaic-classroom/route.ts`: read the authenticated tutor snapshot and submit only its allowlisted ID.
- Modify `OpenMAIC/lib/a3/openmaic-classroom-bridge.ts`: bridge and artifact snapshot types.
- Modify `OpenMAIC/app/api/generate-classroom/route.ts`: validate `a3TutorPersonaId` before job creation.
- Modify `OpenMAIC/lib/server/classroom-generation.ts`: private teaching strategy injection, main-teacher projection, and Stage snapshot.
- Modify `OpenMAIC/lib/types/stage.ts`: optional `a3Context.tutorPersona` and `fallbackUsed`.
- Create `OpenMAIC/tests/a3-openmaic-tutor-handoff.test.ts`: trust-boundary and persistence regression tests.
- Modify `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`: accept one resolved asset path and report load failure.
- Modify `OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx`: keep one Canvas and switch one active model.
- Modify `OpenMAIC/components/a3/features/coaching/digital-human-runtime.ts`: dispose prior model resources and default fallback.
- Create `OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts`: one-renderer and fallback tests.
- Create `OpenMAIC/components/a3/features/coaching/tutor-feedback-panel.tsx`: compact 1-5 rating and fixed tags.
- Modify `OpenMAIC/components/a3/features/coaching-view.tsx`: show feedback after an ended/summarized session.
- Create `OpenMAIC/tests/a3-tutor-feedback-panel.test.ts`: feedback interaction contract.
- Create `OpenMAIC/app/a3/admin/tutors/page.tsx`: guarded admin route.
- Create `OpenMAIC/components/a3/features/admin/admin-tutors-view.tsx`: operations and analytics workspace.
- Modify `OpenMAIC/components/a3/features/admin/admin-console-layout.tsx`: add the tutor-management navigation item.
- Modify `OpenMAIC/lib/a3/admin-types.ts`: tutor admin response contracts.
- Modify `OpenMAIC/lib/a3/admin-api.ts`: typed GET/PATCH calls.
- Create `OpenMAIC/tests/a3-admin-tutors.test.ts`: route, navigation, response, and mutation contracts.
- Modify `docker-compose.yml` and `docker-compose.prod.yml` only if the existing `a3-frontend-data` mount does not already cover `/app/data/tutor-previews`.

## Contract Decisions

Public persona snapshots may contain only:

```ts
type A3TutorPersona = {
  id: 'structured-teacher' | 'socratic-guide' | 'practice-coach' | 'foundation-coach';
  name: string;
  shortDescription: string;
  teachingStyle: string;
  avatarAssetId: string;
  avatarPublicPath: string;
  voiceProfileId: string;
  voicePreviewEnabled: boolean;
  allowedWorkflows: string[];
  schemaVersion: 'a3.tutor-persona.v1';
};
```

The browser, Stage, artifacts, admin responses, and audit rows must never receive `instruction`, `voice`, `openaiVoice`, `dashscopeVoice`, provider API keys, signed URLs, or absolute filesystem paths.

### Task 1: Add Tutor Configuration, Avatar Asset, and Feedback Models

**Files:**
- Modify: `backend/apps/learning/models.py`
- Create: `backend/apps/learning/migrations/0014_tutor_persona_operations.py`
- Create: `backend/apps/learning/tests/test_tutor_persona_operations.py`

- [ ] **Step 1: Write failing model and seed tests**

Add tests that assert the default asset and four configurations exist after migration, `(user, session)` feedback is unique, and only one default asset can be enabled:

```python
class TutorPersonaOperationsModelTests(TestCase):
    def test_seeded_catalog_contains_one_default_asset_and_four_personas(self):
        self.assertEqual(TutorAvatarAsset.objects.filter(is_default=True, status="enabled").count(), 1)
        self.assertEqual(TutorPersonaConfiguration.objects.count(), 4)
        self.assertEqual(
            set(TutorPersonaConfiguration.objects.values_list("persona_id", flat=True)),
            {"structured-teacher", "socratic-guide", "practice-coach", "foundation-coach"},
        )

    def test_feedback_is_unique_per_user_and_session(self):
        TutorPersonaFeedback.objects.create(user=self.user, session=self.session, persona_id="structured-teacher", rating=4)
        with self.assertRaises(IntegrityError):
            TutorPersonaFeedback.objects.create(user=self.user, session=self.session, persona_id="structured-teacher", rating=5)
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_operations -v 2
```

Expected: FAIL because the three model classes and migration records do not exist.

- [ ] **Step 3: Implement the three models and database constraints**

Use stable identifiers and controlled relative paths:

```python
class TutorAvatarAsset(models.Model):
    asset_id = models.CharField(max_length=64, unique=True)
    display_name = models.CharField(max_length=120)
    public_path = models.CharField(max_length=255)
    thumbnail_path = models.CharField(max_length=255, blank=True)
    author = models.CharField(max_length=120, blank=True)
    source_name = models.CharField(max_length=120, blank=True)
    source_url = models.URLField(blank=True)
    license_name = models.CharField(max_length=120, blank=True)
    license_url = models.URLField(blank=True)
    usage_scope = models.JSONField(default=list, blank=True)
    sha256 = models.CharField(max_length=64)
    file_size_bytes = models.PositiveBigIntegerField()
    status = models.CharField(max_length=16, choices=(("draft", "草稿"), ("enabled", "启用"), ("disabled", "停用")), default="draft")
    is_default = models.BooleanField(default=False)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_tutor_avatar_assets"
        constraints = [
            models.UniqueConstraint(fields=["is_default"], condition=models.Q(is_default=True), name="unique_default_tutor_avatar"),
        ]


class TutorPersonaConfiguration(models.Model):
    persona_id = models.CharField(max_length=64, unique=True)
    enabled = models.BooleanField(default=True)
    avatar_asset = models.ForeignKey(TutorAvatarAsset, on_delete=models.PROTECT, related_name="persona_configurations")
    voice_preview_enabled = models.BooleanField(default=True)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="updated_tutor_personas")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_tutor_persona_configurations"


class TutorPersonaFeedback(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="tutor_persona_feedback")
    session = models.ForeignKey(CoachingSession, on_delete=models.CASCADE, related_name="tutor_feedback")
    persona_id = models.CharField(max_length=64)
    rating = models.PositiveSmallIntegerField()
    tags = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "a3_tutor_persona_feedback"
        constraints = [models.UniqueConstraint(fields=["user", "session"], name="unique_user_session_tutor_feedback")]
        indexes = [models.Index(fields=["persona_id", "-created_at"], name="idx_tutor_feedback_persona")]
```

The migration must seed `teacher-default-v1` from `/a3/assets/teacher-avatar/teacher.vrm`, compute its real SHA-256 and byte size during development, mark unknown license metadata as incomplete rather than verified, and bind all four personas to that one asset.

- [ ] **Step 4: Run migrations and model tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_operations -v 2
```

Expected: no uncommitted model changes and all focused tests PASS.

- [ ] **Step 5: Commit the model slice**

```powershell
git add backend/apps/learning/models.py backend/apps/learning/migrations/0014_tutor_persona_operations.py backend/apps/learning/tests/test_tutor_persona_operations.py
git commit -m "feat: add tutor persona operation models"
```

### Task 2: Apply the Database Overlay to Public Tutor Resolution

**Files:**
- Create: `backend/apps/learning/tutor_persona_operations.py`
- Modify: `backend/apps/learning/tutor_personas.py`
- Modify: `backend/apps/profiles/tests/test_tutor_preferences.py`
- Modify: `backend/apps/learning/tests/test_coaching_tutor_persona.py`

- [ ] **Step 1: Write failing overlay and fallback tests**

Cover disabled saved preferences, one enabled fallback, public avatar path projection, historical snapshot preservation, and secret exclusion:

```python
def test_disabled_saved_persona_falls_back_without_rewriting_historical_snapshot(self):
    TutorPersonaConfiguration.objects.filter(persona_id="practice-coach").update(enabled=False)
    preference = get_user_tutor_preference(self.user)
    self.assertEqual(preference["personaId"], "structured-teacher")
    self.assertEqual(preference["source"], "runtime_fallback")
    self.assertEqual(self.historical_session.metadata["tutorPersona"]["id"], "practice-coach")

def test_public_catalog_contains_controlled_avatar_path_but_no_private_voice(self):
    persona = list_public_tutor_personas()[0]
    self.assertTrue(persona["avatarPublicPath"].startswith("/a3/assets/teacher-avatar/"))
    self.assertNotIn("instruction", persona)
    self.assertNotIn("voice", persona)
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_tutor_preferences backend.apps.learning.tests.test_coaching_tutor_persona -v 2
```

Expected: FAIL because the catalog ignores database enablement and avatar bindings.

- [ ] **Step 3: Implement overlay resolution and cache invalidation**

The service contract is:

```python
TUTOR_CONFIG_CACHE_KEY = "a3:tutor-persona-config:v1"

def list_enabled_persona_overlays() -> dict[str, dict]:
    return {
        row.persona_id: {
            "enabled": row.enabled,
            "voicePreviewEnabled": row.voice_preview_enabled,
            "avatarAssetId": row.avatar_asset.asset_id,
            "avatarPublicPath": row.avatar_asset.public_path,
        }
        for row in TutorPersonaConfiguration.objects.select_related("avatar_asset")
    }

def resolve_enabled_public_persona(persona_id: str | None) -> tuple[dict, bool]:
    requested = resolve_tutor_persona(persona_id)
    overlays = list_enabled_persona_overlays()
    if requested and overlays.get(requested["id"], {}).get("enabled"):
        return merge_public_overlay(requested, overlays[requested["id"]]), False
    fallback_id = "structured-teacher" if overlays.get("structured-teacher", {}).get("enabled") else next(
        key for key, value in overlays.items() if value.get("enabled")
    )
    return merge_public_overlay(resolve_tutor_persona(fallback_id), overlays[fallback_id]), True
```

If the table is unavailable during rolling deployment, preserve current code-only behavior and set `fallbackUsed=True`; never fail authentication or coaching startup because migration has not completed.

- [ ] **Step 4: Run profile and coaching regressions**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_tutor_preferences backend.apps.learning.tests.test_coaching_tutor_persona -v 2
```

Expected: PASS; old snapshots remain unchanged and new sessions use enabled configurations.

- [ ] **Step 5: Commit the runtime overlay**

```powershell
git add backend/apps/learning/tutor_persona_operations.py backend/apps/learning/tutor_personas.py backend/apps/profiles/tests/test_tutor_preferences.py backend/apps/learning/tests/test_coaching_tutor_persona.py
git commit -m "feat: apply tutor persona configuration overlay"
```

### Task 3: Add Student Tutor Feedback

**Files:**
- Create: `backend/apps/learning/tutor_feedback.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`
- Create: `backend/apps/learning/tests/test_tutor_persona_feedback.py`
- Create: `OpenMAIC/components/a3/features/coaching/tutor-feedback-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Create: `OpenMAIC/tests/a3-tutor-feedback-panel.test.ts`

- [ ] **Step 1: Write failing API tests**

Test anonymous access, ownership, active-session rejection, fixed tags, rating range, idempotent update, and persona ID extraction from the session snapshot:

```python
def test_owner_can_create_and_update_feedback_for_ended_session(self):
    response = self.client.post(self.url, data=json.dumps({"rating": 4, "tags": ["讲解清楚", "帮助理解"]}), content_type="application/json")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json()["feedback"]["personaId"], "foundation-coach")
    response = self.client.post(self.url, data=json.dumps({"rating": 5, "tags": ["节奏合适"]}), content_type="application/json")
    self.assertEqual(response.status_code, 200)
    self.assertEqual(TutorPersonaFeedback.objects.count(), 1)
    self.assertEqual(TutorPersonaFeedback.objects.get().rating, 5)
```

- [ ] **Step 2: Run backend feedback tests and verify failure**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_feedback -v 2
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement validated upsert and endpoint**

Use exactly these tags:

```python
ALLOWED_TUTOR_FEEDBACK_TAGS = {"讲解清楚", "节奏合适", "帮助理解", "仍然困惑"}

@transaction.atomic
def save_tutor_feedback(*, user, session, rating: int, tags: list[str]) -> TutorPersonaFeedback:
    if session.user_id != user.id:
        raise PermissionError("无权评价该辅导会话")
    if session.status != CoachingSessionStatus.ENDED:
        raise ValueError("辅导结束后才能评价")
    if rating not in range(1, 6):
        raise ValueError("评分必须为 1 到 5 分")
    normalized_tags = list(dict.fromkeys(tags))
    if any(tag not in ALLOWED_TUTOR_FEEDBACK_TAGS for tag in normalized_tags):
        raise ValueError("反馈标签无效")
    persona_id = str((session.metadata.get("tutorPersona") or {}).get("id") or "")
    feedback, _ = TutorPersonaFeedback.objects.update_or_create(
        user=user,
        session=session,
        defaults={"persona_id": persona_id, "rating": rating, "tags": normalized_tags},
    )
    return feedback
```

Route: `POST /api/learning/coaching/sessions/<session_id>/tutor-feedback/`.

- [ ] **Step 4: Write and run the frontend feedback test**

The panel must expose five radio-style rating buttons, four toggle tags, submit/update state, and no free-text field. Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-feedback-panel.test.ts
```

Expected before UI implementation: FAIL because the panel does not exist.

- [ ] **Step 5: Implement the compact panel and coaching integration**

Submit only:

```ts
await a3PostJson(`/api/learning/coaching/sessions/${sessionId}/tutor-feedback/`, {
  rating,
  tags: selectedTags,
});
```

Show the panel only after summary completion or `status === 'ended'`; keep the conversation and digital-human layout dimensions unchanged.

- [ ] **Step 6: Run backend and frontend feedback tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_feedback -v 2
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-feedback-panel.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit feedback**

```powershell
git add backend/apps/learning/tutor_feedback.py backend/apps/learning/views.py backend/apps/learning/urls.py backend/apps/learning/tests/test_tutor_persona_feedback.py OpenMAIC/components/a3/features/coaching/tutor-feedback-panel.tsx OpenMAIC/components/a3/features/coaching-view.tsx OpenMAIC/tests/a3-tutor-feedback-panel.test.ts
git commit -m "feat: collect tutor session feedback"
```

### Task 4: Add Admin Tutor Operations and Analytics APIs

**Files:**
- Create: `backend/apps/system/admin_tutor_services.py`
- Modify: `backend/apps/system/admin_views.py`
- Modify: `backend/apps/system/admin_urls.py`
- Create: `backend/apps/system/tests/test_admin_tutors.py`

- [ ] **Step 1: Write failing permissions, mutation, and analytics tests**

Cover admin-only access, accepted ranges, mandatory reason, last-enabled-persona protection, default asset protection, allowlisted asset paths, audit redaction, 60-second cache, data-status values, and fewer-than-five assessment pairs:

```python
def test_patch_requires_reason_and_preserves_one_enabled_persona(self):
    response = self.client.patch("/api/admin/tutors/personas/structured-teacher/", data=json.dumps({"enabled": False, "reason": ""}), content_type="application/json")
    self.assertEqual(response.status_code, 400)
    TutorPersonaConfiguration.objects.exclude(persona_id="structured-teacher").update(enabled=False)
    response = self.client.patch("/api/admin/tutors/personas/structured-teacher/", data=json.dumps({"enabled": False, "reason": "维护"}), content_type="application/json")
    self.assertEqual(response.status_code, 409)

def test_assessment_change_reports_insufficient_sample(self):
    payload = self.client.get("/api/admin/tutors/?range=7d").json()
    self.assertEqual(payload["analytics"]["assessmentAssociation"]["dataStatus"], "insufficient_sample")
    self.assertNotIn("causal", json.dumps(payload).lower())
```

- [ ] **Step 2: Run admin tests and verify failure**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_tutors -v 2
```

Expected: FAIL because admin tutor routes do not exist.

- [ ] **Step 3: Implement the admin service**

The GET response must use this stable shape:

```python
{
    "success": True,
    "range": "30d",
    "dataStatus": "partial",
    "kpis": {
        "enabledPersonaCount": 4,
        "sessionCount": 0,
        "verifiedResponseRate": {"value": None, "dataStatus": "not_collected"},
        "satisfaction": {"value": None, "sampleCount": 0, "dataStatus": "not_collected"},
    },
    "personas": [],
    "assets": [],
    "providerStatus": [],
    "analytics": {
        "adoption": [],
        "sessionQuality": [],
        "feedback": [],
        "assessmentAssociation": {"dataStatus": "insufficient_sample", "pairCount": 0},
    },
}
```

Pair completed assessments by the session's `user_id` and `knowledge_point_id`: latest completed score in the seven days before `started_at`, then first completed score in the seven days after `ended_at`. Build the score from answers for that same knowledge point; batch-query sessions, answers, and questions and pair in memory to avoid per-session queries. Label the result `observedAssociation=True` and never claim causality.

- [ ] **Step 4: Implement guarded PATCH and audit**

Accept only `enabled`, `avatarAssetId`, `voicePreviewEnabled`, and `reason`. Reject unknown personas, unknown/disabled assets, path traversal, protocol URLs, non-`.vrm` paths, disabling the final enabled persona, and disabling the default asset. Record sanitized `before`, `after`, actor, IP, and reason through `AdminAuditLog` with action `tutor.persona.update`; invalidate tutor and analytics caches after commit.

- [ ] **Step 5: Run admin API tests and query-count assertions**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_tutors backend.apps.system.tests.test_admin_permissions -v 2
```

Expected: PASS with no private prompt, provider voice, key, absolute path, or student message body in serialized responses.

- [ ] **Step 6: Commit admin backend**

```powershell
git add backend/apps/system/admin_tutor_services.py backend/apps/system/admin_views.py backend/apps/system/admin_urls.py backend/apps/system/tests/test_admin_tutors.py
git commit -m "feat: add tutor operations analytics api"
```

### Task 5: Add Authenticated, Cached Voice Previews

**Files:**
- Create: `OpenMAIC/lib/server/a3-tutor-config-client.ts`
- Create: `OpenMAIC/lib/server/a3-tutor-voice-preview.ts`
- Create: `OpenMAIC/app/api/a3/tutors/voice-preview/route.ts`
- Create: `OpenMAIC/tests/a3-tutor-voice-preview.test.ts`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Write failing route tests**

Test missing cookie, unknown/disabled persona, fixed preview copy, Qwen-before-OpenAI selection, 15-second abort, one in-flight generation per cache key, persistent cache hit, binary content type, and absence of provider metadata in headers/body.

```ts
it('deduplicates identical preview requests and returns cached audio', async () => {
  const first = await Promise.all([
    generateTutorVoicePreview('foundation-coach', runtime),
    generateTutorVoicePreview('foundation-coach', runtime),
  ]);
  expect(ttsMock).toHaveBeenCalledTimes(1);
  expect(first[0].audio.equals(first[1].audio)).toBe(true);
});
```

- [ ] **Step 2: Run the voice-preview tests and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-voice-preview.test.ts
```

Expected: FAIL because the route and generator do not exist.

- [ ] **Step 3: Implement provider selection, cache, timeout, and response**

Use server-fixed Chinese copy and a versioned cache key:

```ts
const PREVIEW_TEXT: Record<A3TutorPersonaId, string> = {
  'structured-teacher': '你好，我会先搭建知识框架，再分步骤帮你理解今天的内容。',
  'socratic-guide': '你好，我会用关键问题引导你思考，一步步找到自己的答案。',
  'practice-coach': '你好，我们会通过例题练习和即时反馈，巩固你的薄弱环节。',
  'foundation-coach': '你好，我会从基础概念开始，用短句和小步骤陪你学会。',
};

const cacheKey = createHash('sha256')
  .update(JSON.stringify({ provider, model, voice, text: PREVIEW_TEXT[personaId], version: 'v1' }))
  .digest('hex');
```

Store only audio bytes under `/app/data/tutor-previews/<cacheKey>.<ext>`. The route authenticates by forwarding the incoming cookie to Django, confirms the persona is enabled, applies the existing request-rate limiter, and returns `503` with `当前未配置音色试听` when no supported TTS provider is configured.

- [ ] **Step 4: Verify the persistent mount**

Run:

```powershell
rg -n "a3-frontend-data|/app/data" docker-compose.yml docker-compose.prod.yml
```

If `/app/data` is already mounted, make no compose change. Otherwise mount the existing named volume; do not create a second preview-only volume.

- [ ] **Step 5: Run voice tests and type checking**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-voice-preview.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS; generated response contains audio only.

- [ ] **Step 6: Commit voice preview backend**

```powershell
git add OpenMAIC/lib/server/a3-tutor-config-client.ts OpenMAIC/lib/server/a3-tutor-voice-preview.ts OpenMAIC/app/api/a3/tutors/voice-preview/route.ts OpenMAIC/tests/a3-tutor-voice-preview.test.ts docker-compose.yml docker-compose.prod.yml
git commit -m "feat: add secure tutor voice previews"
```

### Task 6: Add Voice Playback to the Shared Persona Selector

**Files:**
- Create: `OpenMAIC/components/a3/features/tutor-persona/use-tutor-voice-preview.ts`
- Modify: `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx`
- Modify: `OpenMAIC/lib/a3/tutor-persona-types.ts`
- Modify: `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`

- [ ] **Step 1: Add failing selector tests**

Assert each enabled persona has an icon button with tooltip, preview does not call `onSelect`, a second preview stops the first, disabled preview shows the unavailable state, and unmount revokes the object URL.

- [ ] **Step 2: Run the selector test and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-selector.test.ts
```

Expected: FAIL because preview controls and lifecycle do not exist.

- [ ] **Step 3: Implement one-audio playback lifecycle**

The hook owns exactly one `HTMLAudioElement`, one `AbortController`, and one object URL:

```ts
type TutorVoicePreviewState = {
  personaId: A3TutorPersonaId | null;
  status: 'idle' | 'loading' | 'playing' | 'error';
  error: string;
};

async function requestPreview(personaId: A3TutorPersonaId) {
  const response = await fetch('/api/a3/tutors/voice-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId }),
    signal: abortController.signal,
  });
  if (!response.ok) throw new Error((await response.json()).error || '音色试听失败');
  return response.blob();
}
```

Stop and clean the current audio before another preview; cleanup on unmount. Keep selection and preview actions independent.

- [ ] **Step 4: Run selector tests and type checking**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-selector.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit selector preview UI**

```powershell
git add OpenMAIC/components/a3/features/tutor-persona/use-tutor-voice-preview.ts OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx OpenMAIC/lib/a3/tutor-persona-types.ts OpenMAIC/tests/a3-tutor-persona-selector.test.ts
git commit -m "feat: add tutor voice preview controls"
```

### Task 7: Carry Authenticated Tutor Snapshots into OpenMAIC Classrooms

**Files:**
- Modify: `OpenMAIC/app/api/a3/resources/openmaic-classroom/route.ts`
- Modify: `OpenMAIC/lib/a3/openmaic-classroom-bridge.ts`
- Modify: `OpenMAIC/app/api/generate-classroom/route.ts`
- Modify: `OpenMAIC/lib/server/classroom-generation.ts`
- Modify: `OpenMAIC/lib/types/stage.ts`
- Modify: `backend/apps/compat/resource_generation.py`
- Modify: `backend/apps/compat/views.py`
- Create: `OpenMAIC/tests/a3-openmaic-tutor-handoff.test.ts`
- Modify: `OpenMAIC/tests/a3-openmaic-classroom-route.test.ts`

- [ ] **Step 1: Write failing trust-boundary and snapshot tests**

Test that client `tutorPersona`, `instruction`, and `voice` fields are ignored; the bridge reads the authenticated preference from Django; only `a3TutorPersonaId` reaches generation; Stage and all artifact states receive one public snapshot plus `fallbackUsed`; and legacy stages without `a3Context` still load.

- [ ] **Step 2: Run focused handoff tests and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-openmaic-classroom-route.test.ts tests/a3-openmaic-tutor-handoff.test.ts
```

Expected: FAIL because generated classrooms do not carry a tutor context.

- [ ] **Step 3: Add the Stage and generation contracts**

```ts
export type A3ClassroomTutorContext = {
  tutorPersona: A3TutorPersona;
  fallbackUsed: boolean;
};

export interface Stage {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  a3Context?: A3ClassroomTutorContext;
}

export interface GenerateClassroomInput {
  requirement: string;
  a3TutorPersonaId?: A3TutorPersonaId;
}
```

Resolve the runtime from the ID server-side. Append the private teaching directive to the outline requirement and generated main teacher persona, but persist only `toPublicTutorPersona(runtime)`.

- [ ] **Step 4: Preserve snapshot evidence through artifact updates**

At `queued`, `running`, `succeeded`, and `failed`, copy the generation-time public snapshot and fallback flag. Never re-resolve historical artifacts during polling or serialization.

- [ ] **Step 5: Run bridge, artifact, and Stage regressions**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-openmaic-classroom-route.test.ts tests/a3-openmaic-classroom-bridge.test.ts tests/a3-openmaic-artifact-history.test.ts tests/a3-openmaic-tutor-handoff.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS; no private runtime fields appear in serialized snapshots.

- [ ] **Step 6: Commit OpenMAIC handoff**

```powershell
git add OpenMAIC/app/api/a3/resources/openmaic-classroom/route.ts OpenMAIC/lib/a3/openmaic-classroom-bridge.ts OpenMAIC/app/api/generate-classroom/route.ts OpenMAIC/lib/server/classroom-generation.ts OpenMAIC/lib/types/stage.ts backend/apps/compat/resource_generation.py backend/apps/compat/views.py OpenMAIC/tests/a3-openmaic-tutor-handoff.test.ts OpenMAIC/tests/a3-openmaic-classroom-route.test.ts
git commit -m "feat: carry tutor personas into OpenMAIC classrooms"
```

### Task 8: Add the Multi-VRM Runtime Framework Without Fake Assets

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-runtime.ts`
- Create: `OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts`

- [ ] **Step 1: Write failing runtime lifecycle tests**

Assert that switching personas bound to the same asset does not reload, switching asset paths reuses the same Canvas/renderer, old model geometry/material/texture resources are disposed, only one active VRM remains, a failed load falls back to `/a3/assets/teacher-avatar/teacher.vrm`, and layout dimensions do not shift while loading.

- [ ] **Step 2: Run the digital-human asset test and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar-assets.test.ts
```

Expected: FAIL because the runtime uses one hard-coded VRM path.

- [ ] **Step 3: Implement controlled asset switching**

Use this runtime contract:

```ts
type AvatarAssetSelection = {
  assetId: string;
  publicPath: string;
};

type AvatarLoadResult = {
  activeAssetId: string;
  fallbackUsed: boolean;
};
```

Do not preload assets. If `assetId` is unchanged, update persona behavior without touching the model. If it changes, keep the Canvas and renderer, dispose the old model, load one new model, and retain a fixed-size loading fallback.

- [ ] **Step 4: Run existing and new avatar tests**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-runtime.test.ts tests/a3-digital-human-avatar.test.ts tests/a3-digital-human-avatar-assets.test.ts tests/a3-coaching-digital-human-integration.test.ts
npx.cmd tsc --noEmit
```

Expected: all new tests PASS. If the known stale test still expects `a3-realtime-preview-strip`, record it as pre-existing and do not rewrite the product to satisfy that obsolete selector.

- [ ] **Step 5: Commit VRM framework**

```powershell
git add OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx OpenMAIC/components/a3/features/coaching/digital-human-runtime.ts OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts
git commit -m "feat: support controlled tutor avatar assets"
```

### Task 9: Build the Admin Tutor Management and Analytics Page

**Files:**
- Create: `OpenMAIC/app/a3/admin/tutors/page.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-tutors-view.tsx`
- Modify: `OpenMAIC/components/a3/features/admin/admin-console-layout.tsx`
- Modify: `OpenMAIC/lib/a3/admin-types.ts`
- Modify: `OpenMAIC/lib/a3/admin-api.ts`
- Create: `OpenMAIC/tests/a3-admin-tutors.test.ts`

- [ ] **Step 1: Write failing admin page contract tests**

Assert the route uses the existing admin guard/layout, navigation exposes `导师管理`, the range is a `7d/30d/90d` segmented control, persona mutations require a reason dialog, assets show license completeness rather than fake verification, metrics show explicit data status, and the assessment panel contains `观察到的相关性，不代表因果关系`.

- [ ] **Step 2: Run admin frontend tests and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-admin-tutors.test.ts
```

Expected: FAIL because the route and navigation item do not exist.

- [ ] **Step 3: Add typed API contracts**

```ts
export type A3TutorMetric<T> = {
  value: T | null;
  dataStatus: 'collected' | 'partial' | 'not_collected' | 'insufficient_sample';
  sampleCount?: number;
};

export type A3AdminTutorRange = '7d' | '30d' | '90d';

export function getA3AdminTutors(range: A3AdminTutorRange) {
  return a3GetJson<A3AdminTutorsResponse>(`/api/admin/tutors/?range=${range}`);
}

export function updateA3AdminTutor(personaId: string, payload: A3AdminTutorUpdateRequest) {
  return a3PatchJson<A3AdminTutorUpdateResponse>(`/api/admin/tutors/personas/${encodeURIComponent(personaId)}/`, payload);
}
```

- [ ] **Step 4: Implement the balanced operations workspace**

Build an unframed page with a compact header, four KPI cells, persona table on the left, asset/provider status on the right, and analytics bands below. Use the existing warm admin palette, 8px-or-less radii, no nested cards, no blue primary buttons, and no student names or conversation bodies. Include loading skeleton, retryable error, empty/insufficient states, success feedback, and mobile stacking.

- [ ] **Step 5: Run admin tests, lint, and type checking**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-admin-tutors.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: PASS with only the seven AGENTS-approved historical warnings and zero lint errors.

- [ ] **Step 6: Commit the admin page**

```powershell
git add OpenMAIC/app/a3/admin/tutors/page.tsx OpenMAIC/components/a3/features/admin/admin-tutors-view.tsx OpenMAIC/components/a3/features/admin/admin-console-layout.tsx OpenMAIC/lib/a3/admin-types.ts OpenMAIC/lib/a3/admin-api.ts OpenMAIC/tests/a3-admin-tutors.test.ts
git commit -m "feat: add tutor management workspace"
```

### Task 10: Full Verification, Documentation, and Deployment Readiness

**Files:**
- Modify: `docs/superpowers/specs/2026-07-26-a3-tutor-persona-p3-p4-design.md`
- Modify: `docs/superpowers/plans/2026-07-26-a3-tutor-persona-p3-p4-implementation.md`
- Modify: `docs/A3_OpenMAIC页面分工与接入边界.md`
- Modify: `.env.example` only if a new non-secret configuration name is required.

- [ ] **Step 1: Run all focused backend tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_tutor_persona_operations backend.apps.learning.tests.test_tutor_persona_feedback backend.apps.learning.tests.test_coaching_tutor_persona backend.apps.profiles.tests.test_tutor_preferences backend.apps.system.tests.test_admin_tutors -v 2
```

Expected: PASS.

- [ ] **Step 2: Run all focused frontend tests**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-runtime.test.ts tests/a3-tutor-persona-selector.test.ts tests/a3-tutor-voice-preview.test.ts tests/a3-tutor-feedback-panel.test.ts tests/a3-openmaic-classroom-route.test.ts tests/a3-openmaic-classroom-bridge.test.ts tests/a3-openmaic-artifact-history.test.ts tests/a3-openmaic-tutor-handoff.test.ts tests/a3-digital-human-avatar-assets.test.ts tests/a3-admin-tutors.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository baseline checks**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: TypeScript PASS, lint has zero errors and only approved historical warnings, Django check PASS, and no pending migrations. If `validate_demo_flow` cannot connect to local MySQL, record the exact credentials/environment blocker and run it in the production-like Docker stack before deployment.

- [ ] **Step 4: Verify security by serialized-output scan**

Run focused tests that serialize profile, coaching, Stage, artifact, admin, and audit responses, then assert none contain:

```text
instruction
openaiVoice
dashscopeVoice
apiKey
Authorization
D:\
/app/data/
/srv/
signedUrl
```

Expected: no sensitive values outside intentional internal test fixtures.

- [ ] **Step 5: Verify production migration and runtime in Docker**

```powershell
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml config --quiet
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml run --rm backend python manage.py migrate --plan
```

Expected: Compose configuration valid; migration plan includes `learning.0014_tutor_persona_operations` once and no destructive table operations.

- [ ] **Step 6: Update docs with truthful capability status**

Document that only `teacher-default-v1` is currently enabled, additional VRMs require verified licensing and a frontend rebuild, voice preview depends on configured provider credentials, analytics are observational, and private strategy fields never enter public contracts.

- [ ] **Step 7: Mark plan tasks complete and commit verification docs**

```powershell
git add docs/superpowers/specs/2026-07-26-a3-tutor-persona-p3-p4-design.md docs/superpowers/plans/2026-07-26-a3-tutor-persona-p3-p4-implementation.md docs/A3_OpenMAIC页面分工与接入边界.md .env.example
git commit -m "docs: record tutor persona operations verification"
```

- [ ] **Step 8: Perform final Git review before any push**

```powershell
git status --short --branch
git diff --check
git log --oneline --decorate -15
```

Expected: clean worktree, no whitespace errors, and only intentional tutor-persona commits. Push, merge into `codex/a3-latest-integration`, GitHub Actions image builds, migration, and server recreation happen only after this checkpoint and explicit user confirmation.

## Production Rollout Sequence

After verified implementation and explicit approval:

1. Push `codex/unified-tutor-persona`.
2. Merge it into `codex/a3-latest-integration` without unrelated commits.
3. Wait for fixed-SHA backend and frontend GHCR images.
4. On the server, back up `/opt/A3/.env.production` and database.
5. Pull both fixed-SHA images before changing containers.
6. Run `python manage.py migrate` using the new backend image.
7. Recreate `backend`, `celery`, `celery-beat`, and `frontend`; recreate `caddy` only if Compose/Caddy configuration changed.
8. Verify `/api/profiles/tutor-preference/`, voice preview, coaching feedback, OpenMAIC classroom artifact snapshots, `/api/admin/tutors/`, and `/a3/admin/tutors`.
9. Confirm the existing persona preference, legacy coaching sessions, legacy classrooms, and the default VRM still work.
10. Keep rollback image digests and the database backup until smoke checks pass.

