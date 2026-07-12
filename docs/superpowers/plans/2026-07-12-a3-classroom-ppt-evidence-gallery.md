# A3 Classroom PPT Evidence Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore real PPT evidence previews and claim-to-citation navigation inside the active redesigned A3 classroom while preserving its three-column workspace.

**Architecture:** Keep `/a3/classroom` routed to `ClassroomViewRedesign` and keep all existing backend contracts. Move the proven claim grouping and gallery rendering behavior into the redesigned verification block, then lock the active route with a source contract test and a real-stack Playwright test that verifies an actual Django image response.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Vitest, Playwright, Django knowledge-base preview endpoints.

---

### Task 1: Make The Active-Route Regression Tests Red

**Files:**
- Modify: `OpenMAIC/tests/a3-classroom-citation-preview.test.ts`
- Create: `OpenMAIC/e2e/tests/a3-classroom-ppt-evidence.spec.ts`

- [ ] **Step 1: Point the contract test at the routed component**

Read both the route and redesigned source, then require the route and gallery contract:

```ts
const pagePath = path.resolve(process.cwd(), 'app/a3/classroom/page.tsx');
const redesignPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view-redesign.tsx');

expect(page).toContain('ClassroomViewRedesign');
expect(source).toContain('groupClaimsByCitation');
expect(source).toContain('function EvidenceGallery');
expect(source).toContain('data-testid="a3-classroom-claim-citation-map"');
expect(source).toContain('data-testid="a3-classroom-evidence-thumbnail"');
expect(source).toContain('data-testid="a3-classroom-citation-preview"');
expect(source).toContain('resolveA3Endpoint(previewUrl)');
```

- [ ] **Step 2: Add a real-stack Playwright test**

Create a serial test guarded by `A3_RUN_REAL_PPT_E2E=1`. Seed demo data, assert through a read-only Django shell query that at least one indexed `.pptx` resource owns a `rendered_slide` asset, log in as the demo student, submit a question about the indexed operating-system scheduling/deadlock PPT, and require:

```ts
await expect(page.getByTestId('a3-classroom-claim-citation-map')).toBeVisible({ timeout: 120_000 });
const preview = page.getByTestId('a3-classroom-citation-preview').first();
await expect(preview).toBeVisible();
expect(previewResponses.some(({ status, contentType }) => status === 200 && contentType.startsWith('image/'))).toBe(true);
```

When multiple thumbnail buttons are present, click the second `a3-classroom-evidence-thumbnail` and assert its `aria-pressed` state changes to `true` while the page remains `/a3/classroom`.

- [ ] **Step 3: Run the contract test and observe the expected failure**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-citation-preview.test.ts
```

Expected: FAIL because the active redesigned component does not contain `groupClaimsByCitation`, `EvidenceGallery`, or the evidence-gallery test IDs.

- [ ] **Step 4: Run the real E2E and observe the active-route failure**

Run against the existing local stack:

```powershell
$env:A3_RUN_REAL_PPT_E2E="1"
$env:A3_PLAYWRIGHT_USE_EXISTING="1"
$env:A3_PLAYWRIGHT_BASE_URL="http://localhost:3000"
npx.cmd playwright test e2e/tests/a3-classroom-ppt-evidence.spec.ts --project=chromium
```

Expected: FAIL because `a3-classroom-claim-citation-map` never appears even though the real response contains mapped PPT citations.

### Task 2: Migrate The Evidence Gallery Into The Redesigned Classroom

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx`

- [ ] **Step 1: Add localized gallery copy**

Extend both `zh-CN` and `en-US` copy objects with keys for gallery title, gallery guidance, source count, thumbnail list label, evidence number, supported-claim count, supporting-points title, additional-claims disclosure, missing-preview fallback, unavailable-preview state, and open-preview hint.

- [ ] **Step 2: Prefer mapped claims in VerificationBadge**

Add the mapped-claim branch while retaining the citation-only fallback:

```tsx
const claimsWithMapping = claims.filter((claim) => claim.citation);
const groupedClaimCitations = groupClaimsByCitation(claimsWithMapping);

{claimsWithMapping.length > 0 && <EvidenceGallery groups={groupedClaimCitations} />}
{citations.length > 0 && claimsWithMapping.length === 0 && <CitationList citations={citations} />}
```

- [ ] **Step 3: Implement resilient preview rendering**

Expand `CitationPreview` to accept `compact`, `thumb`, `large`, and `hero` sizes. Render images with `object-contain`; on error, retain the frame and show localized unavailable text instead of returning `null`. Continue resolving relative URLs through `resolveA3Endpoint`.

- [ ] **Step 4: Implement the responsive gallery and grouping function**

Port the old grouping identity:

```ts
const key = [
  claim.citation.previewUrl,
  claim.citation.title,
  claim.citation.location,
  claim.citation.sourceTypeLabel || claim.citation.type,
].filter(Boolean).join('::') || claim.id;
```

Render a full-width active preview, a horizontally scrollable thumbnail strip with stable-width buttons and `aria-pressed`, and up to three supporting claims before a disclosure for the remainder. Do not change the outer workspace grid or panel state.

- [ ] **Step 5: Run the focused test and confirm green**

Run:

```powershell
pnpm.cmd vitest run tests/a3-classroom-citation-preview.test.ts tests/a3-classroom-redesign-contract.test.ts
```

Expected: both files pass.

### Task 3: Verify The Real PPT Chain And Frontend Quality

**Files:**
- Verify: `OpenMAIC/components/a3/features/classroom-view-redesign.tsx`
- Verify: `OpenMAIC/e2e/tests/a3-classroom-ppt-evidence.spec.ts`

- [ ] **Step 1: Run the real-stack PPT E2E**

Use the Task 1 environment and command. Expected: the real question returns mapped claims, the gallery appears, at least one preview response is HTTP 200 with `image/*`, and thumbnail selection remains on `/a3/classroom`.

- [ ] **Step 2: Capture desktop and mobile screenshots**

Use Playwright at desktop and mobile viewport sizes after the gallery appears. Confirm the desktop three-column layout remains visible, the gallery fits within the central message column, the mobile layout has no horizontal page overflow, and thumbnail scrolling does not resize the message bubble.

- [ ] **Step 3: Run static verification**

Run:

```powershell
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected: TypeScript exits 0; ESLint exits 0 with only the seven AGENTS.md-approved historical warnings.

- [ ] **Step 4: Inspect and commit only scoped files**

Run `git diff --check` and inspect `git status --short --branch`. Stage only the redesigned classroom, focused contract test, real E2E test, and this plan. Do not stage `control/celery.pidbox.exchange` or `control/reply.celery.pidbox.exchange`.

Commit with:

```powershell
git commit -m "fix: restore PPT evidence gallery in redesigned classroom"
```
