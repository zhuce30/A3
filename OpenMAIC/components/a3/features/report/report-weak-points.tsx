import Link from 'next/link';
import { ArrowRight, BookOpenCheck, Clock3 } from 'lucide-react';
import type { WeakKnowledgePointInsight } from '@/lib/a3/report-view-model';

export function ReportWeakPoints({
  weakKnowledgePoints,
}: {
  weakKnowledgePoints: WeakKnowledgePointInsight[];
}) {
  const visiblePoints = weakKnowledgePoints.slice(0, 3);
  return (
    <section aria-labelledby="report-weak-title" data-testid="a3-report-weakness-trends">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="report-weak-title" className="text-xl font-semibold text-[var(--a3-text)]">优先掌握的知识点</h2>
          <p className="mt-1 text-sm text-[var(--a3-text-muted)]">按错题和最近作答证据排序，最多保留三项。</p>
        </div>
        <Link href="/a3/wrong-notebook" className="text-sm font-semibold text-blue-700 hover:text-blue-800">查看全部错题</Link>
      </div>

      {visiblePoints.length > 0 ? (
        <div className={`grid gap-3 ${visiblePoints.length === 2 ? 'xl:grid-cols-2' : visiblePoints.length >= 3 ? 'xl:grid-cols-3' : ''}`} data-testid="a3-report-wrong-mastery-explanation">
          {visiblePoints.map((point) => (
            <article key={point.knowledgePoint} className="flex min-w-0 flex-col rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 text-base font-semibold text-[var(--a3-text)]">{point.knowledgePoint}</h3>
                <span className="shrink-0 rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">{point.status}</span>
              </div>
              <p className="mt-3 text-xs font-medium leading-5 text-[var(--a3-text-muted)]">{point.evidence}</p>
              <p className="mt-3 flex-1 text-sm leading-6 text-[var(--a3-text-muted)]">{point.reason}</p>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--a3-border)] pt-4">
                <span className="inline-flex items-center gap-1.5 text-xs text-[var(--a3-text-muted)]">
                  <Clock3 className="size-3.5" />
                  {point.action.estimatedMinutes} 分钟
                </span>
                <Link href={point.action.href} className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-800">
                  {point.action.label}
                  <ArrowRight className="size-4" />
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-dashed border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-6 sm:flex-row sm:items-center">
          <BookOpenCheck className="size-8 shrink-0 text-[var(--a3-text-muted)]" />
          <div className="flex-1">
            <h3 className="font-semibold text-[var(--a3-text)]">还没有知识点级证据</h3>
            <p className="mt-1 text-sm leading-6 text-[var(--a3-text-muted)]">完成一次测评后，这里会显示具体知识点、错因和下一步练习。</p>
          </div>
          <Link href="/a3/assessment" className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700">
            去完成测评
            <ArrowRight className="size-4" />
          </Link>
        </div>
      )}
    </section>
  );
}
