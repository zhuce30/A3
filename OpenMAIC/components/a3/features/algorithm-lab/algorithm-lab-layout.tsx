'use client';

import { useState, type ReactNode } from 'react';

type MobilePanel = 'input' | 'run' | 'result';

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

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-sm">
      <div className="grid grid-cols-3 border-b border-[var(--a3-border)] p-1 md:hidden" role="tablist" aria-label="实验工作区">
        {([
          ['input', '输入'],
          ['run', '运行'],
          ['result', '结果'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mobilePanel === value}
            onClick={() => setMobilePanel(value)}
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

      {mobilePanel === 'input' ? <div className="p-4 md:hidden">{inputPanel}</div> : null}
      {mobilePanel === 'result' ? <div className="p-4 md:hidden">{statusPanel}</div> : null}

      <div className="xl:grid xl:grid-cols-[280px_minmax(0,1fr)_300px]">
        <aside className="hidden border-r border-[var(--a3-border)] p-4 xl:block">{inputPanel}</aside>
        <div className={`${mobilePanel === 'run' ? 'block' : 'hidden'} min-w-0 md:block`}>
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
