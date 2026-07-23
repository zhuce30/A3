# A3 Realtime Media Focus and Region Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Follow superpowers:test-driven-development for every behavior change.

**Goal:** Add smooth camera/screen focus, selectable visual regions, and optional browser-side target detection to the existing realtime coaching stage without moving or remounting the Three.js digital human.

**Architecture:** Keep the digital-human Canvas and both media elements mounted in one stable stage. Promote only the selected media wrapper with a transform-based FLIP animation. Represent every selection in normalized source-video coordinates, crop a single frame in the browser, and extend the existing realtime frame route with optional validated region metadata. Automatic detection is lazy, local, worker-based, and always falls back to manual selection.

**Tech Stack:** Next.js 15, React 19, TypeScript, `motion/react`, Canvas, MediaStream, Web Worker, OffscreenCanvas, optional `onnxruntime-web`, Vitest, Playwright.

**Design:** `docs/superpowers/specs/2026-07-23-a3-realtime-media-focus-and-region-analysis-design.md`

---

### Task 1: Define media focus and normalized-region contracts

**Files:**
- Modify: `OpenMAIC/lib/a3/realtime-coaching-types.ts`
- Create: `OpenMAIC/lib/a3/realtime-media-focus.ts`
- Create: `OpenMAIC/tests/a3-realtime-media-focus.test.ts`

- [ ] **Step 1: Add failing type and geometry tests**

Cover:

- `RealtimeFocusedMedia = 'camera' | 'screen' | null`.
- normalized region validation and clamping.
- client-point to source-video mapping for `object-cover` and `object-contain`.
- rejection of clicks inside `object-contain` letterbox areas.
- source-video region to DOM overlay mapping.
- reverse drag, minimum area, out-of-bounds coordinates, DPR independence, and optional mirror conversion.

- [ ] **Step 2: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-media-focus.test.ts
```

Expected: the new module and contracts do not exist.

- [ ] **Step 3: Implement pure coordinate helpers**

Keep helpers independent of React and browser media objects where possible. Use explicit source size, viewport size, fit mode, and mirror inputs. Do not duplicate coordinate math in the overlay or capture hook.

- [ ] **Step 4: Verify GREEN**

Run the focused test and `npx.cmd tsc --noEmit`.

- [ ] **Step 5: Commit the contract layer**

```powershell
git add OpenMAIC/lib/a3/realtime-coaching-types.ts OpenMAIC/lib/a3/realtime-media-focus.ts OpenMAIC/tests/a3-realtime-media-focus.test.ts
git commit -m "feat(coaching): add realtime media region contracts"
```

### Task 2: Add persistent media focus without moving the digital human

**Files:**
- Create: `OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx`
- Modify: `OpenMAIC/tests/a3-coaching-digital-human-integration.test.ts`
- Create: `OpenMAIC/tests/a3-realtime-media-stage.test.tsx`

- [ ] **Step 1: Add failing stage behavior tests**

Require:

- the digital-human element always exists.
- camera and screen `<video>` nodes are persistent across focus changes.
- disabled media cannot receive focus.
- click and Enter/Space focus an enabled preview.
- repeated click, Escape, and return command clear focus.
- camera and screen expose distinct selected states and stable test IDs.
- focus controls expose `aria-pressed`, readable labels, and focus restoration.
- reduced-motion state removes positional transition.

- [ ] **Step 2: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-media-stage.test.tsx tests/a3-coaching-digital-human-integration.test.ts
```

- [ ] **Step 3: Extract the existing video surface into a stable stage**

Move only the current digital-human surface, preview strip, and media chrome into `RealtimeMediaStage`. Keep the surrounding page header, side panel, evidence panel, and bottom call controls unchanged.

Render one persistent wrapper and one persistent `<video>` per source. Do not conditionally render a second focused `<video>`. Preserve `cameraVideoRef` and `screenVideoRef` ownership.

- [ ] **Step 4: Implement transform-based media promotion**

Use `motion/react` layout/FLIP on the media wrapper only. Configure 240-280ms and `[0.22, 1, 0.36, 1]`. Keep labels and commands in a separate overlay so text is not scaled during transition.

Do not animate or resize the `DigitalHumanAvatar` wrapper. Do not use a full-page modal.

- [ ] **Step 5: Add browser fullscreen behavior**

Use Fullscreen API on the focused media surface. Handle `fullscreenchange`, unsupported browsers, Escape, unmount, and focus restoration. Fullscreen failure must leave stage focus intact.

- [ ] **Step 6: Verify GREEN**

Run focused tests, TypeScript, and the existing realtime contract test.

- [ ] **Step 7: Commit focus interaction**

