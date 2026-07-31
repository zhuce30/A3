// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AlgorithmLabLayout } from '@/components/a3/features/algorithm-lab/algorithm-lab-layout';
import { AlgorithmLabStatusPanel } from '@/components/a3/features/algorithm-lab/algorithm-lab-status-panel';
import { PageReplacementVisualizer } from '@/components/a3/features/algorithm-lab/page-replacement-visualizer';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';

let root: Root | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('algorithm lab responsive layout', () => {
  it('mounts each side region once while tabs and tablet controls target those regions', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root!.render(
        <AlgorithmLabLayout
          canvasRef={{ current: null }}
          inputPanel={<div data-testid="input-panel-instance">input</div>}
          canvas={<div data-testid="canvas-instance">canvas</div>}
          statusPanel={<div data-testid="status-panel-instance">status</div>}
          controls={<div>controls</div>}
          explanation={<div>explanation</div>}
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="input-panel-instance"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="status-panel-instance"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="canvas-instance"]')).toHaveLength(1);

    const inputTab = container.querySelector<HTMLButtonElement>('#algorithm-lab-tab-input')!;
    const inputPanel = container.querySelector<HTMLElement>('#algorithm-lab-panel-input')!;
    expect(inputTab.getAttribute('aria-controls')).toBe(inputPanel.id);
    expect(inputPanel.getAttribute('aria-labelledby')).toBe(inputTab.id);

    const tabletInputToggle = container.querySelector<HTMLButtonElement>('[aria-controls="algorithm-lab-input-content"]')!;
    expect(tabletInputToggle.getAttribute('aria-expanded')).toBe('false');
    act(() => tabletInputToggle.click());
    expect(tabletInputToggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('[data-testid="input-panel-instance"]')).toHaveLength(1);
  });

  it('mounts only historical and current page columns so future outcomes cannot be inspected', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const input = { referenceString: [1, 2, 3, 4, 5], frameCount: 2 };
    const runs = (['fifo', 'lru'] as const).map((algorithm) => (
      simulatePageReplacement(input, algorithm)
    ));
    const seeks: number[] = [];

    act(() => {
      root!.render(
        <PageReplacementVisualizer
          runs={runs}
          referenceString={input.referenceString}
          frameCount={input.frameCount}
          currentStepIndex={1}
          completed={false}
          onSeek={(index) => seeks.push(index)}
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="page-reference-column"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="page-state-column"]')).toHaveLength(4);
    expect(container.querySelector('[data-reference-index="2"]')).toBeNull();
    expect(container.textContent).toContain('当前列 2 / 5');

    const currentColumn = container.querySelector<HTMLButtonElement>(
      '[data-testid="page-reference-column"][data-reference-index="1"]',
    )!;
    act(() => currentColumn.click());
    expect(seeks).toEqual([1]);
  });

  it('shows cumulative in-progress page fault rates and preserves the final rate', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const run = simulatePageReplacement(
      { referenceString: [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2], frameCount: 3 },
      'fifo',
    );

    act(() => {
      root!.render(
        <AlgorithmLabStatusPanel
          phase="running"
          speed={1}
          currentStepIndex={4}
          finalStepIndex={12}
          replayCount={0}
          syncState="idle"
          syncError=""
          pageRuns={[run]}
          onSpeedChange={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain('80%');

    act(() => {
      root!.render(
        <AlgorithmLabStatusPanel
          phase="completed"
          speed={1}
          currentStepIndex={12}
          finalStepIndex={12}
          replayCount={0}
          syncState="idle"
          syncError=""
          pageRuns={[run]}
          onSpeedChange={() => undefined}
        />,
      );
    });
    expect(container.textContent).toContain('76.92%');
  });
});
