'use client';

import { useState } from 'react';
import styles from './a3-product-homepage.module.css';

type ClassroomMode = 'lesson' | 'citations';

export function A3HomepageClassroomIsland() {
  const [mode, setMode] = useState<ClassroomMode>('lesson');

  return (
    <div className={styles.classroomControls}>
      <div role="group" aria-label="课堂展示模式" className={styles.segmentedControl}>
        <button type="button" aria-pressed={mode === 'lesson'} onClick={() => setMode('lesson')}>
          讲解
        </button>
        <button
          type="button"
          aria-pressed={mode === 'citations'}
          onClick={() => setMode('citations')}
        >
          引用
        </button>
      </div>
      <div aria-live="polite">
        {mode === 'citations' ? (
          <div className={styles.citationLabels}>
            <span>操作系统 / 第 3 章 / 课程 PPT</span>
            <span>进程调度 / 知识总结</span>
          </div>
        ) : (
          <p className={styles.lessonFocus}>当前讲解：进程调度中的饥饿与公平性</p>
        )}
      </div>
    </div>
  );
}
