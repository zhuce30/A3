# Adaptive Question Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 A3 当前“静态题库 + 个性化抽题”升级为“知识库可溯源生成候选题 + 自动验证 + 教师审核 + 学生自适应练习”的真实题库系统。

**Architecture:** 现有 `Question`、`AssessmentSession`、`WrongQuestion` 保留为答题与错题闭环主干；新增题目来源、证据、生成任务、审核状态和自适应选题服务。正式测评只使用 verified/approved 题，低风险练习可以使用自动验证通过的 personal/practice 题，但必须显示来源与可信状态。

**Tech Stack:** Django ORM/API/management command, existing A3 AgentKernel, existing knowledge_base hybrid retrieval, Next.js A3 pages, existing OpenMAIC API proxy, backend Django tests, frontend TypeScript/lint.

---

## Current Baseline

当前链路是真实的，但还不是多模态知识库驱动出题：

- `backend/apps/assessments/models.py`
  - `Question` 是静态题库表。
  - `AssessmentSession.question_ids` 保存一次练习抽到的题。
  - `WrongQuestion` 保存用户错题与复习状态。
- `backend/apps/assessments/services.py`
  - `create_assessment()` 从 `Question.objects.filter(is_active=True)` 抽题。
  - `practice_suggestions()` 根据画像 weak_points、错题、学习路径给练习建议。
  - `answer_assessment_question()` 判分并写回错题、画像、复习计划。
- `backend/apps/compat/agent_kernel.py`
  - `AssessmentAgent` 负责判分，不负责生成题。
- `backend/apps/assessments/migrations/0002_seed_questions.py`
  - 当前默认题来自 migration seed。

本计划的关键边界：

- 不删除现有题库、错题本、学习报告、学习计划回流。
- 不让未审核 LLM 题直接进入入学诊断或正式测评。
- 所有生成题必须有证据来源、验证状态、题目来源类型和作用域。
- 学生个人资料生成的题默认只属于该学生，不混入公共题库。

## File Structure

### Backend Models

- Modify: `backend/apps/assessments/models.py`
  - 扩展 `Question`：题目类型、来源类型、作用域、审核状态、生成状态、证据摘要、来源资源、创建者。
  - Create models:
    - `QuestionEvidence`
    - `QuestionGenerationJob`
    - `QuestionQualityCheck`
    - `StudentQuestionMastery`
- Create migration: `backend/apps/assessments/migrations/0003_adaptive_question_bank.py`

### Backend Services

- Create: `backend/apps/assessments/generation.py`
  - 从知识库检索证据并生成候选题。
- Create: `backend/apps/assessments/verification.py`
  - 校验题干、选项、答案唯一性、解析、证据支撑和难度标签。
- Create: `backend/apps/assessments/adaptive.py`
  - 根据画像、错题、学习路径、个人资料、掌握度选择题目。
- Modify: `backend/apps/assessments/services.py`
  - `create_assessment()` 接入 adaptive selector。
  - `serialize_question()` 返回 source/review/evidence 元数据。
- Modify: `backend/apps/compat/agent_kernel.py`
  - 增加 `QuestionGeneratorAgent`、`QuestionVerifierAgent`、`AdaptivePracticeAgent`。

### Backend APIs

- Modify: `backend/apps/assessments/views.py`
  - 新增生成任务、审核、候选题列表、学生个性化练习入口。
- Modify: `backend/apps/assessments/urls.py`
  - 新增题库 API 路由。

### Frontend

- Modify: `OpenMAIC/components/a3/features/assessment-view.tsx`
  - 展示题目来源、可信状态、证据入口。
- Create or modify: `OpenMAIC/components/a3/features/question-bank-view.tsx`
  - 教师/管理员题库管理、候选题审核、生成任务状态。
- Modify: `OpenMAIC/app/a3/teacher/page.tsx`
  - 增加题库审核入口。
- Modify: `OpenMAIC/app/a3/capabilities/page.tsx` and `OpenMAIC/components/a3/features/capabilities-view.tsx`
  - 展示题库生成指标、验证通过率、知识库覆盖率。
- Modify or create: `OpenMAIC/app/api/a3/assessments/*`
  - 如现有代理缺口存在，补齐 Next API proxy。

