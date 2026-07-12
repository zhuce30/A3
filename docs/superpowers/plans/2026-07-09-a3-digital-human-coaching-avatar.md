# A3 Digital Human Coaching Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `AI` placeholder in `/a3/coaching` with a real 2D/3D digital human presentation layer while preserving the existing A3 realtime coaching, RAG, verifier, safety, session persistence, and learning-loop contracts.

**Architecture:** Keep A3's current realtime coaching stack as the source of truth. Add a provider-neutral avatar layer that consumes existing realtime state (`assistantSpeaking`, `audioLevel`, transcript/audio events, provider status) and renders either a browser-side 3D avatar first or a remote avatar video stream later. Do not move CoachAgent, RetrieverAgent, VerifierAgent, or SafetyAgent into the avatar service.

**Tech Stack:** Next.js 16, React, existing A3 realtime coaching hooks, Web Audio API, WebRTC/WebSocket, Vitest, Playwright. Phase 1 uses browser-side 3D avatar rendering; Phase 2 can add Live2D/VRM; Phase 3 can add OpenAvatarChat/LiveTalking-style remote avatar service.

## Execution Status - 2026-07-09

Chosen route: Phase 1 browser-side local 3D digital human first.

Completed:

- Added provider-neutral digital human state/types.
- Added a local Three.js avatar renderer for `/a3/coaching`.
- Replaced the static assistant `AI` visual identity in `RealtimeCoachingCall`.
- Mapped realtime status and `assistantSpeaking` into avatar states.
- Kept the existing A3 realtime coaching, RAG, verifier, safety, transcript, camera, screen, and fallback flow ownership unchanged.
- Added Vitest coverage for avatar types/rendering/status contracts.
- Added Playwright coverage for desktop and mobile Three.js rendering with pixel checks.
- Adjusted realtime coaching layout breakpoints so the digital human remains visible at common desktop widths.
- Added VRM model loading for the exported teacher avatar at `/a3/assets/teacher-avatar/teacher.vrm`, with the primitive Three.js avatar retained as fallback.
- Tuned VRM camera framing to an upper-body face-to-face profile, added multi-mouth-expression speech cycling, state-based facial expressions, and asset license notes in `public/a3/assets/teacher-avatar/README.md`.

Verified:

- `pnpm.cmd vitest run tests/a3-digital-human-avatar.test.ts tests/a3-realtime-coaching-contract.test.ts`
- `npx.cmd tsc --noEmit`
- `A3_PLAYWRIGHT_USE_EXISTING=1 npx.cmd playwright test e2e/tests/a3-digital-human-coaching.spec.ts --project=chromium`
- `pnpm.cmd lint`

Deferred:

- GLB scene assets or Live2D asset integration.
- Remote high-fidelity avatar service.
- Avatar-service API contract and runtime capability evidence.

---

## Current Baseline

The existing project is already close to realtime coaching:

- `/a3/coaching` renders `RealtimeCoachingCall` from `OpenMAIC/components/a3/features/coaching-view.tsx`.
- `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts` already manages microphone, camera, screen sharing, WebRTC SDP exchange, DashScope WebSocket proxy, PCM audio streaming, audio delta playback, interruption, RAG tool calls, visual frame capture, and session ending.
- `OpenMAIC/lib/a3/realtime-coaching-types.ts` already defines `openai_realtime_webrtc`, `dashscope_qwen_omni_realtime`, and `local_fallback_record_then_respond`.
- `OpenMAIC/app/api/a3/coaching/realtime/*` already contains session, SDP, tool, frame, message, and end routes.
- The visual avatar area in `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx` is still a static circular `AI` placeholder.
- No real avatar renderer dependency is currently wired into `OpenMAIC/package.json`.

This plan therefore does not rebuild realtime transport. It upgrades the presentation layer first, then optionally adds a remote high-fidelity avatar service.

## Target User Experience

