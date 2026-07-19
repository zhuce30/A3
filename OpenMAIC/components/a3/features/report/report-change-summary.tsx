import { CircleAlert, CircleCheck, Minus, TrendingUp } from 'lucide-react';
import type { ReportChange } from '@/lib/a3/report-view-model';

const changeStyle = {
  progress: { icon: TrendingUp, label: '进步', className: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200' },
  stable: { icon: CircleCheck, label: '保持', className: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200' },
  risk: { icon: CircleAlert, label: '风险', className: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200' },
  insufficient: { icon: Minus, label: '待积累', className: 'border-[var(--a3-border)] bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]' },
} as const;

export function ReportChangeSummary({ changes }: { changes: ReportChange[] }) {
  return (
    <section aria-labelledby="report-changes-title" data-testid="a3-report-weekly-summary">
      <div className="mb-4">
        <h2 id="report-changes-title" className="text-xl font-semibold text-[var(--a3-text)]">本周期发生了什么变化</h2>
        <p className="mt-1 text-sm text-[var(--a3-text-muted)]">只展示能解释现状的变化，不用单个分数代替结论。</p>
      </div>
      <div className={`grid gap-3 ${changes.length === 2 ? 'lg:grid-cols-2' : changes.length >= 3 ? 'lg:grid-cols-3' : ''}`}>
        {changes.map((change) => {
          const style = changeStyle[change.kind];
          const Icon = style.icon;
          return (
            <article key={`${change.title}-${change.value}`} className="rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-[var(--a3-text)]">{change.title}</span>
                <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold ${style.className}`}>
                  <Icon className="size-3.5" />
                  {style.label}
                </span>
              </div>
              <div className="mt-5 text-2xl font-semibold text-[var(--a3-text)]">{change.value}</div>
              <div className="mt-2 text-sm font-medium text-[var(--a3-text)]">{change.comparison}</div>
              <p className="mt-3 text-sm leading-6 text-[var(--a3-text-muted)]">{change.explanation}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
