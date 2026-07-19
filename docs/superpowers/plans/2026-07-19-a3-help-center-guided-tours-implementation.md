# A3 Help Center and Guided Tours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `/a3/help` into a searchable screenshot-rich manual and add durable, restartable 3-5 step tours for profile setup, admission diagnostic, today/plan, resource generation, and knowledge-base indexing.

**Architecture:** Keep help content and tour definitions as typed frontend data. Render the help center and article routes independently from the marketing homepage, publish sanitized screenshots under `public/a3/help`, and mount one tour provider around the A3 shell so both onboarding and authenticated pages can participate. Persist only completion metadata in localStorage, namespaced by user, tour, and version.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind CSS, Lucide, Sharp, Vitest, Playwright.

---

## File Map

- Modify: `OpenMAIC/lib/a3/help-content.ts` - categories, structured articles, search, route allowlist.
- Create: `OpenMAIC/components/a3/features/help/help-layout.tsx` - standalone help header and responsive local navigation.
- Create: `OpenMAIC/components/a3/features/help/help-article-view.tsx` - article content, CTA, screenshot, TOC.
- Create: `OpenMAIC/components/a3/features/help/help-screenshot.tsx` - accessible image enlargement.
- Modify: `OpenMAIC/components/a3/features/help-center-view.tsx` - task-first landing layout.
- Create: `OpenMAIC/app/a3/help/[articleId]/page.tsx` - article route.
- Modify: `OpenMAIC/app/a3/help/page.tsx` - standalone help layout.
- Modify: `OpenMAIC/lib/a3/auth-navigation.ts` - public help-prefix recognition.
- Modify: `OpenMAIC/components/a3/auth/a3-auth-gate.tsx` - use path predicate.
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx` - bypass standalone help and add sidebar help entry.
- Modify: `OpenMAIC/components/a3/layout/a3-top-actions.tsx` - link search results to articles and expose current-page tour restart.
- Create: `OpenMAIC/lib/a3/guided-tour.ts` - definitions, storage keys, route matching, missing-anchor helpers.
- Create: `OpenMAIC/components/a3/guided-tour/guided-tour-provider.tsx` - lifecycle and query-param restart.
- Create: `OpenMAIC/components/a3/guided-tour/guided-tour-overlay.tsx` - accessible overlay and responsive placement.
- Modify: `OpenMAIC/app/a3/layout.tsx` - mount provider inside auth context and outside shell bypass.
- Modify: five target feature files - add stable `data-tour-id` anchors.
- Create: `OpenMAIC/tests/a3-help-content.test.ts` and `OpenMAIC/tests/a3-guided-tour.test.ts`.
- Create: `OpenMAIC/tests/a3-auth-navigation.test.ts` - public help-prefix and protected workflow routing.
- Create: `OpenMAIC/e2e/tests/a3-help-and-guided-tour.spec.ts`.

### Task 1: Expand the typed help-content contract

- [ ] **Step 1: Write failing content tests**

Create `OpenMAIC/tests/a3-help-content.test.ts` with assertions for ten categories, article lookup, keyword/error search, valid A3 CTA routes, and five tour-linked articles:

```ts
expect(a3HelpCategories).toHaveLength(10);
expect(getA3HelpArticle('generate-personal-resources')?.tourId).toBe('resource-generation');
expect(searchA3HelpArticles('一直解析中', 'zh-CN').map((item) => item.id))
  .toContain('knowledge-base-indexing');
expect(a3HelpArticles.every((item) => !item.action || item.action.href.startsWith('/a3/'))).toBe(true);
```

- [ ] **Step 2: Run the test and verify failure**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-help-content.test.ts
```

Expected: FAIL because categories, article lookup, sections, action, and tour fields do not exist.

- [ ] **Step 3: Replace the flat article type with structured types**

Implement in `lib/a3/help-content.ts`:

