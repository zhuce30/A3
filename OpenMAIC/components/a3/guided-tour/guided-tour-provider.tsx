'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { A3GuidedTourOverlay } from '@/components/a3/guided-tour/guided-tour-overlay';
import {
  buildA3TourStorageKey,
  getA3TourById,
  getA3TourForRoute,
  parseA3TourState,
  resolveA3TourSteps,
  shouldAutoStartA3Tour,
  type A3GuidedTour,
  type A3TourId,
  type A3TourState,
  type A3TourStep,
} from '@/lib/a3/guided-tour';

export const A3_TOUR_TARGET_WAIT_MS = 3200;
export const A3_TOUR_START_EVENT = 'a3-guided-tour-start';

type ActiveTour = { tour: A3GuidedTour; steps: A3TourStep[] };

export function A3GuidedTourProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <A3GuidedTourController />
      </Suspense>
    </>
  );
}

function A3GuidedTourController() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useA3CurrentUser();
  const [active, setActive] = useState<ActiveTour | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const handledReplay = useRef<string | null>(null);
  const userId = user?.id;

  const persist = useCallback((tour: A3GuidedTour, status: A3TourState['status']) => {
    if (!userId) return;
    window.localStorage.setItem(
      buildA3TourStorageKey(userId, tour.id, tour.version),
      JSON.stringify({ status, updatedAt: new Date().toISOString() } satisfies A3TourState),
    );
  }, [userId]);

  const startTour = useCallback(async (tour: A3GuidedTour, force: boolean) => {
    if (!user?.id || !tour.audience.includes(user.role) || !tour.routes.includes(pathname)) return;
    const steps = await waitForTourSteps(tour.steps);
    if (!steps.length) return;
    const stored = parseA3TourState(window.localStorage.getItem(buildA3TourStorageKey(user.id, tour.id, tour.version)));
    if (!force && !shouldAutoStartA3Tour({ state: stored, hasVisibleTarget: true, blockingActivity: hasBlockingActivity() })) return;
    setStepIndex(0);
    setActive({ tour, steps });
  }, [pathname, user]);

  useEffect(() => {
    if (!user?.id) return;
    const replayId = searchParams.get('tour');
    const replayKey = replayId ? `${pathname}:${replayId}` : null;
    if (replayKey && handledReplay.current !== replayKey) {
      const replayTour = getA3TourById(replayId);
      if (!replayTour) return;
      const timer = window.setTimeout(() => {
        handledReplay.current = replayKey;
        void startTour(replayTour, true);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const automatic = getA3TourForRoute(pathname, user.role);
    if (!automatic) return;
    const timer = window.setTimeout(() => void startTour(automatic, false), 700);
    return () => window.clearTimeout(timer);
  }, [pathname, searchParams, startTour, user]);

  useEffect(() => {
    const handleStart = (event: Event) => {
      const id = (event as CustomEvent<{ tourId?: A3TourId }>).detail?.tourId;
      const tour = getA3TourById(id);
      if (tour) void startTour(tour, true);
    };
    window.addEventListener(A3_TOUR_START_EVENT, handleStart);
    return () => window.removeEventListener(A3_TOUR_START_EVENT, handleStart);
  }, [startTour]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      const step = active.steps[stepIndex];
      if (step && isVisibleTarget(step.target)) return;
      const nextIndex = active.steps.findIndex((candidate, index) => index > stepIndex && isVisibleTarget(candidate.target));
      if (nextIndex >= 0) setStepIndex(nextIndex);
      else setActive(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, stepIndex]);

  const close = (status: A3TourState['status']) => {
    if (active) persist(active.tour, status);
    setActive(null);
    setStepIndex(0);
  };

  if (!active?.steps[stepIndex]) return null;

  return (
    <A3GuidedTourOverlay
      tour={active.tour}
      step={active.steps[stepIndex]}
      stepIndex={stepIndex}
      stepCount={active.steps.length}
      onPrevious={() => setStepIndex((current) => Math.max(0, current - 1))}
      onNext={() => {
        if (stepIndex >= active.steps.length - 1) close('completed');
        else setStepIndex((current) => current + 1);
      }}
      onDismiss={() => close('dismissed')}
    />
  );
}

async function waitForTourSteps(steps: A3TourStep[]) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < A3_TOUR_TARGET_WAIT_MS) {
    const available = resolveA3TourSteps(steps, isVisibleTarget);
    if (available.length) return available;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  return [];
}

function isVisibleTarget(selector: string) {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  const style = window.getComputedStyle(target);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function hasBlockingActivity() {
  return Boolean(document.querySelector('[data-a3-blocking-activity="true"], [aria-busy="true"]'));
}