```powershell
git add OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx OpenMAIC/tests/a3-realtime-media-stage.test.tsx OpenMAIC/tests/a3-coaching-digital-human-integration.test.ts
git commit -m "feat(coaching): add smooth realtime media focus"
```

### Task 3: Pause the covered avatar without destroying WebGL state

**Files:**
- Modify: `OpenMAIC/lib/a3/digital-human-types.ts`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx`
- Modify: `OpenMAIC/tests/a3-digital-human-runtime.test.ts`
- Modify: `OpenMAIC/tests/a3-digital-human-avatar.test.ts`

- [ ] **Step 1: Add failing render-suspension tests**

Require a `renderSuspended` input that stops new avatar animation frames while preserving the same Canvas, renderer, scene, model and loaded actions. Require resume to render again without asset reload or component remount.

- [ ] **Step 2: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-runtime.test.ts tests/a3-digital-human-avatar.test.ts
```

- [ ] **Step 3: Implement a ref-driven pause gate**

Add `renderSuspended?: boolean` with a default of `false`. Feed it into the existing `canAnimate`/`syncAnimation` path through a ref or narrow effect that does not recreate the Three.js scene. Do not add the flag to an effect dependency list if doing so disposes and recreates the renderer.

- [ ] **Step 4: Sequence focus and pause safely**

- On focus: finish media promotion, then suspend the fully covered avatar.
- On return: resume avatar, wait for one animation frame, then animate media back.
- On interrupted transitions or unmount: leave the avatar in a valid resumed state.

- [ ] **Step 5: Verify GREEN and identity stability**

Confirm tests prove the Canvas node is unchanged and model-load helpers are not invoked again.

- [ ] **Step 6: Commit avatar suspension**

```powershell
git add OpenMAIC/lib/a3/digital-human-types.ts OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx OpenMAIC/components/a3/features/coaching/digital-human-three-stage.tsx OpenMAIC/tests/a3-digital-human-runtime.test.ts OpenMAIC/tests/a3-digital-human-avatar.test.ts
git commit -m "perf(coaching): suspend covered digital human rendering"
```

### Task 4: Add manual region selection before automatic detection

**Files:**
- Create: `OpenMAIC/components/a3/features/coaching/realtime-region-overlay.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx`
- Create: `OpenMAIC/tests/a3-realtime-region-overlay.test.tsx`
- Modify: `OpenMAIC/tests/a3-realtime-media-focus.test.ts`

- [ ] **Step 1: Add failing pointer and keyboard tests**

Cover create, cancel, move, resize, clear, minimum area, source switch, Escape behavior, disabled media, letterbox rejection and normalized callback values.

- [ ] **Step 2: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-region-overlay.test.tsx tests/a3-realtime-media-focus.test.ts
```

- [ ] **Step 3: Implement an accessible overlay**

Use Pointer Events with pointer capture. Keep the overlay inside the focused media bounds, not over the page or bottom call controls. Provide clear commands to enter selection mode, clear selection, analyze selection, and analyze full frame.

Use familiar icons from the existing icon library and tooltips. Do not add instructional cards or redesign the page.

- [ ] **Step 4: Preserve selection through API failure**

Submitting or retrying analysis must not clear the selected region. Switching source or stopping its stream must clear that source's region.

- [ ] **Step 5: Verify GREEN**

Run focused tests and TypeScript.

- [ ] **Step 6: Commit manual selection**

```powershell
git add OpenMAIC/components/a3/features/coaching/realtime-region-overlay.tsx OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx OpenMAIC/tests/a3-realtime-region-overlay.test.tsx OpenMAIC/tests/a3-realtime-media-focus.test.ts
git commit -m "feat(coaching): add manual realtime region selection"
```

### Task 5: Add lazy browser-side detection behind an adapter

**Files:**
- Create: `OpenMAIC/lib/a3/browser-vision/detector-types.ts`
- Create: `OpenMAIC/lib/a3/browser-vision/detector-controller.ts`
- Create: `OpenMAIC/lib/a3/browser-vision/mediapipe-object-detector.ts`
- Create: `OpenMAIC/lib/a3/browser-vision/document-proposals.ts`
- Create: `OpenMAIC/lib/a3/browser-vision/opencv-document-detector.ts`
- Create: `OpenMAIC/workers/a3-object-detector.worker.ts`
- Create: `OpenMAIC/components/a3/features/coaching/use-realtime-object-detection.ts`
- Create: `OpenMAIC/components/a3/features/coaching/realtime-detection-overlay.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx`
- Create: `OpenMAIC/scripts/prepare-a3-browser-vision-assets.mjs`
- Create: `OpenMAIC/public/models/a3-detection/MODEL_INFO.md`
- Modify: `OpenMAIC/.gitignore`
- Modify: `OpenMAIC/package.json`
- Modify: `OpenMAIC/pnpm-lock.yaml`
- Create: `OpenMAIC/tests/a3-browser-object-detection.test.ts`
- Create: `OpenMAIC/tests/a3-realtime-object-detection-ui.test.ts`

- [x] **Step 1: Add failing controller tests with a fake adapter**

Require:

- no model load before the user enables detection on focused media.
- at most one inference in flight.
- latest-frame behavior with no queue growth.
- 3 FPS default and 5 FPS hard maximum.
- stop on hidden document, source change, focus exit, locked selection and unmount.
- normalized, clamped and class-filtered results.
- explicit error state with manual-selection fallback.

- [x] **Step 2: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-browser-object-detection.test.ts tests/a3-realtime-object-detection-ui.test.tsx
```

