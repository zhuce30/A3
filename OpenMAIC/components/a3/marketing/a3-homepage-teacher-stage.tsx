'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar';
import styles from './a3-product-homepage.module.css';

export const A3_HOMEPAGE_TEACHER_ROOT_MARGIN = '160px';
export const A3_HOMEPAGE_TEACHER_STABILITY_MS = 120;
export const A3_HOMEPAGE_TEACHER_DEMO_DURATION_MS = 8_000;

export type A3HomepageTeacherDemoPhase = 'appear' | 'listen' | 'question' | 'complete';
type A3HomepageTeacherRenderPhase = 'static' | A3HomepageTeacherDemoPhase;

const A3_HOMEPAGE_TEACHER_PHASE_BOUNDARIES = [
  { at: 1_800, phase: 'listen' },
  { at: 3_600, phase: 'question' },
  { at: A3_HOMEPAGE_TEACHER_DEMO_DURATION_MS, phase: 'complete' },
] as const;

export function resolveTeacherDemoPhase(elapsedMs: number): A3HomepageTeacherDemoPhase {
  if (elapsedMs >= A3_HOMEPAGE_TEACHER_DEMO_DURATION_MS) return 'complete';
  if (elapsedMs >= 3_600) return 'question';
  if (elapsedMs >= 1_800) return 'listen';
  return 'appear';
}

export function shouldStartTeacherDemo({
  active,
  reducedMotion,
  started,
  visualReady,
}: {
  active: boolean;
  reducedMotion: boolean;
  started: boolean;
  visualReady: boolean;
}) {
  return active && visualReady && !reducedMotion && !started;
}

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
  const activationStartedRef = useRef(false);
  const timelineStartedRef = useRef(false);
  const [active, setActive] = useState(false);
  const [demoPhase, setDemoPhase] = useState<A3HomepageTeacherRenderPhase>('static');
  const [visualReady, setVisualReady] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [preserveFallback, setPreserveFallback] = useState(false);
  const [fallbackVisible, setFallbackVisible] = useState(true);
  const [fallbackImageFailed, setFallbackImageFailed] = useState(false);
  const resetToStaticFallback = useCallback(() => {
    setActive(false);
    setDemoPhase('static');
    setRendererReady(false);
    setPreserveFallback(false);
    setFallbackVisible(true);
  }, []);
  const reducedMotion = useHomepageReducedMotion(resetToStaticFallback);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || visualReady) return;

    const updateVisualReady = () => {
      const image = root.querySelector<HTMLImageElement>(
        '[data-testid="a3-homepage-teacher-fallback"] img',
      );
      if (image?.complete && image.naturalWidth > 0) setVisualReady(true);
    };
    const image = root.querySelector<HTMLImageElement>(
      '[data-testid="a3-homepage-teacher-fallback"] img',
    );
    image?.addEventListener('load', updateVisualReady);
    image?.addEventListener('error', updateVisualReady);
    const observer = new MutationObserver(updateVisualReady);
    observer.observe(root, { childList: true, subtree: true });
    updateVisualReady();
    return () => {
      image?.removeEventListener('load', updateVisualReady);
      image?.removeEventListener('error', updateVisualReady);
      observer.disconnect();
    };
  }, [visualReady]);

  useEffect(() => {
    if (reducedMotion) return;

    const root = rootRef.current;
    if (!root || activationStartedRef.current || typeof IntersectionObserver === 'undefined')
      return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry && shouldActivateTeacherStage(entry)) {
          activationStartedRef.current = true;
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
    if (
      !shouldStartTeacherDemo({
        active,
        reducedMotion,
        started: timelineStartedRef.current,
        visualReady,
      })
    )
      return;

    timelineStartedRef.current = true;
    const timeoutIds = [{ at: 0 }, ...A3_HOMEPAGE_TEACHER_PHASE_BOUNDARIES].map(({ at }) =>
      window.setTimeout(() => setDemoPhase(resolveTeacherDemoPhase(at)), at),
    );

    return () => timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
  }, [active, reducedMotion, visualReady]);

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
  const renderPhase = reducedMotion ? 'complete' : demoPhase;

  return (
    <div
      ref={rootRef}
      className={styles.teacherStage}
      data-testid="a3-homepage-teacher-stage"
      data-renderer={rendererReady ? 'terminal' : active ? 'loading' : 'fallback'}
      data-demo-phase={renderPhase}
      data-demo-active={active}
      data-visual-ready={visualReady}
    >
      <div className={styles.teacherVisual} data-testid="a3-homepage-teacher-visual">
        {active && !reducedMotion ? (
          <div className={styles.teacherRenderer}>
            <DigitalHumanAvatar
              {...A3_HOMEPAGE_TEACHER_DEMO_PROPS}
              state={renderPhase === 'appear' ? 'idle' : 'listening'}
            />
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
            {fallbackImageFailed ? (
              <div className={styles.mediaFallback} role="img" aria-label="数字教师实时辅导界面">
                <strong>数字教师画面暂未加载</strong>
                <span>你仍可继续浏览完整学习流程。</span>
              </div>
            ) : (
              <Image
                src="/a3/assets/homepage/teacher-fallback.webp"
                alt="数字教师实时辅导界面"
                fill
                sizes="(max-width: 768px) 100vw, 92vw"
                onLoad={() => setVisualReady(true)}
                onError={() => {
                  setFallbackImageFailed(true);
                  setVisualReady(true);
                }}
              />
            )}
          </div>
        ) : null}
      </div>
      {renderPhase === 'listen' ? (
        <div className={styles.teacherStatus} data-testid="a3-homepage-teacher-status">
          正在倾听
        </div>
      ) : null}
      {renderPhase === 'static' || renderPhase === 'question' || renderPhase === 'complete' ? (
        <div className={styles.teacherPrompt} data-testid="a3-homepage-teacher-prompt">
          正在倾听：进程调度为什么会发生饥饿？
        </div>
      ) : null}
      <Link className={styles.teacherLink} href="/a3/coaching" prefetch={false}>
        进入实时辅导
      </Link>
    </div>
  );
}