Students enter `/a3/coaching`, start realtime coaching, and see a digital teacher instead of a static `AI` circle.

The digital human must:

- idle naturally before the call starts;
- react to `assistantSpeaking`;
- use `audioLevel` to drive mouth movement in the first implementation;
- show listening/thinking/speaking/error/degraded states;
- keep camera and screen previews available;
- keep citations, verification status, transcript, and tool results visible;
- support interruption without visual desynchronization;
- degrade cleanly to the current static panel if WebGL/avatar loading fails.

The digital human must not:

- invent citations or bypass A3 verification;
- directly call LLM/RAG APIs from the avatar component;
- expose API keys, signed URLs, or local absolute asset paths to the page;
- pretend that remote video avatar streaming succeeded when only a local placeholder is running.

## Recommended Technical Direction

Use a staged architecture.

### Phase 1: Browser-Side 3D Digital Human

Best first implementation. It is stable, cheap, and fits the current code.

Rendering choices:

- Preferred: lightweight React component with CSS/SVG/Canvas-style face first, then upgrade to Three.js/VRM when dependencies are approved.
- If adding 3D dependencies: use `three` plus a focused wrapper component. Add `@react-three/fiber` only if the team wants declarative React 3D and accepts the dependency weight.
- Do not introduce a GPU avatar backend in this phase.

Control signals:

```ts
type A3DigitalHumanAvatarState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'visual_focus'
  | 'degraded'
  | 'error'
  | 'ended';
```

Inputs:

```ts
type A3DigitalHumanAvatarProps = {
  state: A3DigitalHumanAvatarState;
  audioLevel: number;
  assistantSpeaking: boolean;
  providerLabel: string;
  modelLabel: string;
  fallbackReason?: string;
};
```

Phase 1 acceptance:

- The `AI` circle is gone.
- A real animated avatar is visible in desktop and mobile layouts.
- Mouth movement changes when `assistantSpeaking` and `audioLevel` change.
- Tests cover degraded, speaking, and idle states.

### Phase 2: Asset-Based 2D/3D Avatar

Upgrade the local avatar renderer without changing realtime APIs.

Options:

- 2D Live2D-like path: use a local model/texture rig or later a Live2D SDK if licensing is acceptable.
- 3D VRM/GLB path: use a teacher model with blendshape mouth states.
- Viseme path: start from audio amplitude, then later add viseme mapping from TTS/provider transcript events if available.

Phase 2 acceptance:

- Avatar asset is loaded from `OpenMAIC/public/a3/avatars/` or another static public directory.
- Loading failure shows a clear fallback renderer.
- No external signed model URL is embedded in source.
- The avatar remains responsive during transcript/audio streaming.

### Phase 3: Remote High-Fidelity Avatar Service

Only add this after Phase 1 works.

Reference architectures:

- OpenAvatarChat-style service: modular ASR/LLM/TTS/avatar pipeline, but A3 must keep LLM/RAG/Verifier/Safety ownership.
- LiveTalking-style service: audio-driven talking avatar with WebRTC/RTMP output.
- MuseTalk/Wav2Lip-style backend: best for high-fidelity lip sync, but requires GPU and more deployment work.

A3 integration rule:

```text
A3 realtime coaching output
  -> answer text/audio events
  -> avatar-service render request
  -> WebRTC remote video track
  -> /a3/coaching avatar panel
```

The avatar service is a renderer. It must not become the tutor brain.

## File Structure

Create or modify these files.

