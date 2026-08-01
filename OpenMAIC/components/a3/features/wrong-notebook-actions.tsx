'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, RefreshCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3DownloadFile, a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type {
  AssessmentJobStatus,
  ReviewHandoutJob,
  WrongExportFormat,
  WrongExportScope,
  WrongQuestionExportJob,
  WrongReviewSummary,
} from '@/lib/a3/assessment-types';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type ExportJobsResponse = A3ApiResponse<{ jobs: WrongQuestionExportJob[] }>;
type ExportJobResponse = A3ApiResponse<{ job: WrongQuestionExportJob; reused?: boolean }>;
type HandoutJobsResponse = A3ApiResponse<{ jobs: ReviewHandoutJob[] }>;
type HandoutJobResponse = A3ApiResponse<{ job: ReviewHandoutJob; reused?: boolean }>;

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
  const [exportJobs, setExportJobs] = useState<WrongQuestionExportJob[]>([]);
  const [handoutJobs, setHandoutJobs] = useState<ReviewHandoutJob[]>([]);
  const [loadingExportJobs, setLoadingExportJobs] = useState(true);
  const [loadingHandoutJobs, setLoadingHandoutJobs] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actingJob, setActingJob] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const hasActiveJob = useMemo(
    () => exportJobs.some((job) => job.status === 'queued' || job.status === 'running')
      || handoutJobs.some((job) => job.status === 'queued' || job.status === 'running'),
    [exportJobs, handoutJobs],
  );

  const loadExportJobs = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingExportJobs(true);
    const result = await a3GetJson<ExportJobsResponse>('/api/assessments/wrong-questions/exports/');
    if (result.success) {
      setExportJobs(result.jobs);
    } else if (!quiet) {
      setError(result.error || '导出任务加载失败');
    }
    if (!quiet) setLoadingExportJobs(false);
  }, []);

  const loadHandoutJobs = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingHandoutJobs(true);
    const result = await a3GetJson<HandoutJobsResponse>('/api/assessments/wrong-questions/review-handouts/');
    if (result.success) {
      setHandoutJobs(result.jobs);
    } else if (!quiet) {
      setError(result.error || '讲义任务加载失败');
    }
    if (!quiet) setLoadingHandoutJobs(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadExportJobs();
      void loadHandoutJobs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadExportJobs, loadHandoutJobs]);

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => {
      void loadExportJobs(true);
      void loadHandoutJobs(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, loadExportJobs, loadHandoutJobs]);

  async function exportWrongQuestions() {
    setExporting(true);
    setError('');
    setNotice('');
    const result = await a3PostJson<ExportJobResponse>(
      '/api/assessments/wrong-questions/exports/',
      { scope, format },
    );
    if (result.success) {
      setNotice(result.reused ? '相同导出任务已在队列中' : '错题导出已进入生成队列');
      await loadExportJobs(true);
    } else {
      setError(result.error || '错题导出任务创建失败');
    }
    setExporting(false);
  }

  async function generateHandout() {
    setGenerating(true);
    setError('');
    setNotice('');
    const result = await a3PostJson<HandoutJobResponse>(
      '/api/assessments/wrong-questions/review-handouts/',
      { scope },
    );
    if (result.success) {
      setNotice(result.reused ? '相同讲义任务已在队列中' : '复习讲义已进入生成队列');
      await loadHandoutJobs(true);
    } else {
      setError(result.error || '复习讲义创建失败');
    }
    setGenerating(false);
  }

  async function runExportJobAction(job: WrongQuestionExportJob, action: 'cancel' | 'retry') {
    setActingJob('export-' + job.jobId);
    setError('');
    const url = '/api/assessments/wrong-questions/exports/' + job.jobId + jobActionPath[action];
    const result = await a3PostJson<ExportJobResponse>(url, {});
    if (result.success) {
      setNotice(action === 'cancel' ? '导出任务已取消' : '导出任务已重新进入生成队列');
      await loadExportJobs(true);
    } else {
      setError(result.error || (action === 'cancel' ? '取消失败' : '重试失败'));
    }
    setActingJob('');
  }

  async function runHandoutJobAction(job: ReviewHandoutJob, action: 'cancel' | 'retry') {
    setActingJob('handout-' + job.jobId);
    setError('');
    const url = '/api/assessments/wrong-questions/review-handouts/' + job.jobId + jobActionPath[action];
    const result = await a3PostJson<HandoutJobResponse>(url, {});
    if (result.success) {
      setNotice(action === 'cancel' ? '讲义任务已取消' : '讲义已重新进入生成队列');
      await loadHandoutJobs(true);
    } else {
      setError(result.error || (action === 'cancel' ? '取消失败' : '重试失败'));
    }
    setActingJob('');
  }

  async function downloadExport(job: WrongQuestionExportJob) {
    if (!job.downloadUrl) return;
    setError('');
    try {
      await a3DownloadFile(job.downloadUrl, `wrong-questions-${job.scope}.${job.format}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '错题导出下载失败');
    }
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
            <h3 className="text-sm font-semibold text-slate-950">导出历史</h3>
            <Button size="icon" variant="ghost" onClick={() => void loadExportJobs()} title="刷新导出任务" aria-label="刷新导出任务">
              <RefreshCcw className="size-4" />
            </Button>
          </div>
          {loadingExportJobs ? (
            <JobListLoading label="正在加载导出任务" />
          ) : exportJobs.length === 0 ? (
            <JobListEmpty label="还没有导出过错题。" />
          ) : (
            <div className="space-y-2">
              {exportJobs.slice(0, 6).map((job) => (
                <ExportJobRow
                  key={job.jobId}
                  job={job}
                  acting={actingJob === 'export-' + job.jobId}
                  onAction={runExportJobAction}
                  onDownload={downloadExport}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-5 border-t border-slate-200 pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-950">讲义历史</h3>
            <Button size="icon" variant="ghost" onClick={() => void loadHandoutJobs()} title="刷新讲义任务" aria-label="刷新讲义任务">
              <RefreshCcw className="size-4" />
            </Button>
          </div>
          {loadingHandoutJobs ? (
            <JobListLoading label="正在加载讲义任务" />
          ) : handoutJobs.length === 0 ? (
            <JobListEmpty label="还没有生成过复习讲义。" />
          ) : (
            <div className="space-y-2">
              {handoutJobs.slice(0, 6).map((job) => (
                <HandoutJobRow
                  key={job.jobId}
                  job={job}
                  acting={actingJob === 'handout-' + job.jobId}
                  onAction={runHandoutJobAction}
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

function ExportJobRow({
  job,
  acting,
  onAction,
  onDownload,
}: {
  job: WrongQuestionExportJob;
  acting: boolean;
  onAction: (job: WrongQuestionExportJob, action: 'cancel' | 'retry') => void;
  onDownload: (job: WrongQuestionExportJob) => void;
}) {
  return (
    <TaskRow
      title={`${scopeLabel(job.scope)}错题 · ${formatLabel(job.format)}`}
      job={job}
      acting={acting}
      auditModel={job.model}
      auditAttempts={job.attempts}
      onCancel={() => onAction(job, 'cancel')}
      onRetry={() => onAction(job, 'retry')}
      download={job.downloadUrl ? { label: `下载${formatLabel(job.format)}`, onClick: () => onDownload(job) } : undefined}
    />
  );
}

function HandoutJobRow({
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
  return (
    <TaskRow
      title={`${scopeLabel(job.scope)}复习讲义`}
      job={job}
      acting={acting}
      auditModel={job.llmAudit.model}
      auditAttempts={job.llmAudit.attempts}
      onCancel={() => onAction(job, 'cancel')}
      onRetry={() => onAction(job, 'retry')}
      downloads={[
        ...(job.docxDownloadUrl ? [{ label: '下载 Word 讲义', onClick: () => onDownload(job.docxDownloadUrl!, 'docx') }] : []),
        ...(job.pdfDownloadUrl ? [{ label: '下载 PDF 讲义', onClick: () => onDownload(job.pdfDownloadUrl!, 'pdf') }] : []),
      ]}
    />
  );
}

type TaskJob = Pick<ReviewHandoutJob, 'status' | 'progress' | 'stage' | 'message' | 'verified' | 'degraded' | 'degradedReasons' | 'promptVersion' | 'updatedAt'>;

function TaskRow({
  title,
  job,
  acting,
  auditModel,
  auditAttempts,
  onCancel,
  onRetry,
  download,
  downloads = [],
}: {
  title: string;
  job: TaskJob;
  acting: boolean;
  auditModel?: string;
  auditAttempts?: number;
  onCancel: () => void;
  onRetry: () => void;
  download?: { label: string; onClick: () => void };
  downloads?: Array<{ label: string; onClick: () => void }>;
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
          {title}
          {job.degraded && <A3Pill tone="orange">基础版</A3Pill>}
          {!job.degraded && job.verified && <A3Pill tone="green">已核验</A3Pill>}
          {!job.degraded && !job.verified && job.status === 'succeeded' && <A3Pill tone="slate">部分核验</A3Pill>}
        </div>
        <p className="mt-1 break-words text-xs text-slate-500">{job.message || statusLabel(job.status)}</p>
        <p className="mt-1 text-xs text-slate-400">{stageLabel(job.stage)} · {formatJobTime(job.updatedAt)}</p>
        {job.status === 'succeeded' && job.promptVersion && (
          <p className="mt-1 text-xs text-slate-400">
            增强协议 {job.promptVersion}
            {auditModel ? ` · ${auditModel}` : ''}
            {auditAttempts ? ` · ${auditAttempts} 次调用` : ''}
          </p>
        )}
        {job.degradedReasons.length > 0 && (
          <p className="mt-1 break-words text-xs text-amber-700">
            降级原因：{job.degradedReasons.map(degradedReasonLabel).join('、')}
          </p>
        )}
        {running && (
          <div className="mt-2 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-slate-100">
            <div className="h-full bg-orange-500 transition-[width]" style={{ width: Math.max(4, job.progress) + '%' }} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {[...(download ? [download] : []), ...downloads].map((item) => (
          <Button key={item.label} size="icon" variant="outline" onClick={item.onClick} title={item.label} aria-label={item.label}>
            {item.label.includes('Word') ? <FileText className="size-4" /> : <Download className="size-4" />}
          </Button>
        ))}
        {running && (
          <Button size="icon" variant="outline" disabled={acting} onClick={onCancel} title="取消任务" aria-label="取消任务">
            <XCircle className="size-4" />
          </Button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button size="icon" variant="outline" disabled={acting} onClick={onRetry} title="重试任务" aria-label="重试任务">
            <RefreshCcw className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function JobListLoading({ label }: { label: string }) {
  return (
    <div className="flex h-20 items-center justify-center text-sm text-slate-500">
      <Loader2 className="mr-2 size-4 animate-spin" />
      {label}
    </div>
  );
}

function JobListEmpty({ label }: { label: string }) {
  return <div className="rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{label}</div>;
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

function formatLabel(format: WrongExportFormat) {
  return formats.find((item) => item.value === format)?.label ?? format.toUpperCase();
}

function statusLabel(status: AssessmentJobStatus) {
  return { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '生成失败', cancelled: '已取消' }[status];
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    queued: '等待处理',
    retrieval: '检索资料',
    enhancing: 'AI 增强',
    rendering: '生成文件',
    document: '整理讲义',
    completed: '处理完成',
    failed: '处理失败',
    cancelled: '已取消',
  };
  return labels[stage] || stage || '等待处理';
}

function formatJobTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '' : time.toLocaleString('zh-CN', { hour12: false });
}

function degradedReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    authentication: '模型服务认证不可用',
    configuration: '模型服务未配置',
    disabled: 'AI 增强已关闭',
    empty_content: '未生成增强内容',
    invalid_response: '模型响应未通过校验',
    missing_evidence: '本地资料证据不足',
    provider_error: '模型服务暂不可用',
    rate_limit: '模型服务繁忙',
    retrieval_error: '本地资料检索失败',
    timeout: '模型服务超时',
  };
  return labels[reason] ?? '增强内容暂不可用';
}
