'use client';

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type MobilePanel = 'input' | 'run' | 'result';

const mobileTabs = [
  { value: 'input', label: '输入', tabId: 'algorithm-lab-tab-input', panelId: 'algorithm-lab-panel-input' },
  { value: 'run', label: '运行', tabId: 'algorithm-lab-tab-run', panelId: 'algorithm-lab-panel-run' },
  { value: 'result', label: '结果', tabId: 'algorithm-lab-tab-result', panelId: 'algorithm-lab-panel-result' },
] as const;

export function getNextMobilePanel(current: MobilePanel, key: string): MobilePanel {
  const currentIndex = mobileTabs.findIndex((tab) => tab.value === current);
  if (key === 'Home') return mobileTabs[0].value;
  if (key === 'End') return mobileTabs[mobileTabs.length - 1].value;
  if (key === 'ArrowRight') return mobileTabs[(currentIndex + 1) % mobileTabs.length].value;
  if (key === 'ArrowLeft') return mobileTabs[(currentIndex - 1 + mobileTabs.length) % mobileTabs.length].value;
  return current;
}

interface AlgorithmLabLayoutProps {
  inputPanel: ReactNode;
  canvas: ReactNode;
  statusPanel: ReactNode;
  controls: ReactNode;
  explanation: ReactNode;
  canvasRef: React.RefObject<HTMLDivElement | null>;
}

export function AlgorithmLabLayout({
  inputPanel,
  canvas,
  statusPanel,
  controls,
  explanation,
  canvasRef,
}: AlgorithmLabLayoutProps) {
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('run');
  const tabRefs = useRef<Partial<Record<MobilePanel, HTMLButtonElement | null>>>({});

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: MobilePanel) {
    const next = getNextMobilePanel(current, event.key);
    if (next === current) return;
    event.preventDefault();
    setMobilePanel(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-sm">
      <div className="grid grid-cols-3 border-b border-[var(--a3-border)] p-1 md:hidden" role="tablist" aria-label="实验工作区">
        {mobileTabs.map(({ value, label, tabId, panelId }) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[value] = element; }}
            id={tabId}
            type="button"
            role="tab"
            aria-selected={mobilePanel === value}
            aria-controls={panelId}
            tabIndex={mobilePanel === value ? 0 : -1}
            onClick={() => setMobilePanel(value)}
            onKeyDown={(event) => handleTabKeyDown(event, value)}
            className={`h-9 rounded-md text-sm font-medium ${mobilePanel === value ? 'bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50' : 'text-[var(--a3-text-muted)]'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="hidden grid-cols-2 border-b border-[var(--a3-border)] md:grid xl:hidden">
          <details className="border-r border-[var(--a3-border)] p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--a3-text)]">输入设置</summary>
            <div className="pt-4">{inputPanel}</div>
          </details>
          <details className="p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--a3-text)]">运行结果</summary>
            <div className="pt-4">{statusPanel}</div>
          </details>
      </div>

      <div
        id="algorithm-lab-panel-input"
        role="tabpanel"
        aria-labelledby="algorithm-lab-tab-input"
        className={`${mobilePanel === 'input' ? 'block' : 'hidden'} p-4 md:hidden`}
      >
        {inputPanel}
      </div>
      <div
        id="algorithm-lab-panel-result"
        role="tabpanel"
        aria-labelledby="algorithm-lab-tab-result"
        className={`${mobilePanel === 'result' ? 'block' : 'hidden'} p-4 md:hidden`}
      >
        {statusPanel}
      </div>

      <div className="xl:grid xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="hidden border-r border-[var(--a3-border)] p-4 xl:block">{inputPanel}</aside>
        <div
          id="algorithm-lab-panel-run"
          role="tabpanel"
          aria-labelledby="algorithm-lab-tab-run"
          className={`${mobilePanel === 'run' ? 'block' : 'hidden'} min-w-0 md:block`}
        >
          <p className="border-b border-[var(--a3-border)] px-4 py-2 text-xs text-[var(--a3-text-muted)] md:hidden">移动端每次显示一个算法</p>
          <section ref={canvasRef} className="min-h-[430px] min-w-0 bg-[var(--a3-surface-solid)]" aria-label="算法运行画布">
            {canvas}
          </section>
            {controls}
            {explanation}
        </div>
        <aside className="hidden border-l border-[var(--a3-border)] p-4 xl:block">{statusPanel}</aside>
      </div>
    </div>
  );
}
