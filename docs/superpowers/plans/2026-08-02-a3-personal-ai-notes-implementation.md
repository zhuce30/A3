# A3 Personal AI Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/a3/notes` as an independent, document-first personal notes workspace with reliable persistence, scoped AI assistance, daily summaries, and user-controlled cross-session memory without changing AI Classroom behavior.

**Architecture:** Add a dedicated Django `backend.apps.notes` domain backed by MySQL and an authenticated `a3-notes-data` volume. The Next.js frontend uses the existing A3 shell, ProseMirror, Dexie, and API utilities; all AI work is persisted in Django and long-running work runs through Celery. Existing LLM, safety, verifier, and optional course retrieval capabilities are called through adapters, while note storage and note memory remain isolated from AI Classroom.

**Tech Stack:** Django 5-style function views, MySQL, Celery/Redis, python-docx/pypdf/python-pptx/openpyxl, Next.js 16, React 19, TypeScript, ProseMirror, Dexie, Vitest, Playwright, Docker Compose.

**Design spec:** `docs/superpowers/specs/2026-08-02-a3-personal-ai-notes-design.md`

---

## File Map

### Backend files to create

```text
backend/apps/notes/__init__.py
backend/apps/notes/apps.py
backend/apps/notes/models.py
backend/apps/notes/serializers.py
backend/apps/notes/urls.py
backend/apps/notes/views_notes.py
backend/apps/notes/views_attachments.py
backend/apps/notes/views_assistant.py
backend/apps/notes/views_digests.py
backend/apps/notes/views_memories.py
backend/apps/notes/tasks.py
backend/apps/notes/services/note_service.py
backend/apps/notes/services/attachment_service.py
backend/apps/notes/services/export_service.py
backend/apps/notes/services/context_service.py
backend/apps/notes/services/assistant_service.py
backend/apps/notes/services/writeback_service.py
backend/apps/notes/services/digest_service.py
backend/apps/notes/services/memory_service.py
backend/apps/notes/tests/test_models.py
backend/apps/notes/tests/test_note_api.py
backend/apps/notes/tests/test_attachments.py
backend/apps/notes/tests/test_export.py
backend/apps/notes/tests/test_assistant.py
backend/apps/notes/tests/test_writeback.py
backend/apps/notes/tests/test_digests.py
backend/apps/notes/tests/test_memory.py
backend/apps/notes/tests/test_isolation.py
backend/apps/notes/management/commands/evaluate_notes_memory.py
backend/apps/notes/evals/long_memory_cases.jsonl
backend/apps/notes/migrations/0001_initial.py
```

### Frontend files to create

```text
OpenMAIC/app/a3/notes/page.tsx
OpenMAIC/app/api/a3/notes/[...path]/route.ts
OpenMAIC/app/api/a3/notes/assistant/stream/[messageId]/route.ts
OpenMAIC/components/a3/notes/notes-workspace.tsx
OpenMAIC/components/a3/notes/notes-navigation.tsx
OpenMAIC/components/a3/notes/note-editor.tsx
OpenMAIC/components/a3/notes/note-editor-toolbar.tsx
OpenMAIC/components/a3/notes/note-attachments.tsx
OpenMAIC/components/a3/notes/note-history-dialog.tsx
OpenMAIC/components/a3/notes/note-conflict-dialog.tsx
OpenMAIC/components/a3/notes/note-ai-drawer.tsx
OpenMAIC/components/a3/notes/note-writeback-preview.tsx
OpenMAIC/components/a3/notes/note-digest-view.tsx
OpenMAIC/components/a3/notes/note-memory-manager.tsx
OpenMAIC/lib/a3/notes/types.ts
OpenMAIC/lib/a3/notes/client.ts
OpenMAIC/lib/a3/notes/draft-store.ts
OpenMAIC/lib/a3/notes/editor-schema.ts
OpenMAIC/lib/a3/notes/autosave-controller.ts
OpenMAIC/tests/a3-personal-notes-model.test.ts
OpenMAIC/tests/a3-personal-notes-autosave.test.ts
OpenMAIC/tests/a3-personal-notes-layout.test.tsx
OpenMAIC/tests/a3-personal-notes-ai.test.tsx
OpenMAIC/tests/a3-personal-notes-memory.test.tsx
OpenMAIC/e2e/tests/a3-personal-notes.spec.ts
```

### Existing files to modify

```text
backend/config/settings.py
backend/config/urls.py
backend/.env.example
docker-compose.yml
docker-compose.prod.yml
OpenMAIC/lib/a3/navigation.ts
OpenMAIC/components/a3/layout/a3-shell.tsx
```

Do not modify `OpenMAIC/app/a3/classroom/`, classroom components, coaching prompts, or the existing RetrieverAgent contract.

---

## Phase 1: Complete Notes Workspace Without AI

### Task 1: Register the notes app and create the core schema

**Files:**
- Create: `backend/apps/notes/__init__.py`
- Create: `backend/apps/notes/apps.py`
- Create: `backend/apps/notes/models.py`
- Create: `backend/apps/notes/migrations/0001_initial.py`
- Create: `backend/apps/notes/tests/__init__.py`
- Create: `backend/apps/notes/tests/test_models.py`
- Modify: `backend/config/settings.py`
- Modify: `backend/config/urls.py`

- [ ] **Step 1: Write failing model ownership and state tests**

```python
class NoteModelTests(TestCase):
    def test_note_defaults_to_version_one_and_unorganized(self):
        note = Note.objects.create(user=self.user, title="进程调度", content_json={"type": "doc"})
        self.assertEqual(note.version, 1)
        self.assertIsNone(note.notebook_id)
        self.assertIsNone(note.deleted_at)

    def test_tag_name_is_unique_per_user(self):
        NoteTag.objects.create(user=self.user, name="调度", normalized_name="调度")
        with self.assertRaises(IntegrityError):
            NoteTag.objects.create(user=self.user, name="调度", normalized_name="调度")

    def test_memory_candidate_is_not_active(self):
        memory = NoteMemory.objects.create(user=self.user, memory_type="core", content="偏好图示", status="candidate")
        self.assertFalse(memory.is_usable)
```

- [ ] **Step 2: Run the test and verify the app does not exist yet**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_models`

Expected: FAIL with `ModuleNotFoundError: No module named 'backend.apps.notes'`.

- [ ] **Step 3: Create the app config and model enums**

```python
class NotesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backend.apps.notes"
    label = "notes"

class NoteMemoryStatus(models.TextChoices):
    CANDIDATE = "candidate", "待确认"
    CONFIRMED = "confirmed", "已启用"
    PAUSED = "paused", "已暂停"
    SUPERSEDED = "superseded", "已替代"
    DELETED = "deleted", "已删除"