- Create `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
  - Renders the first local digital human.
  - Owns visual state, mouth animation, and fallback UI.

- Create `OpenMAIC/lib/a3/digital-human-types.ts`
  - Defines avatar state, avatar mode, and event contracts.

- Modify `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx`
  - Replaces the static `AI` circle with `DigitalHumanAvatar`.
  - Maps realtime status to avatar state.

- Modify `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`
  - Exposes any missing avatar-friendly state, but does not move rendering logic into the hook.
  - Optional: expose a normalized `avatarAudioLevel`.

- Create `OpenMAIC/tests/a3-digital-human-avatar.test.tsx`
  - Unit tests for avatar rendering and state mapping.

- Extend `OpenMAIC/tests/a3-realtime-coaching-contract.test.ts`
  - Contract test that realtime UI imports the avatar component and no longer uses the bare `AI` placeholder as the main assistant identity.

- Extend or create `OpenMAIC/e2e/tests/a3-digital-human-coaching.spec.ts`
  - Playwright test for visible avatar, speaking state, degraded fallback, and no layout break.

- Optional Phase 2 create `OpenMAIC/public/a3/avatars/teacher-avatar/`
  - Static model/textures only. Do not commit large generated binary assets unless they are small and license-safe.

- Optional Phase 3 create `OpenMAIC/lib/server/a3-avatar-provider.ts`
  - Server-side adapter for future remote avatar service.

- Optional Phase 3 create `OpenMAIC/app/api/a3/coaching/avatar/session/route.ts`
  - Creates a remote avatar rendering session without exposing backend keys.

## Task 1: Add Avatar Types

**Files:**
- Create: `OpenMAIC/lib/a3/digital-human-types.ts`
- Test: `OpenMAIC/tests/a3-digital-human-avatar.test.tsx`

- [ ] **Step 1: Write the failing type/import test**

Create `OpenMAIC/tests/a3-digital-human-avatar.test.tsx` with:

```ts
import { describe, expect, it } from 'vitest';
import type { A3DigitalHumanAvatarState, A3DigitalHumanAvatarMode } from '@/lib/a3/digital-human-types';

