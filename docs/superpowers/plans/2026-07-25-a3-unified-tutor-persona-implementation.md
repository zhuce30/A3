# A3 Unified Tutor Persona Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, persisted tutor-persona system whose selected teaching strategy and voice affect A3 text QA and realtime coaching, while reusing the existing VRM avatar and keeping Safety/Retriever/Verifier behavior unchanged.

**Architecture:** Django owns the canonical learner preference, validates persona IDs, injects a resolved server-side persona into the QA workflow, and snapshots the public persona on `CoachingSession.metadata`. Next.js owns provider-specific realtime mapping, but resolves it only from the persona snapshot stored in the authenticated Django session. A shared client hook and compact segmented selector expose the same preference in face-to-face coaching and the A3 classroom.

**Tech Stack:** Django 5, Python unittest/Django TestCase, Next.js 15, React 19, TypeScript, Vitest, Three.js/VRM, OpenAI Realtime WebRTC, DashScope Realtime WebSocket proxy.

---

## File Map

**Backend persona domain**

- Create `backend/apps/learning/tutor_personas.py`: private persona policies, public serialization, validation, default resolution and profile preference persistence.
- Modify `backend/apps/profiles/views.py`: authenticated GET/PATCH preference endpoint.
- Modify `backend/apps/profiles/urls.py`: route `tutor-preference/`.
- Test `backend/apps/profiles/tests/test_tutor_preferences.py`.

**Backend QA and coaching session**

- Modify `backend/apps/compat/views.py`: parse `persona_id`, resolve it, pass it into QA workflow, return public snapshot.
- Modify `backend/apps/compat/agent_kernel.py`: TeacherAgent consumes only resolved server persona.
- Modify `backend/apps/compat/llm.py`: add controlled teaching-style instruction layer.
- Modify `backend/apps/learning/services.py`: persist persona snapshot in coaching session metadata and create a new active session when a populated session changes persona.
- Modify `backend/apps/learning/views.py`: accept `tutorPersonaId` when appending messages.
- Test `backend/apps/compat/tests/test_tutor_persona_qa.py`.
- Test `backend/apps/learning/tests/test_coaching_tutor_persona.py`.

**Realtime server and proxy**

- Create `OpenMAIC/lib/a3/tutor-persona-types.ts`: public API contracts.
- Create `OpenMAIC/lib/server/a3-tutor-persona-runtime.ts`: allowlisted provider instructions and voice mapping.
- Modify `OpenMAIC/lib/a3/realtime-coaching-types.ts`: resolved persona in session contract.
- Modify `OpenMAIC/app/api/a3/coaching/realtime/session/route.ts`: accept persona, persist snapshot, build provider session from resolved persona.
- Modify `OpenMAIC/lib/server/a3-realtime-provider.ts`, `a3-openai-realtime.ts`, `a3-dashscope-realtime.ts`, `a3-realtime-sdp.ts`: bind instructions and voice.
- Modify `OpenMAIC/app/api/a3/coaching/realtime/sdp/route.ts`: resolve authenticated session snapshot before SDP exchange.
- Modify `OpenMAIC/scripts/a3-dashscope-realtime-proxy.mjs`: resolve authenticated coaching session before `session.update`.
- Test `OpenMAIC/tests/a3-tutor-persona-runtime.test.ts`.
- Test `OpenMAIC/tests/a3-realtime-coaching-contract.test.ts`.

**Frontend preference and pages**

- Create `OpenMAIC/components/a3/features/tutor-persona/use-tutor-persona.ts`: load, select, persist, error state.
- Create `OpenMAIC/components/a3/features/tutor-persona/tutor-persona-selector.tsx`: compact segmented selector with loading/error states.
- Modify `OpenMAIC/components/a3/features/coaching-view.tsx`: one shared preference for realtime and text coaching.
- Modify `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx` and `use-realtime-coaching.ts`: pass persona into realtime session.
- Modify `OpenMAIC/components/a3/features/classroom-view-redesign.tsx`: compact selector and persona-aware QA request.
- Modify `OpenMAIC/app/api/a3/coaching/respond/route.ts`: forward validated `personaId` to Django and return resolved persona.
- Test `OpenMAIC/tests/a3-tutor-persona-selector.test.ts`.
- Test `OpenMAIC/tests/a3-tutor-persona-page-integration.test.ts`.

