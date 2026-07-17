'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { BarChart3, ChevronRight, Download, FileDown, Radar, UserRound } from 'lucide-react';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { BarChart, LineChart, RadarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, RadarComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Button } from '@/components/ui/button';
import type { DynamicProfileInsight } from '@/components/a3/profile/dynamic-profile-insight-panel';
import { DynamicProfileInsightPanel } from '@/components/a3/profile/dynamic-profile-insight-panel';
import type { LearningReport } from '@/lib/a3/assessment-types';
import {
  profileSourceLabel,
  profileStatusLabel,
  summarizeProfileTimelineEntry,
  type DynamicProfileFeedResponse,
} from '@/lib/a3/profile-timeline';

echarts.use([BarChart, LineChart, RadarChart, GridComponent, LegendComponent, RadarComponent, TooltipComponent, SVGRenderer]);

export function ReportDetails({
  report,
  dynamicProfile,
  profileFeed,
  supplementalLoading,
  supplementalError,
  summaryTool,
  onExportCsv,
  onExportPdf,
  onTrendDrill,
  onCapabilityDrill,
}: {
  report: LearningReport;
  dynamicProfile: DynamicProfileInsight | null;
  profileFeed: DynamicProfileFeedResponse | null;
  supplementalLoading: boolean;
  supplementalError: string;
  summaryTool: ReactNode;
  onExportCsv: () => void;
  onExportPdf: () => void;
  onTrendDrill: (bucket: LearningReport['trends'][number]) => void;
  onCapabilityDrill: (axis: LearningReport['capabilityAxes'][number]) => void;
}) {
  return (
    <details className="group rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-slate-950 sm:px-6">
        <span>详细分析与报告工具</span>
        <ChevronRight className="size-4 text-slate-400 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-3 border-t border-slate-200 p-4 sm:p-6">
        {supplementalLoading && (
          <div role="status" className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">补充数据加载中，核心报告不受影响。</div>
        )}
        {supplementalError && (
          <div role="status" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">补充数据暂不可用：{supplementalError}</div>
        )}

        <DetailItem title="作答趋势" icon={<BarChart3 className="size-4" />} testId="a3-report-detail-trends">
          <ReportTrendChart report={report} onDrill={onTrendDrill} />
        </DetailItem>

        <DetailItem title="能力分布" icon={<Radar className="size-4" />} testId="a3-report-detail-capability">
          <CapabilityChart report={report} onDrill={onCapabilityDrill} />
        </DetailItem>

        <DetailItem title="画像变化" icon={<UserRound className="size-4" />} testId="a3-report-dynamic-profile">
          <div className="grid gap-4 xl:grid-cols-2">
            <DynamicProfileInsightPanel dynamicProfile={dynamicProfile} compact />
            <ProfileTimeline feed={profileFeed} />
          </div>
        </DetailItem>

        <DetailItem title="AI 学习总结" icon={<FileDown className="size-4" />} testId="a3-report-detail-summary">
          {summaryTool}
        </DetailItem>

        <DetailItem title="导出与计算口径" icon={<Download className="size-4" />} testId="a3-report-detail-exports">
          <div className="grid gap-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onExportCsv}><Download className="size-4" />导出 CSV</Button>
              <Button variant="outline" onClick={onExportPdf}><FileDown className="size-4" />打印 / PDF</Button>
            </div>
            <div className="rounded-lg bg-slate-50 p-4 text-sm leading-6 text-slate-600" data-testid="a3-report-detail-coverage">
              <div>统计周期：{report.period.start} 至 {report.period.end}</div>
              <div>作答样本：{report.metrics.answeredQuestions} 次；学习天数：{report.metrics.studyDays} 天</div>
              <div>更新时间：{formatDateTime(report.updatedAt)}</div>
              <p className="mt-2 text-xs text-slate-500">正确率只统计系统内已记录作答；周期比较要求当前与上一等长周期均至少 3 次作答。</p>
            </div>
          </div>
        </DetailItem>
      </div>
    </details>
  );
}

