import Link from 'next/link';
import { ArrowRight, CalendarDays, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';
import type { SevenDayReportPlan } from '@/lib/a3/report-view-model';

export function ReportSevenDayPlan({ plan }: { plan: SevenDayReportPlan }) {
  return (
    <section
      aria-labelledby="report-seven-day-title"
      className="rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)]"
      data-testid="a3-report-weekly-prescription"
    >
      <div className="border-b border-[var(--a3-border)] p-5 sm:p-6" data-testid="a3-report-diagnosis">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-700">
          <CalendarDays className="size-4" />
          未来安排
        </div>
        <h2 id="report-seven-day-title" className="mt-3 text-xl font-semibold text-[var(--a3-text)]">从今天开始的 7 天行动</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--a3-text-muted)]">{plan.goal}</p>
      </div>

      <div className="p-5 sm:p-6" data-testid="a3-report-continuity-loop">
        <ol className="space-y-3" data-testid="a3-report-focus-areas">
          {plan.actions.map((action, index) => (
            <li key={action.id} className="grid gap-4 rounded-lg border border-[var(--a3-border)] p-4 md:grid-cols-[40px_minmax(0,1fr)_auto] md:items-center">
              <span className="flex size-9 items-center justify-center rounded-md bg-blue-600 text-sm font-semibold text-white">{action.order}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="font-semibold text-[var(--a3-text)]">{action.label}</h3>
                  <span className="inline-flex items-center gap-1 text-xs text-[var(--a3-text-muted)]"><Clock3 className="size-3.5" />{action.estimatedMinutes} 分钟</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]" data-testid="a3-report-completion-criteria">
                  完成标准：{action.completionCriteria}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">数据回流：{action.feedback}</p>
              </div>
              <Link
                href={action.href}
                data-testid={index === 0 ? 'a3-report-loop-primary' : undefined}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-[var(--a3-border)] px-3 py-2 text-sm font-semibold text-[var(--a3-text)] hover:border-blue-300 hover:text-blue-700"
              >
                去完成
                <ArrowRight className="size-4" />
              </Link>
            </li>
          ))}
        </ol>

        {plan.latestAdjustment && (
          <div className="mt-4 flex gap-3 rounded-lg bg-blue-50 p-4 dark:bg-blue-950/40" data-testid="a3-report-plan-change">
            <RefreshCw className="mt-0.5 size-4 shrink-0 text-blue-700 dark:text-blue-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-blue-950 dark:text-blue-100">{plan.latestAdjustment.title}</div>
              <p className="mt-1 text-sm leading-6 text-blue-800 dark:text-blue-200">{plan.latestAdjustment.reason}</p>
            </div>
            <Link data-testid="a3-report-plan-change-action" href="/a3/today" className="shrink-0 text-sm font-semibold text-blue-800 dark:text-blue-200">查看今日安排</Link>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--a3-border)] pt-4" data-testid="a3-report-action-hub">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--a3-text-muted)]"><CheckCircle2 className="size-4" />相关入口</span>
          <span data-testid="a3-report-loop-step-today"><Link data-testid="a3-report-action-today" href="/a3/today" className="text-sm font-semibold text-[var(--a3-text)] hover:text-blue-700">今日任务</Link></span>
          <span data-testid="a3-report-loop-step-review"><Link data-testid="a3-report-action-review" href="/a3/wrong-notebook" className="text-sm font-semibold text-[var(--a3-text)] hover:text-blue-700">错题复盘</Link></span>
          <span data-testid="a3-report-loop-step-plan"><Link data-testid="a3-report-action-plan" href="/a3/study-plan" className="text-sm font-semibold text-[var(--a3-text)] hover:text-blue-700">学习计划</Link></span>
          <span className="sr-only" data-testid="a3-report-weekly-summary">计划与学习结果会持续回流到本报告。</span>
        </div>
      </div>
    </section>
  );
}