### Tests and Evaluation

- Modify: `backend/apps/assessments/tests/test_assessment_flow.py`
- Create: `backend/apps/assessments/tests/test_question_generation.py`
- Create: `backend/apps/assessments/tests/test_adaptive_practice.py`
- Create: `backend/apps/assessments/management/commands/evaluate_question_bank.py`
- Optional create: `OpenMAIC/tests/a3-question-bank.test.ts`

---

## Data Model Design

### Extend `Question`

Add fields:

```python
class QuestionType(models.TextChoices):
    SINGLE_CHOICE = "single_choice", "单选题"
    MULTIPLE_CHOICE = "multiple_choice", "多选题"
    SHORT_ANSWER = "short_answer", "简答题"


class QuestionSourceType(models.TextChoices):
    SEEDED = "seeded", "系统预置"
    TEACHER = "teacher", "教师录入"
    KB_GENERATED = "kb_generated", "知识库生成"
    PERSONAL_GENERATED = "personal_generated", "个人资料生成"
    VARIANT = "variant", "错题变式"


class QuestionReviewStatus(models.TextChoices):
    DRAFT = "draft", "草稿"
    AUTO_VERIFIED = "auto_verified", "自动验证通过"
    APPROVED = "approved", "教师审核通过"
    REJECTED = "rejected", "已拒绝"
    DISABLED = "disabled", "已停用"
```

Fields:

```python
question_type = models.CharField(max_length=32, choices=QuestionType.choices, default=QuestionType.SINGLE_CHOICE)
source_type = models.CharField(max_length=32, choices=QuestionSourceType.choices, default=QuestionSourceType.SEEDED)
review_status = models.CharField(max_length=32, choices=QuestionReviewStatus.choices, default=QuestionReviewStatus.APPROVED)
scope = models.CharField(max_length=32, default="global")
owner = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="owned_questions")
source_resource = models.ForeignKey("knowledge_base.KnowledgeResource", null=True, blank=True, on_delete=models.SET_NULL, related_name="questions")
source_block_id = models.CharField(max_length=128, blank=True)
evidence_summary = models.TextField(blank=True)
quality_score = models.FloatField(default=0)
metadata = models.JSONField(default=dict, blank=True)
```

Rules:

- Existing seeded questions migrate to `source_type=seeded`, `review_status=approved`, `scope=global`。
- `is_active=True` 不等于可用于正式测评；正式测评还需要 `review_status=approved`。
- `personal_generated` 题必须带 `owner_id`，查询时只能给 owner 使用。

### Create `QuestionEvidence`

```python
class QuestionEvidence(models.Model):
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="evidence_items")
    resource = models.ForeignKey("knowledge_base.KnowledgeResource", null=True, blank=True, on_delete=models.SET_NULL)
    block_id = models.CharField(max_length=128, blank=True)
    page_number = models.PositiveIntegerField(null=True, blank=True)
    preview_url = models.CharField(max_length=512, blank=True)
    quote = models.TextField(blank=True)
    modality = models.CharField(max_length=32, default="text")
    score = models.FloatField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
```

Rules:

- 每道生成题至少 1 条 evidence。
- visual/PPTX 题优先保留 `preview_url`，前端可以展示缩略图。
- `quote` 只能保存短证据摘要，不保存超长原文。

### Create `QuestionGenerationJob`

```python
class QuestionGenerationJob(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="question_generation_jobs")
    knowledge_point = models.ForeignKey("learning.KnowledgePoint", null=True, blank=True, on_delete=models.SET_NULL)
    resource = models.ForeignKey("knowledge_base.KnowledgeResource", null=True, blank=True, on_delete=models.SET_NULL)
    scope = models.CharField(max_length=32, default="personal")
    status = models.CharField(max_length=32, default="queued")
    requested_count = models.PositiveSmallIntegerField(default=5)
    generated_count = models.PositiveSmallIntegerField(default=0)
    verified_count = models.PositiveSmallIntegerField(default=0)
    rejected_count = models.PositiveSmallIntegerField(default=0)
    error = models.CharField(max_length=255, blank=True)
    trace = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

### Create `QuestionQualityCheck`

```python
class QuestionQualityCheck(models.Model):
    question = models.ForeignKey(Question, on_delete=models.CASCADE, related_name="quality_checks")
    checker = models.CharField(max_length=64)
    passed = models.BooleanField(default=False)
    score = models.FloatField(default=0)
    issues = models.JSONField(default=list, blank=True)
    evidence = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
