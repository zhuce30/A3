# AI Enhanced Wrong Exports and Review Handouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将错题 Word/Excel/PDF 导出改为真实后台任务，并通过现有 OpenAI-compatible 模型 API 为错题导出和复习讲义生成经过 schema、答案一致性和引用白名单校验的 AI 增强内容。

**Architecture:** 新增独立 `WrongQuestionExportJob` 保存错题导出快照、状态、审计和文件；保留并扩展 `ReviewHandoutJob`。两个任务在 `resource-generation` 队列运行，共用 `AssessmentContentEnhancer` 完成检索证据格式化、版本化 Prompt、模型调用、最多两次重试、JSON 校验和局部降级，之后由各自渲染器生成文件。

**Tech Stack:** Django 5、MySQL、Celery、Redis、requests/OpenAI-compatible chat completions、python-docx、openpyxl、ReportLab、Next.js 16、React、TypeScript、Vitest。

---

## File Map

New backend files:

- `backend/apps/assessments/content_prompts.py`: `wrong-export-v1` 与 `review-handout-v1` Prompt。
- `backend/apps/assessments/content_schemas.py`: JSON 提取、schema、题目 ID、答案冲突和引用校验。
- `backend/apps/assessments/content_enhancer.py`: 模型调用、重试、局部降级和审计。
- `backend/apps/assessments/wrong_export_jobs.py`: 导出任务领域服务与安全文件解析。
- `backend/apps/assessments/migrations/0009_ai_enhanced_exports.py`: 新任务表与讲义审计字段。
- `backend/apps/assessments/tests/test_content_enhancer.py`: Prompt/校验/重试专项测试。

Modified backend files:

- `backend/apps/assessments/models.py`
- `backend/apps/assessments/wrong_exports.py`
- `backend/apps/assessments/review_handouts.py`
- `backend/apps/assessments/tasks.py`
- `backend/apps/assessments/views.py`
- `backend/apps/assessments/urls.py`
- `backend/apps/assessments/tests/test_wrong_exports.py`
- `backend/apps/assessments/tests/test_review_handouts.py`
- `.env.production.template`
- `docker-compose.prod.yml`

Modified frontend files:

- `OpenMAIC/lib/a3/assessment-types.ts`
- `OpenMAIC/components/a3/features/wrong-notebook-actions.tsx`
- `OpenMAIC/tests/a3-wrong-notebook-exports.test.ts`

## Task 1: Versioned Prompt and Schema Contracts

**Files:**
- Create: `backend/apps/assessments/content_prompts.py`
- Create: `backend/apps/assessments/content_schemas.py`
- Create: `backend/apps/assessments/tests/test_content_enhancer.py`

- [ ] **Step 1: Write failing Prompt tests**

```python
def test_wrong_export_prompt_forbids_answer_rewrite_and_unknown_sources(self):
    messages = build_wrong_export_messages(PROFILE, [QUESTION], [SOURCE])
    system, user = messages[0]["content"], messages[1]["content"]
    self.assertIn("不得修改或质疑 correctAnswer", system)
    self.assertIn("只能使用提供的 sourceId", system)
    self.assertIn("只输出一个 JSON 对象", system)
    self.assertIn('"questionId": "q-1"', user)
    self.assertIn('"sourceId": "S1"', user)
    self.assertNotIn("13800001111", user)

def test_handout_prompt_requires_tiered_practice_and_no_fake_pages(self):
    system = build_review_handout_messages(PROFILE, WEAKNESS, [QUESTION], [SOURCE])[0]["content"]
    self.assertIn("不得编造教材名称、页码", system)
    self.assertIn("基础、巩固、迁移", system)
    self.assertIn("evidenceStatus", system)
```

- [ ] **Step 2: Run and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_content_enhancer --verbosity 2
```

Expected: import failure because Prompt/schema modules do not exist.

- [ ] **Step 3: Implement Prompt builders**

Define `WRONG_EXPORT_PROMPT_VERSION = "wrong-export-v1"` and `REVIEW_HANDOUT_PROMPT_VERSION = "review-handout-v1"`. Both builders return system/user messages. User JSON includes only minimal profile fields, stable question IDs, immutable question facts and `sourceId/title/location/snippet`; never phone, session, internal path or key.

- [ ] **Step 4: Write failing schema tests**

```python
def test_validator_rejects_unknown_citation(self):
    payload = valid_wrong_export_payload(citation_ids=["S9"])
    with self.assertRaisesMessage(ContentValidationError, "未知引用 S9"):
        validate_wrong_export_payload(payload, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})

