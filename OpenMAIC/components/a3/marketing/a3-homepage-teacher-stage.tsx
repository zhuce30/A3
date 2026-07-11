'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import styles from './a3-product-homepage.module.css';

const DigitalHumanAvatar = dynamic(
  () =>
    import('@/components/a3/features/coaching/digital-human-avatar').then(
      (module) => module.DigitalHumanAvatar,
    ),
  { ssr: false },
);

export const A3_HOMEPAGE_TEACHER_ROOT_MARGIN = '160px';

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

export function A3HomepageTeacherStage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

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

  return (
    <div
      ref={rootRef}
      className={styles.teacherStage}
      data-testid="a3-homepage-teacher-stage"
      data-renderer={active ? 'digital-human' : 'fallback'}
    >
      <div className={styles.teacherVisual}>
        {active ? (
          <DigitalHumanAvatar {...A3_HOMEPAGE_TEACHER_DEMO_PROPS} />
        ) : (
          <Image
            src="/a3/assets/homepage/teacher-fallback.webp"
            alt="数字教师实时辅导界面"
            fill
            sizes="(max-width: 768px) 100vw, 92vw"
          />
        )}
      </div>
      <div className={styles.teacherPrompt}>正在倾听：进程调度为什么会发生饥饿？</div>
      <Link className={styles.teacherLink} href="/a3/coaching">
        进入实时辅导
      </Link>
    </div>
  );
}
