# Student Personal Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add student-owned personal knowledge bases so each student can upload course materials, have them parsed by a personal material agent, and receive individualized study plans, classroom answers, recommendations, and citations based on those materials.

**Architecture:** Convert A3 knowledge base access from a teacher-only upload surface into a scoped knowledge system with global, class/teacher, and personal resources. Retrieval must merge accessible scopes with priority order: student personal resources first, then class/teacher resources, then global corpus. A new PersonalMaterialAgent summarizes uploaded student resources, extracts knowledge points, updates profile weak points and preferences, and creates study-plan/recommendation evidence.

**Tech Stack:** Django models/views/tasks for knowledge resources and agent writeback, existing multimodal parser and DashScope visual embedding, Next.js A3 pages/components, existing A3 API client, Vitest/Playwright/frontend `tsc`, Django test runner and demo validation commands.

---

## File Structure

**Backend model/API**
- Modify: `backend/apps/knowledge_base/models.py`
  - Add `resource_scope`, `visibility`, `course_key`, and optional `student_profile_snapshot` fields to `KnowledgeResource`.
- Create: `backend/apps/knowledge_base/migrations/0005_resource_scope.py`
  - Data migration defaults existing uploaded resources to teacher scope and global corpus remains external/full-index.
- Modify: `backend/apps/knowledge_base/services.py`
  - Add scope-aware serializers, access helpers, upload policy, and personal-material writeback entry.
- Modify: `backend/apps/knowledge_base/views.py`
  - Allow student upload for `personal` scope, keep teacher upload for teacher/class scope, expose scope filters.
- Modify: `backend/apps/knowledge_base/tasks.py`
  - Trigger personal material analysis after student upload indexing succeeds.
- Modify: `backend/domains/knowledge_base/retriever.py`
  - Accept ordered source path groups and merge results with scope priority.
- Modify: `backend/domains/knowledge_base/visual_retriever.py`
  - Preserve scope metadata in visual index items.

**Personal material agent**
- Create: `backend/apps/knowledge_base/personal_agent.py`
  - Implement `PersonalMaterialAgent` with deterministic schema output and LLM/VLM-assisted summary hooks.
- Create: `backend/apps/knowledge_base/tests/test_personal_material_agent.py`
  - Unit tests for resource type inference, knowledge point extraction, and writeback payload shape.
- Modify: `backend/apps/profiles/models.py` or existing profile service file after inspection
  - Store material-derived weak points and learning preferences through existing profile update path.
- Modify: `backend/apps/learning/services.py` or existing study plan generator after inspection
  - Add material-derived plan tasks with source references.

**Frontend**
- Modify: `OpenMAIC/components/a3/features/knowledge-base-view.tsx`
  - Add tabs: `我的资料`, `教师资料`, `全局资料`.
  - Student users can upload only into `我的资料`.
  - Teacher users can upload into teacher/class scope.
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`
  - Citation labels show `我的资料`, `教师资料`, or `全局知识库`.
- Modify: `OpenMAIC/components/a3/features/study-plan-view.tsx`
  - Display material-derived plan tasks and source reason.
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx`
  - Show recommendations generated from student uploads.
- Add or update tests under `OpenMAIC/tests/` and `OpenMAIC/e2e/tests/`.

---

## Implementation Tasks

### Task 1: Add Knowledge Resource Scopes

**Files:**
- Modify: `backend/apps/knowledge_base/models.py`
- Create: `backend/apps/knowledge_base/migrations/0005_resource_scope.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing tests for scoped resources**

Add tests that create a student, teacher, and resources with `personal`, `teacher`, and `global` scopes. Assert student upload resources are scoped to the owner and teacher uploads remain visible to the teacher.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_resources.KnowledgeResourceTests --keepdb
```

Expected before implementation: fails because `resource_scope` does not exist.

- [ ] **Step 2: Add model choices and fields**

Implement fields:

```python
class ResourceScope(models.TextChoices):
    PERSONAL = "personal", "personal"
    TEACHER = "teacher", "teacher"
    CLASS = "class", "class"
    GLOBAL = "global", "global"
```

Add to `KnowledgeResource`:

