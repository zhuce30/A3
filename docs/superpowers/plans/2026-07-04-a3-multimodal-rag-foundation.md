# A3 Multimodal RAG Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable foundation for A3 multimodal knowledge-base ingestion so PPTX and image uploads are no longer treated as successful RAG resources without parse/index evidence.

**Architecture:** Keep A3's Django ownership, permissions, resource records, jobs, and learning APIs. Add page/asset/block/index-entry models and a lightweight native parser adapter that records multimodal quality evidence now, while leaving Docling/MinerU/OCR/visual-index adapters replaceable in later tasks. Existing FAISS/BM25 text retrieval remains the first searchable path; visual assets and OCR status become explicit metadata instead of fake success.

**Tech Stack:** Django models/migrations/tests, existing Celery upload job, `python-pptx`, Pillow-optional image metadata, Next.js knowledge-base page types, existing A3 API client, PowerShell verification.

---

## File Structure

- Modify `backend/apps/knowledge_base/models.py`: add status `indexed_with_warnings` and multimodal metadata tables.
- Add `backend/apps/knowledge_base/migrations/0003_multimodal_blocks.py`: schema for parse runs, pages, assets, blocks, index entries, and resource status choice.
- Add `backend/domains/knowledge_base/multimodal_parser.py`: native parser adapter for PDF/PPTX/image/XLSX metadata and text blocks.
- Modify `backend/apps/knowledge_base/services.py`: serialize multimodal quality fields and allow image uploads.
- Modify `backend/apps/knowledge_base/tasks.py`: run parser before/around existing text index and prevent empty PPTX/image resources from normal indexed success.
- Modify `backend/apps/knowledge_base/views.py` and `backend/apps/knowledge_base/urls.py`: add parse detail endpoint.
- Modify `backend/apps/knowledge_base/tests/test_resources.py`: regression coverage for image upload, PPTX text evidence, image-only PPTX warning behavior, and parse detail serialization.
- Add `backend/apps/knowledge_base/management/commands/evaluate_multimodal_rag.py`: smoke metric command.
- Modify `OpenMAIC/components/a3/features/knowledge-base-view.tsx`: accept image uploads and display multimodal quality summary.

---

### Task 1: Backend Model And Serialization Contract

**Files:**
- Modify: `backend/apps/knowledge_base/models.py`
- Modify: `backend/apps/knowledge_base/services.py`
- Add: `backend/apps/knowledge_base/migrations/0003_multimodal_blocks.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing tests for multimodal fields**

Add tests that create `KnowledgePage`, `KnowledgeAsset`, `KnowledgeBlock`, and `KnowledgeIndexEntry`, then assert `serialize_resource()` returns:

```python
payload["multimodal"]["parseStatus"] == "completed_with_warnings"
payload["multimodal"]["pages"] == 1
payload["multimodal"]["visualIndexed"] == 1
payload["multimodal"]["warnings"] == ["OCR not configured"]
```

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_resources.KnowledgeResourceTests.test_resource_serialization_includes_multimodal_quality
```

Expected: FAIL because the models and serialized fields do not exist.

- [ ] **Step 2: Implement the models and migration**

Add:

```python
class KnowledgeParseRun(models.Model): ...
class KnowledgeAsset(models.Model): ...
class KnowledgePage(models.Model): ...
class KnowledgeBlock(models.Model): ...
class KnowledgeIndexEntry(models.Model): ...
```

Use related names `parse_runs`, `assets`, `pages`, `blocks`, and `index_entries`. Store warnings and metadata in JSON fields. Add `INDEXED_WITH_WARNINGS = "indexed_with_warnings"` to `ResourceStatus`.

- [ ] **Step 3: Implement serializer fields**

Update `serialize_resource()` to include:

```python
"status": resource.status,
"multimodal": build_resource_multimodal_summary(resource),
```

The summary must count pages, blocks by modality, text index entries, visual index entries, quality score, parse status, and warnings.

- [ ] **Step 4: Run focused backend test**

Run the same test. Expected: PASS.

---

### Task 2: Native Multimodal Parser Adapter

