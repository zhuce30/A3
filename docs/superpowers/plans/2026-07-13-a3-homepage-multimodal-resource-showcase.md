# A3 Homepage Multimodal Resource Showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, privacy-safe multimodal resource showcase to `/a3` using a real captured resource-pack screen and the seven canonical A3 resource types.

**Architecture:** Keep homepage copy in the existing content model, render the new chapter through a focused marketing component, and insert it between knowledge base and classroom in the existing story. Extend the read-only Playwright capture pipeline to publish one validated WebP from authenticated demo data without exposing a live public resource API.

**Tech Stack:** Next.js 15, React 19, TypeScript, CSS Modules, Vitest, Playwright, Sharp, Django resource type contract.

---

## File Structure

- Create `OpenMAIC/components/a3/marketing/a3-homepage-resource-showcase.tsx`: render the public resource chapter and canonical type index.
- Modify `OpenMAIC/components/a3/marketing/a3-homepage-content.ts`: define the resource story item and seven public resource labels.
- Modify `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`: insert the focused component between knowledge and classroom.
- Modify `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`: add desktop, mobile, focus, image, and reduced-motion contracts.
- Modify `OpenMAIC/scripts/capture-a3-homepage-assets.mjs`: capture a real resource-pack result with the existing read-only request policy.
- Create `OpenMAIC/public/a3/assets/homepage/multimodal-resources.webp`: publish the sanitized real product capture.
- Modify `OpenMAIC/tests/a3-homepage-content.test.ts`: enforce ordering, canonical types, public data boundary, asset quality, and capture readiness.
- Modify `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`: verify the chapter on desktop, mobile, and reduced-motion layouts.

### Task 1: Lock the Public Content Contract

**Files:**
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-content.ts`

- [ ] **Step 1: Write the failing content tests**

Add assertions that the ordered story IDs are `profile`, `diagnostic`, `knowledge`, `resources`, `classroom`, `coaching`, `evidence`, `teacher`; that the resource public model contains exactly the canonical keys below; and that the new asset is required:

```ts
expect(A3_HOMEPAGE_RESOURCE_TYPES.map((item) => item.type)).toEqual([
  'lecture_doc',
  'knowledge_card',
  'mind_map',
  'practice_set',
  'case_study',
  'code_lab',
  'micro_video_script',
]);
expect(expectedAssets).toContain('multimodal-resources.webp');
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-homepage-content.test.ts`

Expected: FAIL because `A3_HOMEPAGE_RESOURCE_TYPES` and the `resources` chapter do not exist.

- [ ] **Step 3: Add the minimal public content model**

Export a readonly resource list with labels and short uses, then add this story item after `knowledge`:

```ts
export const A3_HOMEPAGE_RESOURCE_TYPES = [
  { type: 'lecture_doc', label: '课程讲解文档', use: '把概念、例子和引用整理成可直接阅读的讲义' },
  { type: 'knowledge_card', label: '知识点速记卡', use: '提炼定义、易错点和复习提示' },
  { type: 'mind_map', label: '知识点思维导图', use: '连接知识点、先修关系和薄弱环节' },
  { type: 'practice_set', label: '专项练习题', use: '围绕薄弱点生成题目、答案和解析' },
  { type: 'case_study', label: '工程实践案例', use: '把知识放进真实问题场景中分析' },
  { type: 'code_lab', label: '代码类实操案例', use: '提供目标、步骤、起始代码和检查点' },
  { type: 'micro_video_script', label: '短视频/动画脚本', use: '为可播放视频准备分镜和讲解脚本' },
] as const;
```

The story item uses `id: 'resources'`, `index: '04 / RESOURCES'`, `media: '/a3/assets/homepage/multimodal-resources.webp'`, and Chinese public copy. Renumber following story indices from 05 through 08 without changing IDs or routes.

- [ ] **Step 4: Run the focused test and confirm the content contract passes**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-homepage-content.test.ts`

