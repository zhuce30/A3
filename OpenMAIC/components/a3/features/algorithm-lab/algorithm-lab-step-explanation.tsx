import { ChevronDown, ListTree } from 'lucide-react';

interface AlgorithmLabStepExplanationProps {
  label: string;
  explanation: string;
  reviewed: boolean;
  onReview: () => void;
}

export function AlgorithmLabStepExplanation({
  label,
  explanation,
  reviewed,
  onReview,
}: AlgorithmLabStepExplanationProps) {
  return (
    <details className="group border-t border-[var(--a3-border)]">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500">
        <span className="flex min-w-0 items-center gap-2"><ListTree className="size-4 shrink-0 text-amber-600" />步骤讲解与运行日志</span>
        <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="max-h-56 overflow-y-auto border-t border-[var(--a3-border)] px-4 py-3 text-sm leading-6 text-[var(--a3-text-muted)]">
        <div className="font-medium text-[var(--a3-text)]">{label || '尚未开始运行'}</div>
        <p className="mt-1">{explanation || '播放实验后，这里会解释当前步骤的状态变化。'}</p>
        {label ? (
          <button type="button" onClick={onReview} className="mt-3 text-xs font-semibold text-amber-700 hover:text-amber-600 dark:text-amber-300">
            {reviewed ? '已标记为重点复查' : '标记为重点复查'}
          </button>
        ) : null}
      </div>
    </details>
  );
}