```python
resource_scope = models.CharField(max_length=16, choices=ResourceScope.choices, default=ResourceScope.TEACHER)
course_key = models.CharField(max_length=128, blank=True)
visibility = models.CharField(max_length=32, default="owner")
student_profile_snapshot = models.JSONField(default=dict, blank=True)
```

- [ ] **Step 3: Create and run migration**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py makemigrations knowledge_base
backend\.venv\Scripts\python.exe backend\manage.py migrate
```

Expected: migration applies without data loss.

- [ ] **Step 4: Make tests pass**

Run the focused tests again. Expected: scoped model tests pass.

### Task 2: Scope-Aware Upload and Listing APIs

**Files:**
- Modify: `backend/apps/knowledge_base/services.py`
- Modify: `backend/apps/knowledge_base/views.py`
- Test: `backend/apps/knowledge_base/tests/test_resources.py`

- [ ] **Step 1: Write failing API tests**

Add tests:
- Student can `POST /api/kb/resources/upload/` and receives a `personal` resource.
- Student `GET /api/kb/resources/` sees only own personal resources plus allowed shared resources.
- Teacher cannot see another student's personal resource.
- Teacher upload defaults to `teacher` scope.

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_resources --keepdb
```

Expected before implementation: student upload returns permission error.

- [ ] **Step 2: Replace teacher-only upload guard with role-aware policy**

In `views.upload`, allow authenticated students. Determine scope:

```python
scope = "personal" if request.user.role == "student" else request.POST.get("scope", "teacher")
```

Reject students trying to upload non-personal scope with HTTP 403 and Chinese error.

- [ ] **Step 3: Update serialization**

Add fields to resource JSON:

```json
{
  "scope": "personal",
  "scopeLabel": "我的资料",
  "courseKey": "材料力学",
  "ownerId": "..."
}
```

- [ ] **Step 4: Make resource listing role-aware**

Student listing:
- own personal resources
- shared teacher/class resources if access exists

Teacher listing:
- own teacher/class resources
- no student personal resources unless explicit future sharing exists

- [ ] **Step 5: Run API tests**

Expected: role boundary tests pass.

### Task 3: PersonalMaterialAgent

**Files:**
- Create: `backend/apps/knowledge_base/personal_agent.py`
- Modify: `backend/apps/knowledge_base/tasks.py`
- Test: `backend/apps/knowledge_base/tests/test_personal_material_agent.py`

- [ ] **Step 1: Write failing agent tests**

Test schema:

```python
{
    "resourceId": "...",
    "materialType": "courseware|note|homework|wrong_question|textbook",
    "summary": "...",
    "knowledgePoints": ["..."],
    "weakPointSignals": ["..."],
    "recommendedTasks": [
        {"title": "...", "reason": "...", "sourceResourceId": "..."}
    ],
}
```

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_personal_material_agent --keepdb
```

Expected before implementation: module missing.

- [ ] **Step 2: Implement deterministic first version**

Use parsed `KnowledgeBlock` text, OCR text, file name, modality counts, and warnings to infer material type and knowledge points. Do not require LLM for test pass.

- [ ] **Step 3: Add LLM/VLM enhancement hook**

Use existing A3 LLM configuration only when available. If unavailable, return deterministic result with `degraded: true`.

- [ ] **Step 4: Trigger after successful student upload**

In upload indexing task, when `resource_scope == personal`, call:

```python
PersonalMaterialAgent().analyze_and_writeback(resource)
```

### Task 4: Profile and Study Plan Writeback

**Files:**
- Modify profile update service after inspecting existing profile code.
- Modify study plan generation service after inspecting existing learning code.
- Test: `backend/apps/learning/tests/` and `backend/apps/profiles/tests/` files matching existing patterns.

- [ ] **Step 1: Write failing writeback tests**

Assert student upload analysis:
- adds material-derived weak points to profile without deleting existing weak points
- creates or updates plan tasks tagged with `source: personal_material`
- stores citation metadata pointing to the resource id

- [ ] **Step 2: Implement profile merge**

Merge weak points by normalized text and cap material-derived additions to a small number per upload to avoid profile pollution.

- [ ] **Step 3: Implement study plan task injection**

Add tasks after current day's required tasks, not before diagnostic tasks. Task format must include source resource id and reason.

- [ ] **Step 4: Run demo validation**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: existing demo flow remains pass.

### Task 5: Scope-Prioritized Hybrid Retrieval

**Files:**
- Modify: `backend/apps/knowledge_base/services.py`
- Modify: `backend/apps/knowledge_base/views.py`
- Modify: `backend/domains/knowledge_base/retriever.py`
- Modify: `backend/domains/knowledge_base/visual_retriever.py`
- Test: `backend/apps/knowledge_base/tests/test_retriever_filters.py`

- [ ] **Step 1: Write failing retrieval tests**

Given same query with matching personal and teacher resources, assert result order prioritizes:

```text
personal -> teacher/class -> global
```

- [ ] **Step 2: Implement accessible path grouping**

Return grouped source paths:

```python
{
    "personal": {...},
    "teacher": {...},
    "global": {...}
}
```

- [ ] **Step 3: Merge results with scope boost**

Apply deterministic score boost:
- personal: `+0.15`
- teacher/class: `+0.08`
- global: `+0`

Keep original score in metadata.

- [ ] **Step 4: Preserve citation scope**

Each citation metadata includes:

```json
{
  "source_scope": "personal",
  "source_origin": "我的资料"
}
```

### Task 6: Student Knowledge Base UI

**Files:**
- Modify: `OpenMAIC/components/a3/features/knowledge-base-view.tsx`
- Test: add or update `OpenMAIC/tests/a3-knowledge-base-personal.test.ts`
- E2E: update `OpenMAIC/e2e/tests/a3-button-actions.spec.ts`

- [ ] **Step 1: Write failing UI source test**

Assert source contains:
- `我的资料`
- `教师资料`
- student upload enabled text
- scope labels in resource rows

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-knowledge-base-personal.test.ts
```