Expected: ordering and canonical type assertions pass; asset assertion may remain red until Task 3 creates the WebP.

- [ ] **Step 5: Commit the content contract**

```powershell
git add OpenMAIC/tests/a3-homepage-content.test.ts OpenMAIC/components/a3/marketing/a3-homepage-content.ts
git commit -m "test: define homepage multimodal resource contract"
```

### Task 2: Render the Multimodal Resource Chapter

**Files:**
- Create: `OpenMAIC/components/a3/marketing/a3-homepage-resource-showcase.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-homepage-story.tsx`
- Modify: `OpenMAIC/components/a3/marketing/a3-product-homepage.module.css`
- Test: `OpenMAIC/tests/a3-homepage-content.test.ts`

- [ ] **Step 1: Write the failing render assertions**

Assert server-rendered homepage markup contains `data-testid="a3-homepage-resources"`, all seven labels once inside the section, the real screenshot alt text, and `href="/a3/recommendations"`. Assert the combined marketing source does not contain `/api/resources/generate/` or `a3PostJson`.

- [ ] **Step 2: Run the focused test and confirm red**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-homepage-content.test.ts`

Expected: FAIL because the chapter component is not rendered.

- [ ] **Step 3: Implement the focused component**

Create a semantic section that receives the `resources` story item, imports `A3_HOMEPAGE_RESOURCE_TYPES`, renders an ordered index, uses `A3HomepageProductMedia` for the real image, and links to `/a3/recommendations`:

```tsx
<section id={item.id} data-story={item.id} data-testid="a3-homepage-resources">
  <div>
    <p>{item.index}</p>
    <h2>{item.title}</h2>
    <p>{item.summary}</p>
    <Link href="/a3/recommendations">查看个性化资源</Link>
  </div>
  <ol aria-label="多模态资源类型">
    {A3_HOMEPAGE_RESOURCE_TYPES.map((resource, index) => (
      <li key={resource.type}>
        <span>{String(index + 1).padStart(2, '0')}</span>
        <strong>{resource.label}</strong>
        <p>{resource.use}</p>
      </li>
    ))}
  </ol>
  <figure>
    <A3HomepageProductMedia src={item.media} alt={item.alt} sizes="(max-width: 767px) calc(100vw - 36px), 68vw" />
  </figure>
</section>
```

Insert it after `KnowledgeFlow` and before the classroom band. Keep all public content server-renderable and do not add API calls.

- [ ] **Step 4: Add layout and accessibility CSS**

Use a dark full-width band with an asymmetric desktop grid, an unboxed indexed list, an 8px resource frame, `object-fit: contain`, and a one-column mobile layout. Add `scroll-margin-top`, `overflow-wrap`, stable aspect ratios, visible focus styles, active feedback, and reduced-motion overrides. Reuse `#d9ff62` as the only accent.

- [ ] **Step 5: Run focused tests and TypeScript**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-homepage-content.test.ts
npx.cmd tsc --noEmit
```

Expected: content/render tests pass except the still-missing real asset; TypeScript exits 0.

- [ ] **Step 6: Commit the chapter implementation**

```powershell
git add OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "feat: add homepage multimodal resource showcase"
```

### Task 3: Capture and Validate the Real Product Evidence

**Files:**
- Modify: `OpenMAIC/scripts/capture-a3-homepage-assets.mjs`
- Create: `OpenMAIC/public/a3/assets/homepage/multimodal-resources.webp`
- Modify: `OpenMAIC/tests/a3-homepage-content.test.ts`

- [ ] **Step 1: Write the failing capture contract**

Assert the capture source includes `filename: 'multimodal-resources.webp'`, waits for `a3-resource-result-preview`, requires at least one `a3-resource-entry`, and includes the filename in `expectedAssets`. Retain the existing assertion that the script does not issue forbidden business writes.

- [ ] **Step 2: Run the capture contract and confirm red**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-capture-readonly.test.ts`

