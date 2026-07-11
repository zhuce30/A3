'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar';
import styles from './a3-product-homepage.module.css';

export const A3_HOMEPAGE_TEACHER_ROOT_MARGIN = '160px';

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

export function A3HomepageTeacherStage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [rendererReady, setRendererReady] = useState(false);
  const [fallbackVisible, setFallbackVisible] = useState(true);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root || typeof MutationObserver === 'undefined') return;

    const updateRendererState = () => {
      const renderer = root.querySelector<HTMLElement>('[data-avatar-renderer]');
      if (isTerminalTeacherRenderer(renderer?.dataset.avatarRenderer ?? null)) {
        setRendererReady(true);
      }
    };
    const mutationObserver = new MutationObserver(updateRendererState);

    mutationObserver.observe(root, {
      attributes: true,
      attributeFilter: ['data-avatar-renderer'],
      childList: true,
      subtree: true,
    });
    updateRendererState();

    return () => mutationObserver.disconnect();
  }, [active]);

  return (
    <div
      ref={rootRef}
      className={styles.teacherStage}
      data-testid="a3-homepage-teacher-stage"
      data-renderer={rendererReady ? 'terminal' : active ? 'loading' : 'fallback'}
    >
      <div className={styles.teacherVisual} data-testid="a3-homepage-teacher-visual">
        {active ? (
          <div className={styles.teacherRenderer}>
            <DigitalHumanAvatar {...A3_HOMEPAGE_TEACHER_DEMO_PROPS} />
          </div>
        ) : null}
        {fallbackVisible ? (
          <div
            className={`${styles.teacherFallback} ${rendererReady ? styles.teacherFallbackHidden : ''}`}
            data-testid="a3-homepage-teacher-fallback"
            onTransitionEnd={(event) => {
              if (rendererReady && event.propertyName === 'opacity') setFallbackVisible(false);
            }}
          >
            <Image
              src="/a3/assets/homepage/teacher-fallback.webp"
              alt="数字教师实时辅导界面"
              fill
              sizes="(max-width: 768px) 100vw, 92vw"
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