**Files:**
- Add: `backend/domains/knowledge_base/multimodal_parser.py`
- Modify: `backend/apps/knowledge_base/tasks.py`
- Modify: `backend/apps/knowledge_base/services.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing tests for image and PPTX parsing**

Add tests for:

```python
test_image_upload_creates_page_asset_block_and_warning_without_ocr
test_pptx_text_slide_creates_slide_page_and_text_block
test_pptx_without_extractable_text_is_indexed_with_warnings_not_plain_indexed
```

Run each focused test and verify it fails because parser behavior is missing.

- [ ] **Step 2: Implement parser result dataclasses**

Create `MultimodalParseResult`, `ParsedPage`, `ParsedAsset`, and `ParsedBlock` dataclasses in `multimodal_parser.py`.

- [ ] **Step 3: Implement native parser**

Support:

```python
parse_resource(source_path: Path, resource_id: str) -> MultimodalParseResult
```

Behavior:

- `.pptx`: use `python-pptx` to count slides and extract shape text into slide text blocks.
- `.png/.jpg/.jpeg/.webp`: create one page, one original image asset, one image block, warning that OCR/visual indexing is not configured yet.
- `.pdf` and `.xlsx`: create parse summary with warnings that native text indexing remains existing path.

- [ ] **Step 4: Persist parser output during upload indexing**

In upload indexing, before existing `append_source_file()`, create a `KnowledgeParseRun`, pages, assets, and blocks. If `append_source_file()` raises because there is no extractable text but parser produced image/page evidence, set resource status to `indexed_with_warnings`, not `failed`.

- [ ] **Step 5: Run focused parser tests**

Expected: PASS.

---

### Task 3: API Parse Detail And Upload Format Support

**Files:**
- Modify: `backend/apps/knowledge_base/services.py`
- Modify: `backend/apps/knowledge_base/views.py`
- Modify: `backend/apps/knowledge_base/urls.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing API tests**

Add tests that:

- `.png` is accepted by `save_upload()`.
- `GET /api/kb/resources/<id>/parse/` returns pages, assets, blocks, quality score, and warnings for the owner.

Run focused tests. Expected: FAIL.

- [ ] **Step 2: Extend supported uploads**

Allow `.png`, `.jpg`, `.jpeg`, and `.webp` in upload validation without changing legacy `.ppt` rejection.

- [ ] **Step 3: Add parse detail serializer and view**

Return:

```json
{
  "success": true,
  "resource": {"id": "...", "name": "..."},
  "multimodal": {...},
  "pages": [...],
  "blocks": [...]
}
```

- [ ] **Step 4: Run focused API tests**

Expected: PASS.

---

### Task 4: Multimodal RAG Smoke Evaluation Command

**Files:**
- Add: `backend/apps/knowledge_base/management/commands/evaluate_multimodal_rag.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing command test**

Use `call_command("evaluate_multimodal_rag", "--top-k", "3", stdout=buffer)` and assert the output includes `parseSuccessRate`, `visualCoverage`, and `hybridReadyRate`.

- [ ] **Step 2: Implement command**

Compute metrics from current DB records:

- resources count
- parsed resources count
- resources with visual/image/page blocks
- resources with searchable text blocks
- degraded/warning resources count

Support:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_multimodal_rag --top-k 3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_multimodal_rag --top-k 3 --json --output backend\tmp\multimodal_rag_metrics.json
```

- [ ] **Step 3: Run command test**

Expected: PASS.

---

### Task 5: Frontend Knowledge Base Quality Display

**Files:**
- Modify: `OpenMAIC/components/a3/features/knowledge-base-view.tsx`
- Test if existing test coverage is available; otherwise verify with TypeScript.

- [ ] **Step 1: Update types**

Add `indexed_with_warnings` status and `multimodal` summary type.

- [ ] **Step 2: Allow image files**

Change file input accept to:

```tsx
accept=".pdf,.pptx,.xlsx,.png,.jpg,.jpeg,.webp"
```

- [ ] **Step 3: Display multimodal quality**

In the resource table, display pages, OCR chars, visual indexed count, quality score, and warnings when present.

- [ ] **Step 4: Run frontend type check**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 6: Full Verification

**Files:** no new files.

- [ ] **Step 1: Run backend knowledge-base tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_resources
```

- [ ] **Step 2: Run backend checks**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
```

- [ ] **Step 3: Run multimodal smoke command**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_multimodal_rag --top-k 3
```

- [ ] **Step 4: Run frontend type check**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
```

Expected: all commands pass. If frontend lint is run, historical warnings are acceptable only if unchanged.

---

## Self-Review

- Spec coverage: This plan covers design phases 0 and 1 foundations: no fake success, multimodal metadata, image upload, PPTX text detection, parser quality warnings, parse detail API, and smoke metrics. It does not claim full OCR, Docling/MinerU, visual embeddings, or VLM evidence answering; those remain later phases.
- Placeholder scan: No TBD/TODO placeholders are used as implementation instructions.
- Type consistency: Resource status uses `indexed_with_warnings`; summary key is `multimodal`; model names are `KnowledgeParseRun`, `KnowledgePage`, `KnowledgeAsset`, `KnowledgeBlock`, and `KnowledgeIndexEntry`.
