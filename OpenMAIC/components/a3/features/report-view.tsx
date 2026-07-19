'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw, Sparkles, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import type { DynamicProfileInsight } from '@/components/a3/profile/dynamic-profile-insight-panel';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { LearningReport } from '@/lib/a3/assessment-types';
import { trackPageView } from '@/lib/a3/learning-event-client';
import type { A3ApiResponse, StudyPlan } from '@/lib/a3/learning-types';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import { buildLearningReportCsv } from '@/lib/a3/report-export';
import { buildStudentReportViewModel } from '@/lib/a3/report-view-model';
import type { LearningEffectReport } from '@/lib/a3/report-view-model';
import { ReportOverviewPanel } from './report/report-overview-panel';
import { ReportChangeSummary } from './report/report-change-summary';
import { ReportWeakPoints } from './report/report-weak-points';
import { ReportSevenDayPlan } from './report/report-seven-day-plan';
import { ReportMethodEffect } from './report/report-method-effect';
import { ReportDetails } from './report/report-details';
import { A3Markdown } from '../ui/a3-markdown';

type ReportPeriod = '7d' | '30d' | 'term';
type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan }>;

type LearningSummaryDocument = {
  id: string;
  schemaVersion: string;
  title: string;
  fileName: string;
  prompt: string;
  contentMd: string;
  summaryDate: string;
  createdAt: string;
};

type LearningSummaryDocumentsResponse = {
  success: boolean;
  error?: string;
  document?: LearningSummaryDocument;
  documents?: LearningSummaryDocument[];
};