```

- [ ] **Step 4: Implement all spec models with named indexes and constraints**

Create `Notebook`, `NoteTag`, `Note`, `NoteRevision`, `NoteMutation`, `NoteAttachment`, `NoteAiSession`, `NoteAiMessage`, `NoteWritebackPreview`, `NoteDailyDigest`, `NoteMemory`, `NoteExportJob`, and `NoteAuditEvent`. `NoteMutation` is the idempotency receipt for autosave and contains `user`, `note`, `mutation_id`, `resulting_version`, and `created_at`. Use `UUIDField(default=uuid.uuid4)`, explicit `db_table` names beginning with `a3_note_`, and indexes beginning with `idx_note_`. Add `UniqueConstraint(user, normalized_name)` for tags, `UniqueConstraint(note, version)` for revisions, `UniqueConstraint(user, mutation_id)` for note mutations, and `UniqueConstraint(session, client_request_id)` for AI messages.

The usable-memory property must be deterministic:

```python
@property
def is_usable(self) -> bool:
    now = timezone.now()
    return (
        self.status == NoteMemoryStatus.CONFIRMED
        and self.deleted_at is None
        and (self.valid_from is None or self.valid_from <= now)
        and (self.valid_until is None or self.valid_until > now)
    )
```

- [ ] **Step 5: Register the app and URL namespace**

Add `"backend.apps.notes"` to `INSTALLED_APPS` and `path("api/notes/", include("backend.apps.notes.urls"))` to `backend/config/urls.py`. Create an initially empty `urlpatterns` so Django can start before endpoint tasks are implemented.

- [ ] **Step 6: Generate and inspect the migration**

Run: `backend\.venv\Scripts\python.exe backend\manage.py makemigrations notes`

Expected: `Migrations for 'notes': 0001_initial.py` with all 13 models and no unrelated migration.

- [ ] **Step 7: Run model and Django checks**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_models`

Expected: PASS.

Run: `backend\.venv\Scripts\python.exe backend\manage.py check`

Expected: `System check identified no issues`.

- [ ] **Step 8: Commit the schema**

```powershell
git add backend/apps/notes backend/config/settings.py backend/config/urls.py
git commit -m "feat: add personal notes data model"
```

### Task 2: Implement note lifecycle, tags, search, revisions, and optimistic locking

**Files:**
- Create: `backend/apps/notes/serializers.py`
- Create: `backend/apps/notes/services/__init__.py`
- Create: `backend/apps/notes/services/note_service.py`
- Create: `backend/apps/notes/views_notes.py`
- Create: `backend/apps/notes/urls.py`
- Create: `backend/apps/notes/tests/test_note_api.py`

- [ ] **Step 1: Write failing API tests for authentication and ownership**

```python
def test_note_detail_rejects_another_user(self):
    foreign = Note.objects.create(user=self.other, title="私有", content_json={"type": "doc"})
    self.client.force_login(self.user)
    response = self.client.get(f"/api/notes/notes/{foreign.id}/")
    self.assertEqual(response.status_code, 404)

def test_patch_rejects_stale_base_version_without_overwrite(self):
    response = self.client.patch(
        f"/api/notes/notes/{self.note.id}/",
        data=json.dumps({"baseVersion": 0, "clientMutationId": str(uuid.uuid4()), "content": {"type": "doc"}}),
        content_type="application/json",
    )
    self.assertEqual(response.status_code, 409)
    self.note.refresh_from_db()
    self.assertEqual(self.note.version, 1)
```

- [ ] **Step 2: Run tests and verify missing routes**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_note_api`

Expected: FAIL with 404 responses for notes routes.

- [ ] **Step 3: Implement strict request parsing and serializers**

Add `parse_json_body(request)`, `serialize_notebook`, `serialize_tag`, `serialize_note_summary`, `serialize_note_detail`, and `serialize_revision`. Reject non-dict JSON, titles over 200 characters, invalid ProseMirror roots, non-UUID mutation IDs, and unsupported smart-view values with normal Chinese errors and stable codes.

- [ ] **Step 4: Implement transactional optimistic save**

```python
@transaction.atomic
def save_note(*, user, note_id, base_version, mutation_id, title, content_json):
    prior = NoteMutation.objects.filter(user=user, mutation_id=mutation_id).first()
    if prior:
        return prior.note, False
    updated = Note.objects.filter(
        id=note_id, user=user, deleted_at__isnull=True, version=base_version
    ).update(
        title=title,
        content_json=content_json,
        content_text=extract_note_text(content_json),
        version=F("version") + 1,
        last_edited_at=timezone.now(),
    )
    if updated != 1:
        raise NoteVersionConflict
    note = Note.objects.get(id=note_id, user=user)
    NoteMutation.objects.create(user=user, note=note, mutation_id=mutation_id, resulting_version=note.version)
    return note, True
```

Use the `NoteMutation` receipt created in Task 1. Do not create a second receipt table or rewrite a migration that has reached any shared environment.

- [ ] **Step 5: Implement notebook, tag, note, revision, search, trash, restore, and purge endpoints**

Use `get_object_or_404(..., user=request.user)` for every object endpoint. `DELETE /notes/<id>/` sets `deleted_at`; restore clears it; purge requires body `{"confirm": true}` and deletes inside a transaction. Search filters title, `content_text`, tag, notebook, and smart view, caps results at 100, and never includes trash unless `view=trash`.

- [ ] **Step 6: Add checkpoint retention behavior**

Create a checkpoint when 15 minutes elapsed since the last checkpoint or the request source is `manual`, `ai_writeback`, or `restore`. Delete automatic checkpoints older than 90 days and retain at most 100 automatic checkpoints per note. Never prune manual, AI, or restore revisions before purge.

- [ ] **Step 7: Run API and model tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_models backend.apps.notes.tests.test_note_api`

Expected: PASS, including 401, 404, 409, idempotent retry, soft delete, restore, purge, and revision retention cases.

- [ ] **Step 8: Commit the lifecycle API**

```powershell
git add backend/apps/notes
git commit -m "feat: add personal note lifecycle API"
```

### Task 3: Add secure attachments, parsing, and authenticated downloads

**Files:**
- Create: `backend/apps/notes/services/attachment_service.py`
- Create: `backend/apps/notes/views_attachments.py`
- Create: `backend/apps/notes/tests/test_attachments.py`
- Modify: `backend/apps/notes/tasks.py`
- Modify: `backend/apps/notes/urls.py`
- Modify: `backend/config/settings.py`
- Modify: `backend/.env.example`

- [ ] **Step 1: Write failing upload and SSRF tests**