function DetailItem({ title, icon, testId, children }: { title: string; icon: ReactNode; testId: string; children: ReactNode }) {
  return (
    <details className="rounded-lg border border-slate-200" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-800">
        {icon}{title}<ChevronRight className="ml-auto size-4 text-slate-400" />
      </summary>
      <div className="border-t border-slate-200 p-4">{children}</div>
    </details>
  );
}

function ReportTrendChart({ report, onDrill }: { report: LearningReport; onDrill: (bucket: LearningReport['trends'][number]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const option = useMemo<EChartsCoreOption>(() => ({
    animationDuration: 300,
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, data: ['作答量', '正确率'] },
    grid: { left: 42, right: 42, top: 20, bottom: 52 },
    xAxis: { type: 'category', data: report.trends.map((item) => item.label), axisLabel: { color: '#64748b' } },
    yAxis: [
      { type: 'value', minInterval: 1, name: '题数' },
      { type: 'value', min: 0, max: 100, name: '正确率' },
    ],
    series: [
      { name: '作答量', type: 'bar', data: report.trends.map((item) => item.questions), itemStyle: { color: '#2563eb' }, barMaxWidth: 28 },
      { name: '正确率', type: 'line', yAxisIndex: 1, data: report.trends.map((item) => item.accuracy), lineStyle: { color: '#059669' }, itemStyle: { color: '#059669' }, smooth: true },
    ],
  }), [report.trends]);
  useReportChart(ref, option, (index) => report.trends[index] && onDrill(report.trends[index]));
  return (
    <div>
      <div ref={ref} className="h-72 w-full" aria-label="作答趋势图" />
      <div className="mt-3 flex flex-wrap gap-2">
        {report.trends.map((bucket) => <button key={bucket.label} type="button" onClick={() => onDrill(bucket)} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600">{bucket.label}</button>)}
      </div>
    </div>
  );
}

function CapabilityChart({ report, onDrill }: { report: LearningReport; onDrill: (axis: LearningReport['capabilityAxes'][number]) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const enoughAxes = report.capabilityAxes.length >= 3;
  const option = useMemo<EChartsCoreOption>(() => ({
    radar: { indicator: report.capabilityAxes.map((axis) => ({ name: axis.label, max: 100 })), radius: '64%' },
    tooltip: {},
    series: [{ type: 'radar', data: [{ value: report.capabilityAxes.map((axis) => axis.value), name: '当前能力' }], areaStyle: { color: 'rgba(37,99,235,.16)' }, lineStyle: { color: '#2563eb' } }],
  }), [report.capabilityAxes]);
  useReportChart(ref, option);
  if (!enoughAxes) return <p className="text-sm leading-6 text-slate-500">能力维度不足 3 项，暂不绘制雷达图。完成更多测评后再查看。</p>;
  return (
    <div>
      <div ref={ref} className="h-72 w-full" aria-label="能力雷达图" />
      <div className="mt-3 flex flex-wrap gap-2">
        {report.capabilityAxes.map((axis) => <button key={axis.label} type="button" onClick={() => onDrill(axis)} className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600">{axis.label} {axis.value}</button>)}
      </div>
    </div>
  );
}

function useReportChart(ref: React.RefObject<HTMLDivElement | null>, option: EChartsCoreOption, onClick?: (index: number) => void) {
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    chart.setOption(option);
    if (onClick) chart.on('click', (params) => onClick(Number(params.dataIndex ?? -1)));
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [onClick, option, ref]);
}

function ProfileTimeline({ feed }: { feed: DynamicProfileFeedResponse | null }) {
  const timeline = feed?.timeline ?? [];
  return (
    <div data-testid="a3-report-profile-timeline" className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-950">画像变化时间线</h3>
      {timeline.length > 0 ? (
        <div className="mt-3 divide-y divide-slate-100">
          {timeline.slice(0, 5).map((item) => (
            <div key={`${item.id}-${item.createdAt}`} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-slate-700">{profileSourceLabel(item.source)}</span>
                <span className="text-slate-500">{profileStatusLabel(item.status)}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-600">{summarizeProfileTimelineEntry(item)}</p>
            </div>
          ))}
        </div>
      ) : <p className="mt-3 text-sm leading-6 text-slate-500">完成诊断、测评或课堂学习后，画像变化会显示在这里。</p>}
    </div>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
