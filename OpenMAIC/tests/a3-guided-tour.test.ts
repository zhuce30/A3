import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  a3GuidedTours,
  buildA3TourStorageKey,
  getA3TourForRoute,
  parseA3TourState,
  resolveA3TourSteps,
  shouldAutoStartA3Tour,
} from '@/lib/a3/guided-tour';

describe('A3 guided tour configuration', () => {
  it('defines the five approved versioned tours with short step sequences', () => {
    expect(a3GuidedTours.map((tour) => tour.id)).toEqual([
      'profile-setup',
      'admission-diagnostic',
      'today-plan',
      'resource-generation',
      'knowledge-base-indexing',
    ]);
    for (const tour of a3GuidedTours) {
      expect(tour.version, tour.id).toBe(1);
      expect(tour.steps.length, tour.id).toBeGreaterThanOrEqual(3);
      expect(tour.steps.length, tour.id).toBeLessThanOrEqual(5);
      expect(new Set(tour.steps.map((step) => step.target)).size, tour.id).toBe(
        tour.steps.length,
      );
    }
  });

  it('matches route and role without exposing teacher knowledge-base guidance to students', () => {
    expect(getA3TourForRoute('/a3/recommendations', 'student')?.id).toBe(
      'resource-generation',
    );
    expect(getA3TourForRoute('/a3/knowledge-base', 'teacher')?.id).toBe(
      'knowledge-base-indexing',
    );
    expect(getA3TourForRoute('/a3/knowledge-base', 'student')).toBeNull();
    expect(getA3TourForRoute('/a3/report', 'student')).toBeNull();
  });

  it('uses a user, tour, and version scoped storage key', () => {
    expect(buildA3TourStorageKey('user-1', 'profile-setup', 1)).toBe(
      'a3-tour:user-1:profile-setup:1',
    );
  });

  it('parses valid completion metadata and rejects malformed values', () => {
    expect(parseA3TourState('{"status":"completed","updatedAt":"2026-07-19T00:00:00.000Z"}')).toEqual({
      status: 'completed',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    expect(parseA3TourState('{"status":"other"}')).toBeNull();
    expect(parseA3TourState('not-json')).toBeNull();
    expect(parseA3TourState(null)).toBeNull();
  });

  it('skips missing targets and reports an empty resolved tour safely', () => {
    const steps = a3GuidedTours[0]!.steps;
    expect(resolveA3TourSteps(steps, (selector) => selector !== steps[1]!.target)).toHaveLength(
      steps.length - 1,
    );
    expect(resolveA3TourSteps(steps, () => false)).toEqual([]);
  });

  it('auto-starts only unfinished tours with a visible first target and no blocking activity', () => {
    expect(
      shouldAutoStartA3Tour({ state: null, hasVisibleTarget: true, blockingActivity: false }),
    ).toBe(true);
    expect(
      shouldAutoStartA3Tour({
        state: { status: 'dismissed', updatedAt: '2026-07-19T00:00:00.000Z' },
        hasVisibleTarget: true,
        blockingActivity: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoStartA3Tour({ state: null, hasVisibleTarget: false, blockingActivity: false }),
    ).toBe(false);
    expect(
      shouldAutoStartA3Tour({ state: null, hasVisibleTarget: true, blockingActivity: true }),
    ).toBe(false);
  });
});

describe('A3 guided tour runtime boundary', () => {
  const providerPath = path.resolve(
    process.cwd(),
    'components/a3/guided-tour/guided-tour-provider.tsx',
  );
  const overlayPath = path.resolve(
    process.cwd(),
    'components/a3/guided-tour/guided-tour-overlay.tsx',
  );
  const layoutSource = fs.readFileSync(path.resolve(process.cwd(), 'app/a3/layout.tsx'), 'utf8');
  const workspaceFrameSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/layout/a3-workspace-frame.tsx'),
    'utf8',
  );

  it('mounts one provider inside auth for learning workspaces only', () => {
    expect(layoutSource).toContain('<A3AuthGate>');
    expect(layoutSource).toContain('<A3WorkspaceFrame>{children}</A3WorkspaceFrame>');
    expect(workspaceFrameSource).toContain('<A3GuidedTourProvider>');
    expect(workspaceFrameSource.indexOf('<A3GuidedTourProvider>')).toBeLessThan(
      workspaceFrameSource.indexOf('<A3Shell>'),
    );
    expect(workspaceFrameSource.indexOf('<AdminConsoleLayout>')).toBeLessThan(
      workspaceFrameSource.indexOf('<A3GuidedTourProvider>'),
    );
  });

  it('supports replay, bounded target waiting, and local completion state', () => {
    expect(fs.existsSync(providerPath)).toBe(true);
    const source = fs.existsSync(providerPath) ? fs.readFileSync(providerPath, 'utf8') : '';
    expect(source).toContain("searchParams.get('tour')");
    expect(source).toContain('buildA3TourStorageKey');
    expect(source).toContain('window.localStorage');
    expect(source).toContain('A3_TOUR_TARGET_WAIT_MS');
    expect(source).toContain('resolveA3TourSteps');
  });

  it('isolates URL search params behind suspense without suspending page content', () => {
    const source = fs.existsSync(providerPath) ? fs.readFileSync(providerPath, 'utf8') : '';
    expect(source).toContain('<Suspense fallback={null}>');
    expect(source).toContain('<A3GuidedTourController />');
    expect(source.indexOf('{children}')).toBeLessThan(source.indexOf('<Suspense fallback={null}>'));
  });

  it('renders an accessible controllable overlay with mobile fallback', () => {
    expect(fs.existsSync(overlayPath)).toBe(true);
    const source = fs.existsSync(overlayPath) ? fs.readFileSync(overlayPath, 'utf8') : '';
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('上一步');
    expect(source).toContain('下一步');
    expect(source).toContain('跳过');
    expect(source).toContain('max-sm:inset-x-3');
  });
});

describe('A3 guided tour workflow anchors', () => {
  const targetSources = [
    'components/a3/auth/a3-auth-pages.tsx',
    'components/a3/features/admission-diagnostic-view.tsx',
    'components/a3/features/today-learning-view.tsx',
    'components/a3/features/recommendations-view.tsx',
    'components/a3/features/knowledge-base-view.tsx',
  ].map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');
  const topActionsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx'),
    'utf8',
  );

  it('maps every configured target to exactly one stable page anchor', () => {
    for (const target of a3GuidedTours.flatMap((tour) => tour.steps.map((step) => step.target))) {
      const tourId = target.match(/data-tour-id="([^"]+)"/)?.[1];
      expect(tourId, target).toBeTruthy();
      expect(targetSources.match(new RegExp(`data-tour-id=["']${tourId}["']`, 'g'))?.length ?? 0, target)
        .toBe(1);
    }
  });

  it('offers a current-page restart only when a route has a configured tour', () => {
    expect(topActionsSource).toContain('getA3TourForRoute(pathname, currentUser?.role)');
    expect(topActionsSource).toContain('A3_TOUR_START_EVENT');
    expect(topActionsSource).toContain('重新查看本页引导');
  });
});