- [x] **Step 3: Implement the adapter and worker protocol**

Define `load`, `detect`, `dispose`, capability and error contracts. Transfer downscaled `ImageBitmap` frames to the worker. Prefer MediaPipe GPU delegate and fall back to CPU/WASM. Close transferred bitmaps and terminate the worker on teardown.

- [x] **Step 4: Audit and add one runtime implementation**

Use MediaPipe EfficientDet-Lite0 INT8 after recording:

- exact package and model license.
- compressed package/model bytes.
- supported browser matrix.
- same-origin versioned model URL.
- model SHA-256 and the fixed 416-pixel maximum input edge.

The build preparation script verifies the official model SHA-256 and keeps the generated TFLite/WASM/OpenCV/Worker assets out of Git. Production images create these versioned same-origin assets during the frontend build.

- [x] **Step 5: Implement conservative labels**

Show only approved teaching-relevant classes. Treat document proposals as “可能的文档区域”; do not infer identity, attention, emotion or cheating. Screen-sharing mode must not run face analysis.

- [x] **Step 6: Add detection controls and fallback**

The detection toggle is off by default. On failure, retain manual selection and whole-frame analysis. Locking a box pauses detection until selection is cleared.

- [x] **Step 7: Verify GREEN and bundle boundaries**

Run focused tests and inspect the production build to verify detector runtime and model are absent from the initial coaching bundle until requested.

- [ ] **Step 8: Commit browser detection after explicit user confirmation**

```powershell
git add OpenMAIC/lib/a3/browser-vision OpenMAIC/workers/a3-object-detector.worker.ts OpenMAIC/components/a3/features/coaching/use-realtime-object-detection.ts OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx OpenMAIC/package.json OpenMAIC/pnpm-lock.yaml OpenMAIC/tests/a3-browser-object-detection.test.ts OpenMAIC/tests/a3-realtime-object-detection-ui.test.tsx
git commit -m "feat(coaching): add local target detection adapter"
```

### Task 6: Crop the selected frame and extend existing metadata safely

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/realtime/frame/route.ts`
- Modify: `OpenMAIC/lib/a3/realtime-coaching-types.ts`
- Modify: `OpenMAIC/tests/a3-realtime-coaching-contract.test.ts`
- Create: `OpenMAIC/tests/a3-realtime-frame-capture.test.ts`
- Modify: `OpenMAIC/e2e/tests/a3-realtime-coaching.spec.ts`

- [ ] **Step 1: Add failing capture tests**

Require explicit `source`, optional normalized `region`, correct source-pixel crop, max output dimension, JPEG quality, unavailable-video errors and whole-frame backward compatibility.

- [ ] **Step 2: Add failing route validation tests**

Reject NaN, negative, out-of-range, zero-area and oversized label values. Accept requests without `region`. Require sanitized region metadata in persisted `visualEvidence` and no image data in logs or metadata.

- [ ] **Step 3: Verify RED**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-frame-capture.test.ts tests/a3-realtime-coaching-contract.test.ts
```

- [ ] **Step 4: Refactor frame capture to accept options**

Change the hook from implicit screen-first selection to an explicit contract such as:

```ts
captureFrame({ source, region, prompt, fast })
```

Keep a no-argument compatibility path for the existing bottom control until all call sites are migrated. Crop in the browser before encoding. Keep the current bounded image size and quality unless measurement justifies a change.

- [ ] **Step 5: Extend the existing Next route only**

Validate optional region fields and include them in `visualEvidence`. Keep the Django coaching session endpoint, vision Agent call, response payload and current success/error envelope unchanged.

- [ ] **Step 6: Verify GREEN**

Run focused tests and the realtime Playwright test with camera, screen, manual region and whole-frame requests.

- [ ] **Step 7: Commit region analysis integration**

