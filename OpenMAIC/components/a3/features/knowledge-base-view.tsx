'use client';

import type { ReactNode } from 'react';
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Database, Download, FileText, FileUp, Loader2, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { Button } from '@/components/ui/button';
import { a3DeleteJson, a3DownloadFile, a3GetJson, a3PostJson, a3UploadFiles } from '@/lib/a3/api-client';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { MetricGrid } from '../ui/metric-card';

type ResourceScope = 'personal' | 'teacher' | 'class' | 'global';

type KnowledgeResource = {
  id: string;
  name: string;
  type: string;
  size: number;
  status: 'uploaded' | 'indexing' | 'indexed' | 'indexed_with_warnings' | 'failed';
  documentCount: number;
  chunks: number;
  error: string;
  scope?: ResourceScope;
  scopeLabel?: string;
  courseKey?: string;
  multimodal?: {
    parseStatus: string;
    parser: string;
    schemaVersion?: string;
    pages: number;
    textBlocks: number;
    imageBlocks: number;
    tableBlocks: number;
    formulaBlocks: number;
    pageImageBlocks: number;
    ocrChars: number;
    textIndexed: number;
    visualIndexed: number;
    qualityScore: number;
    textCoverage?: number;
    garbledRatio?: number;
    citationReadiness?: boolean;
    providerChain?: string[];
    warnings: string[];
  };
  updatedAt: string;
  jobId?: string | null;
};

type KnowledgeStats = {
  corpusFiles: number;
  globalIndexedFiles?: number;
  globalIndexedDocuments?: number;
  skippedFiles?: number;
  managedFiles: number;
  indexedFiles: number;
  failedFiles: number;
  legacyPptFiles: number;
  indexedDocuments: number;
  embedModel: string;
};

type KnowledgeJob = {
  id: string;
  type: 'upload' | 'rebuild' | 'parse';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  summary?: { parsed?: number; indexed: number; failed: number };
  resources?: Array<{ id: string; name: string; status: KnowledgeResource['status']; error: string }>;
  error: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt: string | null;
};

type SearchResult = {
  content: string;
  score: number | null;
  metadata: Record<string, unknown>;
  location?: { page?: number; slide?: number };
  evidence?: Array<{ text?: string; page?: number; slide?: number; assetPreviewUrl?: string }>;
};

const emptyStats: KnowledgeStats = {
  corpusFiles: 0,
  managedFiles: 0,
  indexedFiles: 0,
  failedFiles: 0,
  legacyPptFiles: 0,
  indexedDocuments: 0,
  embedModel: '',
};

