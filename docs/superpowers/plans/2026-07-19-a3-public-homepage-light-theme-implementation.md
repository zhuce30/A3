# A3 Public Homepage Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public homepage's black visual system with the approved cream-and-forest-green theme and refresh every product screenshot from the current A3 interface materials.

**Architecture:** Preserve the existing server-component homepage structure, route model, story sequence, and public asset URLs. Use Sharp to regenerate the existing WebP asset names from approved screenshots, then convert the CSS module to page-level color tokens so every homepage section shares the same light visual system without changing authenticated A3 screens.

**Tech Stack:** Next.js 15, React 19, TypeScript, CSS Modules, Sharp, Vitest, Playwright.

---

## File Map

- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css` - homepage color tokens and light responsive styling.
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-hero.tsx` - semantic hero kicker/trust copy only if selectors need stable contracts.
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.tsx` - structured-data text only if existing text encoding or contrast hooks fail tests.
- Replace: `OpenMAIC/public/a3/assets/homepage/*.webp` - current real product screenshots under stable filenames.
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts` - light-theme and regenerated-asset contracts.
- Modify: `OpenMAIC/tests/a3-homepage-launch-baseline.test.ts` - approved CTA color and public visual boundary.
- Modify: `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts` - desktop/mobile visual and next-section visibility assertions.

### Task 1: Lock the light-theme contract with failing tests

- [ ] **Step 1: Add theme-token and no-black/no-blue-primary assertions**

Add to `OpenMAIC/tests/a3-homepage-content.test.ts`:

```ts
it('uses the approved cream and forest-green public theme', () => {
  expect(homepageCss).toContain('--a3-home-cream: #fff8d8');
  expect(homepageCss).toContain('--a3-home-action: #245c48');
  expect(homepageCss).toContain('--a3-home-ink: #18231f');
  expect(homepageCss).not.toMatch(/\.page\s*\{[^}]*background:\s*#0b0e10/);
  expect(homepageCss).not.toMatch(/\.(?:headerCta|primaryCta)\s*\{[^}]*background:\s*#(?:2563eb|3b82f6)/i);
});

it('keeps dark renderer surfaces local instead of making them page bands', () => {
  expect(homepageCss).toMatch(/\.teacherVisual\s*\{[^}]*background:/);
  expect(homepageCss).not.toMatch(/\.(?:page|story|knowledgeBand|foundationBand|feedbackBand)\s*\{[^}]*background:\s*#0[0-9a-f]{5}/i);
});
```

- [ ] **Step 2: Add screenshot-source asset assertions**

Extend the asset test so every stable WebP is decoded and its modification is represented by current screenshot dimensions, while preserving the existing filename list:

```ts
expect(A3_HOMEPAGE_HERO_MEDIA[0]?.src).toBe('/a3/assets/homepage/today-plan.webp');
expect(A3_HOMEPAGE_STORY.find((item) => item.id === 'progress-refresh')?.media)
  .toBe('/a3/assets/homepage/progress-refresh.webp');
```

- [ ] **Step 3: Run the focused tests and verify failure**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-launch-baseline.test.ts
```

Expected: FAIL because the CSS still declares the black page background and does not expose the approved color tokens.

- [ ] **Step 4: Commit the failing contract**

```powershell
git add OpenMAIC/tests/a3-homepage-content.test.ts OpenMAIC/tests/a3-homepage-launch-baseline.test.ts
git commit -m "test(a3): define light homepage visual contract"
```

### Task 2: Regenerate homepage screenshots from current product materials

- [ ] **Step 1: Define the stable source-to-output mapping**

Use this exact mapping without changing public URLs:

```js
const files = {
  '今日任务.png': 'today-plan.webp',
  '画像构建.png': 'profile.webp',
  '入学诊断.png': 'diagnostic.webp',
  '系统资料.png': 'knowledge-base.webp',
  '资源推荐1.png': 'multimodal-resources.webp',
  'AI课堂1.png': 'classroom.webp',
  '错题本.png': 'assessment-review.webp',
  '学习报告1.png': 'progress-refresh.webp',
  '教师工作台1.png': 'teacher-workbench.webp',
  '面对面.png': 'teacher-fallback.webp',
};
```

- [ ] **Step 2: Convert source PNG files to optimized WebP files**

Run from `OpenMAIC` with the installed Sharp dependency:

```powershell
node -e "const sharp=require('sharp');const path=require('path');const src=path.resolve('..','PPT背景','页面截图材料');const out=path.resolve('public','a3','assets','homepage');const files={'今日任务.png':'today-plan.webp','画像构建.png':'profile.webp','入学诊断.png':'diagnostic.webp','系统资料.png':'knowledge-base.webp','资源推荐1.png':'multimodal-resources.webp','AI课堂1.png':'classroom.webp','错题本.png':'assessment-review.webp','学习报告1.png':'progress-refresh.webp','教师工作台1.png':'teacher-workbench.webp','面对面.png':'teacher-fallback.webp'};Promise.all(Object.entries(files).map(([a,b])=>sharp(path.join(src,a)).webp({quality:82,effort:5}).toFile(path.join(out,b)))).then(()=>console.log('homepage assets updated'))"
```

Expected: `homepage assets updated`; ten existing WebP files are replaced, each remains larger than 10 KB and decodable.

- [ ] **Step 3: Run asset tests**

```powershell
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
```

Expected: asset decode, size, dimensions, nonblank, and private-path checks PASS; theme checks still FAIL.

- [ ] **Step 4: Commit only the ten generated assets**

```powershell
git add OpenMAIC/public/a3/assets/homepage
git commit -m "assets(a3): refresh homepage product screenshots"
```

### Task 3: Convert the homepage CSS to the approved light system

- [ ] **Step 1: Add page-level tokens to `.page`**

Replace the dark root declaration in `a3-product-homepage.module.css` with:

```css
.page {
  --a3-home-cream: #fff8d8;
  --a3-home-action: #245c48;
  --a3-home-action-hover: #1d4b3b;
  --a3-home-ink: #18231f;
  --a3-home-muted: #59655f;
  --a3-home-line: rgb(24 35 31 / 14%);
  --a3-home-soft: #f3f7f4;
  --a3-home-surface: #ffffff;
  min-height: 100vh;
  overflow-x: clip;
  background: var(--a3-home-surface);
  color: var(--a3-home-ink);
  scroll-behavior: smooth;
}
```

- [ ] **Step 2: Update navigation and actions**

Use cream translucent navigation, dark ink text, forest-green primary actions, and forest-green focus rings:

```css
.header {
  border-bottom: 1px solid var(--a3-home-line);
  background: rgb(255 248 216 / 94%);
}

.headerCta,
.primaryCta {
  background: var(--a3-home-action);
  color: #fff;
}

.secondaryCta {
  border-color: var(--a3-home-action);
  color: var(--a3-home-action);
}
```

Replace dark hover, menu, and mobile-navigation colors with the same tokens. Keep the existing dimensions, focus behavior, and mobile menu mechanics.

- [ ] **Step 3: Update hero and screenshot framing**

Set the hero to cream, use `#9a6a00` only for the product-name accent, and keep screenshot frames white:

```css
.hero { background: var(--a3-home-cream); }
.heroCopy h1 { color: var(--a3-home-ink); }
.heroCopy h1 span:first-child { color: #9a6a00; }
.heroSupport { color: var(--a3-home-muted); }
.fullProductFrame,
.resourceProductFrame { border-color: var(--a3-home-line); background: #fff; }
```

- [ ] **Step 4: Update every below-fold band**

Use only white, cream, and soft sage page bands. Convert headings, summaries, list borders, evidence rows, FAQ, footer, and knowledge-flow labels to ink/muted/action tokens. Keep `teacherVisual` dark only as a contained media renderer surface; its surrounding section must remain light.

- [ ] **Step 5: Preserve responsive and reduced-motion contracts**

Do not change existing breakpoint widths, stable aspect ratios, 44px touch targets, or reduced-motion behavior. Ensure the mobile hero still exposes the next section edge on 360x800 and 390x844.

- [ ] **Step 6: Run focused tests**

```powershell
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-launch-baseline.test.ts tests/a3-homepage-public-route.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the light-theme implementation**

```powershell
git add OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts OpenMAIC/tests/a3-homepage-launch-baseline.test.ts
git commit -m "feat(a3): restyle public homepage with warm light theme"
```

### Task 4: Verify desktop and mobile behavior

- [ ] **Step 1: Extend Playwright checks**

In `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`, assert the computed page background is not black, the primary CTA background resolves to the forest-green family, and the next section intersects the first viewport.

```ts
await expect(page.getByTestId('a3-product-homepage')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
await expect(page.getByRole('main').getByRole('link', { name: '开始体验', exact: true }))
  .toHaveCSS('background-color', 'rgb(36, 92, 72)');
```

- [ ] **Step 2: Run type, unit, and E2E verification**

```powershell
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-launch-baseline.test.ts tests/a3-homepage-public-route.test.ts
npx.cmd playwright test e2e/tests/a3-product-homepage.spec.ts --project=chromium
```

Expected: all commands exit 0; lint may only report the documented historical warnings from `AGENTS.md`.

- [ ] **Step 3: Capture visual evidence**

Capture 1440x900, 1280x720, 390x844, and 360x800 screenshots. Check that text does not overlap screenshots, buttons wrap safely, the hero shows a hint of the next section, and no full-width black band remains.

- [ ] **Step 4: Commit E2E coverage**

```powershell
git add OpenMAIC/e2e/tests/a3-product-homepage.spec.ts
git commit -m "test(a3): cover light homepage across viewports"
```
