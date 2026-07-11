import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  advanceAvatarFrame,
  resolveTeacherActionTransition,
  retainResourceUnlessDisposed,
  shouldStartAvatarAssetLoad,
  shouldRunAvatarAnimation,
} from '@/components/a3/features/coaching/digital-human-runtime';

describe('A3 digital teacher runtime decisions', () => {
  it('accumulates elapsed time from one meaningful delta per frame', () => {
    let elapsedSeconds = 0;
    const observedDeltas: number[] = [];

    for (let frame = 0; frame < 60; frame += 1) {
      const timing = advanceAvatarFrame(elapsedSeconds, 1 / 60);
      elapsedSeconds = timing.elapsedSeconds;
      observedDeltas.push(timing.deltaSeconds);
    }

    expect(elapsedSeconds).toBeCloseTo(1, 8);
    expect(Math.min(...observedDeltas)).toBeGreaterThan(0.016);
    expect(advanceAvatarFrame(elapsedSeconds, -1).deltaSeconds).toBe(0);
    expect(advanceAvatarFrame(elapsedSeconds, 2).deltaSeconds).toBe(0.1);
  });

  it('does not reset an available wait fallback every frame when nod is missing', () => {
    const decision = resolveTeacherActionTransition('nod', new Set(['wait', 'idle']), 'wait');

    expect(decision).toEqual({
      actualActionKey: 'wait',
      requestedActionAvailable: false,
      shouldTransition: false,
    });
  });

  it('disposes late resources instead of retaining them after teardown', () => {
    const resource = { id: 'late-vrm' };
    const dispose = vi.fn();

    expect(retainResourceUnlessDisposed(resource, true, dispose)).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(resource);
    expect(retainResourceUnlessDisposed(resource, false, dispose)).toBe(resource);
  });

  it('runs animation only while mounted, visible, and inside the viewport', () => {
    expect(
      shouldRunAvatarAnimation({ disposed: false, documentVisible: true, intersecting: true }),
    ).toBe(true);
    expect(
      shouldRunAvatarAnimation({ disposed: true, documentVisible: true, intersecting: true }),
    ).toBe(false);
    expect(
      shouldRunAvatarAnimation({ disposed: false, documentVisible: false, intersecting: true }),
    ).toBe(false);
    expect(
      shouldRunAvatarAnimation({ disposed: false, documentVisible: true, intersecting: false }),
    ).toBe(false);
  });

  it('starts the heavy avatar asset load once, only near the visible viewport', () => {
    expect(
      shouldStartAvatarAssetLoad({
        disposed: false,
        documentVisible: true,
        intersecting: true,
        loadStarted: false,
      }),
    ).toBe(true);
    expect(
      shouldStartAvatarAssetLoad({
        disposed: false,
        documentVisible: true,
        intersecting: false,
        loadStarted: false,
      }),
    ).toBe(false);
    expect(
      shouldStartAvatarAssetLoad({
        disposed: false,
        documentVisible: false,
        intersecting: true,
        loadStarted: false,
      }),
    ).toBe(false);
    expect(
      shouldStartAvatarAssetLoad({
        disposed: false,
        documentVisible: true,
        intersecting: true,
        loadStarted: true,
      }),
    ).toBe(false);
  });

  it('integrates viewport scheduling without statically importing the renderer on the A3 entry page', () => {
    const stageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-three-stage.tsx'),
      'utf8',
    );
    const a3EntrySource = fs.readFileSync(path.resolve(process.cwd(), 'app/a3/page.tsx'), 'utf8');

    expect(stageSource).toContain('new IntersectionObserver');
    expect(stageSource).toContain("document.visibilityState === 'visible'");
    expect(stageSource).toContain('new THREE.Timer()');
    expect(stageSource).not.toContain('new THREE.Clock()');
    expect(stageSource).toContain('advanceAvatarFrame');
    expect(stageSource).toContain('resolveTeacherActionTransition');
    expect(stageSource).toContain('retainResourceUnlessDisposed');
    expect(stageSource).toContain('disposeTeacherAction');
    expect(a3EntrySource).not.toMatch(/(?:from|require\()[^\n]*digital-human/);
  });

  it('loads the Three stage client-side behind a fixed-size semantic fallback', () => {
    const avatarSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/features/coaching/digital-human-avatar.tsx'),
      'utf8',
    );

    expect(avatarSource).toMatch(/dynamic\(\s*\(\) => import\('\.\/digital-human-three-stage'\)/);
    expect(avatarSource).toContain('ssr: false');
    expect(avatarSource).toContain('data-avatar-renderer="loading"');
    expect(avatarSource).toContain('data-testid="a3-digital-human-three-stage"');
    expect(avatarSource).toContain('h-[420px]');
    expect(avatarSource).not.toContain(
      "import { DigitalHumanThreeStage } from './digital-human-three-stage'",
    );
  });
});
