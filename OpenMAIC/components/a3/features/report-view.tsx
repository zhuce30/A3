'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Clock3,
  Download,
  FileDown,
  FileQuestion,
  FileText,
  Loader2,
  RotateCcw,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { BarChart, LineChart, RadarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, RadarComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Button } from '@/components/ui/button';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { trackPageView } from '@/lib/a3/learning-event-client';
import type { LearningReport } from '@/lib/a3/assessment-types';
import { buildWeaknessTrendItems } from '@/lib/a3/report-weakness-trends';
import { buildLearningReportCsv } from '@/lib/a3/report-export';
import type { A3ApiResponse, StudyPlan, StudyPlanAdjustment } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { DynamicProfileInsightPanel } from '@/components/a3/profile/dynamic-profile-insight-panel';
import type { DynamicProfileInsight } from '@/components/a3/profile/dynamic-profile-insight-panel';
import {
  profileSourceLabel,
  profileStatusLabel,
  profileStatusTone,
  summarizeProfileTimelineEntry,
  summarizeProfileUpdateEvidence,
  type DynamicProfileFeedResponse,
  type ProfileTimelineEntry,
} from '@/lib/a3/profile-timeline';

echarts.use([BarChart, LineChart, RadarChart, GridComponent, LegendComponent, RadarComponent, TooltipComponent, SVGRenderer]);

type LearningEffectReport = {
  schemaVersion?: string;
  overallEffectScore?: number;
  confidence?: 'high' | 'medium' | 'low' | string;
  missingEvidence?: string[];
  behavior?: {
    activeDays?: number;
    totalDurationSec?: number;
    taskCompletionRate?: number;
    reflectionCount?: number;
    eventCount?: number;
  };
  assessment?: {
    attemptCount?: number;
    averageScore?: number;
    correctRate?: number;
    wrongQuestionCount?: number;
    reviewedWrongQuestionCount?: number;
  };
  knowledgePoints?: Array<{
    knowledgePointId: string;
    name: string;
    preScore: number;
    postScore: number;
    learningGain: number;
    attemptCount: number;
    correctRate: number;
    wrongCount: number;
    reviewCount: number;
    trend: 'improving' | 'stable' | 'declining' | string;
    confidence: 'high' | 'medium' | 'low' | string;
    evidence?: string[];
  }>;
  trends?: {
    sevenDay?: LearningEffectTrend;
    fourteenDay?: LearningEffectTrend;
    thirtyDay?: LearningEffectTrend;
  };
  resourceUsage?: {
    opened?: number;
    completed?: number;
    skipped?: number;
    favorited?: number;
    totalFeedback?: number;
  };
  eventStream?: {
    schemaVersion?: string;
    v2EventCount?: number;
    acceptedCount?: number;
    singleApi?: string;
    batchApi?: string;
    sourcePages?: Array<{ sourcePage?: string; count?: number }>;
  };
  resourceEffectiveness?: number;
  masterySignals?: {
    averageFeedbackScore?: number;
    weakPoints?: string[];
  };
  planExecution?: {
    taskCount?: number;
    completedTasks?: number;
    completionRate?: number;
  };
  planAdjustment?: {
    strategy?: string;
    reason?: string;
    evidence?: {
      opened?: number;
      completed?: number;
      skipped?: number;
      favorited?: number;
      averageFeedbackScore?: number;
      planCompletionRate?: number;
      latestGoal?: string;
    };
    nextAction?: { label: string; href: string; reason?: string };
  };
  optimizationPolicy?: {
    policyVersion?: string;
    decisionId?: string;
    selectedStrategy?: string;
    outcomeStatus?: string;
    selectedCandidate?: {
      decisionScore?: number;
      rankingBasis?: string[];
      expectedMetricDelta?: Record<string, number>;
    };
    candidates?: Array<{ strategy?: string; decisionScore?: number; rankingBasis?: string[] }>;
    successCriteria?: Array<{ metric?: string; target?: number; targetDelta?: number; windowDays?: number }>;
    observedMetricDelta?: Record<string, number>;
  };
  updatedAt?: string;
};

type OptimizationPolicyDecision = {
  decisionId?: string;
  decisionAt?: string;
  selectedStrategy?: string;
  decisionScore?: number;
  outcomeStatus?: string;
  rankingBasis?: string[];
  evaluationWindow?: { days?: number; startedAt?: string; endedAt?: string };
  observedMetricDelta?: Record<string, number>;
  expectedMetricDelta?: Record<string, number>;
  explorationMode?: boolean;
};

type OptimizationPolicyResponse = {
  success: boolean;
  error?: string;
  decisionHistory?: OptimizationPolicyDecision[];
};

type LearningSummaryDocument = {
  id: string;
  schemaVersion: string;
  title: string;
  fileName: string;
  prompt: string;
  contentMd: string;
  summaryDate: string;
  createdAt: string;
  sourceSnapshot?: {
    eventCounts?: Record<string, number>;
    reportMetrics?: {
      accuracy?: number;
      activeWrongQuestions?: number;
      pathProgress?: number;
      studyMinutes?: number;
    };
  };
};

type LearningSummaryDocumentsResponse = {
  success: boolean;
  error?: string;
  document?: LearningSummaryDocument;
  documents?: LearningSummaryDocument[];
};

type LearningEffectTrend = {
  days?: number;
  behavior?: {
    activeDays?: number;
    eventCount?: number;
    taskCompletionRate?: number;
  };
  assessment?: {
    attemptCount?: number;
    averageScore?: number;
    correctRate?: number;
  };
};

type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan }>;
type StudyPlanRelationship = NonNullable<StudyPlan['planContext']>['relationship'];
type ReportPeriod = '7d' | '30d' | 'term';
type ChartClickParams = { name?: string; dataIndex?: number };

type PrimaryAction = {
  label: string;
  href: string;
  reason: string;
  source: '处方' | '闭环' | '默认';
};