```

### Create `StudentQuestionMastery`

```python
class StudentQuestionMastery(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="question_mastery")
    knowledge_point = models.ForeignKey("learning.KnowledgePoint", on_delete=models.CASCADE)
    attempts = models.PositiveIntegerField(default=0)
    correct = models.PositiveIntegerField(default=0)
    mastery_score = models.FloatField(default=0.5)
    last_practiced_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
```

Rules:

- `answer_assessment_question()` 每次答题后更新 mastery。
- 选题时优先覆盖低 mastery、最近错题、当前学习路径节点。

---

## API Contract

### Generate Candidate Questions

`POST /api/assessments/questions/generate/`

Request:

```json
{
  "knowledgePointId": "uuid-or-empty",
  "resourceId": "uuid-or-empty",
  "scope": "personal",
  "count": 5,
  "difficultyRange": [1, 3],
  "questionTypes": ["single_choice"]
}
```

Response:

```json
{
  "success": true,
  "job": {
    "id": "uuid",
    "status": "queued",
    "requestedCount": 5,
    "generatedCount": 0,
    "verifiedCount": 0,
    "rejectedCount": 0
  }
}
```

Validation:

- `count` min 1 max 20。
- student 用户只能创建 `scope=personal`。
- teacher/admin 可以创建 `teacher/class/global` 范围任务。
- `resourceId` 必须符合用户可见资源范围。

### List Candidate Questions

`GET /api/assessments/questions/?status=auto_verified&scope=personal`

Response:

```json
{
  "success": true,
  "questions": [
    {
      "id": "uuid",
      "stem": "题干",
      "options": [{"key": "A", "text": "选项"}],
      "knowledgePoint": {"id": "uuid", "title": "知识点"},
      "difficulty": 2,
      "sourceType": "personal_generated",
      "reviewStatus": "auto_verified",
      "qualityScore": 0.86,
      "evidence": [
        {
          "resourceTitle": "课件标题",
          "pageNumber": 3,
          "previewUrl": "/api/kb/resources/.../preview/...",
          "quote": "短证据摘要",
          "modality": "visual"
        }
      ]
    }
  ]
}
```

### Review Candidate Question

`POST /api/assessments/questions/<question_id>/review/`

Request:

```json
{
  "action": "approve",
  "reason": "解析准确，答案唯一"
}
```

Rules:

- teacher/admin only。
- `approve` sets `review_status=approved`, `is_active=True`。
- `reject` sets `review_status=rejected`, `is_active=False`。
- `disable` sets `review_status=disabled`, `is_active=False`。

### Start Adaptive Practice

Existing:

`POST /api/assessments/start/`

Extend request:

```json
{
  "mode": "practice",
  "strategy": "adaptive",
  "knowledgePoint": "根轨迹",
  "limit": 10,
  "allowPersonalGenerated": true
}
```

Response keeps current shape and adds:

```json
{
  "selection": {
    "strategy": "adaptive",
    "reason": "优先覆盖最近错题和当前学习路径节点",
    "sourceCounts": {
      "approved": 7,
      "autoVerifiedPersonal": 3
    }
  }
}
```

---

## Agent Design

### `QuestionGeneratorAgent`

Input:

```json
{
  "jobId": "uuid",
  "userId": "uuid",
  "knowledgePointId": "uuid",
  "resourceId": "uuid",
  "scope": "personal",
  "requestedCount": 5
}
```

Steps:

1. 调用 existing hybrid retrieval，检索 text/vector/visual evidence。
2. 构造 VLM/LLM prompt，要求输出 JSON。
3. 为每道候选题创建 `Question(review_status=draft)`。
4. 写入 `QuestionEvidence`。
5. 交给 `QuestionVerifierAgent`。

Output:

```json
{
  "generatedQuestionIds": ["uuid"],
  "evidenceCount": 8,
  "status": "generated"
}
```

### `QuestionVerifierAgent`

Checks:

- 题干不为空，不含乱码，不含“根据上文”等脱离上下文表达。
- 单选题必须有 4 个非空选项。
- 正确答案 key 必须存在且唯一。
- 解析必须说明为什么正确，且不能只复述答案。
- 至少 1 条 evidence 支撑题干或解析。
- 难度必须在 1 到 5。
- 与同知识点已有题相似度过高则拒绝。

Output:

```json
{
  "passed": true,
  "qualityScore": 0.84,
  "issues": [],
  "nextStatus": "auto_verified"
}
```

### `AdaptivePracticeAgent`

Input:

```json
{
  "userId": "uuid",
  "mode": "practice",
  "knowledgePoint": "根轨迹",
  "limit": 10
}
```

Selection weights:

- active wrong questions: 35%
- low mastery knowledge points: 25%
- current learning path node: 20%
- personal material generated questions: 10%
- mixed review / spacing: 10%

Safety:

- formal `assessment` mode: only `review_status=approved`。
- `practice` mode: `approved` plus owner-visible `auto_verified` personal questions。
- never select `draft/rejected/disabled`。

---

## Implementation Tasks

### Task 1: Add Question Bank Metadata Models

**Files:**

- Modify: `backend/apps/assessments/models.py`
- Create: `backend/apps/assessments/migrations/0003_adaptive_question_bank.py`
- Test: `backend/apps/assessments/tests/test_question_generation.py`

- [ ] Step 1: Add failing tests for default seeded question metadata.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_question_generation
```