Expected: FAIL because the new capture entry is absent.

- [ ] **Step 3: Extend the read-only capture definition**

Add a student asset for `/a3/recommendations` with `testId: 'a3-resource-result-preview'`. Its readiness function must wait for the result preview and require `page.getByTestId('a3-resource-entry').count()` to be greater than zero. Capture the preview plus its nearest resource result section at 1440px width, with at least 520px height. Add the output filename to `expectedAssets`.

- [ ] **Step 4: Start or reuse the local stack and run the capture**

Check the existing local frontend and backend ports first. When healthy, run:

```powershell
cd OpenMAIC
$env:A3_CAPTURE_BASE_URL='http://localhost:3000'
$env:A3_CAPTURE_LOGIN_ORIGIN='http://localhost:8000'
node scripts/capture-a3-homepage-assets.mjs
```

Expected: the script logs the generated `multimodal-resources.webp` dimensions, reports no blocked writes, failed API responses, browser errors, sensitive text, or missing resource entries.

- [ ] **Step 5: Run asset validation**

Run: `cd OpenMAIC; pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-capture-readonly.test.ts tests/a3-homepage-capture-atomic.test.ts`

Expected: all tests pass; Sharp reports a decodable, nonblank WebP of at least 640x360 and larger than 10KB.

- [ ] **Step 6: Commit the real evidence asset and pipeline**

```powershell
git add OpenMAIC/scripts/capture-a3-homepage-assets.mjs OpenMAIC/public/a3/assets/homepage/multimodal-resources.webp OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "feat: capture homepage multimodal resource evidence"
```

### Task 4: Browser Regression, Quality Gate, and Push

**Files:**
- Modify: `OpenMAIC/e2e/tests/a3-product-homepage.spec.ts`

- [ ] **Step 1: Add browser assertions**

Add `a3-homepage-resources` to the reduced-motion chapter list. In both existing desktop and mobile layout tests, assert all seven resource labels are visible after scrolling the section into view, the screenshot has nonzero natural dimensions, the CTA remains on one line, the section does not overflow horizontally, and the indexed copy does not overlap the resource image.

- [ ] **Step 2: Run the focused Playwright test**

Run: `cd OpenMAIC; npx.cmd playwright test e2e/tests/a3-product-homepage.spec.ts --project=chromium`

Expected: PASS for desktop, mobile, short viewport, anonymous auth, anchors, and reduced motion.

- [ ] **Step 3: Inspect generated screenshots**

Open `OpenMAIC/test-results/a3-homepage-desktop.png` and `OpenMAIC/test-results/a3-homepage-mobile.png`. Confirm the new chapter is legible, the real screenshot is not blank or cropped, text does not overlap, and the page retains the existing dark/lime visual system.

- [ ] **Step 4: Run required frontend quality gates**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-homepage-content.test.ts tests/a3-homepage-capture-readonly.test.ts tests/a3-homepage-capture-atomic.test.ts
```

Expected: TypeScript and tests exit 0; lint contains no new errors and only the historical warnings allowed by `AGENTS.md`.

- [ ] **Step 5: Perform the design pre-flight audit**

Confirm one dark theme, one lime accent, consistent 6px to 8px radii, no em dash in visible copy, no duplicate CTA intent, no seven-card grid, no API call, no private implementation brand, no horizontal overflow, and a readable mobile collapse.

- [ ] **Step 6: Commit E2E coverage and any verified corrections**

```powershell
git add OpenMAIC/e2e/tests/a3-product-homepage.spec.ts OpenMAIC/components/a3/marketing OpenMAIC/tests/a3-homepage-content.test.ts
git commit -m "test: verify homepage multimodal showcase layouts"
```

- [ ] **Step 7: Push the integration branch**

Run: `git status --short --branch; git push origin codex/a3-latest-integration`

Expected: only the two known local Celery runtime files remain uncommitted; remote branch advances to the verified homepage implementation.