```python
def test_attachment_download_requires_owner(self):
    response = self.other_client.get(f"/api/notes/attachments/{self.attachment.id}/download/")
    self.assertEqual(response.status_code, 404)

def test_link_rejects_private_redirect_target(self):
    with patch("backend.apps.notes.services.attachment_service.requests.get") as request:
        request.return_value.headers = {"Location": "http://169.254.169.254/latest/meta-data"}
        response = self.client.post(self.url, {"kind": "link", "url": "https://example.test/link"})
    self.assertEqual(response.status_code, 400)
    self.assertEqual(response.json()["code"], "unsafe_note_link")
```

- [ ] **Step 2: Run tests and verify missing endpoints**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_attachments`

Expected: FAIL with missing attachment routes.

- [ ] **Step 3: Add explicit settings and storage path creation**

```python
A3_NOTES_STORAGE_ROOT = Path(os.getenv("A3_NOTES_STORAGE_ROOT", str(BASE_DIR / "tmp" / "a3-notes")))
A3_NOTES_ATTACHMENT_MAX_BYTES = int(os.getenv("A3_NOTES_ATTACHMENT_MAX_BYTES", str(50 * 1024 * 1024)))
A3_NOTES_USER_QUOTA_BYTES = int(os.getenv("A3_NOTES_USER_QUOTA_BYTES", str(512 * 1024 * 1024)))
A3_NOTES_PARSE_TIMEOUT_SECONDS = int(os.getenv("A3_NOTES_PARSE_TIMEOUT_SECONDS", "90"))
```

Document the same defaults in `backend/.env.example` without secrets.

- [ ] **Step 4: Implement file validation and safe paths**

Allow PDF, DOCX, PPTX, XLSX, TXT, Markdown, PNG, JPEG, and WebP. Compare extension, detected signature, and declared MIME; reject executables, macro-enabled Office files, path traversal, files over 50 MiB, quota overflow, and more than 30 active attachments per note. Store files under `<user_uuid>/<note_uuid>/<attachment_uuid>/<safe_name>` and persist only the relative path.

- [ ] **Step 5: Implement link validation before every request and redirect**

Resolve DNS and reject loopback, private, link-local, multicast, reserved, and cloud metadata destinations for IPv4 and IPv6. Accept only HTTP(S), cap redirects at three, response body at 2 MiB, and timeout at five seconds. Revalidate each redirect target. Reuse principles from `OpenMAIC/lib/server/ssrf-guard.ts` but implement server-side Python validation rather than importing TypeScript.

- [ ] **Step 6: Implement idempotent Celery parsing**

```python
@shared_task(name="notes.parse_attachment", soft_time_limit=80, time_limit=90)
def parse_attachment_task(attachment_id: str) -> dict:
    attachment = NoteAttachment.objects.filter(id=attachment_id, deleted_at__isnull=True).first()
    if not attachment or attachment.parse_status == "succeeded":
        return {"skipped": True}
    return parse_and_persist_attachment(attachment)
```

Dispatch parser functions by MIME and reuse document parsing primitives from `backend/domains/knowledge_base/` without creating knowledge resources, chunks, vectors, or graph entities. Truncate extracted text at the configured limit and persist a readable error code on failure.

- [ ] **Step 7: Implement authenticated upload/download/reparse/delete views**

Use `MultiPartParser` only on the upload endpoint. Return `FileResponse` after ownership and deleted-state checks. Reparse resets status and enqueues one task. Delete marks the record deleted and schedules physical cleanup only after note purge or attachment purge.

- [ ] **Step 8: Run attachment tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_attachments`

Expected: PASS for MIME mismatch, quota, ownership, parser success/failure, timeout, SSRF, redirect validation, and authenticated download.

- [ ] **Step 9: Commit attachments**

```powershell
git add backend/apps/notes backend/config/settings.py backend/.env.example
git commit -m "feat: add secure personal note attachments"
```

### Task 4: Add asynchronous export and cleanup jobs

**Files:**
- Create: `backend/apps/notes/services/export_service.py`
- Create: `backend/apps/notes/tests/test_export.py`
- Modify: `backend/apps/notes/tasks.py`
- Modify: `backend/apps/notes/views_notes.py`
- Modify: `backend/apps/notes/urls.py`
- Modify: `backend/config/settings.py`

- [ ] **Step 1: Write failing export ownership and expiry tests**

```python
def test_export_contains_only_requested_owned_notes(self):
    job = create_export_job(user=self.user, note_ids=[self.note.id, self.foreign_note.id], format="markdown_zip")
    build_note_export(str(job.id))
    with ZipFile(job.absolute_path) as archive:
        names = archive.namelist()
    self.assertIn("notes/进程调度.md", names)
    self.assertNotIn("notes/他人笔记.md", names)

def test_expired_export_cannot_download(self):
    self.job.expires_at = timezone.now() - timedelta(seconds=1)
    self.job.save(update_fields=["expires_at"])
    self.assertEqual(self.client.get(self.download_url).status_code, 410)
```

- [ ] **Step 2: Run tests and verify export behavior is absent**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_export`

Expected: FAIL because export service and routes do not exist.

- [ ] **Step 3: Implement snapshot-based ZIP export**

At job creation, store selected owned note IDs and versions. Export Markdown or JSON plus `manifest.json` and attachment files. Normalize ZIP paths, reject symlinks, and never include absolute paths, deleted notes, API metadata, AI prompts, or files outside the notes root.

- [ ] **Step 4: Add Celery build and cleanup tasks**

Create `notes.build_export`, `notes.cleanup_expired_exports`, `notes.cleanup_trashed_notes`, and `notes.cleanup_stale_jobs`. Cleanup must be idempotent and constrained to resolved paths below `A3_NOTES_STORAGE_ROOT`.

- [ ] **Step 5: Add beat schedules**

Add daily export cleanup, daily 30-day trash purge, and 15-minute stale-job recovery entries to the existing `CELERY_BEAT_SCHEDULE` dictionary. Preserve the current optimization-policy schedule.

- [ ] **Step 6: Run export and scheduler tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_export backend.apps.system.tests.test_health`

Expected: PASS and existing beat schedule test remains green.

- [ ] **Step 7: Commit export and cleanup**

```powershell
git add backend/apps/notes backend/config/settings.py
git commit -m "feat: add personal note export and cleanup jobs"
```

### Task 5: Build the typed frontend client and offline draft queue

**Files:**
- Create: `OpenMAIC/lib/a3/notes/types.ts`
- Create: `OpenMAIC/lib/a3/notes/client.ts`
- Create: `OpenMAIC/lib/a3/notes/draft-store.ts`
- Create: `OpenMAIC/lib/a3/notes/autosave-controller.ts`
- Create: `OpenMAIC/app/api/a3/notes/[...path]/route.ts`
- Create: `OpenMAIC/tests/a3-personal-notes-model.test.ts`
- Create: `OpenMAIC/tests/a3-personal-notes-autosave.test.ts`

