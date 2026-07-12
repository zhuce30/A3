'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar';
import { A3HomepageProductMedia } from './a3-homepage-product-media';
import styles from './a3-product-homepage.module.css';

export const A3_HOMEPAGE_TEACHER_ROOT_MARGIN = '160px';
export const A3_HOMEPAGE_TEACHER_STABILITY_MS = 120;

const TERMINAL_TEACHER_RENDERERS = new Set([
  'vrm',
  'vrm_idle_animation',
  'primitive',
  'static_fallback',
]);

export const A3_HOMEPAGE_TEACHER_DEMO_PROPS = {
  state: 'listening',
  mode: 'local_vrm',
  audioLevel: 0,
  assistantSpeaking: false,
  providerLabel: '本地数字教师',
  modelLabel: '静音演示',
} as const;

export function shouldActivateTeacherStage(
  entry: Pick<IntersectionObserverEntry, 'isIntersecting'>,
) {
  return entry.isIntersecting;
}

export function isTerminalTeacherRenderer(renderer: string | null) {
  return renderer !== null && TERMINAL_TEACHER_RENDERERS.has(renderer);
}

export function deriveTeacherHandoffState(renderer: string | null) {
  const rendererReady = isTerminalTeacherRenderer(renderer);
  return { fallbackRequired: !rendererReady || renderer === 'primitive', rendererReady };
}

export function shouldDismissTeacherFallback(
  rendererReady: boolean,
  _trigger: 'transition_end' | 'transition_cancel' | 'timeout',
) {
  return rendererReady;
}

function useHomepageReducedMotion(onReduce: () => void) {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window === 'undefined'
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updatePreference = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
      if (event.matches) onReduce();
    };

    media.addEventListener('change', updatePreference);
    return () => media.removeEventListener('change', updatePreference);
  }, [onReduce]);

  return reducedMotion;
}

export function A3HomepageTeacherStage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [preserveFallback, setPreserveFallback] = useState(false);
  const [fallbackVisible, setFallbackVisible] = useState(true);
  const resetToStaticFallback = useCallback(() => {
    setActive(false);
    setRendererReady(false);
    setPreserveFallback(false);
    setFallbackVisible(true);
  }, []);
  const reducedMotion = useHomepageReducedMotion(resetToStaticFallback);

  useEffect(() => {
    if (reducedMotion) return;

    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && shouldActivateTeacherStage(entry)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { rootMargin: A3_HOMEPAGE_TEACHER_ROOT_MARGIN },
    );

    observer.observe(root);
    return () => observer.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    const root = rootRef.current;
    if (reducedMotion || !active || !root || typeof MutationObserver === 'undefined') return;

    let stabilityTimeoutId: number | null = null;
    let terminalConfirmed = false;
    const cancelStabilityCheck = () => {
      if (stabilityTimeoutId === null) return;
      window.clearTimeout(stabilityTimeoutId);
      stabilityTimeoutId = null;
    };
    const restoreFallback = () => {
      cancelStabilityCheck();
      terminalConfirmed = false;
      const fallback = root.querySelector<HTMLElement>(
        '[data-testid="a3-homepage-teacher-fallback"]',
      );
      fallback?.classList.remove(styles.teacherFallbackHidden);
      fallback?.setAttribute('aria-hidden', 'false');
      setRendererReady(false);
      setPreserveFallback(false);
      setFallbackVisible(true);
    };
    const updateRendererState = () => {
      const renderer = root.querySelector<HTMLElement>('[data-avatar-renderer]');
      const handoffState = deriveTeacherHandoffState(renderer?.dataset.avatarRenderer ?? null);
      if (!handoffState.rendererReady) {
        restoreFallback();
        return;
      }
      if (terminalConfirmed) {
        setPreserveFallback(handoffState.fallbackRequired);
        if (handoffState.fallbackRequired) setFallbackVisible(true);
        return;
      }
      if (stabilityTimeoutId !== null) return;

      stabilityTimeoutId = window.setTimeout(() => {
        stabilityTimeoutId = null;
        const currentRenderer = root.querySelector<HTMLElement>('[data-avatar-renderer]');
        const currentState = deriveTeacherHandoffState(
          currentRenderer?.dataset.avatarRenderer ?? null,
        );
        if (!currentState.rendererReady) {
          restoreFallback();
          return;
        }
        terminalConfirmed = true;
        setPreserveFallback(currentState.fallbackRequired);
        if (currentState.fallbackRequired) setFallbackVisible(true);
        setRendererReady(true);
      }, A3_HOMEPAGE_TEACHER_STABILITY_MS);
    };
    const mutationObserver = new MutationObserver(updateRendererState);

    mutationObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-avatar-renderer'],
      childList: true,
      subtree: true,
    });
    updateRendererState();

    return () => {
      cancelStabilityCheck();
      mutationObserver.disconnect();
    };
  }, [active, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || !rendererReady || preserveFallback) return;

    const timeoutId = window.setTimeout(() => {
      if (shouldDismissTeacherFallback(rendererReady, 'timeout')) setFallbackVisible(false);
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [preserveFallback, reducedMotion, rendererReady]);

  const dismissFallback = (trigger: 'transition_end' | 'transition_cancel') => {
    if (shouldDismissTeacherFallback(rendererReady, trigger)) setFallbackVisible(false);
  };

  return (
    <div
      ref={rootRef}
      className={styles.teacherStage}
      data-testid="a3-homepage-teacher-stage"
      data-renderer={rendererReady ? 'terminal' : active ? 'loading' : 'fallback'}
    >
      <div className={styles.teacherVisual} data-testid="a3-homepage-teacher-visual">
        {active && !reducedMotion ? (
          <div className={styles.teacherRenderer}>
            <DigitalHumanAvatar {...A3_HOMEPAGE_TEACHER_DEMO_PROPS} />
          </div>
        ) : null}
        {fallbackVisible ? (
          <div
            className={`${styles.teacherFallback} ${rendererReady && !preserveFallback ? styles.teacherFallbackHidden : ''}`}
            data-testid="a3-homepage-teacher-fallback"
            aria-hidden={rendererReady && !preserveFallback}
            onTransitionEnd={(event) => {
              if (event.propertyName === 'opacity') dismissFallback('transition_end');
            }}
            onTransitionCancel={() => dismissFallback('transition_cancel')}
          >
            <A3HomepageProductMedia
              src="/a3/assets/homepage/teacher-fallback.webp"
              alt="数字教师实时辅导界面"
              priority
              sizes="(max-width: 768px) 100vw, 92vw"
              fallbackKind="teacher"
            />
          </div>
        ) : null}
      </div>
      <div className={styles.teacherPrompt}>正在倾听：进程调度为什么会发生饥饿？</div>
      <Link className={styles.teacherLink} href="/a3/coaching">
        进入实时辅导
      </Link>
    </div>
  );
}
