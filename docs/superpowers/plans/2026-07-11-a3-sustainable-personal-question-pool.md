# A3 Sustainable Personal Question Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every student's practice pool supplied with evidence-grounded, quality-verified variants that avoid answered history without allowing unbounded database growth.

**Architecture:** Reuse `AssessmentAnswer` as the authoritative answered-question history. Add a per-user/per-knowledge-point sequence for concurrency-safe variant allocation and an archive timestamp on personal questions. Serve sessions synchronously from unseen questions, create the minimum missing variants immediately, then dispatch a Celery refill when the unseen personal pool falls below its watermark.

**Tech Stack:** Django ORM and migrations, Celery shared tasks, existing A3 question verifier, Django `TestCase`.

---

### Task 1: Persist variant sequencing and archive state

**Files:**
- Modify: `backend/apps/assessments/models.py`
- Create: `backend/apps/assessments/migrations/0004_personal_question_pool.py`
- Test: `backend/apps/assessments/tests/test_assessment_flow.py`

- [ ] Add `Question.archived_at` and a `PersonalQuestionSequence` model uniquely keyed by `user` and `knowledge_point` with `next_variant_index` starting at 1.
- [ ] Generate the migration and run `manage.py check`.

### Task 2: Exclude answered history and allocate persistent variants

**Files:**
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_assessment_flow.py`

- [ ] Write tests that complete one practice session and assert the next session contains no prior question IDs and uses larger `variantIndex` values.
- [ ] Run the tests and confirm they fail because current variants restart at 1 and reuse stems.
- [ ] Implement answered-ID exclusion plus transactionally reserved sequence ranges.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Generate dynamic grounded variants

**Files:**
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_assessment_flow.py`

- [ ] Write a failing test asserting later variants rotate scenario context, numeric parameter, distractor order, and primary source evidence while retaining `QuestionEvidence` and a passing `QuestionQualityCheck`.
- [ ] Build content context from persistent `variantIndex`, rotated neighboring points, and rotated knowledge blocks.
- [ ] Verify every active personal candidate is `auto_verified`; rejected candidates remain inactive.

### Task 4: Add low-watermark asynchronous refill

**Files:**
- Create: `backend/apps/assessments/tasks.py`
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_personal_question_pool.py`

- [ ] Write a failing test that answering below the low watermark dispatches `assessments.refill_personal_question_pool` after transaction commit.
- [ ] Implement the Celery task and a synchronous service returning generated, verified, rejected, and archived counts.
- [ ] Keep session creation synchronous for only the missing questions required by that request; use Celery for replenishing the reserve pool.

### Task 5: Enforce bounded retention and archive old variants

**Files:**
- Modify: `backend/apps/assessments/services.py`
- Test: `backend/apps/assessments/tests/test_personal_question_pool.py`

- [ ] Write a failing test with more than 40 personal variants and assert oldest answered variants are archived first while current-session and unseen variants remain active.
- [ ] Implement per-user/per-point maximum active pool enforcement with `archived_at`, `is_active=False`, and archive metadata.
- [ ] Exclude archived questions from student selection and teacher candidate review.

### Task 6: Regression verification

**Files:**
- Modify: `backend/apps/assessments/views.py` only if serialization needs pool audit fields.
- Test: existing assessments and teacher-review tests.

- [ ] Run assessment tests, Django check, strict demo validation, TypeScript, lint, and the teacher review frontend test.
- [ ] Inspect migration consistency and `git diff --check`.
