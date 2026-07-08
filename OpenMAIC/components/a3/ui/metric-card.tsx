import type { A3Metric } from '@/lib/a3/types';
import { cn } from '@/lib/utils';

const toneClass: Record<NonNullable<A3Metric['tone']>, string> = {
  blue: 'text-blue-700 bg-blue-50 dark:bg-blue-950/50 dark:text-blue-200',
  green: 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950/50 dark:text-emerald-200',
  violet: 'text-violet-700 bg-violet-50 dark:bg-violet-950/50 dark:text-violet-200',
  orange: 'text-orange-700 bg-orange-50 dark:bg-orange-950/50 dark:text-orange-200',
  red: 'text-rose-700 bg-rose-50 dark:bg-rose-950/50 dark:text-rose-200',
};

export function MetricCard({ metric }: { metric: A3Metric }) {
  const tone = metric.tone ?? 'blue';

  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 shadow-[var(--a3-shadow)]">
      <div className="text-sm text-[var(--a3-text-muted)]">{metric.label}</div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="text-2xl font-semibold tracking-normal text-[var(--a3-text)]">{metric.value}</div>
        {metric.delta && (
          <div className={cn('rounded-md px-2 py-1 text-xs font-medium', toneClass[tone])}>
            {metric.delta}
          </div>
        )}
      </div>
    </div>
  );
}

export function MetricGrid({ metrics }: { metrics: A3Metric[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <MetricCard key={metric.label} metric={metric} />
      ))}
    </div>
  );
}