```ts
export type A3HelpCategoryId =
  | 'quick-start' | 'account-profile' | 'today-plan' | 'ai-learning'
  | 'resources-favorites' | 'assessment-review' | 'report-notifications'
  | 'teacher' | 'knowledge-base' | 'troubleshooting';

export type A3HelpArticle = {
  id: string;
  categoryId: A3HelpCategoryId;
  title: Record<A3Locale, string>;
  summary: Record<A3Locale, string>;
  audience: Array<'student' | 'teacher' | 'admin'>;
  keywords: string[];
  estimatedMinutes: number;
  updatedAt: string;
  prerequisites: Record<A3Locale, string[]>;
  sections: Array<{
    id: string;
    title: Record<A3Locale, string>;
    paragraphs?: Record<A3Locale, string[]>;
    steps?: Record<A3Locale, string[]>;
    screenshot?: { src: string; alt: Record<A3Locale, string>; markers?: Array<{ label: string; x: number; y: number }> };
    tone?: 'default' | 'warning' | 'success';
  }>;
  action?: { label: Record<A3Locale, string>; href: string };
  tourId?: string;
};
```

Add `a3HelpCategories`, `getA3HelpArticle`, `searchA3HelpArticles`, and `getA3HelpArticleHref(id)` returning `/a3/help/${id}`.

- [ ] **Step 4: Populate the initial complete article set**

Preserve the six existing topics, add articles for today/plan, resource generation/records/favorites, report/notifications, teacher intervention, and parsing failures. Every category must have at least one article; the five tour articles must include prerequisites, numbered steps, expected result, troubleshooting, action, and `tourId`.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm.cmd vitest run tests/a3-help-content.test.ts
git add OpenMAIC/lib/a3/help-content.ts OpenMAIC/tests/a3-help-content.test.ts
git commit -m "feat(a3): structure searchable help content"
```

Expected: PASS.

### Task 2: Build the standalone help landing and navigation entry

- [ ] **Step 1: Add failing source, markup, and auth-routing tests**

Extend `a3-help-content.test.ts` to server-render `HelpCenterView` and assert a search input, three quick-start links, category navigation, article-detail links, no nested article step dump, and a useful no-result reset action.

Create `tests/a3-auth-navigation.test.ts` with these route contracts:

```ts
expect(isA3PublicPath('/a3')).toBe(true);
expect(isA3PublicPath('/a3/help')).toBe(true);
expect(isA3PublicPath('/a3/help/generate-personal-resources')).toBe(true);
expect(isA3PublicPath('/a3/today')).toBe(false);
expect(getA3AuthTarget('/a3/today', null)).toBe('/a3/login?next=%2Fa3%2Ftoday');
```

Run both tests before implementation and expect failure because `isA3PublicPath` and the new help markup do not exist yet.

- [ ] **Step 2: Make `/a3/help` and descendants standalone public paths**

Add to `auth-navigation.ts`:

```ts
export function isA3PublicPath(pathname: string) {
  return A3_PUBLIC_PATHS.has(pathname) || pathname === '/a3/help' || pathname.startsWith('/a3/help/');
}
```

Use this predicate in `A3AuthGate` and `A3Shell`. Help routes must bypass the learning shell and render their own help header; `/a3` remains the separate marketing homepage.

- [ ] **Step 3: Create the shared help layout**

Create `components/a3/features/help/help-layout.tsx` with brand link, search affordance, “返回学习区”, and optional desktop category rail. On mobile, open categories from a Lucide `Menu` button into a dialog/drawer with focus management.

- [ ] **Step 4: Refactor `HelpCenterView`**

Use an unframed task-first layout:

```tsx
<HelpLayout activeCategory={category} onCategoryChange={setCategory}>
  <header>...</header>
  <HelpSearch value={query} onChange={setQuery} />
  <nav aria-label="快速开始">...</nav>
  <section aria-live="polite">{articles.map(renderArticleRow)}</section>