- [ ] **Step 1: Write failing contract and autosave tests**

```typescript
it('keeps a conflicting draft instead of overwriting it', async () => {
  backend.patch.mockResolvedValue({ success: false, status: 409, code: 'note_version_conflict', serverVersion: 8 });
  const result = await controller.flush(localDraft({ baseVersion: 7 }));
  expect(result.kind).toBe('conflict');
  expect(await draftStore.get(result.noteId)).toBeTruthy();
});

it('deduplicates a retried mutation id', async () => {
  await controller.flush(localDraft({ clientMutationId: 'same-id' }));
  await controller.flush(localDraft({ clientMutationId: 'same-id' }));
  expect(backend.patch).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests and verify missing modules**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts`

Expected: FAIL with unresolved notes modules.

- [ ] **Step 3: Define stable TypeScript contracts**

Define `NoteSummary`, `NoteDetail`, `NoteRevision`, `NoteAttachment`, `NoteConflict`, `NoteAiSession`, `NoteAiMessage`, `NoteDigest`, `NoteMemory`, and `ApiResult<T>`. Match backend camelCase serialization exactly. Do not use `any`; unknown metadata remains `Record<string, unknown>`.

- [ ] **Step 4: Implement a generic authenticated Next proxy**

Proxy GET/POST/PATCH/DELETE to `/api/notes/<path>`, forwarding cookie, CSRF-relevant headers, query, multipart bodies, content type, status, `Content-Disposition`, and streaming bodies. Reject paths containing `..`, encoded separators, or a non-allowlisted first segment. Do not buffer file downloads or store jobs in memory.

- [ ] **Step 5: Implement Dexie draft tables and retry state**

```typescript
class NotesDraftDatabase extends Dexie {
  drafts!: Table<NoteDraft, string>;
  mutations!: Table<PendingNoteMutation, string>;
  constructor() {
    super('a3-personal-notes');
    this.version(1).stores({ drafts: 'noteId,updatedAt', mutations: 'clientMutationId,noteId,createdAt' });
  }
}
```

Store only the current user's opaque user ID, note ID, content, base version, mutation ID, and timestamps. Clear another account's pending drafts when the authenticated user changes, after presenting a warning instead of exposing content across accounts.

- [ ] **Step 6: Implement debounced autosave and online retry**

Debounce 1.5 seconds, serialize one request per note, persist locally before network calls, delete the mutation only after server acknowledgement, and stop retries on `409`. Network failures remain queued and resume on `online` events or page reopening.

- [ ] **Step 7: Run frontend tests and typecheck**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts`

Expected: PASS.

Run: `cd OpenMAIC; npx.cmd tsc --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit frontend data infrastructure**

```powershell
git add OpenMAIC/lib/a3/notes OpenMAIC/app/api/a3/notes OpenMAIC/tests/a3-personal-notes-model.test.ts OpenMAIC/tests/a3-personal-notes-autosave.test.ts
git commit -m "feat: add personal notes client persistence"
```

### Task 6: Build the document-first ProseMirror editor

**Files:**
- Create: `OpenMAIC/lib/a3/notes/editor-schema.ts`
- Create: `OpenMAIC/components/a3/notes/note-editor.tsx`
- Create: `OpenMAIC/components/a3/notes/note-editor-toolbar.tsx`
- Create: `OpenMAIC/components/a3/notes/note-attachments.tsx`
- Create: `OpenMAIC/components/a3/notes/note-history-dialog.tsx`
- Create: `OpenMAIC/components/a3/notes/note-conflict-dialog.tsx`
- Modify: `OpenMAIC/tests/a3-personal-notes-layout.test.tsx`

- [ ] **Step 1: Write failing editor behavior tests**

Test that the editor loads server JSON, emits valid ProseMirror JSON, renders tables/formulas/code/images, exposes `saving/saved/offline/conflict`, keeps a stable editor height, opens revision history, and never replaces content automatically after a `409`.

- [ ] **Step 2: Run the tests and verify components are missing**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-layout.test.tsx`

Expected: FAIL with unresolved editor components.

- [ ] **Step 3: Compose a note-specific schema from existing ProseMirror modules**

Reuse nodes and marks under `OpenMAIC/lib/prosemirror/`, adding only note-specific attachment references and formula rendering. Keep stored content JSON-compatible and sanitize pasted HTML through schema parsing; never store arbitrary HTML as the source of truth.

- [ ] **Step 4: Implement the editor lifecycle**

Create `EditorState` once per note/version, destroy `EditorView` on note switch or unmount, route transactions to the autosave controller, and keep local drafts during loading failures. Use icon buttons with Lucide icons and tooltips for formatting commands; use text buttons only for explicit actions such as restore and resolve conflict.

- [ ] **Step 5: Implement history and conflict resolution**

History shows timestamp, source, title, and preview. Restore requires confirmation and uses the revision restore API. Conflict dialog offers “查看差异”, “保留为副本”, and “采用服务器版本”; none is preselected and closing the dialog keeps the local draft.

- [ ] **Step 6: Implement attachment controls**

Show compact inline attachment rows with file type, size, parse state, retry, download, insert reference, and delete actions. Do not wrap each attachment in a decorative card. Upload progress must have a stable row height.

- [ ] **Step 7: Run tests, typecheck, and lint touched files**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-layout.test.tsx tests/a3-personal-notes-autosave.test.ts`

Expected: PASS.

Run: `cd OpenMAIC; npx.cmd tsc --noEmit`

Expected: PASS.

- [ ] **Step 8: Commit the editor**

```powershell
git add OpenMAIC/components/a3/notes OpenMAIC/lib/a3/notes OpenMAIC/tests/a3-personal-notes-layout.test.tsx
git commit -m "feat: add document-first personal note editor"
```

### Task 7: Assemble navigation, smart views, responsive workspace, and Phase 1 E2E

**Files:**
- Create: `OpenMAIC/app/a3/notes/page.tsx`
- Create: `OpenMAIC/components/a3/notes/notes-workspace.tsx`
- Create: `OpenMAIC/components/a3/notes/notes-navigation.tsx`
- Create: `OpenMAIC/e2e/tests/a3-personal-notes.spec.ts`
- Modify: `OpenMAIC/lib/a3/navigation.ts`
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`

- [ ] **Step 1: Write failing route, layout, and mobile E2E tests**

Cover: notes entry in student navigation; first empty state creates a note; desktop widths preserve dominant editor space; AI rail is absent in Phase 1; notebook/tag filters work; trash restore works; mobile uses list/editor routes or view state rather than compressed columns; reload restores an offline draft.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-layout.test.tsx`