### Task 1: Backend Persona Catalog And Preference

- [ ] **Step 1: Write failing preference tests**

Create `backend/apps/profiles/tests/test_tutor_preferences.py` covering authenticated GET, PATCH, invalid ID, profile JSON preservation, and profile-based default selection. Assert that public responses never contain `systemInstruction` or provider voice internals.

- [ ] **Step 2: Verify RED**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_tutor_preferences -v 2
```

Expected: FAIL because `/api/profiles/tutor-preference/` does not exist.

- [ ] **Step 3: Implement the catalog and endpoint**

Create four immutable personas: `structured-teacher`, `socratic-guide`, `practice-coach`, `foundation-coach`. Store private `instruction` and provider voices only in the server catalog. Public serialization returns:

```python
{
    "id": persona["id"],
    "name": persona["name"],
    "shortDescription": persona["shortDescription"],
    "teachingStyle": persona["teachingStyle"],
    "avatarAssetId": persona["avatarAssetId"],
    "voiceProfileId": persona["voiceProfileId"],
    "allowedWorkflows": list(persona["allowedWorkflows"]),
    "schemaVersion": "a3.tutor-persona.v1",
}
```

PATCH accepts only `{ "personaId": "..." }`, validates `coaching` or `classroom` availability, preserves unrelated `extra_profile`, and writes:

```python
extra_profile["tutorPreference"] = {
    "personaId": resolved["id"],
    "updatedAt": timezone.now().isoformat(),
    "schemaVersion": "a3.tutor-preference.v1",
}
```

- [ ] **Step 4: Verify GREEN**

Run the Task 1 test command and `backend\.venv\Scripts\python.exe backend\manage.py check`.

### Task 2: Persona-Aware QA Workflow

- [ ] **Step 1: Write failing QA tests**

Create `backend/apps/compat/tests/test_tutor_persona_qa.py` that patches `chat_completion`, asks the same grounded question with two persona IDs, and asserts the system messages contain distinct controlled strategy instructions. Also assert unknown IDs return HTTP 400 and all successful outputs still contain verifier/safety fields.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_tutor_persona_qa -v 2
```

Expected: FAIL because `qa_interact` ignores `persona_id`.

- [ ] **Step 3: Implement resolved persona injection**

Resolve `persona_id` in `qa_interact`; do not pass raw client text into the kernel. Add `tutorPersona` to the payload. `TeacherAgent` passes it to:

```python
generate_tutoring_answer(question, target=target, sources=sources, tutor_persona=tutor_persona)
```

The LLM system message appends only `tutor_persona["instruction"]` from the server catalog. Preserve the existing base safety, grounding, Markdown, citation and continuation instructions. Return only `public_tutor_persona()` in `resolvedPersona` and trace evidence.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 tests plus existing `backend.apps.compat.tests.test_llm_prompt` and `backend.apps.compat.tests.test_agent_runtime`.

### Task 3: Coaching Session Persona Snapshot

- [ ] **Step 1: Write failing session tests**

Create `backend/apps/learning/tests/test_coaching_tutor_persona.py` covering snapshot persistence, serialization, unknown persona rejection, idempotent reuse, and automatic end/new-session behavior when a populated active session changes persona.

- [ ] **Step 2: Verify RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_tutor_persona -v 2
```

- [ ] **Step 3: Implement session binding**

Extend `append_coaching_messages(..., tutor_persona_id="")`. Resolve the persona server-side. If an active session already has a different persona and contains a user message, end it and create a new session. Save only the public snapshot under `metadata["tutorPersona"]`. Include `tutorPersona` in session detail and row serialization.

- [ ] **Step 4: Verify GREEN**

Run Task 3 tests and existing learning coaching tests discovered with:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests -v 1
```

### Task 4: Realtime Instructions And Voice

- [ ] **Step 1: Write failing runtime contract tests**

Create `OpenMAIC/tests/a3-tutor-persona-runtime.test.ts` covering runtime allowlisting, unknown-ID fallback, OpenAI session instructions/voice, DashScope connection URL session binding, and public/private separation. Extend the existing realtime contract test to require `coachingSessionId` during SDP exchange.

