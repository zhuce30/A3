# A3 Dashboard Action-First Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `/a3/dashboard` around today's learning actions while eliminating content-driven grid overflow at desktop, tablet, and mobile widths.

**Architecture:** Keep all existing API calls, response types, data derivation, and routes in `DashboardView`. Recompose the existing dashboard sections into explicit action-first responsive grids, then harden both dashboard grid children and the shared `A3Card` root against CSS min-content expansion.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Vitest, Playwright.

---

### Task 1: Add a failing dashboard layout contract

**Files:**
- Create: `OpenMAIC/tests/a3-dashboard-action-layout.test.ts`
- Read: `OpenMAIC/components/a3/features/dashboard-view.tsx`
- Read: `OpenMAIC/components/a3/ui/a3-card.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const dashboard = readFileSync(join(root, 'components/a3/features/dashboard-view.tsx'), 'utf8');
const card = readFileSync(join(root, 'components/a3/ui/a3-card.tsx'), 'utf8');

describe('A3 dashboard action-first responsive layout', () => {
  it('puts todays actions before supporting dashboard content', () => {
    expect(dashboard).toContain('data-testid="a3-dashboard-action-zone"');
    expect(dashboard).toContain('data-testid="a3-dashboard-momentum-rail"');
    expect(dashboard).toContain('data-testid="a3-dashboard-path-profile-zone"');
  });

  it('uses zero-minimum grid tracks and cards', () => {
    expect(dashboard).toContain('xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]');
    expect(dashboard).not.toContain('xl:grid-cols-[1fr_1.05fr_1.35fr]');
    expect(card).toContain("'min-w-0 rounded-[14px]");
  });

  it('wraps real long task copy without expanding the page', () => {
    expect(dashboard).toContain('line-clamp-2 break-words');
    expect(dashboard).toContain('min-w-0 flex-1');
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-dashboard-action-layout.test.ts
```

Expected: FAIL because the action-zone test IDs, `minmax(0, ...)` tracks, shared-card `min-w-0`, and two-line task wrapping are not present.

- [ ] **Step 3: Commit the failing test only after the implementation batch is green**

The repository convention keeps the regression test and its small implementation in one reviewable commit. Do not commit a known-red branch state.

### Task 2: Implement the action-first dashboard composition

**Files:**
- Modify: `OpenMAIC/components/a3/features/dashboard-view.tsx`
- Modify: `OpenMAIC/components/a3/ui/a3-card.tsx`
- Test: `OpenMAIC/tests/a3-dashboard-action-layout.test.ts`

- [ ] **Step 1: Harden the shared card root**

Change the shared card base class to:

```tsx
'min-w-0 rounded-[14px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-[var(--a3-shadow)]'
```

- [ ] **Step 2: Replace the three-column motivation hero with an action-first zone**

Use an explicit zero-minimum grid:

```tsx
<div
  data-testid="a3-dashboard-action-zone"
  className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
>
  <TodayActionHub ... />
  <div data-testid="a3-dashboard-momentum-rail" className="grid min-w-0 gap-5">
    <LearningMomentum ... />
    <LearningBadgeSummary ... />
  </div>
</div>
```

`TodayActionHub` must render weekly progress, current action context, the three real tasks, and the existing study-plan CTA. It must consume the existing `tasks`, `motivation`, `planRelationship`, and `loading` values only.

- [ ] **Step 3: Put path and learner profile in a stable 2:1 grid**

```tsx
<div
  data-testid="a3-dashboard-path-profile-zone"
  className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]"
>
  <PathCard ... />
  <LearnerSnapshot ... />
</div>
```

Remove fixed `min-h-[326px]` from these cards unless it is required for content alignment.

- [ ] **Step 4: Harden the remaining support grids**

Replace every `xl:grid-cols-[1fr_1.05fr_1.35fr]` dashboard group with explicit zero-minimum tracks, for example:

```tsx
className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.35fr)]"
```

Add `min-w-0` to `CoachEntry` and other non-`A3Card` grid children.

- [ ] **Step 5: Replace single-line task truncation**

For `TodayActionHub` and `UpcomingTasks`, use:

```tsx
<div className="line-clamp-2 break-words text-sm font-semibold leading-5 text-[var(--a3-text)]">
  {task.title}
</div>
<div className="mt-1 line-clamp-2 break-words text-xs leading-5 text-[var(--a3-text-muted)]">
  {task.subtitle}
</div>
```

Keep status icons, counters, and CTA controls `shrink-0`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-dashboard-action-layout.test.ts tests/a3-dashboard-real-data-copy.test.ts tests/a3-today-sidebar-polish.test.ts
```

Expected: all files and tests pass; the existing real-data endpoint and copy assertions remain unchanged.

### Task 3: Verify responsive behavior and regressions

**Files:**
- Verify: `OpenMAIC/components/a3/features/dashboard-view.tsx`
- Verify: `OpenMAIC/components/a3/ui/a3-card.tsx`
- Verify: `OpenMAIC/tests/a3-dashboard-action-layout.test.ts`

- [ ] **Step 1: Run static validation**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: TypeScript exits `0`; lint reports no errors and only the warnings already allowed by `AGENTS.md`.

- [ ] **Step 2: Start the local frontend**

```powershell
cd OpenMAIC
pnpm.cmd dev -- --hostname 127.0.0.1 --port 3003
```

Expected: Next.js reports `http://127.0.0.1:3003` ready.

- [ ] **Step 3: Verify viewport overflow and screenshots with Playwright**

Check `/a3/dashboard` at `1920x1080`, `1440x1000`, `1024x900`, and `390x844`. For every viewport assert:

```ts
document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
```

Also verify the action zone appears before the path/profile zone, long task text stays inside its card, no card overlaps another card, and the mobile order starts with today's actions.

- [ ] **Step 4: Review the final diff**

```powershell
git diff --check
git diff --stat
git status --short --branch
```

Expected: only the planned dashboard, shared card, regression test, and implementation plan files are part of this feature; unrelated runtime and output files remain untouched.

- [ ] **Step 5: Commit the implementation**

```powershell
git add -- OpenMAIC/components/a3/features/dashboard-view.tsx OpenMAIC/components/a3/ui/a3-card.tsx OpenMAIC/tests/a3-dashboard-action-layout.test.ts docs/superpowers/plans/2026-07-19-a3-dashboard-action-first-layout-implementation.md
git commit -m "fix(a3): prioritize dashboard learning actions"
```
