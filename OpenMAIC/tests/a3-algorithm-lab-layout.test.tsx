// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AlgorithmLabLayout } from '@/components/a3/features/algorithm-lab/algorithm-lab-layout';

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
});