Expected:

```text
ImportError or AttributeError for source_type/review_status fields
```

- [ ] Step 2: Add enum classes and fields to `Question`.

Implementation must include:

```python
class QuestionSourceType(models.TextChoices):
    SEEDED = "seeded", "系统预置"
    TEACHER = "teacher", "教师录入"
    KB_GENERATED = "kb_generated", "知识库生成"
    PERSONAL_GENERATED = "personal_generated", "个人资料生成"
    VARIANT = "variant", "错题变式"
```

- [ ] Step 3: Add `QuestionEvidence`, `QuestionGenerationJob`, `QuestionQualityCheck`, `StudentQuestionMastery`.

- [ ] Step 4: Generate migration and verify existing questions receive safe defaults.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations assessments
backend\.venv\Scripts\python.exe backend\manage.py migrate
```

Expected:

```text
Applying assessments.0003_adaptive_question_bank... OK
```

- [ ] Step 5: Run assessment tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments
```

Expected:

```text
OK
```

### Task 2: Add Question Verification Service

**Files:**

- Create: `backend/apps/assessments/verification.py`
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_question_generation.py`

- [ ] Step 1: Write tests for invalid options, missing evidence, duplicate answer, low quality explanation.

- [ ] Step 2: Implement `verify_question(question) -> QuestionVerificationResult`.

Required result shape:

```python
@dataclass
class QuestionVerificationResult:
    passed: bool
    score: float
    issues: list[dict]
    next_status: str
```

- [ ] Step 3: Persist a `QuestionQualityCheck` row for every verification.

- [ ] Step 4: Update `is_valid_assessment_question()` so formal selection ignores non-approved generated questions.

Rules:

```text
assessment mode: is_active=True and review_status=approved
practice mode: is_active=True and review_status in approved/auto_verified, scoped to current user
```

- [ ] Step 5: Run targeted tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_question_generation
```

Expected:

```text
OK
```

### Task 3: Add Knowledge-Base Candidate Generation

**Files:**

- Create: `backend/apps/assessments/generation.py`
- Modify: `backend/apps/assessments/views.py`
- Modify: `backend/apps/assessments/urls.py`
- Test: `backend/apps/assessments/tests/test_question_generation.py`

- [ ] Step 1: Add tests that student can generate only personal questions from accessible resources.

- [ ] Step 2: Add `create_question_generation_job(user, payload)`.

Validation:

```text
count: 1..20
scope for student: personal only
resource: must be visible to requester
knowledgePointId: optional but if present must exist
```