export function ReportView() {
  const router = useRouter();
  const user = useA3CurrentUser();
  const [report, setReport] = useState<LearningReport | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>('30d');
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [learningEffect, setLearningEffect] = useState<LearningEffectReport | null>(null);
  const [dynamicProfile, setDynamicProfile] = useState<DynamicProfileInsight | null>(null);
  const [profileFeed, setProfileFeed] = useState<DynamicProfileFeedResponse | null>(null);
  const [supplementalLoading, setSupplementalLoading] = useState(true);
  const [supplementalError, setSupplementalError] = useState('');
  const [summaryDocuments, setSummaryDocuments] = useState<LearningSummaryDocument[]>([]);
  const [selectedSummaryId, setSelectedSummaryId] = useState('');
  const [summaryPrompt, setSummaryPrompt] = useState('总结我今天学了什么');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const displayName = user?.displayName?.trim() || '同学';

  useEffect(() => {
    void trackPageView('/a3/report', { page: 'report', period });
    let active = true;
    void a3GetJson<A3ApiResponse<{ report: LearningReport }>>(`/api/assessments/report/?period=${period}`).then((result) => {
      if (!active) return;
      if (result.success) {
        setReport(result.report);
        setError('');
      }
      else setError(result.error || '学习报告加载失败');
      setLoading(false);
      setReportLoading(false);
    });
    return () => { active = false; };
  }, [period, reloadToken]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      a3GetJson<{ success: boolean; error?: string; effectReport?: LearningEffectReport }>('/api/learning/effect/report/'),
      a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
      a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/'),
      a3GetJson<LearningSummaryDocumentsResponse>('/api/learning/report-summaries/?limit=20'),
    ]).then(([effectResult, planResult, profileResult, summaryResult]) => {
      if (!active) return;
      if (effectResult.success) setLearningEffect(effectResult.effectReport ?? null);
      if (planResult.success) setStudyPlan(planResult.plan ?? null);
      if (profileResult.success) {
        setProfileFeed(profileResult);
        setDynamicProfile(profileResult.dynamicProfile ?? null);
      }
      if (summaryResult.success) {
        const documents = summaryResult.documents ?? [];
        setSummaryDocuments(documents);
        setSelectedSummaryId((current) => current || documents[0]?.id || '');
      }
      const failures = [
        !effectResult.success && effectResult.error,
        !planResult.success && planResult.error,
        !profileResult.success && profileResult.error,
        !summaryResult.success && summaryResult.error,
      ].filter(Boolean);
      setSupplementalError(failures.length ? String(failures[0]) : '');
      setSupplementalLoading(false);
    });
    return () => { active = false; };
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

  const exportReport = useCallback(() => {
    if (!report) return;
    const csv = buildLearningReportCsv(report);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `学习报告-${report.period.end}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [report]);

  if (loading && !report) return <ReportSkeleton />;

  if (!report) {
    return (
      <div className="rounded-lg border border-rose-200 bg-[var(--a3-surface-solid)] p-6" role="alert">
        <h1 className="text-lg font-semibold text-[var(--a3-text)]">学习报告暂时无法打开</h1>
        <p className="mt-2 text-sm text-rose-700">{error || '请稍后重试。'}</p>
        <Button className="mt-4" onClick={() => { setLoading(true); setReloadToken((value) => value + 1); }}>
          <RotateCcw className="size-4" />重新加载
        </Button>
      </div>
    );
  }

  const studentReport = buildStudentReportViewModel({ report, studyPlan, effectReport: learningEffect });
  const summaryTool = (
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
  );

  return (
    <div className="space-y-7" data-testid="a3-report-view">
      <style jsx global>{`
        @media print {
          aside, nav, header, .a3-report-no-print { display: none !important; }
          [data-testid='a3-report-view'] { padding: 0 !important; }
          [data-testid='a3-report-view'] section { break-inside: avoid; box-shadow: none !important; }
        }
      `}</style>
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-blue-50">
            <Image src="/avatars/learner.svg" alt={`${displayName}头像`} fill className="object-cover" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-[var(--a3-text)]">{displayName}的学习报告</h1>
            <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{studentReport.period.label}：{studentReport.period.start} 至 {studentReport.period.end}</p>
          </div>
        </div>
        <PeriodSegmentedControl value={period} loading={reportLoading} onChange={(nextPeriod) => {
          if (nextPeriod === period) return;
          setError('');
          setReportLoading(true);
          setPeriod(nextPeriod);
        }} />
      </header>

      {error && <p role="status" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">新周期加载失败，仍显示上一周期报告：{error}</p>}
      <ReportOverviewPanel overview={studentReport.overview} evidenceState={studentReport.evidenceState} updating={reportLoading} />
      <ReportChangeSummary changes={studentReport.changes} />
      <ReportWeakPoints weakKnowledgePoints={studentReport.weakKnowledgePoints} />
      <ReportSevenDayPlan plan={studentReport.sevenDayPlan} />
      <ReportMethodEffect methods={studentReport.effectiveMethods} />
      <ReportDetails
        report={report}
        dynamicProfile={dynamicProfile}
        profileFeed={profileFeed}
        supplementalLoading={supplementalLoading}
        supplementalError={supplementalError}
        summaryTool={summaryTool}
        onExportCsv={exportReport}
        onExportPdf={() => window.print()}
        onTrendDrill={(bucket) => {
          const query = new URLSearchParams({ source: 'report', period, start: bucket.start || '', end: bucket.end || '', label: bucket.label });
          router.push(`/a3/assessment?${query.toString()}`);
        }}
        onCapabilityDrill={(axis) => {
          const query = new URLSearchParams({ source: 'report', period, focus: axis.label });
          router.push(`/a3/wrong-notebook?${query.toString()}`);
        }}
      />
      <p className="pb-2 text-center text-xs text-[var(--a3-text-muted)]">报告仅统计系统内已记录的学习行为。</p>
    </div>
  );
}

function PeriodSegmentedControl({ value, loading, onChange }: { value: ReportPeriod; loading: boolean; onChange: (value: ReportPeriod) => void }) {
  const options: Array<{ key: ReportPeriod; label: string }> = [
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
    { key: 'term', label: '本学期' },
  ];
  return (
    <div className="a3-report-no-print inline-flex h-10 items-center rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-1" aria-label="报告周期">
      {options.map((option) => (
        <button key={option.key} type="button" disabled={loading} onClick={() => onChange(option.key)} className={`h-8 px-3 text-sm font-medium transition-colors ${value === option.key ? 'rounded-md bg-blue-600 text-white' : 'text-[var(--a3-text-muted)] hover:text-[var(--a3-text)]'}`}>
          {option.label}
        </button>
      ))}
      {loading && <Loader2 className="mx-2 size-4 animate-spin text-blue-600" />}
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
  return (
    <section data-testid="a3-report-summary-tool" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
        <label className="block">
          <span className="text-sm font-semibold text-[var(--a3-text)]">总结要求</span>
          <textarea data-testid="a3-report-summary-prompt" value={prompt} maxLength={200} rows={3} onChange={(event) => onPromptChange(event.target.value)} className="mt-2 w-full resize-none rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 py-2 text-sm leading-6 text-[var(--a3-text)] outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-950" />
        </label>
        <Button data-testid="a3-report-summary-generate" type="button" onClick={onGenerate} disabled={loading} className="mt-3">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}生成总结
        </Button>
        {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
        <div data-testid="a3-report-summary-markdown" className="mt-4 min-h-40 rounded-lg bg-[var(--a3-surface-muted)] p-4">
          {selected ? <A3Markdown className="text-[var(--a3-text)]">{selected.contentMd}</A3Markdown> : <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--a3-text-muted)]"><FileText className="size-5" />还没有学习总结</div>}
        </div>
      </div>
      <div data-testid="a3-report-summary-history" className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--a3-text)]">历史总结</h3>
        {documents.length ? documents.map((item) => (
          <button key={item.id} type="button" onClick={() => onSelect(item.id)} className={`w-full rounded-lg border p-3 text-left transition-colors ${item.id === selected?.id ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/40' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)]'}`}>
            <span className="block truncate text-sm font-semibold text-[var(--a3-text)]">{item.title}</span>
            <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">{item.summaryDate}</span>
          </button>
        )) : <p className="rounded-lg bg-[var(--a3-surface-muted)] p-3 text-sm text-[var(--a3-text-muted)]">生成后会保留在这里。</p>}
      </div>
    </section>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-5" aria-label="正在汇总学习数据">
      <div className="h-14 animate-pulse rounded-lg bg-slate-200" />
      <div className="h-72 animate-pulse rounded-lg bg-slate-200" />
      <div className="grid gap-3 md:grid-cols-3">{[0, 1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-lg bg-slate-100" />)}</div>
    </div>
  );
}