</HelpLayout>
```

Rows link to `/a3/help/[articleId]`; workflow CTAs remain inside article pages.

- [ ] **Step 5: Add the stable shell entry and update top help results**

Add a `CircleHelp` link immediately above the fixed user card in `a3-shell.tsx`, with collapsed and expanded labels. Change top-help search results to article detail URLs via `getA3HelpArticleHref(article.id)`.

- [ ] **Step 6: Run focused tests and commit**

```powershell
pnpm.cmd vitest run tests/a3-help-content.test.ts tests/a3-auth-navigation.test.ts
git add OpenMAIC/app/a3/help/page.tsx OpenMAIC/components/a3/features/help-center-view.tsx OpenMAIC/components/a3/features/help OpenMAIC/components/a3/auth/a3-auth-gate.tsx OpenMAIC/components/a3/layout/a3-shell.tsx OpenMAIC/components/a3/layout/a3-top-actions.tsx OpenMAIC/lib/a3/auth-navigation.ts OpenMAIC/tests
git commit -m "feat(a3): upgrade standalone help center"
```

Expected: PASS.

### Task 3: Add article detail pages and real screenshots

- [ ] **Step 1: Add failing article-route tests**

Assert known IDs render title, prerequisites, sections, screenshot alt text, action route, and optional tour replay; unknown IDs call the not-found boundary.

- [ ] **Step 2: Publish five optimized help screenshots**

Convert these sources with Sharp to `OpenMAIC/public/a3/help/`:

```js
{
  '画像构建.png': 'profile-setup.webp',
  '入学诊断.png': 'admission-diagnostic.webp',
  '今日任务.png': 'today-plan.webp',
  '资源推荐1.png': 'resource-generation.webp',
  '系统资料.png': 'knowledge-base.webp',
}
```

Use WebP quality 82 and verify every image is decodable, at least 640x360, nonblank, and contains no source-document files in the public directory.

- [ ] **Step 3: Create the dynamic article route**

Implement `app/a3/help/[articleId]/page.tsx`:

```tsx
export default async function A3HelpArticlePage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  const article = getA3HelpArticle(articleId);
  if (!article) notFound();
  return <HelpArticleView article={article} />;
}
```

- [ ] **Step 4: Implement article rendering and screenshot enlargement**

`HelpArticleView` renders breadcrumbs, metadata, prerequisites, sections, markers, warning/success bands, action, and tour restart. `HelpScreenshot` uses `next/image`, a real button, `Dialog` semantics, Escape close, and focus return. Marker positions are percentages from typed content data.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm.cmd vitest run tests/a3-help-content.test.ts
git add OpenMAIC/app/a3/help OpenMAIC/components/a3/features/help OpenMAIC/public/a3/help OpenMAIC/tests/a3-help-content.test.ts
git commit -m "feat(a3): add screenshot-rich help articles"
```

Expected: PASS.

### Task 4: Implement the guided-tour core test-first

- [ ] **Step 1: Write failing pure-function tests**

Create `tests/a3-guided-tour.test.ts`:

```ts
expect(buildA3TourStorageKey('user-1', 'profile-setup', 1))
  .toBe('a3-tour:user-1:profile-setup:1');
expect(getA3TourForRoute('/a3/recommendations')?.id).toBe('resource-generation');
expect(resolveA3TourSteps(steps, (selector) => selector !== '[data-tour-id="missing"]'))
  .toHaveLength(steps.length - 1);
```

Also test role filtering, query-param replay, completion/dismissal parsing, malformed localStorage values, and all-anchors-missing fallback.

- [ ] **Step 2: Run and verify failure**

```powershell
pnpm.cmd vitest run tests/a3-guided-tour.test.ts
```

Expected: FAIL because `lib/a3/guided-tour.ts` does not exist.

- [ ] **Step 3: Implement typed tour definitions and storage helpers**

Create the five approved tours with version `1`, exact routes, roles, 3-5 steps, stable selectors, Chinese/English text, and placement. Export only pure route, storage, and step-resolution functions from `lib/a3/guided-tour.ts`.

- [ ] **Step 4: Implement overlay and provider**

Mount in `app/a3/layout.tsx`:

```tsx
<A3AuthGate>
  <A3GuidedTourProvider>
    <A3Shell>{children}</A3Shell>
  </A3GuidedTourProvider>
</A3AuthGate>
```