```powershell
git add OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts OpenMAIC/app/api/a3/coaching/realtime/frame/route.ts OpenMAIC/lib/a3/realtime-coaching-types.ts OpenMAIC/tests/a3-realtime-frame-capture.test.ts OpenMAIC/tests/a3-realtime-coaching-contract.test.ts OpenMAIC/e2e/tests/a3-realtime-coaching.spec.ts
git commit -m "feat(coaching): analyze selected realtime media regions"
```

### Task 7: Complete browser, performance and regression verification

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-realtime-media-focus.spec.ts`
- Modify: existing tests only where new stable selectors are required
- Output: `outputs/test-evidence/realtime-media-focus/`

- [ ] **Step 1: Add desktop and mobile Playwright scenarios**

Use deterministic Canvas-backed fake camera and screen streams. Verify focus, source switch, Escape, full-screen fallback, region selection, retry, media stop and reduced-motion behavior.

- [ ] **Step 2: Prove node and stream identity**

Before and after focus transitions, assert:

- digital-human Canvas is the same DOM node.
- camera and screen videos are the same DOM nodes.
- `srcObject` identity is unchanged.
- `getUserMedia`/`getDisplayMedia` call counts do not increase.
- Canvas client dimensions do not change.

- [ ] **Step 3: Capture visual evidence**

Capture default, camera focus, screen focus, locked detection region, manual region and mobile layouts. Check for nonblank media pixels, stable framing, no control overlap and no clipped labels.

- [ ] **Step 4: Measure animation and detection**

Record actual transition duration, long tasks during focus, worker inference median, dropped-frame behavior and model-load timing. Do not claim a fixed FPS across all user devices.

- [ ] **Step 5: Run the focused suite**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-media-focus.test.ts tests/a3-realtime-media-stage.test.tsx tests/a3-realtime-region-overlay.test.tsx tests/a3-browser-object-detection.test.ts tests/a3-realtime-object-detection-ui.test.tsx tests/a3-realtime-frame-capture.test.ts tests/a3-realtime-coaching-contract.test.ts tests/a3-coaching-digital-human-integration.test.ts tests/a3-digital-human-runtime.test.ts tests/a3-digital-human-avatar.test.ts
npx.cmd playwright test e2e/tests/a3-realtime-media-focus.spec.ts e2e/tests/a3-realtime-coaching.spec.ts --project=chromium
npx.cmd tsc --noEmit
pnpm.cmd lint
```

- [ ] **Step 6: Run backend baseline checks**

No Django business API change is expected, but verify the product baseline:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

- [ ] **Step 7: Run production build and inspect lazy loading**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd build
```

Confirm the detection runtime is lazy, the approved model uses a versioned URL, and focus/manual selection work when the model request is blocked.

- [ ] **Step 8: Commit verification coverage**

```powershell
git add OpenMAIC/e2e/tests/a3-realtime-media-focus.spec.ts outputs/test-evidence/realtime-media-focus
git commit -m "test(coaching): verify media focus and region analysis"
```

## Delivery checkpoints

### Checkpoint A: Safe visual interaction

Tasks 1-3 complete. Camera and screen focus smoothly; digital human and media streams retain identity. This checkpoint can ship independently and requires no backend change.

### Checkpoint B: Precise manual analysis

Tasks 4 and 6 complete. Users can draw and analyze a region through the existing frame route. This checkpoint should ship before automatic detection.

### Checkpoint C: Optional local detection

Task 5 complete only after package/model licensing, size, browser support and performance gates pass. Failure or rollback leaves Checkpoint B fully usable.

### Checkpoint D: Production acceptance

Task 7 complete. Desktop/mobile screenshots, stream identity, animation, lazy loading, TypeScript, lint, Playwright and backend checks are recorded.

## Interface impact

**Interface path:** `POST /api/a3/coaching/realtime/frame`

**Existing request fields:** `coachingSessionId`, `imageDataUrl`, `source`, `prompt`, `fast`

**New optional request field:** `region`

**Response fields:** unchanged

**Frontend call locations:**

- `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`
- `OpenMAIC/components/a3/features/coaching/realtime-media-stage.tsx`
- `OpenMAIC/components/a3/features/coaching/realtime-region-overlay.tsx`

**Regression verification:**

- requests without `region` continue to pass.
- whole-frame “看这里/截图分析” continues to work.
- Django coaching session persistence receives optional metadata through the existing message payload.
- Agent provider, authentication, citations, safety and verification response contracts remain unchanged.

## Rollback sequence

1. Disable the detector adapter and remove its control; keep manual selection.
2. Disable manual selection and optional region metadata; keep media focus.
3. Revert media focus to static previews; existing whole-frame capture and realtime call remain operational.
4. If avatar suspension causes any stale frame or resume defect, force `renderSuspended=false` without unmounting the avatar.