export function KnowledgeBaseView() {
  const searchParams = useSearchParams();
  const currentUser = useA3CurrentUser();
  const canManageKnowledgeBase = currentUser?.role === 'teacher' || currentUser?.role === 'admin';
  const canUploadKnowledgeBase = Boolean(currentUser);
  const [resources, setResources] = useState<KnowledgeResource[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [stats, setStats] = useState<KnowledgeStats>(emptyStats);
  const [activeScope, setActiveScope] = useState<ResourceScope>(canManageKnowledgeBase ? 'teacher' : 'personal');
  const [uploadScope, setUploadScope] = useState<ResourceScope>(canManageKnowledgeBase ? 'teacher' : 'personal');
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [forceReparsing, setForceReparsing] = useState(false);
  const [reparsingResourceIds, setReparsingResourceIds] = useState<Set<string>>(() => new Set());
  const [resourceFeedback, setResourceFeedback] = useState<Record<string, { tone: 'blue' | 'green' | 'red'; text: string }>>({});
  const [searching, setSearching] = useState(false);

  const loadResources = useCallback(async () => {
    setLoading(true);
    const result = await a3GetJson<{ success: boolean; error?: string; resources: KnowledgeResource[]; stats: KnowledgeStats }>('/api/kb/resources/');
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '资料读取失败');
      return;
    }
    setResources(result.resources ?? []);
    setStats(result.stats ?? emptyStats);
  }, []);

  const loadJobs = useCallback(async () => {
    const result = await a3GetJson<{ success: boolean; jobs: KnowledgeJob[]; error?: string }>('/api/kb/jobs/');
    if (result.success) setJobs(result.jobs ?? []);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadResources();
      void loadJobs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadResources, loadJobs]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return undefined;
    const timer = window.setInterval(() => {
      void loadResources();
      void loadJobs();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [jobs, loadResources, loadJobs]);

  const visibleResources = useMemo(
    () => resources.filter((resource) => resourceMatchesTab(resource, activeScope)),
    [resources, activeScope],
  );

  const scopeTabs = useMemo(
    () => [
      { key: 'personal' as const, label: '我的资料', count: resources.filter((item) => item.scope === 'personal').length },
      { key: 'teacher' as const, label: '课程资料', count: resources.filter((item) => item.scope === 'teacher' || item.scope === 'class').length },
      { key: 'global' as const, label: '全局知识库', count: resources.filter((item) => item.scope === 'global').length },
    ],
    [resources],
  );

  async function uploadFiles(files: FileList | null) {
    if (!canUploadKnowledgeBase) {
      setMessage('请先登录后再上传资料。');
      return;
    }
    if (!files?.length) return;
    setUploading(true);
    setMessage('');
    const result = await a3UploadFiles<{ success: boolean; error?: string; errors?: Array<{ name: string; error: string }> }>(
      '/api/kb/resources/upload/',
      Array.from(files),
      { scope: uploadScope },
    );
    setUploading(false);
    if (!result.success) {
      setMessage(result.errors?.map((item) => `${item.name}: ${item.error}`).join('；') || result.error || '上传失败，请检查文件格式。');
      return;
    }
    setSelectedFiles(null);
    setActiveScope(uploadScope);
    setMessage('资料已上传，后台会自动完成多模态解析、索引和失败原因记录。');
    await loadResources();
    await loadJobs();
  }

  async function rebuildIndex() {
    if (!canManageKnowledgeBase) {
      setMessage('当前账号没有教师权限，无法重建知识库索引。');
      return;
    }
    setRebuilding(true);
    const result = await a3PostJson<{ success: boolean; error?: string }>('/api/kb/rebuild/', {});
    setRebuilding(false);
    setMessage(result.success ? '已提交全量重建任务。' : result.error ?? '重建任务提交失败。');
    await loadJobs();
  }

  async function forceReparseAll() {
    if (!canUploadKnowledgeBase) {
      setMessage('请先登录后再重新解析已有资料。');
      return;
    }
    setForceReparsing(true);
    const result = await a3PostJson<{ success: boolean; error?: string; job?: KnowledgeJob; resources?: KnowledgeResource[]; stats?: KnowledgeStats }>('/api/kb/reparse/force/', {});
    setForceReparsing(false);
    if (!result.success) {
      setMessage(result.error ?? '重新解析已有资料失败。');
      return;
    }
    setResources(result.resources ?? resources);
    setStats(result.stats ?? stats);
    setMessage(result.job ? `已提交多模态解析任务：${result.job.totalFiles || result.resources?.length || 0} 个资料。` : '已提交多模态解析任务。');
    await loadJobs();
  }

  async function reparseResource(resource: KnowledgeResource) {
    if (reparsingResourceIds.has(resource.id)) return;
    setReparsingResourceIds((current) => new Set(current).add(resource.id));
    setResourceFeedback((current) => ({
      ...current,
      [resource.id]: { tone: 'blue', text: '正在提交重解析任务...' },
    }));
    const result = await a3PostJson<{ success: boolean; error?: string; job?: KnowledgeJob; resource?: KnowledgeResource }>(`/api/kb/resources/${resource.id}/reparse/`, {});
    if (!result.success) {
      setResourceFeedback((current) => ({
        ...current,
        [resource.id]: { tone: 'red', text: result.error ?? '重解析任务提交失败，请稍后重试。' },
      }));
      setMessage(result.error ?? '重解析任务提交失败。');
      setReparsingResourceIds((current) => {
        const next = new Set(current);
        next.delete(resource.id);
        return next;
      });
      return;
    }
    const updatedResource = result.resource;
    if (updatedResource) {
      setResources((current) => current.map((item) => (item.id === resource.id ? { ...item, ...updatedResource } : item)));
    }
    if (result.job) {
      setJobs((current) => [result.job!, ...current.filter((job) => job.id !== result.job!.id)]);
    }
    setResourceFeedback((current) => ({
      ...current,
      [resource.id]: { tone: 'green', text: '已加入后台解析队列，右侧可查看进度。' },
    }));
    setMessage(`已提交重解析任务：${resource.name}。后台会重新抽取文本、表格、公式、图片说明和引用证据。`);
    await loadResources();
    await loadJobs();
    setReparsingResourceIds((current) => {
      const next = new Set(current);
      next.delete(resource.id);
      return next;
    });
  }

  async function deleteResource(resource: KnowledgeResource) {
    if (!window.confirm(`确定删除“${resource.name}”吗？此操作不可撤销。`)) return;
    const result = await a3DeleteJson<{ success: boolean; error?: string }>(`/api/kb/resources/${resource.id}/`);
    setMessage(result.success ? `已删除：${resource.name}` : result.error ?? '删除失败。');
    if (result.success) await loadResources();
  }

  async function retryJob(jobId: string) {
    const result = await a3PostJson<{ success: boolean; error?: string }>(`/api/kb/jobs/${jobId}/retry/`, {});
    setMessage(result.success ? '已重新提交后台任务。' : result.error ?? '重试失败。');
    if (result.success) await loadJobs();
  }

  async function downloadResource(resource: KnowledgeResource) {
    try {
      await a3DownloadFile(`/api/kb/resources/${resource.id}/download/`, resource.name);
    } catch {
      setMessage(`下载失败：${resource.name}`);
    }
  }

  const searchKnowledge = useCallback(async (nextQuery: string) => {
    const keyword = nextQuery.trim();
    if (!keyword) {
      setMessage('请输入检索问题。');
      return;
    }
    setSearching(true);
    setMessage('');
    const result = await a3GetJson<{ success: boolean; error?: string; results: SearchResult[] }>(`/api/kb/search/?q=${encodeURIComponent(keyword)}&top_k=5&include_assets=1`);
    setSearching(false);
    if (!result.success) {
      setResults([]);
      setMessage(result.error ?? '检索失败。');
      return;
    }
    setResults(result.results ?? []);
  }, []);

  useEffect(() => {
    const initialSearchQuery = searchParams.get('q');
    if (!initialSearchQuery) return;
    startTransition(() => {
      void searchKnowledge(initialSearchQuery);
    });
  }, [searchParams, searchKnowledge]);

  const metrics = [
    { label: '全量资料', value: String(stats.globalIndexedFiles ?? stats.corpusFiles ?? 0), tone: 'blue' as const },
    { label: '已索引片段', value: String(stats.globalIndexedDocuments ?? stats.indexedDocuments ?? 0), tone: 'green' as const },
    { label: '管理资料', value: String(stats.managedFiles ?? 0), tone: 'violet' as const },
    { label: '失败资料', value: String(stats.failedFiles ?? 0), tone: stats.failedFiles ? 'orange' as const : 'green' as const },
  ];

  return (
    <div className="space-y-6" data-testid="a3-knowledge-base-view">
      <section className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <A3Pill tone="blue">{canManageKnowledgeBase ? '教学知识库' : '我的学习资料'}</A3Pill>
            <h1 className="mt-4 text-2xl font-semibold text-[var(--a3-text)]">本地知识库</h1>
            <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">
              上传资料会进入后台解析队列，系统会记录进度、失败原因、表格/公式识别和引用可用性，课堂、推荐和资源生成都会优先使用这些真实来源。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManageKnowledgeBase && (
              <select
                aria-label="资料上传范围"
                value={uploadScope}
                onChange={(event) => setUploadScope(event.target.value as ResourceScope)}
                className="h-10 rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm"
              >
                <option value="teacher">课程资料</option>
                <option value="global">全局知识库</option>
              </select>
            )}
            <label className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-[var(--a3-border)] px-3 text-sm font-medium ${canUploadKnowledgeBase ? '' : 'pointer-events-none opacity-50'}`}>
              <FileUp className="size-4" />
              选择资料
              <input data-testid="a3-kb-file-input" className="hidden" type="file" multiple accept=".pdf,.pptx,.xlsx,.png,.jpg,.jpeg,.webp" disabled={!canUploadKnowledgeBase} onChange={(event) => setSelectedFiles(event.target.files)} />
            </label>
            <Button data-testid="a3-kb-upload-submit" type="button" onClick={() => void uploadFiles(selectedFiles)} disabled={!canUploadKnowledgeBase || uploading || !selectedFiles?.length}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
              上传并解析
            </Button>
            <Button type="button" variant="outline" onClick={() => void rebuildIndex()} disabled={!canManageKnowledgeBase || rebuilding}>
              {rebuilding ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              重建索引
            </Button>
            <Button data-testid="a3-kb-force-reparse" type="button" variant="outline" onClick={() => void forceReparseAll()} disabled={!canUploadKnowledgeBase || forceReparsing}>
              {forceReparsing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              重跑多模态解析
            </Button>
            <Button asChild variant="outline">
              <Link href="/a3/knowledge-graph">资料图谱</Link>
            </Button>
          </div>
        </div>
        {selectedFiles?.length ? <p className="mt-4 text-xs text-[var(--a3-text-muted)]">已选择 {selectedFiles.length} 个文件：{Array.from(selectedFiles).map((file) => file.name).join('、')}</p> : null}
      </section>

      {message ? <div data-testid="a3-kb-message" className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">{message}</div> : null}

      <MetricGrid metrics={metrics} />

      <div className="grid gap-5 xl:grid-cols-[1fr_0.85fr]">
        <A3Card title="资料空间" action={<Button type="button" variant="ghost" size="sm" onClick={() => void loadResources()}><RefreshCw className="size-4" />刷新</Button>}>
          <div className="mb-4 flex flex-wrap gap-2" data-testid="a3-kb-scope-tabs">
            {scopeTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveScope(tab.key)}
                className={`rounded-full border px-3 py-2 text-sm font-medium ${activeScope === tab.key ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-[var(--a3-border)] text-[var(--a3-text-muted)]'}`}
              >
                {tab.label}<span className="ml-2 text-xs">{tab.count}</span>
              </button>
            ))}
          </div>

          {loading ? (
            <EmptyState icon={<Loader2 className="size-8 animate-spin" />} title="正在读取资料" desc="后台会同步返回资料状态和最近一次解析质量。" />
          ) : visibleResources.length ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--a3-border)]">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]">
                  <tr>
                    <th className="px-4 py-3 font-medium">文件</th>
                    <th className="px-4 py-3 font-medium">来源</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium">解析质量</th>
                    <th className="px-4 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleResources.map((resource) => {
                    const reparseFeedback = resourceFeedback[resource.id];
                    const isReparsingResource = reparsingResourceIds.has(resource.id);
                    return (
                    <tr key={resource.id} data-testid="a3-kb-resource-row" className="border-t border-[var(--a3-border)]">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--a3-text)]">{resource.name}</div>
                        <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{resource.type}{resource.courseKey ? ` · ${resource.courseKey}` : ''}</div>
                      </td>
                      <td className="px-4 py-3"><ScopePill scope={resource.scope} label={resource.scopeLabel} /></td>
                      <td className="px-4 py-3"><StatusPill status={resource.status} /></td>
                      <td className="px-4 py-3"><ResourceQualitySummary resource={resource} /></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" variant="ghost" size="sm" onClick={() => void downloadResource(resource)}><Download className="size-4" />下载</Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isReparsingResource || resource.status === 'indexing'}
                            onClick={() => void reparseResource(resource)}
                          >
                            {isReparsingResource || resource.status === 'indexing' ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                            {isReparsingResource ? '提交中' : resource.status === 'indexing' ? '处理中' : '重解析'}
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => void deleteResource(resource)}><Trash2 className="size-4" />删除</Button>
                        </div>
                        {reparseFeedback ? (
                          <div className={`mt-2 rounded-lg px-2.5 py-1.5 text-xs ${
                            reparseFeedback.tone === 'red'
                              ? 'bg-red-50 text-red-700'
                              : reparseFeedback.tone === 'green'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-blue-50 text-blue-700'
                          }`}>
                            {reparseFeedback.text}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Database className="size-8" />} title="当前范围没有资料" desc="上传 PDF、PPTX、图片或表格后，后台解析结果会出现在这里。" />
          )}
        </A3Card>

        <A3Card title="后台任务" action={<A3Pill tone="blue">最近 {Math.min(jobs.length, 6)} 条</A3Pill>}>
          <div className="overflow-hidden rounded-xl border border-[var(--a3-border)]">
            {jobs.slice(0, 6).map((job) => (
              <div key={job.id} data-testid="a3-kb-job-item" className="border-b border-[var(--a3-border)] p-4 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[var(--a3-text)]">{jobTypeLabel(job)}</span>
                      <span className="text-xs text-[var(--a3-text-muted)]">{formatJobTime(job)}</span>
                    </div>
                    <div className="mt-1 truncate text-sm text-[var(--a3-text)]">{jobResourceTitle(job)}</div>
                    <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{jobSummaryText(job)}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill status={job.status} />
                    {job.status === 'failed' ? <Button size="sm" variant="outline" onClick={() => void retryJob(job.id)}><RotateCcw className="size-3" />重试</Button> : null}
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--a3-surface-muted)]">
                  <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
                </div>
                {job.status === 'running' && job.currentFile ? <p className="mt-2 text-xs text-blue-700">正在处理：{job.currentFile}</p> : null}
                {job.error ? <p className="mt-2 text-xs text-red-600">{job.error}</p> : null}
              </div>
            ))}
            {!jobs.length ? <EmptyState icon={<RefreshCw className="size-8" />} title="暂无后台任务" desc="上传资料、重建索引或重跑解析后，这里会显示进度和失败原因。" /> : null}
          </div>
        </A3Card>
      </div>

      <A3Card title="知识库检索" action={<Search className="size-4 text-blue-600" />}>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void searchKnowledge(query);
          }}
        >
          <input
            data-testid="a3-kb-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm outline-none focus:border-blue-400"
            placeholder="输入课程问题，例如：进程调度为什么会产生饥饿？"
          />
          <Button data-testid="a3-kb-search-submit" type="submit" disabled={searching}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            检索
          </Button>
        </form>
        <div data-testid="a3-kb-quality-panel" className="mt-4 grid gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900 md:grid-cols-4">
          <div data-testid="a3-kb-quality-upload-evidence">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">上传证据</div>
            <div className="mt-1 font-medium">{resources.length} 个资源</div>
          </div>
          <div data-testid="a3-kb-quality-index-evidence">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">索引证据</div>
            <div className="mt-1 font-medium">{stats.indexedDocuments} 个片段</div>
          </div>
          <div data-testid="a3-kb-quality-search-evidence">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">检索证据</div>
            <div data-testid="a3-kb-quality-search-count" className="mt-1 font-medium">{results.length} 条结果</div>
          </div>
          <div data-testid="a3-kb-quality-classroom-evidence">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">课堂引用</div>
            <Link className="mt-1 inline-flex font-medium text-blue-700 hover:text-blue-900" href="/a3/classroom">进入 AI 课堂</Link>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {results.map((result, index) => (
            <div key={`${displayTitle(result.metadata, index)}-${index}`} data-testid="a3-kb-search-result" className="rounded-xl border border-[var(--a3-border)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <A3Pill tone="blue">{sourceOrigin(result.metadata)}</A3Pill>
                <A3Pill tone="slate">{sourceType(result.metadata)}</A3Pill>
                <span className="text-xs text-[var(--a3-text-muted)]">{formatEvidenceLocation(result)} · score {formatScore(result.score)}</span>
              </div>
              <div className="mt-2 font-medium text-[var(--a3-text)]">{displayTitle(result.metadata, index)}</div>
              <div className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">
                <A3Markdown>{result.content || result.evidence?.[0]?.text || '没有可展示片段'}</A3Markdown>
              </div>
            </div>
          ))}
          {!results.length ? <EmptyState icon={<FileText className="size-8" />} title="还没有检索结果" desc="输入问题后，系统会展示真实召回来源、页码/幻灯片和相似度。" /> : null}
        </div>
      </A3Card>
    </div>
  );
}