The provider waits a bounded period for the first visible anchor, skips missing later anchors, suppresses automatic opening during active form/upload/generation states, and honors `?tour=<id>` for replay. The overlay uses `createPortal`, fixed highlight geometry, focus trapping, Escape, previous/next/skip/complete, mobile bottom-sheet fallback, resize/scroll repositioning, and reduced-motion behavior.

- [ ] **Step 5: Run tests and commit**

```powershell
pnpm.cmd vitest run tests/a3-guided-tour.test.ts
git add OpenMAIC/app/a3/layout.tsx OpenMAIC/lib/a3/guided-tour.ts OpenMAIC/components/a3/guided-tour OpenMAIC/tests/a3-guided-tour.test.ts
git commit -m "feat(a3): add durable guided tour framework"
```

Expected: PASS.

### Task 5: Add five workflow anchors without changing business calls

- [ ] **Step 1: Add anchor contract tests**

Read the five target sources and assert every selector referenced by `a3GuidedTours` appears exactly once or in the intended repeated scope. Assert no API endpoint strings or request payloads are changed.

- [ ] **Step 2: Add stable anchors**

Modify only wrapper elements or existing controls:

- `components/a3/auth/a3-auth-pages.tsx`: profile introduction, interview, manual form, save/continue.
- `components/a3/features/admission-diagnostic-view.tsx`: purpose, question area, progress, submit/result.
- `components/a3/features/today-learning-view.tsx`: daily prescription, next action, task list, plan relationship.
- `components/a3/features/recommendations-view.tsx`: context summary, need input, resource type selector, generation/records actions.
- `components/a3/features/knowledge-base-view.tsx`: upload, parsing status, resource list, search/retry.

Example:

```tsx
<section data-tour-id="resource-generation-context">...</section>
```

Do not rename props, move API hooks, or alter request/response handling.

- [ ] **Step 3: Add current-page restart to the top help panel**

When a route has a configured tour, show a button/link labeled “重新查看本页引导” that dispatches the provider start event or navigates with the `tour` query. Do not render it on unsupported routes.

- [ ] **Step 4: Run compatibility tests and commit**

```powershell
pnpm.cmd vitest run tests/a3-guided-tour.test.ts tests/a3-profile-setup.test.ts tests/a3-recommendations-page-quality.test.ts tests/a3-knowledge-base-copy.test.ts tests/a3-today-sidebar-polish.test.ts
git add OpenMAIC/components/a3/auth/a3-auth-pages.tsx OpenMAIC/components/a3/features OpenMAIC/components/a3/layout/a3-top-actions.tsx OpenMAIC/tests/a3-guided-tour.test.ts
git commit -m "feat(a3): connect guided tours to learning workflows"
```

Expected: PASS and no backend contract changes.

### Task 6: End-to-end verification

- [ ] **Step 1: Create Playwright coverage**

Create `e2e/tests/a3-help-and-guided-tour.spec.ts` covering:

- public help landing search and category filtering;
- article detail screenshot enlargement and workflow CTA;
- student role only sees relevant content;
- first eligible visit opens the tour;
- complete/dismiss prevents automatic reopening;
- `?tour=` replays a completed tour;
- missing target closes safely without a stuck overlay;
- 390x844 uses the bottom-sheet presentation without overlap.

- [ ] **Step 2: Run full frontend verification**

```powershell
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-help-content.test.ts tests/a3-guided-tour.test.ts tests/a3-profile-setup.test.ts tests/a3-recommendations-page-quality.test.ts tests/a3-knowledge-base-copy.test.ts
npx.cmd playwright test e2e/tests/a3-help-and-guided-tour.spec.ts --project=chromium
```

Expected: exit 0; only historical warnings listed in `AGENTS.md` may remain.

- [ ] **Step 3: Verify no backend surface changed**

```powershell
git diff --name-only HEAD~6..HEAD | rg "^(backend/|OpenMAIC/app/api/)"
```

Expected: no output.

- [ ] **Step 4: Commit E2E coverage**

```powershell
git add OpenMAIC/e2e/tests/a3-help-and-guided-tour.spec.ts
git commit -m "test(a3): cover help center and guided tours"
```