Expected: FAIL because the workspace route is missing.

- [ ] **Step 3: Add the product navigation entry**

Add `/a3/notes` as a top-level `NotebookPen` navigation item with `roles: ['student']`, positioned after AI learning and before the course knowledge base. Add it to `navLabels`. It is not a child of the AI learning group because child entries do not support role filtering, and it must not appear in teacher or admin navigation.

- [ ] **Step 4: Implement the continuous workspace**

Desktop tracks: `220px minmax(560px, 1fr)` inside the A3 shell; Phase 2 later adds the collapsed AI rail. Use one continuous background, subtle dividers, square-to-8px controls, and no page-level card wrapper. The center editor must use all remaining height below the global header.

- [ ] **Step 5: Implement smart views and accessible mobile transitions**

Provide recent, today, daily summaries, unorganized, attachments, and trash. On widths below `768px`, render only one of list/editor/AI and keep explicit back buttons, focus restoration, and browser history behavior.

- [ ] **Step 6: Run unit and Playwright tests**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts tests/a3-personal-notes-layout.test.tsx`

Expected: PASS for all Phase 1 frontend tests.

Run: `cd OpenMAIC; npx.cmd playwright test e2e/tests/a3-personal-notes.spec.ts --project=chromium --workers=1`

Expected: PASS for create, edit, offline recovery, conflict, attachment, restore, and responsive layout flows.

- [ ] **Step 7: Commit the workspace**

```powershell
git add OpenMAIC/app/a3/notes OpenMAIC/components/a3/notes OpenMAIC/lib/a3/navigation.ts OpenMAIC/components/a3/layout/a3-shell.tsx OpenMAIC/e2e/tests/a3-personal-notes.spec.ts
git commit -m "feat: add personal notes workspace"
```

### Task 8: Add Phase 1 production persistence and release gate

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `backend/.env.example`
- Test: `backend/apps/notes/tests/test_attachments.py`

- [ ] **Step 1: Write a deployment contract test**

Add a test that parses both compose YAML files and asserts `a3-notes-data` is mounted read-write at `/app/storage/a3-notes` for `backend` and `celery`, is not mounted by `frontend` or `caddy`, and `A3_NOTES_STORAGE_ROOT` matches the mount.

- [ ] **Step 2: Run the deployment test and verify failure**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_attachments.NoteStorageDeploymentTests`

Expected: FAIL because the volume is absent.

- [ ] **Step 3: Add the named volume and environment**

Add `a3-notes-data:/app/storage/a3-notes` to backend and celery in development and production compose files. Declare the named volume at the bottom of each file. Do not mount it into frontend, Caddy, resource-worker, or video-worker.

- [ ] **Step 4: Run the complete Phase 1 gate**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_models backend.apps.notes.tests.test_note_api backend.apps.notes.tests.test_attachments backend.apps.notes.tests.test_export
backend\.venv\Scripts\python.exe backend\manage.py check
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts tests/a3-personal-notes-layout.test.tsx
```

Expected: all commands PASS; lint may show only the historical warnings listed in `AGENTS.md`.

- [ ] **Step 5: Commit Phase 1 deployment support**

```powershell
git add docker-compose.yml docker-compose.prod.yml backend/.env.example backend/apps/notes/tests/test_attachments.py
git commit -m "deploy: persist personal note storage"
```

**Phase 1 release checkpoint:** Create, organize, edit, attach, recover, export, and delete notes must work with all model API keys removed.

---

## Phase 2: Scoped AI Assistant and Daily Summaries

### Task 9: Implement persisted AI sessions and bounded context selection

**Files:**
- Create: `backend/apps/notes/services/context_service.py`
- Create: `backend/apps/notes/services/assistant_service.py`
- Create: `backend/apps/notes/views_assistant.py`
- Create: `backend/apps/notes/tests/test_assistant.py`
- Modify: `backend/apps/notes/tasks.py`
- Modify: `backend/apps/notes/urls.py`

- [ ] **Step 1: Write failing scope and citation tests**

```python
def test_current_note_scope_never_reads_unselected_note(self):
    context = build_note_context(user=self.user, scope={"type": "note", "noteIds": [str(self.note.id)]}, query="调度")
    self.assertIn("时间片", context.text)
    self.assertNotIn("另一个用户的秘密", context.text)

def test_course_retriever_is_called_only_when_explicitly_enabled(self):
    with patch("backend.apps.notes.services.context_service.retrieve_course_evidence") as retrieve:
        build_note_context(user=self.user, scope=self.scope, query="调度", include_course_evidence=False)
    retrieve.assert_not_called()
```

- [ ] **Step 2: Run tests and verify missing context service**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_assistant`

Expected: FAIL with missing assistant modules.

- [ ] **Step 3: Implement immutable scope snapshots**

Validate `note`, `notebook`, and `selection` scope types; resolve only owned, non-deleted notes; store IDs and versions on `NoteAiSession.scope_snapshot`. Current-note mode uses bounded current content. Multi-note mode ranks bounded paragraphs using title/tag match, term overlap, and recency, with a hard token/character budget and source coordinates. It must not write any FAISS files or knowledge graph records.

- [ ] **Step 4: Implement optional existing course evidence adapter**

When `includeCourseEvidence` is true, call the existing RetrieverAgent service and normalize its citations as `sourceKind="course_knowledge"`. Note citations use `sourceKind="personal_note"`. Keep the existing RetrieverAgent signature unchanged.

- [ ] **Step 5: Persist queued AI messages and execute via Celery**

POST chat creates one user message and one assistant message with `status=queued` and unique `client_request_id`, then enqueues `notes.generate_assistant_message`. The task transitions `queued -> streaming -> succeeded|failed`, persists partial content at bounded intervals, runs safety before generation and Verifier after generation, and stores `traceId`, citations, claims, and degraded state.

- [ ] **Step 6: Add session, chat, and message-status endpoints**

Implement create/list session, list session messages, submit chat, and `GET /api/notes/assistant/messages/<id>/`. Status responses include persisted content and never expose internal prompts.