export function ReportView() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const [report, setReport] = useState<LearningReport | null>(null);
  const [learningEffect, setLearningEffect] = useState<LearningEffectReport | null>(null);
  const [optimizationDecisionHistory, setOptimizationDecisionHistory] = useState<OptimizationPolicyDecision[]>([]);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [dynamicProfile, setDynamicProfile] = useState<DynamicProfileInsight | null>(null);
  const [profileFeed, setProfileFeed] = useState<DynamicProfileFeedResponse | null>(null);
  const [summaryDocuments, setSummaryDocuments] = useState<LearningSummaryDocument[]>([]);
  const [selectedSummaryId, setSelectedSummaryId] = useState('');
  const [summaryPrompt, setSummaryPrompt] = useState('总结我今天学了什么');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<ReportPeriod>('30d');
  const displayName = user?.displayName?.trim() || '同学';

  useEffect(() => {
    void trackPageView('/a3/report', { page: 'report', period });
    let active = true;
    void a3GetJson<A3ApiResponse<{ report: LearningReport }>>(`/api/assessments/report/?period=${period}`).then((result) => {
      if (!active) return;
      if (result.success) setReport(result.report);
      else setError(result.error || '学习报告加载失败');
      setLoading(false);
      setReportLoading(false);
    });
    return () => {
      active = false;
    };
  }, [period]);

  useEffect(() => {
    let active = true;
    void a3GetJson<{ success: boolean; error?: string; effectReport?: LearningEffectReport }>('/api/learning/effect/report/').then((result) => {
      if (!active) return;
      if (result.success) setLearningEffect(result.effectReport ?? null);
    });
    void a3GetJson<OptimizationPolicyResponse>('/api/learning/effect/optimization-policy/?days=30').then((result) => {
      if (!active) return;
      if (result.success) setOptimizationDecisionHistory(result.decisionHistory ?? []);
    });
    void a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1').then((result) => {
      if (!active) return;
      if (result.success) setStudyPlan(result.plan ?? null);
    });
    void a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/').then((result) => {
      if (!active) return;
      if (result.success) {
        setProfileFeed(result);
        setDynamicProfile(result.dynamicProfile ?? null);
      }
    });
    void a3GetJson<LearningSummaryDocumentsResponse>('/api/learning/report-summaries/?limit=20').then((result) => {
      if (!active) return;
      if (result.success) {
        const documents = result.documents ?? [];
        setSummaryDocuments(documents);
        setSelectedSummaryId((current) => current || documents[0]?.id || '');
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function generateSummaryDocument() {
    const prompt = summaryPrompt.trim();
    if (!prompt) {
      setSummaryError('请输入一句总结要求');
      return;
    }
    setSummaryLoading(true);
    setSummaryError('');
    const result = await a3PostJson<LearningSummaryDocumentsResponse>('/api/learning/report-summaries/', { prompt });
    setSummaryLoading(false);
    if (!result.success || !result.document) {
      setSummaryError(result.error || '学习总结生成失败');
      return;
    }
    const documents = result.documents ?? [result.document];
    setSummaryDocuments(documents);
    setSelectedSummaryId(result.document.id);
  }

  function exportReport() {
    if (!report) return;
    const csv = buildLearningReportCsv(report);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `学习报告-${report.period.end}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportPdf() {
    window.print();
  }

  function drillToTrend(bucket: LearningReport['trends'][number]) {
    const query = new URLSearchParams({
      source: 'report',
      period,
      start: bucket.start || '',
      end: bucket.end || '',
      label: bucket.label,
    });
    router.push(`/a3/assessment?${query.toString()}`);
  }

  function drillToCapability(axis: LearningReport['capabilityAxes'][number]) {
    const query = new URLSearchParams({
      source: 'report',
      period,
      focus: axis.label,
    });
    router.push(`/a3/wrong-notebook?${query.toString()}`);
  }

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在汇总学习数据
      </div>
    );
  }

  if (!report) {
    return (
      <A3Card>
        <p className="text-sm text-rose-700">{error || '报告暂不可用'}</p>
      </A3Card>
    );
  }

  const weaknessTrends = buildWeaknessTrendItems(report);
  const planRelationship = studyPlan?.planContext?.relationship;
  const primaryAction = getPrimaryAction(report);
  const reportHealth = getReportHealth(report);
  const planCompletion = report.weeklySummary?.planCompletion ?? report.metrics.pathProgress;
  const weeklyTarget = report.weeklyPrescription?.weeklyTarget;

  return (
    <div className="space-y-5" data-testid="a3-report-view">
      <style jsx global>{`
        @media print {
          body {
            background: white;
          }
          aside,
          nav,
          header,
          .a3-report-no-print {
            display: none !important;
          }
          [data-testid='a3-report-view'] {
            padding: 0 !important;
          }
          [data-testid='a3-report-view'] section {
            break-inside: avoid;
            box-shadow: none !important;
          }
        }
      `}</style>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative size-16 shrink-0 overflow-hidden rounded-2xl bg-blue-50">
            <Image src="/avatars/learner.svg" alt={`${displayName}头像`} fill className="object-cover" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-slate-950">{displayName}的学习报告</h1>
              <A3Pill tone={reportHealth.tone}>{reportHealth.label}</A3Pill>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-sm text-slate-500">
              <span>{report.period.label || periodLabel(period)}：{report.period.start} 至 {report.period.end}</span>
              <span>更新于 {new Date(report.updatedAt).toLocaleString('zh-CN')}</span>
            </div>
          </div>
        </div>
        <div className="a3-report-no-print flex flex-wrap items-center gap-2">
          <PeriodSegmentedControl
            value={period}
            loading={reportLoading}
            onChange={(nextPeriod) => {
              if (nextPeriod === period) return;
              setReportLoading(true);
              setPeriod(nextPeriod);
            }}
          />
          <Button variant="outline" onClick={exportReport}>
            <Download className="mr-2 size-4" />
            CSV
          </Button>
          <Button variant="outline" onClick={exportPdf}>
            <FileDown className="mr-2 size-4" />
            PDF
          </Button>
        </div>
      </div>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_360px]">
        <div className="overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div className="p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-2">
                <A3Pill tone={primaryAction.source === '默认' ? 'slate' : 'blue'}>{primaryAction.source}</A3Pill>
                <span className="text-sm font-medium text-slate-500">现在最值得做</span>
              </div>
              <h2 className="mt-4 text-2xl font-semibold tracking-normal text-slate-950">{primaryAction.label}</h2>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">{primaryAction.reason}</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button asChild className="bg-blue-600 hover:bg-blue-700">
                  <Link data-testid="a3-report-primary-action" href={primaryAction.href}>
                    开始处理
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/a3/today">回到今日任务</Link>
                </Button>
              </div>
            </div>
            <div className="border-t border-slate-200 bg-slate-50 p-5 lg:border-l lg:border-t-0">
              <div className="text-sm font-semibold text-slate-950">本周目标</div>
              <div className="mt-4 flex items-end gap-2">
                <span className="text-4xl font-semibold text-slate-950">{weeklyTarget?.current ?? report.weeklySummary?.completedTasks ?? 0}</span>
                <span className="pb-1 text-sm text-slate-500">/ {weeklyTarget?.target ?? report.weeklySummary?.totalTasks ?? '--'} 项</span>
              </div>
              <ProgressBar value={weeklyTarget?.progress ?? planCompletion} className="mt-4" />
              <p className="mt-4 line-clamp-3 text-sm leading-6 text-slate-600">
                {weeklyTarget?.reason || report.weeklySummary?.recommendation || '完成今日任务后，报告会继续更新计划进度和复习队列。'}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Metric icon={Target} label="正确率" value={`${report.metrics.accuracy}%`} detail={`${report.metrics.answeredQuestions} 题`} tone="blue" />
          <Metric icon={FileQuestion} label="待巩固" value={`${report.metrics.activeWrongQuestions}`} detail={`已掌握 ${report.metrics.masteredWrongQuestions}`} tone="orange" />
          <Metric icon={TrendingUp} label="路径进度" value={`${report.metrics.pathProgress}%`} detail={`${report.metrics.masteredKnowledgePoints}/${report.metrics.totalKnowledgePoints} 知识点`} tone="green" />
          <Metric icon={Clock3} label="学习投入" value={`${report.metrics.studyMinutes}`} detail={`${report.metrics.studyDays} 天`} tone="slate" />
        </div>
      </section>

      <LearningSummaryPanel
        documents={summaryDocuments}
        selectedId={selectedSummaryId}
        prompt={summaryPrompt}
        loading={summaryLoading}
        error={summaryError}
        onPromptChange={setSummaryPrompt}
        onSelect={setSelectedSummaryId}
        onGenerate={generateSummaryDocument}
      />

      <section className="grid gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <A3Card title="趋势判断" subtitle="作答量、正确率和能力轴放在一起看，先判断节奏是否稳定。">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
            <ReportTrendEChart report={report} onDrill={drillToTrend} />
            <CapabilityRadarChart report={report} onDrill={drillToCapability} />
          </div>
        </A3Card>

        <div className="space-y-5" data-testid="a3-report-dynamic-profile">
          <WrongQuestionPanel report={report} />
          <DynamicProfileInsightPanel dynamicProfile={dynamicProfile} compact />
          <ReportProfileTimelinePanel feed={profileFeed} />
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <A3Card title="薄弱点处理队列" subtitle="只保留需要行动的项目，按风险和变化排序。">
          <div className="grid gap-3 md:grid-cols-2" data-testid="a3-report-weakness-trends">
            {weaknessTrends.slice(0, 4).map((item) => (
              <Link key={`${item.title}-${item.href}`} href={item.href} className="group rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-slate-950">{item.title}</div>
                  <A3Pill tone={item.status === 'worsening' ? 'orange' : item.status === 'improving' ? 'green' : 'blue'}>
                    {item.status === 'worsening' ? '加重' : item.status === 'improving' ? '改善' : '观察'}
                  </A3Pill>
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">{item.evidence}</p>
                <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                  <span className="line-clamp-2">{item.nextAction}</span>
                  <ArrowRight className="size-4 shrink-0 text-blue-600 transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            ))}
          </div>
        </A3Card>

        <div data-testid="a3-report-action-hub">
          <A3Card title="快捷动作">
            <div className="space-y-3">
              <ReportActionLink href="/a3/today" testId="a3-report-action-today" title="今日任务" detail="按报告优先级完成一个最小任务。" />
              <ReportActionLink href="/a3/wrong-notebook" testId="a3-report-action-review" title="错题复盘" detail="处理待巩固错题和高频错因。" />
              <ReportActionLink href="/a3/study-plan" testId="a3-report-action-plan" title="学习计划" detail="查看顺延任务和复习节奏。" />
            </div>
            <RelationshipActionContext relationship={planRelationship} testId="a3-report-relationship-action-context" />
          </A3Card>
        </div>
      </section>

      {report.weeklyPrescription && <WeeklyPrescriptionPanel report={report} relationship={planRelationship} />}

      <section className="grid gap-5 xl:grid-cols-2">
        {report.resourcePackEffect && <ResourcePackEffectPanel effect={report.resourcePackEffect} />}
        {learningEffect && <LearningEffectPanel effect={learningEffect} decisionHistory={optimizationDecisionHistory} />}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <A3Card title="下一阶段建议">
          <div className="divide-y divide-slate-200">
            {report.suggestions.length > 0 ? (
              report.suggestions.slice(0, 4).map((suggestion) => (
                <div key={suggestion.title} className="flex gap-3 py-4 first:pt-0 last:pb-0">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-blue-600" />
                  <div>
                    <div className="font-semibold text-slate-900">{suggestion.title}</div>
                    <p className="mt-1 text-sm leading-6 text-slate-600">{suggestion.detail}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">完成一次测评或错题复盘后，这里会生成下一阶段建议。</p>
            )}
          </div>
        </A3Card>
        {report.weeklySummary && <WeeklySummaryPanel report={report} />}
      </section>

      {report.actionLoop && <ActionLoopPanel report={report} relationship={planRelationship} />}

      <div className="pb-2 text-center text-xs text-slate-400">报告仅统计系统内已记录的学习行为。</div>
    </div>
  );
}

function LearningSummaryPanel({
  documents,
  selectedId,
  prompt,
  loading,
  error,
  onPromptChange,
  onSelect,
  onGenerate,
}: {
  documents: LearningSummaryDocument[];
  selectedId: string;
  prompt: string;
  loading: boolean;
  error: string;
  onPromptChange: (value: string) => void;
  onSelect: (id: string) => void;
  onGenerate: () => void;
}) {
  const selected = documents.find((item) => item.id === selectedId) ?? documents[0] ?? null;
  const eventTotal = selected?.sourceSnapshot?.eventCounts
    ? Object.values(selected.sourceSnapshot.eventCounts).reduce((sum, value) => sum + Number(value || 0), 0)
    : 0;
  return (
    <section data-testid="a3-report-summary-tool" className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <A3Card title="AI 学习总结" subtitle="根据今天真实学习记录生成 Markdown 文档，并保留每次历史。">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
          <label className="block">
            <span className="text-sm font-semibold text-slate-900">一句话要求</span>
            <textarea
              data-testid="a3-report-summary-prompt"
              value={prompt}
              maxLength={200}
              rows={3}
              onChange={(event) => onPromptChange(event.target.value)}
              className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              placeholder="例如：总结我今天学了什么，并给出明天第一步"
            />
          </label>
          <Button
            data-testid="a3-report-summary-generate"
            type="button"
            onClick={onGenerate}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 lg:mt-7"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            生成总结
          </Button>
        </div>
        {error && (
          <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}
        <div data-testid="a3-report-summary-markdown" className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          {selected ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-950">{selected.fileName}</div>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatReportDateTime(selected.createdAt)} · 证据事件 {eventTotal} 条
                  </p>
                </div>
                <A3Pill tone="blue">{selected.schemaVersion}</A3Pill>
              </div>
              <A3Markdown className="rounded-lg bg-white p-4 text-slate-700">{selected.contentMd}</A3Markdown>
            </>
          ) : (
            <div className="flex min-h-40 flex-col items-center justify-center text-center text-sm text-slate-500">
              <FileText className="mb-3 size-8 text-slate-400" />
              还没有学习总结，输入一句话后生成第一篇 Markdown 文档。
            </div>
          )}
        </div>
      </A3Card>

      <A3Card title="总结历史">
        <div data-testid="a3-report-summary-history" className="space-y-2">
          {documents.length > 0 ? (
            documents.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                  item.id === selected?.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-200'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="line-clamp-1 text-sm font-semibold text-slate-950">{item.title}</span>
                  <A3Pill tone={item.id === selected?.id ? 'blue' : 'slate'}>{item.summaryDate}</A3Pill>
                </div>
                <p className="mt-1 line-clamp-1 text-xs text-slate-500">{item.fileName}</p>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">{item.prompt}</p>
              </button>
            ))
          ) : (
            <div className="rounded-xl bg-slate-50 px-3 py-4 text-sm leading-6 text-slate-500">
              每次生成都会保留在这里，文件名按日期和序号递增。
            </div>
          )}
        </div>
      </A3Card>
    </section>
  );
}

function EChart({
  option,
  className,
  ariaLabel,
  onChartClick,
}: {
  option: EChartsCoreOption;
  className?: string;
  ariaLabel: string;
  onChartClick?: (params: ChartClickParams) => void;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    chartInstance.current = echarts.init(chartRef.current, null, { renderer: 'svg' });
    const resizeObserver = new ResizeObserver(() => chartInstance.current?.resize());
    resizeObserver.observe(chartRef.current);
    return () => {
      resizeObserver.disconnect();
      chartInstance.current?.dispose();
      chartInstance.current = null;
    };
  }, []);

  useEffect(() => {
    chartInstance.current?.setOption(option, true);
  }, [option]);

  useEffect(() => {
    const instance = chartInstance.current;
    if (!instance || !onChartClick) return;
    const handler = (params: unknown) => onChartClick(params as ChartClickParams);
    instance.on('click', handler);
    return () => {
      instance.off('click', handler);
    };
  }, [onChartClick]);

  return <div ref={chartRef} role="img" aria-label={ariaLabel} className={className} />;
}

function ReportTrendEChart({ report, onDrill }: { report: LearningReport; onDrill: (bucket: LearningReport['trends'][number]) => void }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const labels = report.trends.map((item) => item.label);
    return {
      color: ['#2563eb', '#f59e0b'],
      tooltip: { trigger: 'axis', confine: true },
      legend: {
        top: 6,
        left: 'center',
        itemWidth: 18,
        itemHeight: 10,
        itemGap: 18,
        textStyle: { color: '#64748b', fontSize: 12 },
      },
      grid: { left: 44, right: 50, top: 64, bottom: 44, containLabel: true },
      xAxis: { type: 'category', data: labels, axisTick: { show: false }, axisLabel: { color: '#64748b' } },
      yAxis: [
        { type: 'value', name: '题量', minInterval: 1, nameGap: 18, axisLabel: { color: '#64748b' }, splitLine: { lineStyle: { color: '#e2e8f0' } } },
        { type: 'value', name: '正确率', min: 0, max: 100, nameGap: 18, axisLabel: { formatter: '{value}%', color: '#64748b' }, splitLine: { show: false } },
      ],
      series: [
        { name: '作答量', type: 'bar', data: report.trends.map((item) => item.questions), barWidth: 22, itemStyle: { borderRadius: [6, 6, 0, 0] } },
        { name: '正确率', type: 'line', yAxisIndex: 1, data: report.trends.map((item) => item.accuracy), smooth: true, symbolSize: 8 },
      ],
    };
  }, [report.trends]);

  if (report.trends.length === 0) {
    return <EmptyChart icon={BarChart3} title="暂无趋势数据" detail="完成测评后会显示周趋势。" />;
  }
  return (
    <div className="min-w-0 overflow-hidden">
      <EChart
        option={option}
        ariaLabel="测评趋势图，点击数据点进入测评钻取"
        className="h-[320px] w-full cursor-pointer overflow-hidden"
        onChartClick={(params) => {
          const index = typeof params.dataIndex === 'number' ? params.dataIndex : report.trends.findIndex((item) => item.label === params.name);
          const bucket = report.trends[index];
          if (bucket) onDrill(bucket);
        }}
      />
      <p className="a3-report-no-print mt-2 text-xs text-slate-500">点击任意柱形或折线点，进入对应时间段测评。</p>
    </div>
  );
}

function CapabilityRadarChart({ report, onDrill }: { report: LearningReport; onDrill: (axis: LearningReport['capabilityAxes'][number]) => void }) {
  const option = useMemo<EChartsCoreOption>(() => {
    const axes = report.capabilityAxes.length > 0 ? report.capabilityAxes : [{ label: '暂无数据', value: 0 }];
    return {
      color: ['#16a34a'],
      tooltip: {},
      radar: {
        radius: '58%',
        center: ['50%', '54%'],
        indicator: axes.map((axis) => ({ name: axis.label, max: 100 })),
        axisName: { color: '#475569' },
        splitLine: { lineStyle: { color: '#e2e8f0' } },
        splitArea: { areaStyle: { color: ['#f8fafc', '#eef6ff'] } },
        axisLine: { lineStyle: { color: '#cbd5e1' } },
      },
      series: [
        {
          name: '能力雷达',
          type: 'radar',
          data: [{ value: axes.map((axis) => axis.value), name: '当前能力' }],
          areaStyle: { opacity: 0.16 },
        },
      ],
    };
  }, [report.capabilityAxes]);

  if (report.capabilityAxes.length === 0) {
    return <EmptyChart icon={Target} title="暂无能力数据" detail="完成诊断或练习后会更新雷达图。" />;
  }
  return (
    <div className="min-w-0 overflow-hidden border-t border-slate-100 pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-950">能力雷达</div>
        <A3Pill tone="green">{Math.round(report.capabilityAxes.reduce((sum, axis) => sum + axis.value, 0) / report.capabilityAxes.length)} 平均</A3Pill>
      </div>
      <EChart
        option={option}
        ariaLabel="能力雷达图，点击进入错题筛选"
        className="h-[300px] w-full cursor-pointer overflow-hidden"
        onChartClick={(params) => {
          const name = params.name || report.capabilityAxes[0]?.label;
          const axis = report.capabilityAxes.find((item) => item.label === name) || report.capabilityAxes[0];
          if (axis) onDrill(axis);
        }}
      />
      <div className="a3-report-no-print mt-2 flex flex-wrap gap-2">
        {report.capabilityAxes.map((axis) => (
          <button
            key={axis.label}
            type="button"
            onClick={() => onDrill(axis)}
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-blue-300 hover:text-blue-700"
          >
            {axis.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PeriodSegmentedControl({
  value,
  loading,
  onChange,
}: {
  value: ReportPeriod;
  loading: boolean;
  onChange: (value: ReportPeriod) => void;
}) {
  const options: Array<{ value: ReportPeriod; label: string }> = [
    { value: '7d', label: '7 天' },
    { value: '30d', label: '30 天' },
    { value: 'term', label: '本学期' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1" aria-label="报告时间范围">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={loading}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            value === option.value ? 'bg-white text-slate-950 shadow-sm' : 'text-slate-600 hover:text-slate-950'
          } disabled:cursor-wait disabled:opacity-60`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EmptyChart({ icon: Icon, title, detail }: { icon: typeof BarChart3; title: string; detail: string }) {
  return (
    <div className="flex h-[270px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50 text-center">
      <Icon className="size-8 text-slate-400" />
      <div className="mt-3 text-sm font-semibold text-slate-800">{title}</div>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

function WeeklyPrescriptionPanel({ report, relationship }: { report: LearningReport; relationship?: StudyPlanRelationship }) {
  if (!report.weeklyPrescription) return null;
  const prescription = report.weeklyPrescription;
  return (
    <div data-testid="a3-report-weekly-prescription">
      <A3Card title="学习处方" subtitle="保留诊断依据，但默认只展示能执行的内容。">
        <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_300px]">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-950">{prescription.weeklyTarget.label}</div>
            <div className="mt-4 flex items-end gap-2">
              <span className="text-3xl font-semibold text-slate-950">{prescription.weeklyTarget.current}</span>
              <span className="pb-1 text-sm text-slate-500">/ {prescription.weeklyTarget.target} 项</span>
            </div>
            <ProgressBar value={prescription.weeklyTarget.progress} className="mt-4" />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {prescription.nextWeekActions.slice(0, 4).map((action) => (
              <Link key={`${action.type}-${action.title}`} href={action.href} className="rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50">
                <A3Pill tone={actionTone(action.type)}>{actionLabel(action.type)}</A3Pill>
                <div className="mt-3 font-semibold text-slate-950">{action.title}</div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">{action.detail}</p>
              </Link>
            ))}
          </div>
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
            <div className="text-sm font-semibold text-blue-950">首要动作</div>
            <div className="mt-3 text-lg font-semibold text-blue-950">{prescription.primaryAction.label}</div>
            <p className="mt-2 text-sm leading-6 text-blue-800">{prescription.primaryAction.reason}</p>
            <RelationshipActionContext relationship={relationship} testId="a3-report-prescription-relationship" />
            <Button asChild className="mt-4 w-full bg-blue-600 hover:bg-blue-700">
              <Link href={prescription.primaryAction.href}>立即开始</Link>
            </Button>
          </div>
        </div>

        <details className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">查看诊断、聚焦区和完成标准</summary>
          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <div data-testid="a3-report-diagnosis">
              <div className="text-sm font-semibold text-slate-950">{prescription.diagnosis.headline}</div>
              <p className="mt-2 text-sm leading-6 text-slate-600">{prescription.diagnosis.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {prescription.diagnosis.evidence.map((item) => (
                  <span key={item} className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                    {item}
                  </span>
                ))}
              </div>
            </div>
            <div data-testid="a3-report-focus-areas">
              <div className="text-sm font-semibold text-slate-950">聚焦区</div>
              <div className="mt-3 space-y-2">
                {prescription.focusAreas.map((area) => (
                  <Link key={area.title} href={area.href} className="block rounded-lg bg-slate-50 p-3 hover:bg-blue-50">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-950">{area.title}</span>
                      <A3Pill tone={area.priority === 'high' ? 'orange' : 'blue'}>{area.priority === 'high' ? '优先' : '跟进'}</A3Pill>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-600">{area.reason}</p>
                  </Link>
                ))}
              </div>
            </div>
            <div data-testid="a3-report-completion-criteria">
              <div className="text-sm font-semibold text-slate-950">完成标准</div>
              <div className="mt-3 space-y-2">
                {prescription.completionCriteria.map((item) => (
                  <div key={item.label} className="rounded-lg bg-slate-50 p-3">
                    <div className="text-sm font-semibold text-slate-950">{item.label}</div>
                    <div className="mt-1 text-xs text-slate-600">目标：{item.target}</div>
                    <div className="mt-1 text-xs text-slate-500">验收：{item.check}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </details>
      </A3Card>
    </div>
  );
}

function WeeklySummaryPanel({ report }: { report: LearningReport }) {
  if (!report.weeklySummary) return null;
  const summary = report.weeklySummary;
  return (
    <div data-testid="a3-report-weekly-summary">
      <A3Card title="本周摘要">
        <div className="grid grid-cols-2 gap-3">
          <WeeklyMetric label="计划完成率" value={`${summary.planCompletion}%`} detail={`${summary.completedTasks}/${summary.totalTasks} 项`} tone="blue" />
          <WeeklyMetric label="复盘次数" value={`${summary.reflectionCount}`} detail={`信心 ${summary.averageConfidence || 0}/5`} tone="green" />
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">{summary.recommendation}</p>
        {summary.planChange && (
          <div data-testid="a3-report-plan-change" className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-blue-950">
                  {summary.planChange.currentChange?.title || '计划保持当前节奏'}
                </div>
                <p className="mt-1 text-xs leading-5 text-blue-800">
                  {summary.planChange.currentChange?.reason || '计划变化会在任务顺延、复习或资源包加入时记录。'}
                </p>
              </div>
              {summary.planChange.currentChange?.type && <A3Pill tone="blue">{planChangeLabel(summary.planChange.currentChange.type)}</A3Pill>}
            </div>
            <Button asChild size="sm" className="mt-3 bg-blue-600 hover:bg-blue-700">
              <Link data-testid="a3-report-plan-change-action" href={summary.planChange.nextAction.href}>
                {summary.planChange.nextAction.label}
              </Link>
            </Button>
          </div>
        )}
      </A3Card>
    </div>
  );
}

function ActionLoopPanel({ report, relationship }: { report: LearningReport; relationship?: StudyPlanRelationship }) {
  if (!report.actionLoop) return null;
  return (
    <div data-testid="a3-report-continuity-loop">
      <A3Card title="连续学习闭环" subtitle={report.actionLoop.continuityMessage}>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="grid gap-3 md:grid-cols-3">
            {report.actionLoop.steps.map((step, index) => (
              <Link key={step.kind} href={step.href} data-testid={`a3-report-loop-step-${step.kind}`} className="rounded-xl border border-slate-200 bg-white p-4 hover:border-blue-300 hover:bg-blue-50">
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">{index + 1}</span>
                <div className="mt-3 font-semibold text-slate-950">{step.title}</div>
                <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-600">{step.reason}</p>
              </Link>
            ))}
          </div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4" data-testid="a3-report-loop-primary">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
              <CheckCircle2 className="size-4" />
              当前最该做
            </div>
            <div className="mt-3 text-lg font-semibold text-emerald-950">{report.actionLoop.primaryAction.label}</div>
            <p className="mt-2 text-sm leading-6 text-emerald-800">{report.actionLoop.primaryReason}</p>
            <RelationshipActionContext relationship={relationship} testId="a3-report-loop-relationship" />
            <Button asChild className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700">
              <Link href={report.actionLoop.primaryAction.href}>按建议执行</Link>
            </Button>
          </div>
        </div>
      </A3Card>
    </div>
  );
}

function RelationshipActionContext({ relationship, testId }: { relationship?: StudyPlanRelationship; testId: string }) {
  if (!relationship) return null;
  const rows = [
    { label: '路径', detail: relationship.path },
    { label: '计划', detail: relationship.plan },
    { label: '今日', detail: relationship.today },
    { label: '写回', detail: relationship.writeback },
  ].filter((item) => item.detail);
  if (!rows.length) return null;
  return (
    <div data-testid={testId} className="mt-4 grid gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 md:grid-cols-2">
      {rows.map((item) => (
        <div key={item.label} className="min-w-0">
          <div className="text-[11px] font-semibold text-blue-950">{item.label}</div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-blue-800">{item.detail}</p>
        </div>
      ))}
    </div>
  );
}

function actionTone(type: NonNullable<LearningReport['weeklyPrescription']>['nextWeekActions'][number]['type']) {
  if (type === 'review') return 'orange';
  if (type === 'assessment') return 'violet';
  if (type === 'plan') return 'green';
  return 'blue';
}

function actionLabel(type: NonNullable<LearningReport['weeklyPrescription']>['nextWeekActions'][number]['type']) {
  if (type === 'review') return '错题';
  if (type === 'assessment') return '测评';
  if (type === 'plan') return '计划';
  return '今日';
}

function planChangeLabel(type: StudyPlanAdjustment['type']) {
  if (type === 'resource_pack') return '资源包';
  if (type === 'rollover') return '顺延';
  if (type === 'review') return '复习';
  if (type === 'mastery') return '薄弱点';
  return '节奏';
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
  detail: string;
  tone: 'blue' | 'green' | 'orange' | 'slate';
}) {
  const toneClass = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    orange: 'bg-orange-50 text-orange-700',
    slate: 'bg-slate-100 text-slate-600',
  }[tone];
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className={`inline-flex size-9 items-center justify-center rounded-lg ${toneClass}`}>
        <Icon className="size-5" />
      </div>
      <div className="mt-4 text-2xl font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-sm font-medium text-slate-700">{label}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function WeeklyMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: 'blue' | 'green' }) {
  const toneClass = tone === 'blue' ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`mt-3 inline-flex rounded-lg px-3 py-2 text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-3 text-sm text-slate-500">{detail}</div>
    </div>
  );
}

function ReportActionLink({ href, testId, title, detail }: { href: string; testId: string; title: string; detail: string }) {
  return (
    <Link href={href} data-testid={testId} className="group block rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-blue-300 hover:bg-blue-50">
      <div className="flex items-center justify-between gap-3">
        <div className="font-semibold text-slate-950">{title}</div>
        <ArrowRight className="size-4 text-blue-600 transition-transform group-hover:translate-x-0.5" />
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-600">{detail}</p>
    </Link>
  );
}

function WrongQuestionPanel({ report }: { report: LearningReport }) {
  return (
    <A3Card title="错题巩固">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-3xl font-semibold text-orange-600">{report.metrics.activeWrongQuestions}</div>
          <div className="mt-1 text-sm text-slate-500">待巩固题目</div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-emerald-600">{report.metrics.masteredWrongQuestions}</div>
          <div className="text-sm text-slate-500">已掌握</div>
        </div>
      </div>
      <div data-testid="a3-report-wrong-mastery-explanation" className="mt-4 rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-700">
        {report.wrongReviewInsight ? (
          <>
            <div className="font-semibold text-slate-950">{report.wrongReviewInsight.headline}</div>
            <p className="mt-1 line-clamp-3">{report.wrongReviewInsight.summary}</p>
            {report.wrongReviewInsight.recentKnowledgePoints.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {report.wrongReviewInsight.recentKnowledgePoints.slice(0, 4).map((point) => (
                  <span key={point} className="rounded-md bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-700">
                    {point}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : report.metrics.activeWrongQuestions > 0 ? (
          <>先完成错题复盘，再推进新任务。</>
        ) : (
          <>当前没有待巩固错题，可以进入测评做迁移练习。</>
        )}
      </div>
      <Button asChild className="mt-5 w-full">
        <Link href={report.wrongReviewInsight?.nextAction.href || '/a3/wrong-notebook'}>
          {report.wrongReviewInsight?.nextAction.label || '进入错题本'}
        </Link>
      </Button>
    </A3Card>
  );
}

function ReportProfileTimelinePanel({ feed }: { feed: DynamicProfileFeedResponse | null }) {
  const timeline = feed?.timeline ?? [];
  const pending = feed?.confirmationQueue ?? [];
  return (
    <A3Card title="画像变化时间线">
      <div data-testid="a3-report-profile-timeline" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm leading-6 text-slate-600">报告会同步展示画像随学习行为更新的证据。</p>
          <A3Pill tone={pending.length ? 'orange' : timeline.length ? 'green' : 'slate'}>
            {pending.length ? `${pending.length} 条待确认` : timeline.length ? '已记录' : '暂无变化'}
          </A3Pill>
        </div>
        {timeline.length > 0 ? (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {timeline.slice(0, 5).map((item) => (
              <ReportProfileTimelineItem key={`${item.id}-${item.versionId || item.createdAt}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-600">
            完成入学诊断、测评、错题复盘或 AI 课堂后，画像变化会进入这里。
          </div>
        )}
        {pending.length > 0 && (
          <Button asChild variant="outline" className="w-full">
            <Link href="/a3/profile-setup">去确认画像变化</Link>
          </Button>
        )}
      </div>
    </A3Card>
  );
}

function ReportProfileTimelineItem({ item }: { item: ProfileTimelineEntry }) {
  return (
    <div className="p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-900">{profileSourceLabel(item.source)}</span>
        <span className={reportProfileStatusClass(item.status)}>{profileStatusLabel(item.status)}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-slate-700">{summarizeProfileTimelineEntry(item)}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{summarizeProfileUpdateEvidence(item)}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
        <span>置信度 {Math.round((item.confidence ?? 0) * 100)}%</span>
        {item.versionNumber ? <span>画像版本 v{item.versionNumber}</span> : null}
        {item.createdAt && <span>{new Date(item.createdAt).toLocaleDateString('zh-CN')}</span>}
      </div>
    </div>
  );
}

function reportProfileStatusClass(status: ProfileTimelineEntry['status']) {
  const tone = profileStatusTone(status);
  if (tone === 'green') return 'rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700';
  if (tone === 'orange') return 'rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700';
  if (tone === 'red') return 'rounded-full bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-700';
  if (tone === 'blue') return 'rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700';
  return 'rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600';
}

function LearningEffectPanel({ effect, decisionHistory }: { effect: LearningEffectReport; decisionHistory: OptimizationPolicyDecision[] }) {
  const usage = effect.resourceUsage ?? {};
  const execution = effect.planExecution ?? {};
  const mastery = effect.masterySignals ?? {};
  const adjustment = effect.planAdjustment ?? {};
  const evidence = adjustment.evidence ?? {};
  const eventStream = effect.eventStream ?? {};
  const optimizationPolicy = effect.optimizationPolicy;
  const knowledgePoints = effect.knowledgePoints ?? [];
  const missingEvidence = effect.missingEvidence ?? [];
  return (
    <div data-testid="a3-report-learning-effect">
      <A3Card title="学习效果评估">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <EffectMetric icon={TrendingUp} label="效果总分" value={effect.overallEffectScore == null ? '--' : `${effect.overallEffectScore}`} />
          <EffectMetric icon={FileQuestion} label="证据置信度" value={effect.confidence ?? '--'} />
          <EffectMetric icon={BookOpen} label="资源打开/完成" value={`${usage.opened ?? 0}/${usage.completed ?? 0}`} />
          <EffectMetric icon={CheckCircle2} label="任务完成" value={`${execution.completedTasks ?? 0}/${execution.taskCount ?? 0}`} />
          <EffectMetric icon={Target} label="资源有效性" value={effect.resourceEffectiveness == null ? '--' : `${effect.resourceEffectiveness}`} />
          <EffectMetric icon={RotateCcw} label="反馈均分" value={`${mastery.averageFeedbackScore ?? evidence.averageFeedbackScore ?? 0}`} />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <EffectMetric icon={BarChart3} label="7 天作答" value={`${effect.trends?.sevenDay?.assessment?.attemptCount ?? 0}`} />
          <EffectMetric icon={BarChart3} label="14 天作答" value={`${effect.trends?.fourteenDay?.assessment?.attemptCount ?? 0}`} />
          <EffectMetric icon={BarChart3} label="30 天作答" value={`${effect.trends?.thirtyDay?.assessment?.attemptCount ?? 0}`} />
        </div>
        <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4" data-testid="a3-report-event-stream-evidence">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-blue-950">事件流采集证据</div>
              <p className="mt-1 text-xs leading-5 text-blue-800">报告读取 LearningEvent v2 的来源页面、客户端事件和批量 ingest 证据。</p>
            </div>
            <A3Pill tone={(eventStream.v2EventCount ?? 0) > 0 ? 'green' : 'orange'}>{eventStream.schemaVersion ?? 'a3.learning-event.v2'}</A3Pill>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <EffectMetric icon={BarChart3} label="v2 事件" value={`${eventStream.v2EventCount ?? 0}`} />
            <EffectMetric icon={CheckCircle2} label="已接收" value={`${eventStream.acceptedCount ?? 0}`} />
            <EffectMetric icon={BookOpen} label="来源页" value={`${eventStream.sourcePages?.length ?? 0}`} />
          </div>
        </div>
        {missingEvidence.length > 0 && (
          <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm leading-6 text-orange-800">
            证据不足：{missingEvidence.join('；')}
          </div>
        )}
        {knowledgePoints.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-sm font-semibold text-slate-950">知识点增益</div>
            <div className="mt-3 grid gap-3">
              {knowledgePoints.slice(0, 4).map((point) => (
                <div key={point.knowledgePointId} className="grid gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-3 md:grid-cols-[minmax(0,1fr)_repeat(4,auto)] md:items-center">
                  <div>
                    <div className="text-sm font-semibold text-slate-950">{point.name}</div>
                    <div className="mt-1 text-xs text-slate-500">证据：{(point.evidence ?? []).join(' / ') || 'assessment'}</div>
                  </div>
                  <A3Pill tone={point.learningGain >= 0 ? 'green' : 'orange'}>{point.trend}</A3Pill>
                  <span className="text-xs text-slate-600">前测 {point.preScore}</span>
                  <span className="text-xs text-slate-600">后测 {point.postScore}</span>
                  <span className="text-xs font-semibold text-slate-950">增益 {point.learningGain > 0 ? '+' : ''}{point.learningGain}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">查看计划调整证据</summary>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            {adjustment.reason ?? '系统会根据资源完成、反馈分数、计划执行率和知识点增益调整后续任务。'}
          </p>
          {(mastery.weakPoints ?? []).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {(mastery.weakPoints ?? []).slice(0, 4).map((point) => (
                <span key={point} className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-orange-700">
                  {point}
                </span>
              ))}
            </div>
          )}
        </details>
        {optimizationPolicy && (
          <details className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4" data-testid="a3-report-optimization-policy">
            <summary className="cursor-pointer text-sm font-semibold text-blue-950">持续优化策略</summary>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <EffectMetric icon={Target} label="策略" value={optimizationPolicy.selectedStrategy ?? '--'} />
              <EffectMetric icon={BarChart3} label="决策分" value={`${optimizationPolicy.selectedCandidate?.decisionScore ?? 0}`} />
              <EffectMetric icon={CheckCircle2} label="评测状态" value={optimizationPolicy.outcomeStatus ?? 'pending'} />
              <EffectMetric icon={RotateCcw} label="候选数" value={`${optimizationPolicy.candidates?.length ?? 0}`} />
            </div>
            <div className="mt-3 rounded-lg bg-white/75 p-3 text-xs leading-5 text-blue-900">
              {(optimizationPolicy.selectedCandidate?.rankingBasis ?? ['等待更多学习行为后回看策略效果']).join('；')}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {(optimizationPolicy.successCriteria ?? []).slice(0, 2).map((item) => (
                <div key={`${item.metric}-${item.windowDays}`} className="rounded-lg bg-white/75 px-3 py-2 text-xs text-blue-900">
                  {item.metric} / {item.windowDays ?? 7} 天 / 目标 {item.targetDelta ?? item.target ?? '--'}
                </div>
              ))}
            </div>
          </details>
        )}
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4" data-testid="a3-report-optimization-decision-history">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-950">策略决策历史</div>
              <p className="mt-1 text-xs leading-5 text-slate-500">最近 {decisionHistory.length}/12 条策略动作及 7 天回看状态。</p>
            </div>
            <A3Pill tone={decisionHistory.length > 0 ? 'blue' : 'slate'}>decisionHistory</A3Pill>
          </div>
          {decisionHistory.length > 0 ? (
            <div className="mt-4 divide-y divide-slate-100">
              {decisionHistory.slice(0, 12).map((decision) => (
                <div key={decision.decisionId || `${decision.selectedStrategy}-${decision.decisionAt}`} className="grid gap-3 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_110px_120px] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-950">{policyStrategyLabel(decision.selectedStrategy)}</span>
                      <A3Pill tone={policyOutcomeTone(decision.outcomeStatus)}>{policyOutcomeLabel(decision.outcomeStatus)}</A3Pill>
                      {decision.explorationMode && <A3Pill tone="violet">探索</A3Pill>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                      {(decision.rankingBasis ?? []).join('；') || decision.decisionId || '等待更多证据完成回看'}
                    </p>
                  </div>
                  <div className="text-xs text-slate-500">
                    <div className="font-semibold text-slate-900">分数 {decision.decisionScore ?? '--'}</div>
                    <div>{formatReportDateTime(decision.decisionAt)}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                    效果 {formatSignedMetric(decision.observedMetricDelta?.effectScoreDelta)}
                    <br />
                    窗口 {decision.evaluationWindow?.days ?? 7} 天
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-500">
              完成一次学习效果评估后，策略决策会写入历史并进入 7 天回看。
            </div>
          )}
        </div>
      </A3Card>
    </div>
  );
}

function policyStrategyLabel(strategy?: string) {
  const labels: Record<string, string> = {
    add_remedial_practice: '补弱练习',
    add_spaced_review: '间隔复习',
    add_diagnostic_practice: '诊断练习',
    reduce_new_content: '降低新内容负荷',
    increase_challenge: '提升挑战',
    recommend_coaching: '辅导介入',
  };
  return labels[strategy || ''] || strategy || '--';
}

function policyOutcomeLabel(status?: string) {
  if (status === 'succeeded') return '有效';
  if (status === 'failed') return '回滚';
  if (status === 'insufficient_evidence') return '证据不足';
  return '回看中';
}

function policyOutcomeTone(status?: string): 'blue' | 'green' | 'orange' | 'red' | 'slate' {
  if (status === 'succeeded') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'insufficient_evidence') return 'orange';
  if (status === 'pending') return 'blue';
  return 'slate';
}

function formatSignedMetric(value?: number) {
  if (value == null || Number.isNaN(value)) return '--';
  return `${value > 0 ? '+' : ''}${value}`;
}

function formatReportDateTime(value?: string) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function EffectMetric({ icon: Icon, label, value }: { icon: typeof BookOpen; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <Icon className="size-5 text-blue-600" />
      <div className="mt-3 text-xl font-semibold text-slate-950">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}

function ResourcePackEffectPanel({ effect }: { effect: NonNullable<LearningReport['resourcePackEffect']> }) {
  const latest = effect.latestRun;
  return (
    <div data-testid="a3-report-resource-pack-effect">
      <A3Card title="资源包转化">
        <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
          <div className="rounded-xl border border-violet-100 bg-violet-50 p-4">
            <div className="text-sm font-semibold text-violet-900">闭环率</div>
            <div className="mt-3 text-4xl font-semibold text-violet-950">{effect.conversionRate}%</div>
            <p className="mt-2 text-xs leading-5 text-violet-800">{effect.conversionMessage}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <ResourcePackMetric label="完成资源包" value={`${effect.totalRuns}`} />
            <ResourcePackMetric label="验证来源" value={`${effect.verifiedSourceCount}`} />
            <ResourcePackMetric label="专项练习" value={`${effect.practiceStartedCount}`} />
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <A3Pill tone={latest ? 'violet' : 'orange'}>{latest ? '最近资源包' : '尚未开始'}</A3Pill>
            {latest && <span className="text-xs text-slate-500">{latest.confidence} confidence</span>}
          </div>
          <div className="mt-3 text-base font-semibold text-slate-950">{latest?.learningGoal || '先完成一个推荐资源包'}</div>
          <p className="mt-2 text-sm leading-6 text-slate-600">{effect.nextAction.reason}</p>
          <Button asChild className="mt-4 bg-violet-600 hover:bg-violet-700">
            <Link href={effect.nextAction.href}>
              {effect.nextAction.label}
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </A3Card>
    </div>
  );
}

function ResourcePackMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-2 overflow-hidden rounded-full bg-slate-200 ${className}`}>
      <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function getPrimaryAction(report: LearningReport): PrimaryAction {
  if (report.weeklyPrescription?.primaryAction) {
    return { ...report.weeklyPrescription.primaryAction, source: '处方' };
  }
  if (report.actionLoop?.primaryAction) {
    return {
      label: report.actionLoop.primaryAction.label,
      href: report.actionLoop.primaryAction.href,
      reason: report.actionLoop.primaryReason,
      source: '闭环',
    };
  }
  if (report.metrics.activeWrongQuestions > 0) {
    return { label: '先复盘错题', href: '/a3/wrong-notebook', reason: '待巩固错题会影响后续知识吸收，先处理错因更稳。', source: '默认' };
  }
  return { label: '继续今日任务', href: '/a3/today', reason: '当前没有更高优先级风险，继续推进今日学习计划。', source: '默认' };
}

function getReportHealth(report: LearningReport): { label: string; tone: 'blue' | 'green' | 'orange' | 'red' | 'slate' } {
  if (report.metrics.activeWrongQuestions >= 5 || report.metrics.accuracy < 60) return { label: '需要干预', tone: 'orange' };
  if (report.metrics.accuracy >= 85 && report.metrics.pathProgress >= 70) return { label: '稳步提升', tone: 'green' };
  if (report.metrics.pathProgress < 35) return { label: '节奏偏慢', tone: 'blue' };
  return { label: '正常推进', tone: 'slate' };
}

function periodLabel(period: ReportPeriod) {
  if (period === '7d') return '近 7 天';
  if (period === '30d') return '近 30 天';
  return '本学期';
}