- [ ] **Step 2: Verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-runtime.test.ts tests/a3-realtime-coaching-contract.test.ts
```

- [ ] **Step 3: Implement provider binding**

`createA3RealtimeSession` receives a resolved public persona and maps its ID through the private Next allowlist. OpenAI `sessionConfig` includes:

```ts
{
  type: 'realtime',
  model,
  instructions: runtime.instructions(targetTitle),
  audio: { output: { voice: runtime.openaiVoice } },
}
```

DashScope returns a connection URL containing only `coachingSessionId`. The proxy authenticates the cookie, fetches `/api/learning/coaching/sessions/<id>/`, verifies ownership through Django, resolves the saved persona ID through its local allowlist, then sets `instructions` and `voice` in `session.update`. Unknown or missing snapshots use `structured-teacher` and record the fallback.

The SDP route similarly fetches the authenticated coaching session and derives runtime config from its saved snapshot rather than trusting browser instructions or voice.

- [ ] **Step 4: Verify GREEN**

Run Task 4 tests and `node --check OpenMAIC/scripts/a3-dashscope-realtime-proxy.mjs`.

### Task 5: Shared Tutor Persona Selector

- [ ] **Step 1: Write failing component tests**

Create `OpenMAIC/tests/a3-tutor-persona-selector.test.ts` covering loading, four options, selected state, recommended marker, PATCH success, error recovery, and no exposure of private instructions.

- [ ] **Step 2: Verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-selector.test.ts
```

- [ ] **Step 3: Implement shared hook and selector**

The hook calls `GET /api/profiles/tutor-preference/` and `PATCH /api/profiles/tutor-preference/`. The selector is a compact segmented control, uses Lucide icons, has stable dimensions, and displays only name plus one short description. It must provide loading, saving, error and retry states without adding nested decorative cards.

- [ ] **Step 4: Verify GREEN**

Run Task 5 tests and `npx.cmd tsc --noEmit`.

### Task 6: Coaching And Classroom Integration

- [ ] **Step 1: Write failing integration tests**

Create `OpenMAIC/tests/a3-tutor-persona-page-integration.test.ts` asserting:

- coaching renders the selector once and passes the same selected ID to realtime and text QA;
- realtime session request body contains `personaId`;
- classroom renders the compact selector and sends `personaId` with `/api/a3/coaching/respond`;
- the respond route forwards `persona_id` and returns `resolvedPersona`;
- no page renders more than one digital-human Canvas.

- [ ] **Step 2: Verify RED**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-tutor-persona-page-integration.test.ts
```

- [ ] **Step 3: Implement page wiring**

Use one `useTutorPersona()` instance in `CoachingView`, render the selector before `RealtimeCoachingCall`, and pass `selectedPersonaId` into both realtime and text workspaces. In the classroom header, render the compact selector without adding the full VRM stage. Add `personaId` to all classroom and coaching text QA requests.

The realtime session route persists the selected persona through the Django coaching-session POST before creating provider state. The browser receives `resolvedPersona` for display but never receives private provider instructions.

- [ ] **Step 4: Verify GREEN**

Run Task 6 tests, all tutor/realtime tests, and TypeScript checking.

### Task 7: Regression And Documentation Verification

- [ ] **Step 1: Run focused frontend regression**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.ts tests/a3-digital-human-runtime.test.ts tests/a3-coaching-digital-human-integration.test.ts tests/a3-realtime-coaching-contract.test.ts tests/a3-tutor-persona-runtime.test.ts tests/a3-tutor-persona-selector.test.ts tests/a3-tutor-persona-page-integration.test.ts
npx.cmd tsc --noEmit
```

- [ ] **Step 2: Run focused backend regression**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_tutor_preferences backend.apps.compat.tests.test_tutor_persona_qa backend.apps.learning.tests.test_coaching_tutor_persona -v 2
backend\.venv\Scripts\python.exe backend\manage.py check
```

- [ ] **Step 3: Run broader project validation**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
cd OpenMAIC
pnpm.cmd lint
```

Record pre-existing allowed warnings separately; do not classify new warnings as historical.

- [ ] **Step 4: Reconcile documentation**

Update `docs/数字人.md` implementation-status statements to identify completed P0/P1/P2 items and retain P3/P4 as future work. Do not claim multiple VRM models or photorealistic digital humans.
