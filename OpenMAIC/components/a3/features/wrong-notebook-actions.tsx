'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, RefreshCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3DownloadFile, a3GetJson, a3PostDownload, a3PostJson } from '@/lib/a3/api-client';
import type { ReviewHandoutJob, WrongExportFormat, WrongExportScope, WrongReviewSummary } from '@/lib/a3/assessment-types';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type JobsResponse = A3ApiResponse<{ jobs: ReviewHandoutJob[] }>;
type JobResponse = A3ApiResponse<{ job: ReviewHandoutJob; reused?: boolean }>;

const scopes: Array<{ value: WrongExportScope; label: string }> = [
  { value: 'active', label: '待巩固' },
  { value: 'due', label: '今日到期' },
  { value: 'mastered', label: '已掌握' },
  { value: 'all', label: '全部' },
];

const formats: Array<{ value: WrongExportFormat; label: string }> = [
  { value: 'docx', label: 'Word' },
  { value: 'xlsx', label: 'Excel' },
  { value: 'pdf', label: 'PDF' },
];

const jobActionPath = {
  cancel: '/cancel/',
  retry: '/retry/',
} as const;

export function WrongNotebookActions({ reviewSummary }: { reviewSummary: WrongReviewSummary | null }) {
  const [scope, setScope] = useState<WrongExportScope>('active');
  const [format, setFormat] = useState<WrongExportFormat>('docx');
  const [jobs, setJobs] = useState<ReviewHandoutJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actingJob, setActingJob] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const hasActiveJob = useMemo(
    () => jobs.some((job) => job.status === 'queued' || job.status === 'running'),
    [jobs],
  );

  const loadJobs = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingJobs(true);
    const result = await a3GetJson<JobsResponse>('/api/assessments/wrong-questions/review-handouts/');
    if (result.success) {
      setJobs(result.jobs);
    } else if (!quiet) {
      setError(result.error || '讲义任务加载失败');
    }
    if (!quiet) setLoadingJobs(false);
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => void loadJobs(true), 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, loadJobs]);

  async function exportWrongQuestions() {
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const date = new Date().toISOString().slice(0, 10);
      const fallback = 'wrong-questions-' + scope + '-' + date + '.' + format;
      const result = await a3PostDownload(
        '/api/assessments/wrong-questions/export/',
        { scope, format },
        fallback,
      );
      setNotice(result.fileName + ' 已开始下载');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '错题导出失败');
    } finally {
      setExporting(false);
    }
  }

  async function generateHandout() {
    setGenerating(true);
    setError('');
    setNotice('');
    const result = await a3PostJson<JobResponse>(
      '/api/assessments/wrong-questions/review-handouts/',
      { scope },
    );
    if (result.success) {
      setNotice(result.reused ? '相同讲义任务已在队列中' : '复习讲义已进入生成队列');
      await loadJobs(true);
    } else {
      setError(result.error || '复习讲义创建失败');
    }
    setGenerating(false);
  }

  async function runJobAction(job: ReviewHandoutJob, action: 'cancel' | 'retry') {
    setActingJob(job.jobId);
    setError('');
    const url = '/api/assessments/wrong-questions/review-handouts/' + job.jobId + jobActionPath[action];
    const result = await a3PostJson<JobResponse>(url, {});
    if (result.success) {
      setNotice(action === 'cancel' ? '讲义任务已取消' : '讲义已重新进入生成队列');
      await loadJobs(true);
    } else {
      setError(result.error || (action === 'cancel' ? '取消失败' : '重试失败'));
    }
    setActingJob('');
  }

  async function downloadHandout(url: string, extension: 'docx' | 'pdf') {
    setError('');
    try {
      await a3DownloadFile(url, 'review-handout.' + extension);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '讲义下载失败');
    }
  }

  return (
    <div data-testid="a3-wrong-notebook-actions">
      <A3Card
        title="导出与复习讲义"
        subtitle="导出真实错题明细，或根据薄弱点和本地课程资料生成个性化讲义。"
        action={<A3Pill tone={hasActiveJob ? 'orange' : 'slate'}>{hasActiveJob ? '后台生成中' : '可用'}</A3Pill>}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-4 rounded-lg border border-slate-200 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">错题明细导出</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">Word 和 PDF 适合复习，Excel 适合筛选与统计。</p>
            </div>
            <ScopeSelect value={scope} onChange={setScope} />
            <div className="grid grid-cols-3 gap-2" aria-label="导出格式">
              {formats.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setFormat(item.value)}
                  className={'h-10 rounded-md border text-sm font-medium transition-colors ' + (
                    format === item.value
                      ? 'border-blue-600 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <Button onClick={exportWrongQuestions} disabled={exporting} className="w-full sm:w-auto">
              {exporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
              导出{formats.find((item) => item.value === format)?.label}
            </Button>
          </section>

          <section className="space-y-4 rounded-lg border border-slate-200 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-950">薄弱点复习讲义</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">答案解析统一放在文末，生成完成后可下载 Word 和 PDF。</p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <Metric label="待巩固" value={reviewSummary?.activeCount ?? 0} />
              <Metric label="今日到期" value={reviewSummary?.todayCount ?? 0} />
              <Metric label="已掌握" value={reviewSummary?.masteredCount ?? 0} />
            </div>
            <Button onClick={generateHandout} disabled={generating} variant="outline" className="w-full bg-white sm:w-auto">
              {generating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <FileText className="mr-2 size-4" />}
              生成复习讲义
            </Button>
          </section>
        </div>

        {(error || notice) && (
          <div className={'mt-4 rounded-lg px-4 py-3 text-sm ' + (error ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700')}>
            {error || notice}
          </div>
        )}

        <div className="mt-5 border-t border-slate-200 pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-950">讲义历史</h3>
            <Button size="icon" variant="ghost" onClick={() => void loadJobs()} title="刷新讲义任务" aria-label="刷新讲义任务">
              <RefreshCcw className="size-4" />
            </Button>
          </div>
          {loadingJobs ? (
            <div className="flex h-20 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 size-4 animate-spin" />
              正在加载讲义任务
            </div>
          ) : jobs.length === 0 ? (
            <div className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">还没有生成过复习讲义。</div>
          ) : (
            <div className="space-y-2">
              {jobs.slice(0, 6).map((job) => (
                <JobRow
                  key={job.jobId}
                  job={job}
                  acting={actingJob === job.jobId}
                  onAction={runJobAction}
                  onDownload={downloadHandout}
                />
              ))}
            </div>
          )}
        </div>
      </A3Card>
    </div>
  );
}

function ScopeSelect({ value, onChange }: { value: WrongExportScope; onChange: (value: WrongExportScope) => void }) {
  return (
    <label className="block text-xs font-medium text-slate-600">
      导出范围
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as WrongExportScope)}
        className="mt-1 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      >
        {scopes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
    </label>
  );
}

function JobRow({
  job,
  acting,
  onAction,
  onDownload,
}: {
  job: ReviewHandoutJob;
  acting: boolean;
  onAction: (job: ReviewHandoutJob, action: 'cancel' | 'retry') => void;
  onDownload: (url: string, extension: 'docx' | 'pdf') => void;
}) {
  const running = job.status === 'queued' || job.status === 'running';
  const icon = running
    ? <Loader2 className="size-4 animate-spin text-orange-600" />
    : job.status === 'succeeded'
      ? <CheckCircle2 className="size-4 text-emerald-600" />
      : job.status === 'cancelled'
        ? <XCircle className="size-4 text-slate-500" />
        : <AlertTriangle className="size-4 text-rose-600" />;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
          {icon}
          {scopeLabel(job.scope)}复习讲义
          {job.degraded && <A3Pill tone="orange">资料不足降级</A3Pill>}
          {job.verified && <A3Pill tone="green">引用已核验</A3Pill>}
        </div>
        <p className="mt-1 truncate text-xs text-slate-500">{job.message || statusLabel(job.status)}</p>
        {running && (
          <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-orange-500 transition-[width]" style={{ width: Math.max(4, job.progress) + '%' }} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {job.docxDownloadUrl && (
          <Button size="sm" variant="outline" onClick={() => onDownload(job.docxDownloadUrl!, 'docx')}>
            <FileText className="mr-2 size-4" />Word
          </Button>
        )}
        {job.pdfDownloadUrl && (
          <Button size="sm" variant="outline" onClick={() => onDownload(job.pdfDownloadUrl!, 'pdf')}>
            <Download className="mr-2 size-4" />PDF
          </Button>
        )}
        {running && (
          <Button size="sm" variant="outline" disabled={acting} onClick={() => onAction(job, 'cancel')}>
            <XCircle className="mr-2 size-4" />取消
          </Button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button size="sm" variant="outline" disabled={acting} onClick={() => onAction(job, 'retry')}>
            <RefreshCcw className="mr-2 size-4" />重试
          </Button>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-slate-50 px-2 py-3">
      <div className="text-lg font-semibold text-slate-950">{value}</div>
      <div className="mt-0.5 text-slate-500">{label}</div>
    </div>
  );
}

function scopeLabel(scope: WrongExportScope) {
  return scopes.find((item) => item.value === scope)?.label ?? scope;
}

function statusLabel(status: ReviewHandoutJob['status']) {
  return { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '生成失败', cancelled: '已取消' }[status];
}