function resourceMatchesTab(resource: KnowledgeResource, activeScope: ResourceScope) {
  if (activeScope === 'teacher') return resource.scope === 'teacher' || resource.scope === 'class';
  return resource.scope === activeScope;
}

function jobTypeLabel(job: KnowledgeJob) {
  if (job.type === 'rebuild') return '全量重建';
  if (job.type === 'parse') return '多模态解析';
  return '上传索引';
}

function jobResourceTitle(job: KnowledgeJob) {
  const names = (job.resources ?? []).map((resource) => resource.name).filter(Boolean);
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} 等 ${names.length} 个文件`;
  if (job.currentFile) return job.currentFile;
  if (job.type === 'rebuild') return '全量知识库索引';
  if (job.type === 'parse') return '已有资料多模态解析';
  return '上传文件索引';
}

function jobSummaryText(job: KnowledgeJob) {
  const total = Math.max(job.totalFiles || job.resources?.length || 0, 0);
  const processed = Math.min(Math.max(job.processedFiles || 0, 0), total || Number.MAX_SAFE_INTEGER);
  const parsed = job.summary?.parsed ?? (job.resources ?? []).filter((resource) => resource.status === 'indexed' || resource.status === 'indexed_with_warnings').length;
  const indexed = job.summary?.indexed ?? (job.resources ?? []).filter((resource) => resource.status === 'indexed' || resource.status === 'indexed_with_warnings').length;
  const failed = job.summary?.failed ?? (job.resources ?? []).filter((resource) => resource.status === 'failed').length;
  const successLabel = job.type === 'parse' ? '解析' : '成功';
  const successCount = job.type === 'parse' ? parsed : indexed;
  if (job.status === 'succeeded') return `已处理 ${processed}/${total || processed} 个文件，${successLabel} ${successCount} 个，失败 ${failed} 个`;
  if (job.status === 'failed') return `处理 ${processed}/${total || processed} 个文件，失败 ${failed || 1} 个`;
  if (job.status === 'running') return `处理中 ${processed}/${total || processed} 个文件`;
  return `排队中，共 ${total || 1} 个文件`;
}

function formatJobTime(job: KnowledgeJob) {
  const value = job.finishedAt || job.startedAt || job.createdAt;
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function ResourceQualitySummary({ resource }: { resource: KnowledgeResource }) {
  const multimodal = resource.multimodal;
  if (!multimodal) return <span className="text-sm text-[var(--a3-text-muted)]">{resource.chunks} 个片段</span>;
  const provider = multimodal.providerChain?.length ? multimodal.providerChain.join(' + ') : multimodal.parser || 'native';
  return (
    <div className="space-y-1 text-xs text-[var(--a3-text-muted)]" data-testid="a3-kb-resource-quality">
      <div className="text-sm text-[var(--a3-text)]">{resource.chunks} chunks · {multimodal.pages} 页/幻灯片</div>
      <div>文本 {multimodal.textBlocks} · 表格 {multimodal.tableBlocks} · 公式 {multimodal.formulaBlocks} · 图片 {multimodal.imageBlocks + multimodal.pageImageBlocks}</div>
      <div>质量 {percent(multimodal.qualityScore)} · 乱码率 {percent(multimodal.garbledRatio)} · {multimodal.citationReadiness ? '可引用' : '需增强解析'}</div>
      <div>{provider}{multimodal.warnings?.length ? ` · 警告 ${multimodal.warnings.length}` : ''}</div>
    </div>
  );
}

function ScopePill({ scope, label }: { scope?: ResourceScope; label?: string }) {
  if (scope === 'personal') return <A3Pill tone="green">{label || '我的资料'}</A3Pill>;
  if (scope === 'global') return <A3Pill tone="slate">{label || '全局知识库'}</A3Pill>;
  if (scope === 'class') return <A3Pill tone="blue">{label || '班级资料'}</A3Pill>;
  return <A3Pill tone="blue">{label || '课程资料'}</A3Pill>;
}

function StatusPill({ status }: { status: KnowledgeResource['status'] | KnowledgeJob['status'] }) {
  const map: Record<string, { label: string; tone: 'green' | 'orange' | 'red' | 'blue' | 'slate' }> = {
    uploaded: { label: '待处理', tone: 'slate' },
    indexing: { label: '处理中', tone: 'blue' },
    indexed: { label: '已完成', tone: 'green' },
    indexed_with_warnings: { label: '有警告', tone: 'orange' },
    failed: { label: '失败', tone: 'red' },
    queued: { label: '排队中', tone: 'slate' },
    running: { label: '运行中', tone: 'blue' },
    succeeded: { label: '成功', tone: 'green' },
  };
  const item = map[status] ?? { label: status, tone: 'slate' as const };
  return <A3Pill tone={item.tone}>{item.label}</A3Pill>;
}

function EmptyState({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="py-10 text-center text-sm text-[var(--a3-text-muted)]">
      <div className="mx-auto mb-3 flex justify-center opacity-50">{icon}</div>
      <div className="font-medium text-[var(--a3-text)]">{title}</div>
      <p className="mx-auto mt-2 max-w-md leading-6">{desc}</p>
    </div>
  );
}

function percent(value?: number) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function displayTitle(metadata: Record<string, unknown>, index: number) {
  return String(metadata.original_name || metadata.title || metadata.file_name || `结果 ${index + 1}`);
}

function formatEvidenceLocation(result: SearchResult) {
  const page = result.location?.page || Number(result.metadata.page || 0);
  const slide = result.location?.slide || Number(result.metadata.slide || 0);
  if (slide) return `第 ${slide} 张幻灯片`;
  if (page) return `第 ${page} 页`;
  return String(result.metadata.display_location || result.metadata.course || '本地知识库');
}

function sourceType(metadata: Record<string, unknown>) {
  return String(metadata.source_type_label || metadata.sourceTypeLabel || metadata.resource_type || metadata.source_type || '本地资料');
}

function sourceOrigin(metadata: Record<string, unknown>) {
  const scope = String(metadata.source_scope || metadata.sourceScope || '');
  if (scope === 'personal') return '我的资料';
  if (scope === 'teacher') return '课程资料';
  if (scope === 'class') return '班级资料';
  if (scope === 'global') return '全局知识库';
  return String(metadata.source_origin || metadata.sourceOrigin || '知识库');
}

function formatScore(score: number | null) {
  if (score === null) return '--';
  return score.toFixed(4);
}
