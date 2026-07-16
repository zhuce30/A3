# A3 Sidebar Navigation Affordance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grouped sidebar labels unambiguously expandable categories while preserving every existing page route as a visible child entry.

**Architecture:** Keep `a3NavItems` as the navigation source of truth, but add each group owner's route as its first child. `A3Shell` renders grouped items as accessible disclosure buttons and standalone items as links. Existing route-owner matching continues to identify and auto-open the active group.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Lucide React, Vitest, Playwright.

---

### Task 1: Lock the navigation information architecture

**Files:**
- Modify: `OpenMAIC/tests/a3-navigation-consolidation.test.ts`
- Modify: `OpenMAIC/lib/a3/navigation.ts`
- Modify: `OpenMAIC/lib/a3/i18n.ts`

- [ ] **Step 1: Write the failing navigation assertions**

Require each grouped item to expose its owner route as the first child with these labels: `今日任务`, `计划总览`, `练习中心`, `AI 课堂`, and `知识库首页`. Also require the shell source to render grouped parents as buttons rather than links.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd OpenMAIC && pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts`

Expected: FAIL because owner routes are absent from `children` and grouped parent markup is still a `Link`.

- [ ] **Step 3: Add owner children and localized labels**

Add the owner routes as first children in `a3NavItems`. Add these keys to both locales:

```ts
navTodayTasks: '今日任务' / 'Today Tasks'
navPlanOverview: '计划总览' / 'Plan Overview'
navPracticeCenter: '练习中心' / 'Practice Center'
navAiClassroom: 'AI 课堂' / 'AI Classroom'
navKnowledgeBaseHome: '知识库首页' / 'Knowledge Base Home'
```

- [ ] **Step 4: Run the focused test**

Run: `cd OpenMAIC && pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts`

Expected: navigation data assertions pass; shell disclosure assertion remains RED until Task 2.

### Task 2: Render accessible collapsible groups

**Files:**
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`
- Test: `OpenMAIC/tests/a3-navigation-consolidation.test.ts`

- [ ] **Step 1: Add disclosure state**

Initialize a `Set<string>` containing grouped navigation hrefs and add an effect that always opens `activeNavHref` when it owns children. Implement `toggleNavGroup(href)` without changing routes.

- [ ] **Step 2: Replace grouped parent links with buttons**

Render grouped parents as 44px buttons with `aria-expanded`, `aria-controls`, a Lucide chevron, and low-contrast active-owner styling. Keep standalone items such as `/a3/report` as `Link` elements with the existing selected-page treatment.

- [ ] **Step 3: Render owner routes as real child links**

Use localized direct-entry labels for the five owner routes. Apply the selected-page background only to the active child link and hide collapsed child containers with conditional rendering.

- [ ] **Step 4: Run focused tests and TypeScript**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts tests/a3-classroom-english-mode-coverage.test.ts
npx.cmd tsc --noEmit
```

Expected: all tests pass and TypeScript exits 0.

### Task 3: Verify sidebar behavior and presentation

**Files:**
- Test: `OpenMAIC/e2e/tests/a3-sidebar-navigation.spec.ts`

- [ ] **Step 1: Add an E2E disclosure test**

Verify the active group is expanded, clicking its button collapses and expands the child container, `/a3/report` remains a direct link, and selecting an owner child navigates to its unchanged route.

- [ ] **Step 2: Run Playwright at desktop width**

Run: `cd OpenMAIC && npx.cmd playwright test e2e/tests/a3-sidebar-navigation.spec.ts --project=chromium`

Expected: PASS at 1440x900 with no overlap or clipped labels.

- [ ] **Step 3: Run final frontend verification**

Run:

```powershell
cd OpenMAIC
pnpm.cmd lint
npx.cmd tsc --noEmit
pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts tests/a3-classroom-english-mode-coverage.test.ts tests/a3-global-search.test.ts
```

Expected: zero lint errors, only repository-approved historical warnings; TypeScript and tests pass.
