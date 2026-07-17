import Link from 'next/link';
import { ArrowRight, CircleAlert, Clock3, ShieldCheck, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StudentReportViewModel } from '@/lib/a3/report-view-model';

export function ReportOverviewPanel({
  overview,
  evidenceState,
  updating,
}: {
  overview: StudentReportViewModel['overview'];
  evidenceState: StudentReportViewModel['evidenceState'];
  updating: boolean;
}) {
  const evidenceLabel = evidenceState === 'ready' ? '证据充分' : evidenceState === 'partial' ? '部分证据' : '证据待补充';

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white" aria-labelledby="report-overview-title">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
              <TrendingUp className="size-4" />
              阶段结论
            </span>
            <span className="text-slate-300">|</span>
            <span className="inline-flex items-center gap-1.5 text-slate-500">
              <ShieldCheck className="size-4" />
              {evidenceLabel}
            </span>
            {updating && <span className="text-blue-600" role="status">正在更新周期数据...</span>}
          </div>
          <h2 id="report-overview-title" className="mt-4 max-w-3xl text-2xl font-semibold text-slate-950 sm:text-3xl">
            {overview.headline}
          </h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">{overview.summary}</p>
          <div className="mt-5 flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <span className="inline-flex items-center gap-2 font-medium text-emerald-700">
              <TrendingUp className="size-4" />
              {overview.progressSignal}
            </span>
            <span className="inline-flex items-center gap-2 font-medium text-amber-700">
              <CircleAlert className="size-4" />
              {overview.primaryRisk}
            </span>
          </div>
        </div>

        <div className="border-t border-slate-200 bg-slate-950 p-5 text-white lg:border-l lg:border-t-0 sm:p-6">
          <p className="text-xs font-semibold text-slate-300">现在先做这一件事</p>
          <h3 className="mt-3 text-xl font-semibold">{overview.primaryAction.label}</h3>
          <p className="mt-3 text-sm leading-6 text-slate-300">{overview.primaryAction.expectedOutcome}</p>
          <div className="mt-4 inline-flex items-center gap-2 text-xs text-slate-300">
            <Clock3 className="size-4" />
            预计 {overview.primaryAction.estimatedMinutes} 分钟
          </div>
          <Button asChild className="mt-5 w-full bg-white text-slate-950 hover:bg-slate-100">
            <Link data-testid="a3-report-primary-action" href={overview.primaryAction.href}>
              开始行动
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