def test_validator_rejects_original_answer_conflict(self):
    payload = valid_wrong_export_payload()
    payload["questionAnalyses"][0]["deepErrorDiagnosis"] = "本题正确答案应为 A"
    with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
        validate_wrong_export_payload(payload, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
```

Also test duplicate/unknown question IDs, invalid evidence status, missing fields and field length overflow.

- [ ] **Step 5: Implement strict validators**

`extract_json_object` calls `json.loads(content.strip())`; Markdown fences and multiple objects are errors. Bound prose to 2,000 characters, lists to 12, exercises to 6. Normalize valid payloads, reject unknown IDs/citations and explicit original-answer conflicts.

- [ ] **Step 6: Run tests and verify GREEN**

Expected: all Task 1 tests pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/assessments/content_prompts.py backend/apps/assessments/content_schemas.py backend/apps/assessments/tests/test_content_enhancer.py
git commit -m "feat: define assessment content prompts and schemas"
```

## Task 2: Shared LLM Enhancer

**Files:**
- Create: `backend/apps/assessments/content_enhancer.py`
- Modify: `backend/apps/assessments/tests/test_content_enhancer.py`

- [ ] **Step 1: Write failing success/audit test**

Patch `content_enhancer.chat_completion`, return valid JSON, and assert verified content plus `promptVersion`, provider, model, attempts, latency, finish reason and token usage.

```python
result = enhance_wrong_export(SNAPSHOT, {"进程调度": [SOURCE]}, sleep=lambda _: None)
self.assertTrue(result.verified)
self.assertFalse(result.degraded)
self.assertEqual(result.audit["promptVersion"], "wrong-export-v1")
self.assertEqual(result.audit["attempts"], 1)
```

- [ ] **Step 2: Write failing retry/degradation tests**

Test timeout then success (2 calls), invalid JSON twice then success (3 calls), HTTP 401 immediate fallback (1 call), one point failure plus one success, all points failing, and safe error categories without exception bodies or keys.

- [ ] **Step 3: Run and verify RED**

Run Task 1 command. Expected: enhancer imports/functions missing.

- [ ] **Step 4: Implement enhancer**

```python
@dataclass
class EnhancementResult:
    content: dict
    citations: list[dict]
    verified: bool
    degraded: bool
    degraded_reasons: list[str]
    audit: dict
```

Implement `enhance_wrong_export` and `enhance_review_handout`. Use `backend.apps.compat.llm.chat_completion`, temperature `0.15`, configured timeout/tokens, and retry delays `[1, 3]`. Classify 401/403 as `authentication` (no retry), 429 as `rate_limit`, timeout as `timeout`, validation as `invalid_response`, and 5xx as `provider_error`.

- [ ] **Step 5: Implement deterministic fallback**

Fallback preserves `questionId`, uses original `errorCause` and `explanation`, gives a fixed self-check/review action, no fabricated exercises/citations, and sets `evidenceStatus="unverified"`.

- [ ] **Step 6: Run and verify GREEN**

Expected: all success, retry, short-circuit, partial and total degradation tests pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/assessments/content_enhancer.py backend/apps/assessments/tests/test_content_enhancer.py
git commit -m "feat: add validated assessment LLM enhancer"
```

## Task 3: Export Job and Audit Models

**Files:**
- Modify: `backend/apps/assessments/models.py`
- Create: `backend/apps/assessments/migrations/0009_ai_enhanced_exports.py`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`
- Modify: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Write failing model tests**

Assert `WrongQuestionExportJob` stores owner, scope, format, snapshot/hash, state, enhancement, citations, `llm_audit`, degradation, artifact metadata and timestamps. Assert `ReviewHandoutJob` gains `enhancement`, `llm_audit`, `degraded_reasons`, `prompt_version` with empty defaults.

- [ ] **Step 2: Run and verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_wrong_exports apps.assessments.tests.test_review_handouts --verbosity 1 --keepdb
```

Expected: model/field failures.

- [ ] **Step 3: Add models**

Use table `a3_wrong_question_export_jobs`; indexes `(user,-created_at)` and `(user,snapshot_hash,format,status)`. Add the four audit fields to `ReviewHandoutJob`. Do not remove or rename existing fields.

- [ ] **Step 4: Generate and inspect migration**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations assessments --name ai_enhanced_exports
backend\.venv\Scripts\python.exe backend\manage.py sqlmigrate assessments 0009
```

Expected: one table, two indexes, four added fields, no unrelated operations.

- [ ] **Step 5: Verify models/migrations**

Run Task 3 tests and `makemigrations --check --dry-run`; expect pass and `No changes detected`.

- [ ] **Step 6: Commit**

```powershell
git add backend/apps/assessments/models.py backend/apps/assessments/migrations/0009_ai_enhanced_exports.py backend/apps/assessments/tests/test_wrong_exports.py backend/apps/assessments/tests/test_review_handouts.py
git commit -m "feat: persist AI enhanced export jobs"
```

## Task 4: Wrong Export Job Domain and Celery Worker

**Files:**
- Create: `backend/apps/assessments/wrong_export_jobs.py`
- Modify: `backend/apps/assessments/tasks.py`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing creation/idempotency tests**

Test scope/format validation, frozen snapshot, hash excluding `generatedAt`, reuse only active identical `(user,hash,format)` jobs, and isolation across users/formats.

- [ ] **Step 2: Write failing lifecycle tests**

Assert stages `retrieval -> enhancing -> rendering -> completed`; success metadata; cancelled jobs write nothing; late workers cannot overwrite cancellation; safe failed message on renderer failure.

- [ ] **Step 3: Run and verify RED**

Run `test_wrong_exports`; expect missing domain functions/task.

- [ ] **Step 4: Implement domain service**

Implement `create_wrong_export_job`, `retry_wrong_export_job`, `generate_wrong_export_job`, `serialize_wrong_export_job`, `resolve_wrong_export_artifact`, `_save_job`. Serialization exposes `downloadUrl` only after success and never exposes paths.

- [ ] **Step 5: Add retrieval and enhancement**

For each knowledge point call `search_knowledge_base(query=f"{point} 核心概念 常见错误 解题方法", top_k=3)`, assign stable `S1...Sn`, pass grouped evidence to enhancer, persist safe citations/audit, then render.

- [ ] **Step 6: Add Celery task**

```python
@shared_task(bind=True, name="assessments.generate_wrong_question_export",
             acks_late=True, soft_time_limit=1200, time_limit=1320)
def generate_wrong_question_export_task(self, job_id: str) -> dict:
    WrongQuestionExportJob.objects.filter(id=job_id, status="queued").update(
        celery_task_id=self.request.id or ""
    )
    return generate_wrong_export_job(job_id)
```

- [ ] **Step 7: Run tests and verify GREEN**

Expected: idempotency, cancellation, late-worker, path and lifecycle tests pass.

- [ ] **Step 8: Commit**

```powershell
git add backend/apps/assessments/wrong_export_jobs.py backend/apps/assessments/tasks.py backend/apps/assessments/tests/test_wrong_exports.py
git commit -m "feat: generate wrong exports in background"
```

## Task 5: AI-Enhanced DOCX, XLSX and PDF Renderers

**Files:**
- Modify: `backend/apps/assessments/wrong_exports.py`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing artifact tests**

Assert DOCX contains original answer/analysis plus `AI 深度诊断`, `迁移练习`, `资料引用`; XLSX sheets are `错题明细`, `AI分析`, `迁移练习与引用`; PDF extracted text contains original answer and AI headings; renderer does not mutate inputs; degraded output has a visible banner.

- [ ] **Step 2: Run and verify RED**

Expected: enhancement ignored and new XLSX sheets absent.

- [ ] **Step 3: Add renderer entry point**

```python
def render_wrong_export(snapshot: dict, export_format: str, *, enhancement: dict | None = None,
                        citations: list[dict] | None = None,
                        degraded_reasons: list[str] | None = None) -> ExportArtifact:
    ...
```

Keep `build_wrong_export` as deterministic compatibility helper that builds a snapshot then calls this without AI content.

- [ ] **Step 4: Extend DOCX/PDF**

Render immutable facts first, then separate AI sections by knowledge point/question ID, transfer practice, answers at document end, citation title/location/snippet and verified/degraded notice. Escape all untrusted text and keep question blocks together where practical.

- [ ] **Step 5: Extend XLSX**

Keep existing `错题明细`. Add `AI分析` columns for ID, knowledge point, group/deep diagnosis, prerequisites, steps, self-check, advice, evidence status, citations. Add `迁移练习与引用` with `记录类型`. Freeze headers, filters, wrapping and bounded widths.

- [ ] **Step 6: Run all export tests**

Expected: DOCX/openpyxl/PDF parsers pass and original data remains unchanged.

- [ ] **Step 7: Commit**

```powershell
git add backend/apps/assessments/wrong_exports.py backend/apps/assessments/tests/test_wrong_exports.py
git commit -m "feat: render AI enhanced wrong exports"
```

## Task 6: Export Job APIs

**Files:**
- Modify: `backend/apps/assessments/views.py`
- Modify: `backend/apps/assessments/urls.py`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing API tests**

Cover auth, create `202`, list, detail, owner isolation, idempotent cancellation/revoke, retry creates new job, safe download, and legacy `POST /wrong-questions/export/` returning `202` JSON instead of binary. Assert dispatch uses task name and `queue="resource-generation"`.

- [ ] **Step 2: Run and verify RED**

Expected: plural routes 404 and legacy endpoint returns binary 200.

- [ ] **Step 3: Implement routes/views**

Add `/wrong-questions/exports/`, detail, cancel, retry, download. Invalid payload is 400, empty scope/invalid state 409, other owner 404. Broker failure stores a safe failed task; no traceback in response.

- [ ] **Step 4: Change legacy contract**

Legacy singular endpoint calls the same creation/dispatch service and returns `202`; remove synchronous binary behavior from HTTP layer.

- [ ] **Step 5: Run assessment tests**

Run Task 3 command; expect 0 failures.

- [ ] **Step 6: Commit**

```powershell
git add backend/apps/assessments/views.py backend/apps/assessments/urls.py backend/apps/assessments/tests/test_wrong_exports.py
git commit -m "feat: expose background wrong export jobs"
```

## Task 7: LLM-Enhanced Review Handouts

**Files:**
- Modify: `backend/apps/assessments/review_handouts.py`
- Modify: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Write failing verified chapter test**

Patch enhancer with verified chapters. Assert persisted enhancement/audit/version and DOCX text includes diagnosis, method, three practice levels, 7-day plan, answers and citations.

- [ ] **Step 2: Write failing partial/total degradation tests**

One verified plus one degraded chapter must finish `succeeded + degraded`, render both, and store only safe reason categories. Total API failure must still generate DOCX/PDF from original explanations.

- [ ] **Step 3: Run and verify RED**

Expected: current fixed chapters lack enhancement/audit/7-day plan.

- [ ] **Step 4: Integrate enhancer**

Split evidence collection from chapter synthesis. Pass evidence to `enhance_review_handout`; preserve current citation normalization. Never let model modify ranking or due state.

- [ ] **Step 5: Add deterministic 7-day planner**

Pure function assigns ranked weaknesses using score/due count. Active weaknesses appear day 1 or 2; later days schedule practice and spaced review. Model text cannot change task truth.

- [ ] **Step 6: Extend DOCX/PDF**

Render diagnosis, concept, prerequisites, common errors, method, worked example, tiered practice, review actions, citations, 7-day schedule, answers, and verified/partial/unverified labels.

- [ ] **Step 7: Run handout/export tests**

Expected: all old cancellation/download and new AI/degradation tests pass.

- [ ] **Step 8: Commit**

```powershell
git add backend/apps/assessments/review_handouts.py backend/apps/assessments/tests/test_review_handouts.py
git commit -m "feat: generate AI enhanced review handouts"
```

## Task 8: Background Export UI

**Files:**
- Modify: `OpenMAIC/lib/a3/assessment-types.ts`
- Modify: `OpenMAIC/components/a3/features/wrong-notebook-actions.tsx`
- Modify: `OpenMAIC/tests/a3-wrong-notebook-exports.test.ts`

- [ ] **Step 1: Write failing frontend contract test**

Require `/wrong-questions/exports/`, `WrongQuestionExportJob`, polling while either job type is active, cancel/retry/download URL, and absence of `a3PostDownload` from initial export creation.

- [ ] **Step 2: Run and verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-wrong-notebook-exports.test.ts
```

- [ ] **Step 3: Add backend-aligned types**

Define shared status/audit/evidence summaries and `WrongQuestionExportJob`; add optional audit/degradation fields to `ReviewHandoutJob`.

- [ ] **Step 4: Replace synchronous action**

Use `a3PostJson` to create `{scope,format}` job. Keep export/handout lists separate. Poll every 2 seconds only while queued/running exists. Use `a3DownloadFile` only after success URL exists.

- [ ] **Step 5: Build task rows**

Show format, scope, progress, stage, verified/partial/base state and time; use icon actions with tooltips for refresh/cancel/retry/download; preserve mobile wrapping and stable row height.

- [ ] **Step 6: Verify frontend**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-wrong-notebook-exports.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: tests/typecheck pass; lint 0 errors and only documented warnings.

- [ ] **Step 7: Commit**

```powershell
git add OpenMAIC/lib/a3/assessment-types.ts OpenMAIC/components/a3/features/wrong-notebook-actions.tsx OpenMAIC/tests/a3-wrong-notebook-exports.test.ts
git commit -m "feat: manage AI export jobs in wrong notebook"
```

## Task 9: Runtime Configuration

**Files:**
- Modify: `.env.production.template`
- Modify: `docker-compose.prod.yml`
- Modify: `scripts/test-start-a3-dev.ps1`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`

- [ ] **Step 1: Write failing static assertions**

Require enable, timeout, max tokens and max attempts variables in template/Compose backend/resource-worker. Require local worker to listen to `celery,resource-generation` and register the new task.

- [ ] **Step 2: Run and verify RED**

Run assessment tests and `scripts/test-start-a3-dev.ps1`; expect missing configuration assertions.

- [ ] **Step 3: Add safe defaults**

```dotenv
A3_ASSESSMENT_EXPORT_LLM_ENABLED=auto
A3_ASSESSMENT_EXPORT_LLM_TIMEOUT_SECONDS=60
A3_ASSESSMENT_EXPORT_LLM_MAX_TOKENS=3000
A3_ASSESSMENT_EXPORT_LLM_MAX_ATTEMPTS=3
```

Pass these to backend and resource-worker. Never put an API key value in the template.

- [ ] **Step 4: Verify config**

Run static tests. Where Docker exists, run production Compose `config --quiet` with the template and expect exit 0 without secret output.

- [ ] **Step 5: Commit**

```powershell
git add .env.production.template docker-compose.prod.yml scripts/test-start-a3-dev.ps1 backend/apps/assessments/tests/test_wrong_exports.py
git commit -m "chore: configure assessment export LLM runtime"
```

## Task 10: Full Verification and Real Model Smoke

**Files:**
- Create if needed: `backend/apps/assessments/management/commands/smoke_ai_assessment_exports.py`
- Modify: `backend/apps/assessments/tests/test_wrong_exports.py`
- Modify: `backend/apps/assessments/tests/test_review_handouts.py`

- [ ] **Step 1: Add safe smoke command**

Accept `--user-id` and require `--real-model` for network. Invoke domain generators for 3 export formats plus one handout, parse five artifacts, print only job ID/status/model/verified/degraded/citation count/file size. Never print Prompt, snippets, key, absolute path or profile.

- [ ] **Step 2: Run focused backend suite**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_content_enhancer apps.assessments.tests.test_wrong_exports apps.assessments.tests.test_review_handouts --verbosity 1 --keepdb
```

- [ ] **Step 3: Run backend checks**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

- [ ] **Step 4: Run frontend checks**

Run Vitest, TypeScript and lint commands from Task 8.

- [ ] **Step 5: Run real model smoke**

```powershell
$demoUserId = backend\.venv\Scripts\python.exe backend\manage.py shell -c "from backend.apps.accounts.models import User; print(User.objects.filter(wrong_questions__isnull=False).distinct().values_list('id', flat=True).first() or '')"
if (-not $demoUserId.Trim()) { throw "没有包含错题的演示用户，先执行 seed_demo_data" }
backend\.venv\Scripts\python.exe backend\manage.py smoke_ai_assessment_exports --user-id $demoUserId.Trim() --real-model
```

Expected: five files succeed; at least one uses non-rules model. Missing evidence may set degraded only with honest `missing_evidence` reason.

- [ ] **Step 6: Inspect artifacts visually**

Render PDFs with Poppler and DOCX with LibreOffice/WPS when available. Check Chinese glyphs, clipping, original answer, AI hierarchy, exercise/answer separation and citations. If DOCX visual tooling is unavailable, report it; structural parsing remains required.

- [ ] **Step 7: Browser verification**

Desktop/mobile `/a3/wrong-notebook`: create export, observe progress, download, exercise cancel/retry, assert no 500 and no overlap.

- [ ] **Step 8: Secret/path scan and commit**

```powershell
git diff --check
rg -n "sk-[A-Za-z0-9]|D:\\\\|/opt/A3|Authorization: Bearer" backend/apps/assessments OpenMAIC/components/a3 OpenMAIC/lib/a3 .env.production.template
git status --short --branch
git add backend/apps/assessments/management/commands/smoke_ai_assessment_exports.py backend/apps/assessments/tests/test_wrong_exports.py backend/apps/assessments/tests/test_review_handouts.py
git commit -m "test: verify AI assessment export workflow"
```

## Task 11: Push and Production Deployment

**Files:** No planned product edits.

- [ ] **Step 1: Review scope**

```powershell
git status --short --branch
git log --oneline --decorate -15
git diff origin/codex/a3-latest-integration...HEAD --stat
```

Exclude control files, caches, outputs, uploads and user documents.

- [ ] **Step 2: Push and wait for images**

```powershell
git push origin codex/a3-latest-integration
gh run list --repo zhuce30/A3 --branch codex/a3-latest-integration --limit 5
```

Both backend/frontend GHCR runs for the exact SHA must succeed.

- [ ] **Step 3: Check server disk before pull**

Run `df -h /` and `docker system df -v`. Require enough unpack space for the 11+ GB backend image. If needed, remove only images unused by containers with `docker image prune -a`; never prune volumes.

- [ ] **Step 4: Deploy backend and migrate**

Pull full-SHA image, verify OCI revision, resolve digest, back up `.env.production`, update `A3_BACKEND_IMAGE`, recreate backend, wait healthy, and verify `assessments.0009` applied.

- [ ] **Step 5: Deploy workers**

Recreate Celery services. Resource-worker logs must show `resource-generation`, `assessments.generate_wrong_question_export`, and `assessments.generate_review_handout`.

- [ ] **Step 6: Deploy frontend and verify public runtime**

Switch frontend digest and recreate frontend/realtime-proxy/Caddy. Verify root `308 /a3`, readiness 200, and unauthenticated export/handout endpoints 401. Log in and run one real export plus one real handout.

- [ ] **Step 7: Record and clean**

Append UTC/full SHA/backend digest/frontend digest to root `0600` deployment history. After health passes, remove only unused images and keep disk below 85%.

---

## Completion Checklist

- [ ] Every behavior change began with a failing test.
- [ ] Original facts and answers stay immutable.
- [ ] Model output passes JSON/schema/question/answer/citation validation.
- [ ] Initial call plus at most two retries is enforced and audited.
- [ ] Partial/total failures still create explicitly degraded files.
- [ ] All five artifacts parse and receive available visual inspection.
- [ ] Both job families support create/list/detail/cancel/retry/download with owner isolation.
- [ ] Frontend no longer initiates synchronous export downloads.
- [ ] Production migration, worker registration, public health and real-model smoke pass.
