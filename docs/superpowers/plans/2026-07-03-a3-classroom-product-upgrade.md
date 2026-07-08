# A3 Classroom Product Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/a3/classroom` as a complete A3 learning classroom with real actions and stronger evidence display.

**Architecture:** Keep the existing `ClassroomView` data flow and backend contracts. Improve component composition, responsive layout, action states, and empty states inside `OpenMAIC/components/a3/features/classroom-view.tsx`.

**Tech Stack:** Next.js client component, React state, Tailwind utility classes, existing A3 cards/buttons, Django-backed A3 APIs.

---

### Task 1: Classroom Workbench Layout

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`

- [ ] Replace the sparse three-column grid with a responsive cockpit layout.
- [ ] Keep all current API calls unchanged.
- [ ] Add visible real-action empty states for OpenMAIC classroom, knowledge-base sources, and target-less classroom.
- [ ] Verify with `npx.cmd tsc --noEmit`.

### Task 2: Real Capability Controls

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`

- [ ] Keep quick prompts wired to `askQuestion`.
- [ ] Keep free-form input wired to `POST /api/a3/coaching/respond`.
- [ ] Keep assistant answers saved through `POST /api/engagement/favorites/create/`.
- [ ] Keep source favorites saved through `POST /api/engagement/favorites/create/`.
- [ ] Keep OpenMAIC classroom opening through artifact `classroomUrl`.

### Task 3: Verification

**Files:**
- Test existing app behavior.

- [ ] Run `npx.cmd tsc --noEmit`.
- [ ] Run `pnpm.cmd lint`.
- [ ] Use Playwright to open `/a3/classroom` and confirm `a3-classroom-view`, input, sources, and real route buttons render.