- [ ] **Step 7: Run assistant tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_assistant`

Expected: PASS for ownership, scope, idempotency, safety refusal, citations, verifier degradation, optional course evidence, failure persistence, and no new vector index.

- [ ] **Step 8: Commit scoped AI services**

```powershell
git add backend/apps/notes
git commit -m "feat: add scoped personal note assistant"
```

### Task 10: Add resilient browser streaming and the collapsible AI drawer

**Files:**
- Create: `OpenMAIC/app/api/a3/notes/assistant/stream/[messageId]/route.ts`
- Create: `OpenMAIC/components/a3/notes/note-ai-drawer.tsx`
- Create: `OpenMAIC/tests/a3-personal-notes-ai.test.tsx`
- Modify: `OpenMAIC/components/a3/notes/notes-workspace.tsx`
- Modify: `OpenMAIC/lib/a3/notes/client.ts`
- Modify: `OpenMAIC/lib/a3/notes/types.ts`

- [ ] **Step 1: Write failing drawer and reconnect tests**

Test that the drawer is collapsed on first load, opening it preserves editor scroll/selection, scope defaults to current note, selected-note scope is explicit, citations jump to note sections, and a dropped stream resumes by persisted message ID without submitting another model request.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-ai.test.tsx`

Expected: FAIL because the drawer and stream route do not exist.

- [ ] **Step 3: Implement Next SSE polling without holding a Django worker**

The Next route emits `text/event-stream`, polls the authenticated Django message-status endpoint every 700 ms, sends only changed status/content, emits a final event for `succeeded|failed`, sends keepalive comments, and closes after a fixed maximum duration. Browser reconnect uses `messageId`; it never reruns POST chat.

- [ ] **Step 4: Implement the low-footprint AI drawer**

Collapsed width is 48px with an icon and tooltip. Expanded width is clamped between 320px and 420px on desktop and becomes a full-screen view on mobile. Keep the editor as the dominant surface. Provide scope selector, conversation, citations, verified/degraded state, retry for failed assistant messages, and explicit “生成写回建议”.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-ai.test.tsx tests/a3-personal-notes-layout.test.tsx`

Expected: PASS.

Run: `cd OpenMAIC; npx.cmd tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit the AI drawer**

```powershell
git add OpenMAIC/app/api/a3/notes/assistant OpenMAIC/components/a3/notes OpenMAIC/lib/a3/notes OpenMAIC/tests/a3-personal-notes-ai.test.tsx
git commit -m "feat: add resilient personal note AI drawer"
```

### Task 11: Implement preview-confirm AI writeback

**Files:**
- Create: `backend/apps/notes/services/writeback_service.py`
- Create: `backend/apps/notes/tests/test_writeback.py`
- Create: `OpenMAIC/components/a3/notes/note-writeback-preview.tsx`
- Modify: `backend/apps/notes/views_assistant.py`
- Modify: `backend/apps/notes/urls.py`
- Modify: `OpenMAIC/components/a3/notes/note-ai-drawer.tsx`

- [ ] **Step 1: Write failing no-silent-write and stale-preview tests**

```python
def test_generating_preview_does_not_change_note(self):
    original = self.note.content_json
    preview = create_writeback_preview(user=self.user, message=self.message, note=self.note)
    self.note.refresh_from_db()
    self.assertEqual(self.note.content_json, original)
    self.assertEqual(preview.status, "pending")

def test_confirm_rejects_changed_target_version(self):
    self.note.version += 1
    self.note.save(update_fields=["version"])
    with self.assertRaises(NoteVersionConflict):
        confirm_writeback(user=self.user, preview_id=self.preview.id)
```

- [ ] **Step 2: Run tests and verify missing service**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_writeback`

Expected: FAIL with missing writeback service.

- [ ] **Step 3: Implement persisted, expiring previews**

Generate a proposed ProseMirror document and structural diff against `target_version`; save it with a 30-minute expiry. Confirm inside a transaction with `select_for_update`, ownership, pending status, expiry, and exact version checks. On success mark applied, create `NoteRevision(source="ai_writeback")`, increment note version, and write `NoteAuditEvent`.

- [ ] **Step 4: Implement the visual diff confirmation UI**

Show changed blocks with additions and removals, target note, target version, expiry, “放弃” and “确认写入”. Do not pre-check confirmation. A `409` returns to diff state with a clear “正文已更新，请重新生成建议” action.

- [ ] **Step 5: Run backend and frontend tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_writeback`

Expected: PASS.

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-ai.test.tsx`

Expected: PASS including explicit confirmation and stale-preview behavior.

- [ ] **Step 6: Commit writeback**

```powershell
git add backend/apps/notes OpenMAIC/components/a3/notes OpenMAIC/tests/a3-personal-notes-ai.test.tsx
git commit -m "feat: add confirmed AI note writeback"
```

### Task 12: Implement versioned automatic and manual daily summaries

**Files:**
- Create: `backend/apps/notes/services/digest_service.py`
- Create: `backend/apps/notes/views_digests.py`
- Create: `backend/apps/notes/tests/test_digests.py`
- Create: `OpenMAIC/components/a3/notes/note-digest-view.tsx`
- Modify: `backend/apps/notes/tasks.py`
- Modify: `backend/apps/notes/urls.py`
- Modify: `backend/config/settings.py`
- Modify: `OpenMAIC/components/a3/notes/notes-workspace.tsx`

- [ ] **Step 1: Write failing source-isolation and version tests**

```python
def test_digest_uses_only_edited_notes_and_their_attachments(self):
    snapshot = build_digest_snapshot(self.user, self.target_date)
    self.assertEqual(snapshot.note_ids, [str(self.edited_note.id)])
    self.assertNotIn(str(self.classroom_session.id), json.dumps(snapshot.payload))
    self.assertNotIn(str(self.memory.id), json.dumps(snapshot.payload))

def test_manual_refresh_creates_revision_without_overwriting(self):
    first = create_digest_job(self.user, self.target_date, generated_by="manual")
    second = create_digest_job(self.user, self.target_date, generated_by="manual")
    self.assertEqual((first.revision, second.revision), (1, 2))
```

- [ ] **Step 2: Run tests and verify missing digest service**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_digests`

Expected: FAIL with missing digest service.

- [ ] **Step 3: Implement immutable digest snapshots**

Select notes edited on the target Beijing date and their directly attached, successfully parsed attachments. Store IDs, versions, and attachment parse versions. Explicitly exclude AI Classroom, tasks, profile, course knowledge, favorites, and `NoteMemory`.

- [ ] **Step 4: Implement idempotent Celery generation and stale recovery**

Automatic jobs use key `auto:<user_id>:<date>` and produce at most one successful automatic revision. Manual refresh always creates the next revision. Failure stores a readable error and never creates blank successful content. Stale queued/processing jobs are failed or requeued by cleanup logic.

- [ ] **Step 5: Schedule daily creation at 02:10 Asia/Shanghai**

Add a beat task that finds users with edits on the previous local date and enqueues one digest job per user. Preserve every existing beat entry.

- [ ] **Step 6: Implement daily summary smart view**

Display date, revision selector, source-note links, generated/manual badge, failed retry action, and Markdown content. Do not present a summary as a normal editable note and do not add controls that create tasks or modify profiles.

