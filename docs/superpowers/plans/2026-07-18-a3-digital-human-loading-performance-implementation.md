# A3 Digital Human Loading Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce digital teacher first-render latency and replace the visible primitive placeholder with a stable static teacher presentation.

**Architecture:** A reproducible asset pipeline produces a versioned optimized VRM and validates VRM extensions. Navigation preloads the code and model, the stage renders a static fallback until the VRM first frame, and animation/spring work is deferred. Versioned assets receive immutable browser caching.

**Tech Stack:** Three.js, `@pixiv/three-vrm`, Next.js 15, Node asset tooling, Vitest, Playwright.

---

### Task 1: Add an auditable VRM optimization pipeline

**Files:**
- Create: `OpenMAIC/scripts/optimize-a3-teacher-vrm.mjs`
- Modify: `OpenMAIC/package.json`
- Create: `OpenMAIC/public/a3/assets/teacher-avatar/teacher.optimized.vrm`
- Test: `OpenMAIC/tests/a3-digital-human-avatar.test.ts`

- [ ] **Step 1: Add failing asset acceptance tests**

Parse the GLB header and JSON chunk. Require output size <= 5 MB; `VRMC_vrm`, `VRMC_springBone`, and `VRMC_materials_mtoon`; meshes, skins, morph targets, humanoid expressions, and image payloads.

- [ ] **Step 2: Verify RED**

Run the digital-human asset test; expected failure is missing optimized model.

- [ ] **Step 3: Implement the optimization script**

Use pinned local Node dependencies. Convert large color textures to WebP, retain lossless treatment for normal/mask textures, apply meshopt-compatible geometry compression only if the installed Three loader path supports it, and write a deterministic report with input/output bytes and preserved extensions.

- [ ] **Step 4: Generate and inspect output**

Run `pnpm.cmd a3:optimize-avatar`. Fail rather than publishing if the model exceeds 5 MB or extension/animation smoke checks fail.

- [ ] **Step 5: Verify GREEN**

Run asset tests and the existing VRM animation tests.

### Task 2: Add versioned immutable caching

**Files:**
- Modify: `OpenMAIC/next.config.ts`
- Modify: `Caddyfile`
- Modify: `docs/A3_GHCR前端镜像部署.md`
- Test: `OpenMAIC/tests/a3-digital-human-avatar.test.ts`
- Test: `OpenMAIC/tests/a3-ghcr-deployment.test.ts`

- [ ] **Step 1: Add failing cache contract tests**

Require `/a3/assets/teacher-avatar/:path*` to return `public, max-age=31536000, immutable` and require a versioned model URL.

- [ ] **Step 2: Verify RED**

Run cache contract tests.

- [ ] **Step 3: Add cache headers and Cloudflare instructions**

Add a narrow Next header rule before the generic security rule. Keep Caddy encoding; document a Cloudflare Cache Rule for `.vrm/.vrma/.webp` with query string in cache key.

- [ ] **Step 4: Verify GREEN**

Run tests and inspect merged Next config behavior.

### Task 3: Replace primitive loading UI with static-to-VRM handoff

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx`
- Create: `OpenMAIC/public/a3/assets/teacher-avatar/teacher-loading.webp`
- Test: `OpenMAIC/tests/a3-digital-human-avatar.test.ts`
- Test: `OpenMAIC/tests/a3-digital-human-runtime.test.ts`

- [ ] **Step 1: Add failing state and rendering tests**

Require `loading_chunk/loading_model/vrm_ready/actions_ready/static_fallback`, require the static image during loading, and forbid production rendering of the primitive avatar.

- [ ] **Step 2: Verify RED**

Run focused tests.

- [ ] **Step 3: Implement stable loading presentation**

Render the static teacher behind the canvas. Keep it visible until the first successful VRM render, crossfade without changing dimensions, and keep it on WebGL/model failure with readable reason.

- [ ] **Step 4: Defer secondary work**

Show rest pose immediately after VRM parse. Load VRMA actions asynchronously; defer spring-bone warmup with idle callbacks/bounded batches. Do not block `activeRenderer='vrm'` on idle action.

- [ ] **Step 5: Adapt pixel ratio**

Use a tested helper that caps DPR at 1 on constrained/mobile devices, 1.5 by default, and 2 only for high capability.

- [ ] **Step 6: Verify GREEN**

Run component/runtime tests and TypeScript.

### Task 4: Preload before route entry and cache module work

**Files:**
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx` or navigation owner
- Create: `OpenMAIC/lib/a3/digital-human-preload.ts`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Test: `OpenMAIC/tests/a3-digital-human-runtime.test.ts`

- [ ] **Step 1: Add failing preload tests**

Require deduplicated dynamic import/model prefetch and trigger on route hover/focus or when the AI learning group becomes active.

- [ ] **Step 2: Verify RED**

Run focused runtime tests.

- [ ] **Step 3: Implement deduplicated preload**

Use module-level promises for the stage chunk and model `fetch`, avoid preloading on save-data/2G, and never block navigation.

- [ ] **Step 4: Add performance marks**

Record chunk ready, model response, VRM first frame, and actions ready without sending telemetry.

- [ ] **Step 5: Verify GREEN**

Run runtime and navigation tests.

### Task 5: Visual and production verification

**Files:**
- Modify tests only if genuine browser behavior requires stable selectors
- Output: `outputs/test-evidence/digital-human-loading/`

- [ ] **Step 1: Run static verification**

Run digital-human tests, `tsc`, lint, and production build.

- [ ] **Step 2: Run Playwright desktop/mobile capture**

Capture initial static state, VRM first frame, and fallback state. Check canvas pixels are nonblank and no text/control overlap occurs.

- [ ] **Step 3: Verify network behavior**

Confirm model response size <= 5 MB and immutable cache headers. Reload and verify the browser does not transfer the full model again.

- [ ] **Step 4: Record before/after metrics**

Report model bytes and measured first-frame timings without claiming unsupported user-network guarantees.