- [ ] Step 3: Add synchronous service `run_question_generation_job(job_id)` for first delivery.

First delivery can run synchronously from API to avoid Celery dependency. A follow-up performance pass can move this into Celery without API changes.

- [ ] Step 4: Use existing knowledge base hybrid retrieval.

Minimum evidence requirement:

```text
top_k >= 5
at least one text or visual evidence item
visual evidence keeps previewUrl when available
```

- [ ] Step 5: Add LLM provider wrapper.

Use existing environment/provider conventions. Do not hardcode API keys.

Provider fallback:

```text
If no LLM key: create job status=failed with Chinese error "未配置出题模型 API Key"
Do not create fake questions.
```

- [ ] Step 6: Parse JSON output into `Question` rows and `QuestionEvidence` rows.

- [ ] Step 7: Immediately call `verify_question()` for each generated candidate.

- [ ] Step 8: Run tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_question_generation
```

Expected:

```text
OK
```

### Task 4: Add Adaptive Practice Selector

**Files:**

- Create: `backend/apps/assessments/adaptive.py`
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_adaptive_practice.py`

- [ ] Step 1: Add tests for selection priority.

Cases:

```text
recent wrong question knowledge point ranks first
low mastery knowledge point ranks above mastered point
formal assessment excludes auto_verified personal question
practice includes current user's auto_verified personal question
practice excludes another user's personal question
```

- [ ] Step 2: Implement `select_adaptive_questions(user, mode, knowledge_point, limit, allow_personal_generated)`.

- [ ] Step 3: Update `create_assessment()` to call adaptive selector when `strategy=adaptive`.

- [ ] Step 4: Update answer flow to maintain `StudentQuestionMastery`.

Formula:

```text
mastery_score = clamp(0.15, 0.98, previous * 0.75 + correctness_rate * 0.25)
```

- [ ] Step 5: Add selection metadata to `serialize_session()`.

- [ ] Step 6: Run tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_adaptive_practice
```

Expected:

```text
OK
```

### Task 5: Add AgentKernel Integration

**Files:**

- Modify: `backend/apps/compat/agent_kernel.py`
- Test: `backend/apps/compat/tests/test_agent_runtime.py`

- [ ] Step 1: Add tests for new agent trace output.

Expected agents:

```text
QuestionGeneratorAgent
QuestionVerifierAgent
AdaptivePracticeAgent
AssessmentAgent
ProfileUpdateAgent
ReviewSchedulerAgent
StudyPlanAgent
```

- [ ] Step 2: Implement `QuestionGeneratorAgent`.

- [ ] Step 3: Implement `QuestionVerifierAgent`.

- [ ] Step 4: Implement `AdaptivePracticeAgent`.

- [ ] Step 5: Add evidence and quality fields to AgentResult.

- [ ] Step 6: Run compat agent tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_agent_runtime
```

Expected:

```text
OK
```

### Task 6: Add Question Bank APIs

**Files:**

- Modify: `backend/apps/assessments/views.py`
- Modify: `backend/apps/assessments/urls.py`
- Test: `backend/apps/assessments/tests/test_question_generation.py`

- [ ] Step 1: Add API tests for generate/list/review endpoints.

- [ ] Step 2: Implement `generate_questions` view.

- [ ] Step 3: Implement `list_questions` view.

- [ ] Step 4: Implement `review_question` view.

- [ ] Step 5: Add permission checks.

Permission matrix:

```text
student: generate/list own personal questions
teacher: list/review teacher/class questions
admin: list/review all scopes
anonymous: 401
```

