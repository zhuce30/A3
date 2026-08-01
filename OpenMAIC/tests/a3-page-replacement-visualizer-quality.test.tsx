// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describePageStateColumn,
  PageReplacementVisualizer,
} from '@/components/a3/features/algorithm-lab/page-replacement-visualizer';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';

const input = { referenceString: [1, 2, 3], frameCount: 1 };
const runs = (['fifo', 'lru', 'opt'] as const).map((algorithm) => (
  simulatePageReplacement(input, algorithm)
));
const scrollIntoView = vi.fn();
let root: Root | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  scrollIntoView.mockReset();
  document.body.replaceChildren();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function renderVisualizer(container: HTMLElement, currentStepIndex: number) {
  act(() => {
    root!.render(
      <PageReplacementVisualizer
        runs={runs}
        referenceString={input.referenceString}
        frameCount={input.frameCount}
        currentStepIndex={currentStepIndex}
        completed={currentStepIndex === input.referenceString.length - 1}
        onSeek={() => undefined}
      />,
    );
  });
}

describe('page replacement visualizer quality regressions', () => {
  it('automatically follows playback and offers an explicit return-to-current-step command', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderVisualizer(container, 0);
    scrollIntoView.mockClear();

    renderVisualizer(container, 1);
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: 'center' }));

    scrollIntoView.mockClear();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="回到当前步骤"]')!.click());
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('renders one selectable algorithm on mobile, parallel rows on desktop, and keeps comparison in metrics', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderVisualizer(container, 1);

    const views = container.querySelector<HTMLElement>('[data-testid="page-algorithm-views"]')!;
    expect(views.querySelectorAll('[data-testid^="page-algorithm-row-"]')).toHaveLength(3);
    expect(views.querySelectorAll('[data-mobile-active="true"]')).toHaveLength(1);
    expect(views.querySelector('[data-testid="page-algorithm-row-fifo"]')!.parentElement!.className).toContain('block');
    expect(views.querySelector('[data-testid="page-algorithm-row-lru"]')!.parentElement!.className).toContain('hidden lg:block');

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="移动端查看 LRU"]')!.click());
    expect(views.querySelector('[data-testid="page-algorithm-row-lru"]')!.parentElement!.getAttribute('data-mobile-active')).toBe('true');

    const visualizerSource = readFileSync(
      join(process.cwd(), 'components/a3/features/algorithm-lab/page-replacement-visualizer.tsx'),
      'utf8',
    );
    const statusSource = readFileSync(
      join(process.cwd(), 'components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx'),
      'utf8',
    );
    expect(visualizerSource).not.toContain('function PageComparisonResult');
    expect(statusSource).toContain('在本次比较中缺页最少');
  });

  it('exposes frame page, insertion, and eviction semantics without a parent aria-label override', () => {
    const fifo = runs[0];
    const hiddenVictim = describePageStateColumn(fifo, 1, 1, false);
    const revealedVictim = describePageStateColumn(fifo, 1, 1, true);

    expect(hiddenVictim).toContain('页框 1：页面 2，调入');
    expect(hiddenVictim).toContain('发生淘汰，淘汰页待判断');
    expect(revealedVictim).toContain('淘汰页面 1');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderVisualizer(container, 1);
    const column = container.querySelector<HTMLButtonElement>(
      '[data-mobile-active="true"] [data-testid="page-state-column"][data-reference-index="1"]',
    )!;

    expect(column.hasAttribute('aria-label')).toBe(false);
    expect(column.textContent).toContain('页框 1：页面 2，调入');
    expect(column.textContent).toContain('发生淘汰，淘汰页待判断');
  });
});
