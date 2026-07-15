# A3 DOCX Online Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert verified platform DOCX resources to cached PDFs and let authenticated students preview them inside A3 while retaining original DOCX downloads and Markdown fallback content.

**Architecture:** A focused Django conversion service validates the managed DOCX, converts it with headless LibreOffice into a persistent cache under `KNOWLEDGE_UPLOAD_ROOT`, and atomically publishes the PDF. A protected preview endpoint streams the cached PDF; the existing content endpoint remains the attachment download. The resource detail page fetches the PDF with credentials, embeds a blob URL on desktop, offers a mobile open action, and preserves parsed Markdown for fallback.

**Tech Stack:** Django, Python `subprocess`/`tempfile`/`pathlib`, LibreOffice Writer, Next.js/React, TypeScript, Vitest, Django TestCase.

---

### Task 1: Cached DOCX-to-PDF conversion service

**Files:**
- Create: `backend/apps/knowledge_base/docx_preview.py`
- Create: `backend/apps/knowledge_base/tests/test_docx_preview.py`
- Modify: `backend/config/settings.py`

- [ ] **Step 1: Write failing conversion tests**

Test a managed `.docx` conversion, stable cache reuse, unsupported extension, missing source, oversized source, missing `soffice`, timeout, and invalid/non-PDF output. Patch `subprocess.run` so tests create `source.pdf` in the requested output directory without requiring local LibreOffice.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_docx_preview
```

Expected: import failure because `backend.apps.knowledge_base.docx_preview` does not exist.

- [ ] **Step 3: Implement the minimal conversion service**

Expose:

```python
class DocxPreviewUnsupported(Exception): ...
class DocxPreviewSourceUnavailable(Exception): ...
class DocxPreviewUnavailable(Exception): ...

def get_or_create_docx_preview(resource: CuratedLearningResource) -> Path: ...
```

The function must validate the database-linked source, enforce `KNOWLEDGE_UPLOAD_MAX_BYTES`, derive `<safe-resource-code>-<content-hash>.pdf`, lock per target path, run `soffice --headless --convert-to pdf`, require a non-empty `%PDF` result, and publish with `os.replace`. Add `A3_SOFFICE_PATH` and `A3_DOCX_PREVIEW_TIMEOUT_SECONDS` settings.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all conversion tests pass.

### Task 2: Protected preview and download API

**Files:**
- Modify: `backend/apps/knowledge_base/urls.py`
- Modify: `backend/apps/knowledge_base/views.py`
- Modify: `backend/apps/knowledge_base/curated_recommendations.py`
- Modify: `backend/apps/knowledge_base/tests/test_curated_resources.py`

- [ ] **Step 1: Write failing API and serialization tests**

Cover authenticated PDF success, unauthenticated `401`, inactive/unverified `404`, external resource `400`, source missing `404`, conversion failure `503`, private/nosniff headers, attachment semantics for `/content/`, and separate `action.preview`/`action.download` payloads without `stored_path`.

- [ ] **Step 2: Run the focused API tests and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_curated_resources.CuratedResourcePreviewApiTests
```

Expected: failures because the preview route and split actions are absent.

- [ ] **Step 3: Implement route, view, headers, and serializer actions**

Add:

```python
path("library/<str:resource_code>/preview/", views.curated_library_preview, ...)
```

Map conversion exceptions to normal Chinese JSON errors, stream successful PDFs inline, set `Cache-Control: private, max-age=86400` and `X-Content-Type-Options: nosniff`, and make content downloads attachments by default. Internal document payloads receive preview/download actions; external videos retain one external action and no preview field.

- [ ] **Step 4: Run focused API tests and verify GREEN**

Run the command from Step 2, then all curated resource tests.

### Task 3: Production LibreOffice Writer dependency

**Files:**
- Modify: `backend/Dockerfile`
- Modify: `backend/apps/knowledge_base/tests/test_deployment_runtime.py`

- [ ] **Step 1: Add a failing Dockerfile contract test**

Require both `libreoffice-impress` and `libreoffice-writer` in the backend image definition.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_deployment_runtime
```

Expected: Writer dependency assertion fails.

- [ ] **Step 3: Add `libreoffice-writer` to the image and verify GREEN**

Run the command from Step 2. Expected: all deployment runtime tests pass.

### Task 4: Product-grade preview UI

**Files:**
- Modify: `OpenMAIC/lib/a3/library-types.ts`
- Modify: `OpenMAIC/components/a3/features/system-resource-detail-view.tsx`
- Modify: `OpenMAIC/tests/a3-system-library.test.ts`

- [ ] **Step 1: Write failing frontend contracts**

Assert separate “在线预览” and “下载原文档” actions, credentialed PDF fetch through `resolveA3Endpoint`, stable loading/error/retry states, desktop iframe, mobile PDF action, Markdown fallback, action-specific `resource_opened` metadata, and no Word controls in the external-video branch.

- [ ] **Step 2: Run Vitest and verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-system-library.test.ts
```

Expected: preview UI assertions fail.

- [ ] **Step 3: Implement typed preview/download actions and UI states**

Fetch the protected preview with `credentials: 'include'`, reject non-PDF/empty responses, create and revoke a blob URL, embed it in a desktop iframe, expose a mobile “打开 PDF 预览” command, retain parsed Markdown below the preview, and keep original DOCX download independently available.

- [ ] **Step 4: Run frontend tests and type/lint verification**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-system-library.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: tests and TypeScript pass; lint has no new errors and only the documented historical warnings.

### Task 5: Integration verification

**Files:**
- No production files added beyond Tasks 1-4.

- [ ] **Step 1: Run Django checks and complete focused suites**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_docx_preview backend.apps.knowledge_base.tests.test_curated_resources backend.apps.knowledge_base.tests.test_deployment_runtime
```

- [ ] **Step 2: Run browser verification at desktop and mobile widths**

Log in as the demo student, open `/a3/library/OS-LAB-003`, verify PDF loading/preview and DOCX download, then repeat at a mobile viewport and confirm the full-width PDF action and Markdown fallback do not overlap.

- [ ] **Step 3: Review security and Git scope**

Confirm API JSON contains no `stored_path`, conversion errors reveal no command/path, `git diff --check` passes, and runtime files under `control/` plus generated `outputs/` files remain unstaged.