- [ ] **Step 2: Add tabs and upload copy**

Tabs:
- 我的资料
- 教师资料
- 全局资料

Student upload button copy:

```text
上传我的资料
```

Teacher upload button copy:

```text
上传教学资料
```

- [ ] **Step 3: Show analysis status**

Each personal resource row shows:
- parsed status
- personal agent status
- extracted knowledge points count
- plan writeback status

### Task 7: Classroom, Recommendations, and Plan Citation UX

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx`
- Modify: `OpenMAIC/components/a3/features/study-plan-view.tsx`
- Test: update existing classroom and recommendation tests.

- [ ] **Step 1: Write failing UI tests**

Assert citations display:
- `我的资料`
- `教师资料`
- `全局知识库`

- [ ] **Step 2: Add source scope badges**

Use existing `A3Pill`:
- personal: green, `我的资料`
- teacher/class: blue, `教师资料`
- global: slate, `全局知识库`

- [ ] **Step 3: Add personal-material plan callout**

Study plan tasks derived from student uploads show:

```text
来自你上传的资料：<resource name>
```

### Task 8: Verification and Acceptance

**Files:**
- Modify tests only unless failures require fixes.

- [ ] **Step 1: Backend verification**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests --keepdb
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

- [ ] **Step 2: Frontend verification**

Run:

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-classroom-citation-preview.test.ts
```

- [ ] **Step 3: Manual acceptance**

Use a student account:
1. Upload a PPTX to `我的资料`.
2. Confirm resource appears only for that student.
3. Confirm indexing finishes.
4. Ask AI 课堂 about the uploaded PPTX.
5. Confirm citations include `我的资料`.
6. Confirm study plan includes at least one material-derived task.

---

## Acceptance Criteria

- Students can upload PPTX/PDF/XLSX/image files as personal resources.
- Student personal resources are private by default.
- Teacher resources do not mix with student personal management lists.
- Retrieval prioritizes personal evidence over teacher/global evidence.
- Classroom citations clearly show source scope.
- PersonalMaterialAgent writes back at least summary, knowledge points, weak-point signals, and recommended tasks.
- Existing teacher upload, multimodal RAG, visual evidence preview, and demo validation remain working.

## Risks and Guardrails

- Do not expose local file paths or API keys in frontend payloads.
- Do not let students see another student's personal resources.
- Do not replace teacher/global retrieval. Personal retrieval is a scoped layer, not a new isolated-only mode.
- Do not mark agent writeback as successful unless it persists to profile/plan data.
- Keep OCR/VLM/embedding failures degraded but visible in resource warnings.