describe('A3 digital human avatar types', () => {
  it('defines stable avatar states and modes', () => {
    const state: A3DigitalHumanAvatarState = 'speaking';
    const mode: A3DigitalHumanAvatarMode = 'local_3d';

    expect(state).toBe('speaking');
    expect(mode).toBe('local_3d');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx
```

Expected: FAIL because `@/lib/a3/digital-human-types` does not exist.

- [ ] **Step 3: Add the type file**

Create `OpenMAIC/lib/a3/digital-human-types.ts`:

```ts
export type A3DigitalHumanAvatarState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'visual_focus'
  | 'degraded'
  | 'error'
  | 'ended';

export type A3DigitalHumanAvatarMode =
  | 'local_3d'
  | 'local_2d'
  | 'remote_video'
  | 'static_fallback';

export type A3DigitalHumanAvatarProps = {
  state: A3DigitalHumanAvatarState;
  mode?: A3DigitalHumanAvatarMode;
  audioLevel: number;
  assistantSpeaking: boolean;
  providerLabel: string;
  modelLabel: string;
  fallbackReason?: string;
};
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx
```

Expected: PASS.

## Task 2: Build the First Local Avatar Component

**Files:**
- Create: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Modify: `OpenMAIC/tests/a3-digital-human-avatar.test.tsx`

- [ ] **Step 1: Add rendering tests**

Extend `OpenMAIC/tests/a3-digital-human-avatar.test.tsx`:

```ts
import { render, screen } from '@testing-library/react';
import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar';

describe('DigitalHumanAvatar', () => {
  it('renders a digital human instead of a static AI label', () => {
    render(
      <DigitalHumanAvatar
        state="idle"
        mode="local_3d"
        audioLevel={0}
        assistantSpeaking={false}
        providerLabel="dashscope_qwen_omni_realtime"
        modelLabel="qwen3.5-omni-plus-realtime"
      />,
    );

    expect(screen.getByTestId('a3-digital-human-avatar')).toBeInTheDocument();
    expect(screen.getByText('数字助教')).toBeInTheDocument();
    expect(screen.queryByText(/^AI$/)).not.toBeInTheDocument();
  });

  it('marks the avatar as speaking when assistant audio is active', () => {
    render(
      <DigitalHumanAvatar
        state="speaking"
        mode="local_3d"
        audioLevel={0.72}
        assistantSpeaking={true}
        providerLabel="openai_realtime_webrtc"
        modelLabel="gpt-realtime-2"
      />,
    );

    const avatar = screen.getByTestId('a3-digital-human-avatar');
    expect(avatar).toHaveAttribute('data-state', 'speaking');
    expect(screen.getByTestId('a3-digital-human-mouth')).toHaveStyle({ transform: 'scaleY(1.72)' });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx
```

Expected: FAIL because `DigitalHumanAvatar` does not exist.

- [ ] **Step 3: Create the component**

Create `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`:

```tsx
'use client';

import { cn } from '@/lib/utils';
import type { A3DigitalHumanAvatarProps } from '@/lib/a3/digital-human-types';

const stateCopy: Record<string, string> = {
  idle: '待开始',
  connecting: '连接中',
  listening: '正在听',
  thinking: '思考中',
  speaking: '讲解中',
  visual_focus: '看画面',
  degraded: '已降级',
  error: '连接异常',
  ended: '已结束',
};

export function DigitalHumanAvatar({
  state,
  mode = 'local_3d',
  audioLevel,
  assistantSpeaking,
  providerLabel,
  modelLabel,
  fallbackReason,
}: A3DigitalHumanAvatarProps) {
  const normalizedLevel = Math.max(0, Math.min(1, audioLevel));
  const mouthScale = assistantSpeaking ? 1 + normalizedLevel : 0.35;

  return (
    <div
      data-testid="a3-digital-human-avatar"
      data-state={state}
      data-mode={mode}
      className="relative flex min-h-[420px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#07111f] p-6 text-center"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(20,184,166,0.22),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0),rgba(2,6,23,0.82))]" />
      <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-300">
        <span className={cn('size-2 rounded-full', state === 'speaking' ? 'bg-emerald-400' : state === 'error' ? 'bg-rose-400' : 'bg-slate-500')} />
        {stateCopy[state] || '待开始'}
      </div>
      <div className="absolute right-5 top-5 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-300">
        {providerLabel} · {modelLabel}
      </div>

      <div className={cn('relative z-10 transition-transform duration-200', assistantSpeaking && 'scale-[1.03]')}>
        <div className="relative h-64 w-52">
          <div className="absolute left-1/2 top-4 h-44 w-40 -translate-x-1/2 rounded-[46%_46%_42%_42%] bg-gradient-to-b from-[#f4c7a1] to-[#d89068] shadow-[0_22px_60px_rgba(20,184,166,0.20)]" />
          <div className="absolute left-1/2 top-0 h-20 w-44 -translate-x-1/2 rounded-t-[58px] bg-slate-900" />
          <div className="absolute left-[58px] top-[76px] size-4 rounded-full bg-slate-900" />
          <div className="absolute right-[58px] top-[76px] size-4 rounded-full bg-slate-900" />
          <div className="absolute left-1/2 top-[128px] h-7 w-16 -translate-x-1/2 overflow-hidden rounded-full bg-slate-950/80">
            <div
              data-testid="a3-digital-human-mouth"
              className="h-full w-full origin-center rounded-full bg-rose-400 transition-transform duration-100"
              style={{ transform: `scaleY(${mouthScale})` }}
            />
          </div>
          <div className="absolute bottom-0 left-1/2 h-28 w-52 -translate-x-1/2 rounded-t-[64px] bg-gradient-to-b from-teal-600 to-blue-700" />
          <div className={cn('absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full border border-teal-300/20', assistantSpeaking && 'animate-pulse')} />
        </div>
      </div>

      <div className="relative z-10 mt-5">
        <div className="text-base font-semibold text-white">数字助教</div>
        <p className="mt-2 max-w-[560px] text-sm leading-6 text-slate-300">
          {fallbackReason || '实时辅导、知识库证据和视觉帧分析仍由 A3 后端统一处理。'}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx
```

Expected: PASS.

## Task 3: Replace the Static AI Placeholder

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx`
- Modify: `OpenMAIC/tests/a3-realtime-coaching-contract.test.ts`

- [ ] **Step 1: Add contract assertions**

Extend the `wires the realtime call UI into the coaching page` test in `OpenMAIC/tests/a3-realtime-coaching-contract.test.ts`:

```ts
expect(component).toContain('DigitalHumanAvatar');
expect(component).toContain('mapRealtimeStatusToAvatarState');
expect(component).toContain('a3-digital-human-avatar');
expect(component).not.toContain('text-5xl font-bold');
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
```

Expected: FAIL because the component still uses the static `AI` circle.

- [ ] **Step 3: Modify the realtime call component**

In `OpenMAIC/components/a3/features/coaching/realtime-coaching-call.tsx`:

Add imports:

```ts
import { DigitalHumanAvatar } from './digital-human-avatar';
import type { A3DigitalHumanAvatarState } from '@/lib/a3/digital-human-types';
```

Add helper near `statusCopy`:

```ts
function mapRealtimeStatusToAvatarState(status: A3RealtimeStatus, assistantSpeaking: boolean): A3DigitalHumanAvatarState {
  if (assistantSpeaking) return 'speaking';
  if (status === 'connecting' || status === 'requesting_permission') return 'connecting';
  if (status === 'visual_focus') return 'visual_focus';
  if (status === 'degraded') return 'degraded';
  if (status === 'error') return 'error';
  if (status === 'ended') return 'ended';
  if (status === 'live') return 'listening';
  return 'idle';
}
```

Replace the static avatar block that contains the circular `AI` label with:

```tsx
<DigitalHumanAvatar
  state={mapRealtimeStatusToAvatarState(status, assistantSpeaking)}
  mode="local_3d"
  audioLevel={audioLevel}
  assistantSpeaking={assistantSpeaking}
  providerLabel={provider}
  modelLabel={session?.model || '未连接'}
  fallbackReason={fallbackReason}
/>
```

- [ ] **Step 4: Run focused tests**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx tests/a3-realtime-coaching-contract.test.ts
```

Expected: PASS.

## Task 4: Add Playwright Coverage for the Digital Human

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-digital-human-coaching.spec.ts`

- [ ] **Step 1: Write e2e test**

Create `OpenMAIC/e2e/tests/a3-digital-human-coaching.spec.ts`:

```ts
import { expect } from '@playwright/test';
import { test } from '../fixtures/base';

test.describe('A3 digital human coaching avatar', () => {
  test('shows digital human avatar in realtime coaching panel', async ({ page }) => {
    await page.route('**/api/a3/coaching/realtime/session', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          provider: 'local_fallback_record_then_respond',
          model: 'a3-local-fallback',
          connection: { type: 'fallback', readyForBrowserMedia: false },
          coachingSessionId: 'digital-human-e2e',
          fallbackReason: '测试环境未配置实时 provider，已降级到录音转写问答。',
          instructions: {
            targetTitle: '面对面辅导',
            safetyPolicyVersion: 'a3.realtime-safety.v1',
            retrievalPolicyVersion: 'a3.hybrid-rag.v1',
          },
        }),
      });
    });

    await page.route('**/api/a3/coaching/realtime/message', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, session: {} }) });
    });

    await page.goto('/a3/coaching');
    const call = page.getByTestId('a3-realtime-coaching-call');
    await expect(call).toBeVisible({ timeout: 60_000 });
    await expect(call.getByTestId('a3-digital-human-avatar')).toBeVisible();
    await expect(call).toContainText('数字助教');

    await call.getByTestId('a3-realtime-start').click();
    await expect(call.getByTestId('a3-digital-human-avatar')).toHaveAttribute('data-state', 'degraded');
    await expect(call).toContainText('测试环境未配置实时 provider');
  });
});
```

- [ ] **Step 2: Run the e2e test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-digital-human-coaching.spec.ts --project=chromium
```

Expected: PASS after the component is wired.

## Task 5: Improve Avatar Audio Reactivity

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Modify: `OpenMAIC/tests/a3-digital-human-avatar.test.tsx`

- [ ] **Step 1: Add test for bounded mouth scale**

Add:

```ts
it('clamps mouth movement when audio level is outside normal range', () => {
  render(
    <DigitalHumanAvatar
      state="speaking"
      audioLevel={4}
      assistantSpeaking={true}
      providerLabel="dashscope_qwen_omni_realtime"
      modelLabel="qwen3.5-omni-plus-realtime"
    />,
  );

  expect(screen.getByTestId('a3-digital-human-mouth')).toHaveStyle({ transform: 'scaleY(2)' });
});
```

- [ ] **Step 2: Run the test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx
```

Expected: PASS if the component already clamps to `0..1`; otherwise fix the clamp.

- [ ] **Step 3: Review `audioLevel` source**

In `OpenMAIC/components/a3/features/coaching/use-realtime-coaching.ts`, keep the existing input audio level for now. Do not add an analyzer for assistant playback until there is a real need, because the current `assistantSpeaking` plus microphone `audioLevel` is enough for the first demo.

If assistant playback feels visually flat later, add a separate `assistantAudioLevel` computed inside `playRealtimeAudioDelta()` by calculating RMS from decoded PCM before enqueueing playback.

## Task 6: Add Asset-Based Avatar Mode

**Files:**
- Modify: `OpenMAIC/lib/a3/digital-human-types.ts`
- Modify: `OpenMAIC/components/a3/features/coaching/digital-human-avatar.tsx`
- Optional create: `OpenMAIC/public/a3/avatars/teacher-avatar/README.md`

- [ ] **Step 1: Add asset metadata type**

Extend `OpenMAIC/lib/a3/digital-human-types.ts`:

```ts
export type A3DigitalHumanAvatarAsset = {
  id: string;
  label: string;
  type: 'css_rig' | 'live2d' | 'vrm' | 'glb';
  publicPath?: string;
  license: string;
};
```

- [ ] **Step 2: Add local asset documentation**

Create `OpenMAIC/public/a3/avatars/teacher-avatar/README.md`:

```md
# A3 Teacher Avatar Assets

This directory is reserved for license-safe digital human assets used by `/a3/coaching`.

Rules:
- Do not commit API keys, signed URLs, or local absolute paths.
- Do not commit large generated binaries without explicit review.
- Every model, texture, or rig must include source and license notes.
- The first shipped avatar can remain the CSS rig in `digital-human-avatar.tsx`.
```

- [ ] **Step 3: Keep the renderer dependency-free unless a real asset is selected**

Do not add `three`, Live2D, or VRM dependencies until the actual model format is chosen. This avoids locking the project into a renderer before assets exist.

## Task 7: Define Remote Avatar Service Contract

**Files:**
- Create: `OpenMAIC/lib/a3/digital-human-service-types.ts`
- Create: `OpenMAIC/tests/a3-digital-human-service-contract.test.ts`

- [ ] **Step 1: Write contract test**

Create `OpenMAIC/tests/a3-digital-human-service-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { A3AvatarServiceProvider, A3AvatarRenderSession } from '@/lib/a3/digital-human-service-types';

describe('A3 remote avatar service contract', () => {
  it('keeps avatar service separate from tutoring logic', () => {
    const provider: A3AvatarServiceProvider = 'openavatarchat_service';
    const session: A3AvatarRenderSession = {
      success: true,
      provider,
      mode: 'remote_video',
      renderSessionId: 'avatar-session-1',
      connection: {
        type: 'webrtc',
        connectionUrl: '/api/a3/coaching/avatar/sdp',
        readyForRemoteVideo: true,
      },
    };

    expect(session.provider).toBe('openavatarchat_service');
    expect(session.connection.readyForRemoteVideo).toBe(true);
  });
});
```

- [ ] **Step 2: Add service types**

Create `OpenMAIC/lib/a3/digital-human-service-types.ts`:

```ts
export type A3AvatarServiceProvider =
  | 'openavatarchat_service'
  | 'livetalking_service'
  | 'custom_avatar_service'
  | 'local_avatar_only';

export type A3AvatarRenderConnection = {
  type: 'webrtc' | 'websocket' | 'http_render' | 'local';
  connectionUrl?: string;
  readyForRemoteVideo: boolean;
  fallbackReason?: string;
};

export type A3AvatarRenderSession = {
  success: boolean;
  provider: A3AvatarServiceProvider;
  mode: 'remote_video' | 'local_3d' | 'local_2d' | 'static_fallback';
  renderSessionId: string;
  connection: A3AvatarRenderConnection;
  error?: string;
};
```

- [ ] **Step 3: Run contract test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-service-contract.test.ts
```

Expected: PASS.

## Task 8: Add Future Remote Avatar Provider Adapter

**Files:**
- Create: `OpenMAIC/lib/server/a3-avatar-provider.ts`
- Create: `OpenMAIC/app/api/a3/coaching/avatar/session/route.ts`
- Extend: `OpenMAIC/tests/a3-digital-human-service-contract.test.ts`

- [ ] **Step 1: Add server adapter contract test**

Extend `OpenMAIC/tests/a3-digital-human-service-contract.test.ts` with a file-content test:

```ts
import fs from 'node:fs';
import path from 'node:path';

it('keeps remote avatar provider secrets server-side', () => {
  const providerPath = path.resolve(process.cwd(), 'lib/server/a3-avatar-provider.ts');
  const source = fs.readFileSync(providerPath, 'utf8');

  expect(source).toContain('createA3AvatarRenderSession');
  expect(source).toContain('process.env.A3_AVATAR_SERVICE_URL');
  expect(source).not.toContain('NEXT_PUBLIC_A3_AVATAR_SERVICE_KEY');
});
```

- [ ] **Step 2: Create server adapter**

Create `OpenMAIC/lib/server/a3-avatar-provider.ts`:

```ts
import type { A3AvatarRenderSession } from '@/lib/a3/digital-human-service-types';

type CreateAvatarSessionInput = {
  coachingSessionId: string;
  userId: string;
};

export async function createA3AvatarRenderSession(input: CreateAvatarSessionInput): Promise<A3AvatarRenderSession> {
  const serviceUrl = process.env.A3_AVATAR_SERVICE_URL;
  const serviceKey = process.env.A3_AVATAR_SERVICE_KEY;

  if (!serviceUrl || !serviceKey) {
    return {
      success: true,
      provider: 'local_avatar_only',
      mode: 'local_3d',
      renderSessionId: `local-avatar-${input.coachingSessionId}`,
      connection: {
        type: 'local',
        readyForRemoteVideo: false,
        fallbackReason: '未配置远程数字人服务，使用本地 3D 数字人。',
      },
    };
  }

  return {
    success: true,
    provider: 'custom_avatar_service',
    mode: 'remote_video',
    renderSessionId: `remote-avatar-${input.coachingSessionId}`,
    connection: {
      type: 'webrtc',
      connectionUrl: '/api/a3/coaching/avatar/sdp',
      readyForRemoteVideo: true,
    },
  };
}
```

- [ ] **Step 3: Create API route**

Create `OpenMAIC/app/api/a3/coaching/avatar/session/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import { createA3AvatarRenderSession } from '@/lib/server/a3-avatar-provider';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = { user?: A3PublicUser | null };

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) return apiError('UNAUTHORIZED', 401, '请先登录后使用数字人辅导');

    const body = await request.json().catch(() => ({})) as { coachingSessionId?: string };
    const coachingSessionId = String(body.coachingSessionId || '').trim();
    if (!coachingSessionId) return apiError('MISSING_REQUIRED_FIELD', 400, '请提供辅导会话 ID');

    const avatar = await createA3AvatarRenderSession({
      coachingSessionId,
      userId: String(auth.user.id || auth.user.phone || 'a3-user'),
    });

    return apiSuccess(avatar);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '数字人会话创建失败', error instanceof Error ? error.message : undefined);
  }
}
```

- [ ] **Step 4: Run contract test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-service-contract.test.ts
```

Expected: PASS.

## Task 9: Add Runtime and Capability Evidence

**Files:**
- Modify: `OpenMAIC/app/api/a3/system/runtime/route.ts`
- Modify: backend demo status only if needed after inspecting existing capability payload
- Extend: existing capability tests if they cover realtime coaching

- [ ] **Step 1: Add runtime checks**

Add checks for:

```text
digitalHumanLocalAvatar: local component available
digitalHumanRemoteService: A3_AVATAR_SERVICE_URL configured or warning
digitalHumanMode: local_3d / remote_video / static_fallback
```

- [ ] **Step 2: Keep capability wording evidence-based**

Use language like:

```text
本地 3D 数字人已启用
远程拟真人服务未配置，当前使用本地数字人
```

Do not write:

```text
拟真人视频已成功接入
```

unless the remote WebRTC avatar service actually returns a video track.

## Task 10: Verification

Run these commands before claiming completion.

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.tsx tests/a3-digital-human-service-contract.test.ts tests/a3-realtime-coaching-contract.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Run the focused e2e check:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-digital-human-coaching.spec.ts --project=chromium
```

Run backend smoke checks if API/runtime payloads changed:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Manual browser check:

```text
Open http://127.0.0.1:3002/a3/coaching
Start realtime coaching
Confirm digital human appears
Confirm degraded provider still shows digital human and clear fallback reason
Confirm camera preview, screen preview, evidence panel, transcript, and interrupt button still work
```

## Acceptance Checklist

- [ ] `/a3/coaching` no longer presents the main assistant as a static `AI` circle.
- [ ] A visible digital human appears before and during realtime coaching.
- [ ] Avatar state changes for idle, connecting, listening, speaking, visual focus, degraded, error, and ended.
- [ ] Mouth movement is bounded and driven by current realtime state.
- [ ] Existing realtime provider flow remains unchanged.
- [ ] Existing RAG, citation, verifier, safety, frame analysis, and session persistence remain visible and functional.
- [ ] Provider failures degrade to current fallback flow without pretending remote avatar video succeeded.
- [ ] Tests cover local avatar rendering and realtime UI integration.
- [ ] No API key, signed URL, or local absolute asset path is exposed in frontend code.

## Open Decisions

- Choose final visual style: local CSS rig first, Live2D, VRM/GLB, or remote video.
- Choose asset source and license for any realistic teacher model.
- Decide whether to add `three` immediately or keep the first version dependency-free.
- Decide whether remote high-fidelity avatar service is needed for the competition demo or only for later productization.

## Recommended Execution Order

1. Implement Tasks 1-4 for a working local digital human in the current page.
2. Fix any existing Chinese乱码 in `realtime-coaching-call.tsx` before public demo.
3. Implement Task 5 only if the first avatar feels visually flat.
4. Implement Task 6 after selecting actual 2D/3D assets.
5. Implement Tasks 7-9 only when a remote avatar service is actually available.

## Self-Review

- Spec coverage: The plan covers the immediate request, current realtime baseline, browser-side digital human, optional 2D/3D asset upgrade, optional remote avatar service, tests, and verification.
- Placeholder scan: No `TBD` or open-ended implementation steps remain. Optional phases are explicitly scoped and have concrete contracts.
- Type consistency: `A3DigitalHumanAvatarState`, `A3DigitalHumanAvatarMode`, `A3DigitalHumanAvatarProps`, `A3AvatarRenderSession`, and provider names are consistent across tasks.