- [ ] **Step 7: Run digest and UI tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_digests backend.apps.system.tests.test_health`

Expected: PASS.

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-ai.test.tsx tests/a3-personal-notes-layout.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit daily summaries**

```powershell
git add backend/apps/notes backend/config/settings.py OpenMAIC/components/a3/notes
git commit -m "feat: add versioned personal note digests"
```

### Task 13: Run the Phase 2 release gate

**Files:**
- Modify: `OpenMAIC/e2e/tests/a3-personal-notes.spec.ts`
- Modify: `backend/apps/notes/tests/test_isolation.py`

- [ ] **Step 1: Add a static isolation regression test**

Parse tracked Python and TypeScript files under learning/classroom/coaching paths and fail if they import `backend.apps.notes`, reference `NoteMemory`, or call notes-memory endpoints. Allow notes services to import existing verifier/retriever adapters in the opposite direction.

- [ ] **Step 2: Add E2E flows for scoped AI, reconnect, writeback, and digest**

Use real backend test data and mock only the external model provider boundary. Assert the database-backed API state after each action; do not satisfy tests with frontend fixture arrays.

- [ ] **Step 3: Run the complete Phase 2 gate**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts tests/a3-personal-notes-layout.test.tsx tests/a3-personal-notes-ai.test.tsx
npx.cmd playwright test e2e/tests/a3-personal-notes.spec.ts --project=chromium --workers=1
```

Expected: all commands PASS; model-unavailable tests prove basic notes remain usable.

- [ ] **Step 4: Commit Phase 2 regression coverage**

```powershell
git add backend/apps/notes/tests/test_isolation.py OpenMAIC/e2e/tests/a3-personal-notes.spec.ts
git commit -m "test: verify personal note AI isolation"
```

**Phase 2 release checkpoint:** AI answers must cite selected note versions, reconnect by message ID, require confirmed writeback, and generate versioned daily summaries without reading memories or classroom history.

---

## Phase 3: Private Cross-Session Memory

### Task 14: Implement memory candidates and confirmed-memory selection

**Files:**
- Create: `backend/apps/notes/services/memory_service.py`
- Create: `backend/apps/notes/views_memories.py`
- Create: `backend/apps/notes/tests/test_memory.py`
- Modify: `backend/apps/notes/tasks.py`
- Modify: `backend/apps/notes/urls.py`
- Modify: `backend/apps/notes/services/context_service.py`

- [ ] **Step 1: Write failing state-machine and selection tests**

```python
def test_candidate_never_enters_context(self):
    candidate = NoteMemory.objects.create(user=self.user, memory_type="core", content="偏好图示", status="candidate")
    selected = select_memories(user=self.user, query="怎么讲解", scope_note_ids=[self.note.id])
    self.assertNotIn(candidate.id, [item.id for item in selected])

def test_superseded_and_deleted_memories_are_excluded(self):
    selected = select_memories(user=self.user, query="学习目标", scope_note_ids=[])
    self.assertNotIn(self.old_memory.id, [item.id for item in selected])
    self.assertNotIn(self.deleted_memory.id, [item.id for item in selected])

def test_memory_does_not_cross_users(self):
    selected = select_memories(user=self.other, query=self.private_phrase, scope_note_ids=[])
    self.assertEqual(selected, [])
```

- [ ] **Step 2: Run tests and verify missing memory service**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_memory`

Expected: FAIL with missing memory service.

- [ ] **Step 3: Implement candidate extraction with a strict schema**

After successful note-assistant sessions or digest completion, enqueue candidate extraction. The model may return only `memoryType`, `content`, `importance`, `confidence`, `sourceMessageIds`, `sourceNoteRefs`, `reason`, and optional validity dates. Validate field lengths, ownership of every source, and deduplicate active same-user candidates. Provider failure creates no candidate and does not affect the source session.

- [ ] **Step 4: Implement an explicit state machine**

Allowed transitions:

```text
candidate -> confirmed | deleted
confirmed -> paused | superseded | deleted
paused -> confirmed | superseded | deleted
superseded -> deleted
deleted -> no transition
```

Every transition uses a transaction, current-user filter, expected current status, and `NoteAuditEvent`. Supersede creates or confirms the replacement and links the old row with `superseded_by` in one transaction.

- [ ] **Step 5: Implement bounded selection without a second index**

Filter to the current user and usable confirmed memories, then restrict episodic candidates by source note overlap and the most recent 180 days. Tokenize Chinese text with `jieba`, compute term relevance as Jaccard overlap, recency as `exp(-age_days / 30)`, and importance as `clamp(importance, 0, 5) / 5`. The product score is `0.45 * relevance + 0.30 * recency + 0.25 * importance`; this is an explicit A3 ranking rule inspired by, but not claimed as an exact reproduction of, Generative Agents. Include at most eight effective core memories within 1,600 characters, then at most six episodic memories while keeping the total memory context within 4,000 characters. Do not create embeddings, FAISS files, knowledge graph rows, or a second RetrieverAgent.

- [ ] **Step 6: Add memory CRUD/state endpoints and context integration**

Expose list, confirm, pause, resume, supersede, and delete endpoints. Add selected memory IDs to assistant message metadata for auditing. The assistant must abstain rather than infer a missing preference when no usable memory exists.

- [ ] **Step 7: Run memory and isolation tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_memory backend.apps.notes.tests.test_isolation`

Expected: PASS for all transitions, expiration, deletion, replacement, user isolation, token budget, and classroom isolation.

- [ ] **Step 8: Commit memory services**

```powershell
git add backend/apps/notes
git commit -m "feat: add confirmed personal note memory"
```

### Task 15: Build the memory review and control interface

**Files:**
- Create: `OpenMAIC/components/a3/notes/note-memory-manager.tsx`
- Create: `OpenMAIC/tests/a3-personal-notes-memory.test.tsx`
- Modify: `OpenMAIC/components/a3/notes/note-ai-drawer.tsx`
- Modify: `OpenMAIC/lib/a3/notes/client.ts`
- Modify: `OpenMAIC/lib/a3/notes/types.ts`

- [ ] **Step 1: Write failing consent and deletion tests**

Test that candidates are visually separate from active memories, confirmation is explicit, source links are visible, editing occurs before confirmation, pause removes the active badge, supersede shows the replacement relationship, and delete removes the item from subsequent assistant context metadata.

