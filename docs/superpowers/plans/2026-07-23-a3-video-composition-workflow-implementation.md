# A3 Video Composition Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable server-side narration, WebVTT generation, and final MP4 composition to the existing persisted segmented-video workflow.

**Architecture:** Extend durable segment records with storyboard and audio metadata, add a one-to-one composition record, and route TTS/FFmpeg work to a dedicated single-concurrency Celery queue. A new authenticated composition page edits narration and controls explicit narration and compose steps through Next.js API proxies.

**Tech Stack:** Django 5, MySQL, Celery/Redis, Qwen DashScope TTS, FFmpeg/ffprobe, Next.js 15, React, TypeScript, Vitest, Docker Compose.

---

### Task 1: Persist storyboard and composition state

**Files:**
- Modify: `backend/apps/compat/models.py`
- Create: `backend/apps/compat/migrations/0008_video_composition_workflow.py`
- Create: `backend/apps/compat/tests/test_video_composition_models.py`

- [ ] Write failing tests that create multiple segments with `visual`, `narration`, `source_ids`, audio metadata and a one-to-one composition.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_video_composition_models --settings=backend.config.test_sqlite_settings` and confirm missing fields fail.
- [ ] Add segment fields and `VideoComposition` with unique playback UUID and state indexes.
- [ ] Generate migration `0008_video_composition_workflow` and verify existing rows receive unique UUID values through nullable/backfill/alter steps on MySQL-safe fields.
- [ ] Rerun the model tests and `makemigrations --check --dry-run`.

### Task 2: Implement VideoDirector validation

**Files:**
- Create: `backend/apps/compat/video_director.py`
- Modify: `backend/apps/compat/video_jobs.py`
- Modify: `OpenMAIC/app/api/a3/resources/openmaic-video/route.ts`
- Create: `backend/apps/compat/tests/test_video_director.py`

- [ ] Write failing tests for structured scene normalization, source ID deduplication, Chinese/English duration estimation and narration fit flags.
- [ ] Implement `estimate_narration_ms`, `direct_video_segments` and `validate_narration_fit` without calling an LLM during requests.
- [ ] Persist all structured fields in new and legacy-imported video jobs and expose them in job serialization.
- [ ] Pass `visual`, `narration`, `sourceIds` and duration from the generated resource script through the Next route.
- [ ] Rerun director and existing video job tests.

### Task 3: Implement cloud TTS and durable assets

**Files:**
- Create: `backend/apps/compat/video_tts.py`
- Create: `backend/apps/compat/video_composition_storage.py`
- Create: `backend/apps/compat/tests/test_video_tts.py`
- Create: `backend/apps/compat/tests/test_video_composition_storage.py`

- [ ] Write failing tests for server-only key resolution, Qwen payload, audio download validation, relative paths and path traversal rejection.
- [ ] Implement Qwen3 TTS Flash calls with configured key priority and bounded timeouts/download sizes.
- [ ] Implement WAV persistence, SHA-256, ffprobe duration, narration TXT and WebVTT generation.
- [ ] Implement authenticated range/file responses for audio, final MP4, TXT and VTT.
- [ ] Run the new storage and TTS tests with network calls mocked at the HTTP boundary.

### Task 4: Implement dedicated composition tasks

**Files:**
- Create: `backend/apps/compat/video_composition_tasks.py`
- Modify: `backend/apps/compat/tasks.py`
- Modify: `backend/config/settings.py`
- Modify: `backend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Create: `backend/apps/compat/tests/test_video_composition_tasks.py`
- Create: `backend/apps/compat/tests/test_video_worker_compose.py`

- [ ] Write failing tests for idempotent narration dispatch, preserving successful segment audio, isolated retry, VTT generation, compose preconditions and FFmpeg argument safety.
- [ ] Implement `generate_video_narration` and `compose_final_video` tasks routed to `video-compose`.
- [ ] Build per-segment normalized H.264/AAC files and concat the final MP4 using argument arrays, never a shell command.
- [ ] Install `ffmpeg` in the backend image and add `video-worker` with `--concurrency=1`, bounded memory and shared `a3-video-data`.
- [ ] Verify Compose merge and run task/compose tests.

### Task 5: Expose authenticated composition APIs

**Files:**
- Modify: `backend/apps/compat/views.py`
- Modify: `backend/apps/compat/urls.py`
- Modify: `backend/apps/compat/video_jobs.py`
- Create: `backend/apps/compat/tests/test_video_composition_api.py`

- [ ] Write failing API tests for ownership, GET state, PATCH narration/settings, generate narration, compose, stage retry and downloads.
- [ ] Implement transactional update/dispatch helpers and serializers.
- [ ] Reject narration generation when estimated narration exceeds its segment duration.
- [ ] Invalidate only edited segment audio and reset final output when source narration changes.
- [ ] Run API tests plus all existing durable video tests.

### Task 6: Build Next API proxy and composition page

**Files:**
- Create: `OpenMAIC/app/api/a3/resources/video-composition/route.ts`
- Create: `OpenMAIC/app/api/a3/resources/video-composition/[asset]/route.ts`
- Create: `OpenMAIC/app/a3/resources/[packId]/video/compose/page.tsx`
- Create: `OpenMAIC/components/a3/features/video-composition-view.tsx`
- Modify: `OpenMAIC/components/a3/features/resource-video-view.tsx`
- Create: `OpenMAIC/tests/a3-video-composition-api.test.ts`
- Create: `OpenMAIC/tests/a3-video-composition-page.test.ts`

- [ ] Write failing source-contract tests for authenticated proxying, four-stage progress, editable narration, voice/speed controls, audio preview, isolated retries and downloads.
- [ ] Implement same-origin Next proxy routes without exposing provider keys or storage paths.
- [ ] Implement the responsive workbench with stable two-column desktop layout and one-column mobile layout.
- [ ] Add the compose-workbench entry to the existing video page when a durable job exists.
- [ ] Run Vitest, TypeScript and targeted ESLint.

### Task 7: Full regression, publish, and production deployment

**Files:**
- Modify: `backend/.env.example`
- Modify: `README.md` or deployment documentation only where required for new variables and service.

- [ ] Run all video backend tests, `manage.py check`, migration check and strict demo validation.
- [ ] Run video frontend tests, TypeScript and targeted ESLint.
- [ ] Run `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` with required placeholder variables.
- [ ] Commit only intended files and push `codex/a3-latest-integration`.
- [ ] Wait for fixed-SHA backend/frontend images.
- [ ] Pull server Git and images, update `.env.production`, run migration, and recreate backend, celery, celery-beat, video-worker, frontend and caddy.
- [ ] Verify container health, worker queue/concurrency, shared volume, authenticated page, logs and public homepage.