- [ ] Step 6: Run tests.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_question_generation
```

Expected:

```text
OK
```

### Task 7: Update Assessment UI

**Files:**

- Modify: `OpenMAIC/components/a3/features/assessment-view.tsx`
- Test: existing TypeScript check

- [ ] Step 1: Display source badge beside question metadata.

Badge labels:

```text
approved: 已审核
auto_verified: 自动验证
personal_generated: 我的资料生成
kb_generated: 知识库生成
seeded: 标准题库
```

- [ ] Step 2: Add compact evidence preview section below explanation after answer submission.

Rules:

```text
show max 3 evidence items
show preview thumbnail when previewUrl exists
show resource title and page number
do not expose local absolute path
```

- [ ] Step 3: Add adaptive practice start option when suggestions exist.

- [ ] Step 4: Run frontend checks.

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:

```text
tsc passes
lint has no new errors; historical warnings only
```

### Task 8: Add Teacher Question Bank Review UI

**Files:**

- Create: `OpenMAIC/components/a3/features/question-bank-view.tsx`
- Modify: `OpenMAIC/app/a3/teacher/page.tsx`
- Optional create: `OpenMAIC/app/a3/question-bank/page.tsx`

- [ ] Step 1: Add UI states: loading, empty, error, success.

- [ ] Step 2: Add filters: scope, review status, knowledge point, source type.

- [ ] Step 3: Add candidate question card with evidence preview and quality issues.

- [ ] Step 4: Add approve/reject buttons wired to real API.

- [ ] Step 5: Add generate button for teacher/class resources.

- [ ] Step 6: Run frontend checks.

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:

```text
tsc passes
lint has no new errors; historical warnings only
```

### Task 9: Add Metrics and Capabilities Evidence

**Files:**

- Create: `backend/apps/assessments/management/commands/evaluate_question_bank.py`
- Modify: `backend/apps/compat/views.py` or existing capabilities runtime status provider
- Modify: `OpenMAIC/components/a3/features/capabilities-view.tsx`

- [ ] Step 1: Implement command output.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_question_bank --json --output backend\tmp\question_bank_metrics.json
```

Expected JSON:

```json
{
  "questionCount": 0,
  "approvedCount": 0,
  "autoVerifiedCount": 0,
  "generatedCount": 0,
  "evidenceCoverage": 0,
  "verificationPassRate": 0,
  "personalQuestionCount": 0,
  "formalAssessmentSafe": true
}
```

- [ ] Step 2: Add capabilities API field `questionBankMetrics`.

- [ ] Step 3: Display metrics in `/a3/capabilities`.

- [ ] Step 4: Add command to validation docs.

### Task 10: Full Verification

Run backend:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_question_bank --json --output backend\tmp\question_bank_metrics.json
```

Run frontend:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:

```text
backend check passes
assessment tests pass
validate_demo_flow passes
retrieval evaluation still passes baseline
question_bank_metrics.json generated
frontend tsc passes
lint has no new errors
```

---

## Rollout Policy

Phase 1:

- Add metadata models.
- Add verification service.
- Add adaptive selector.
- Keep generation behind API and permission checks.
- Existing assessments continue to work.

Phase 2:

- Add knowledge-base generation.
- Add student personal material generated practice.
- Add teacher review UI.

Phase 3:

- Add bulk generation jobs.
- Move generation to Celery when synchronous response becomes slow.
- Add item difficulty calibration and mastery analytics.

## Acceptance Criteria

- A student can upload personal material, generate personal practice candidates, and start adaptive practice using approved + own auto-verified questions.
- A teacher can generate candidates from class/teacher resources, review them, and approve them into usable question bank.
- Formal assessment never selects draft/rejected/auto-verified personal questions.
- Every generated question has at least one evidence item.
- `/a3/capabilities` shows question bank metrics.
- Existing wrong-question, profile update, study-plan refresh and notification loops remain working.

## Risk Controls

- If no LLM/VLM key exists, generation returns failed job with readable Chinese error and creates no fake questions.
- If retrieval returns no evidence, generation job fails with readable Chinese error and creates no question.
- If verification fails, question remains `draft` or `rejected` and cannot be selected.
- If generated answer is not unique, verifier rejects it.
- If question is personal, query filters enforce `owner=request.user`.

## Self-Review

- Spec coverage: covers generation, verification, adaptive practice, personal scope, teacher review, capabilities metrics, and formal assessment safety.
- Red-flag scan: no deferred-only steps; each task has files, checks, expected command output, and concrete rules.
- Type consistency: `QuestionSourceType`, `QuestionReviewStatus`, `QuestionGenerationJob`, `QuestionEvidence`, `QuestionQualityCheck`, and `StudentQuestionMastery` are consistently named across models, services, APIs, and tests.