- [ ] **Step 2: Run tests and verify the manager is missing**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-memory.test.tsx`

Expected: FAIL with unresolved memory manager.

- [ ] **Step 3: Implement a document-like memory manager**

Use a compact list with filters for candidates, active, paused, and history. Each row shows content, type, source, effective period, and state actions. Avoid dashboard cards and aggregate charts. Confirmation opens an editable preview; deletion requires confirmation and explains that future note-assistant conversations will stop using it.

- [ ] **Step 4: Surface memory use in assistant answers**

When an answer used memories, show a compact “使用了 N 条已确认记忆” disclosure that expands to source and state. Do not show candidate memories as used. Do not expose memory controls anywhere outside `/a3/notes`.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-personal-notes-memory.test.tsx tests/a3-personal-notes-ai.test.tsx`

Expected: PASS.

Run: `cd OpenMAIC; npx.cmd tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit memory UI**

```powershell
git add OpenMAIC/components/a3/notes OpenMAIC/lib/a3/notes OpenMAIC/tests/a3-personal-notes-memory.test.tsx
git commit -m "feat: add personal memory controls"
```

### Task 16: Add LongMemEval-style reproducible evaluation

**Files:**
- Create: `backend/apps/notes/management/__init__.py`
- Create: `backend/apps/notes/management/commands/__init__.py`
- Create: `backend/apps/notes/management/commands/evaluate_notes_memory.py`
- Create: `backend/apps/notes/evals/long_memory_cases.jsonl`
- Modify: `backend/apps/notes/tests/test_memory.py`

- [ ] **Step 1: Add command-contract tests**

Test deterministic `--offline` evaluation, JSON output schema, non-zero exit under `--strict` when a required metric fails, and no raw private note content in output artifacts.

- [ ] **Step 2: Create at least 50 fixed evaluation cases**

The JSONL set must cover cross-session recall, temporal updates, preference corrections, abstention, unconfirmed candidates, pause, expiry, supersede, deletion, and cross-user isolation. Every case includes expected selected memory IDs or expected abstention; use synthetic Chinese learning scenarios only.

- [ ] **Step 3: Implement evaluator metrics**

Output selection precision, selection recall, abstention accuracy, update consistency, deletion consistency, and cross-user leakage count. `--offline` exercises deterministic selection without calling a model. Strict thresholds are precision at least 0.90, recall at least 0.85, abstention accuracy at least 0.90, update consistency 1.0, deletion consistency 1.0, and cross-user leakage exactly 0. Optional `--with-model` evaluates final answer use but never replaces the deterministic gate.

- [ ] **Step 4: Run the evaluator and tests**

Run: `backend\.venv\Scripts\python.exe backend\manage.py evaluate_notes_memory --offline --strict --output backend\tmp\notes_memory_metrics.json`

Expected: exit 0, `crossUserLeakage=0`, `deletionConsistency=1.0`, and every configured strict threshold passes.

Run: `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes.tests.test_memory`

Expected: PASS.

- [ ] **Step 5: Commit evaluation assets**

```powershell
git add backend/apps/notes/management backend/apps/notes/evals backend/apps/notes/tests/test_memory.py
git commit -m "test: add personal memory evaluation"
```

### Task 17: Run final regression, migration, and deployment verification

**Files:**
- Modify: `OpenMAIC/e2e/tests/a3-personal-notes.spec.ts`
- Modify: `docs/A3_OpenMAIC页面分工与接入边界.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Extend the end-to-end flow through all three phases**

Cover note creation, attachment parsing, offline recovery, conflict resolution, scoped AI, citation jump, rejected and confirmed writeback, digest retry/versioning, memory candidate confirmation, cross-session reuse, correction through supersede, pause, delete, and verified absence after deletion.

- [ ] **Step 2: Update ownership documentation without changing AI Classroom ownership**

Add `/a3/notes` as the owner of personal notes, note AI, daily digests, and note-only memory. State that AI Classroom remains the owner of classroom conversation and course RAG and cannot read `NoteMemory`.

- [ ] **Step 3: Update AGENTS.md verification and button-level flow**

Add the notes backend tests, frontend unit tests, Playwright test, memory evaluator, and this path:

```text
个人笔记 -> 自动保存 -> 附件解析 -> 限定范围 AI -> 引用 -> 差异确认写回
个人笔记 -> 每日总结 -> 记忆候选 -> 用户确认 -> 跨会话使用 -> 暂停/删除
```

- [ ] **Step 4: Run the full final gate**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py evaluate_notes_memory --offline --strict --output backend\tmp\notes_memory_metrics.json
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-personal-notes-model.test.ts tests/a3-personal-notes-autosave.test.ts tests/a3-personal-notes-layout.test.tsx tests/a3-personal-notes-ai.test.tsx tests/a3-personal-notes-memory.test.tsx
npx.cmd playwright test e2e/tests/a3-personal-notes.spec.ts --project=chromium --workers=1
```

Expected: all commands PASS; only pre-existing lint warnings documented in `AGENTS.md` may remain.

- [ ] **Step 5: Validate production compose before deployment**

Run:

```powershell
docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml config --quiet
```

Expected: exit 0 with no missing notes environment variables.

- [ ] **Step 6: Commit final integration documentation and tests**

```powershell
git add OpenMAIC/e2e/tests/a3-personal-notes.spec.ts docs/A3_OpenMAIC页面分工与接入边界.md AGENTS.md
git commit -m "docs: complete personal notes integration"
```

- [ ] **Step 7: Deployment sequence after GitHub Actions succeeds**

On the server, back up `.env.production`, set the fixed backend/frontend image digests, pull both images, run `python manage.py migrate --noinput` in the new backend image, and recreate `backend`, `celery`, `celery-beat`, `frontend`, and `caddy` with `--no-build`. Verify `/api/notes/notes/` authentication, the `a3-notes-data` mount, Celery beat schedule, and attachment read/write before opening traffic to the feature.

**Phase 3 release checkpoint:** Only confirmed, effective, current-user memories can influence `/a3/notes`; pause, supersede, expiry, and deletion must be observable in both database state and final assistant behavior, with zero cross-user leakage.

---

## Final Acceptance Checklist

- [ ] Phase 1 works with all model provider keys removed.
- [ ] No note or attachment enters the course knowledge base automatically.
- [ ] AI reads only the selected note scope and optional explicitly enabled course evidence.
- [ ] AI writeback always requires a persisted preview and explicit confirmation.
- [ ] Daily summaries read only edited notes and their attachments and preserve every revision.
- [ ] Unconfirmed, paused, superseded, expired, and deleted memories never enter context.
- [ ] AI Classroom and coaching behavior remain unchanged and cannot read `NoteMemory`.
- [ ] Every attachment and export download is owner-authenticated.
- [ ] Automatic save is idempotent, offline-recoverable, and conflict-safe.
- [ ] Desktop editor remains dominant; mobile uses separate list/editor/AI views.
- [ ] MySQL migrations, Celery tasks, Docker volume, frontend build, backend checks, unit tests, E2E tests, and memory evaluation all pass.
