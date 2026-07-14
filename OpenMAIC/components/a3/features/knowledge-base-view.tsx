'use client';

import type { ReactNode } from 'react';
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ChevronDown, Database, Download, FileText, FileUp, Loader2, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useA3CurrentUser } from '@/components/a3/auth/a3-auth-gate';
import { Button } from '@/components/ui/button';
import { a3DeleteJson, a3DownloadFile, a3GetJson, a3PostJson, a3UploadFiles } from '@/lib/a3/api-client';
import { A3Card, A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { MetricGrid } from '../ui/metric-card';

type ResourceScope = 'personal' | 'teacher' | 'class' | 'global';

type KnowledgeWikiSummary = {
  status: 'ready' | 'not_built' | 'pending' | 'blocked' | 'not_ready' | 'empty' | 'failed' | string;
  conceptCount: number;
  definitionCount: number;
  aliasCount: number;
  summaryCount: number;
  lastBuiltAt?: string | null;
  reason?: string;
};

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
  wiki?: KnowledgeWikiSummary;
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
  type: 'upload' | 'rebuild' | 'parse' | 'wiki';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  totalFiles: number;
  processedFiles: number;
  currentFile: string;
  summary?: { parsed?: number; rebuilt?: number; indexed: number; failed: number };
  resources?: Array<{ id: string; name: string; status: KnowledgeResource['status']; error: string }>;
  error: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt: string | null;
  progressDetail?: {
    phase?: string;
    phaseLabel?: string;
    resourceId?: string;
    resourceName?: string;
    file?: { current?: number; total?: number };
    page?: { current?: number; total?: number };
    block?: { current?: number; total?: number };
    chunk?: { current?: number; total?: number };
    metrics?: Record<string, number>;
    recentEvents?: Array<{ time?: string; phase?: string; message: string }>;
  };
};

type SearchResult = {
  content: string;
  text?: string;
  score: number | null;
  metadata: Record<string, unknown>;
  location?: { page?: number; slide?: number };
  evidence?: Array<{ text?: string; page?: number; slide?: number; assetPreviewUrl?: string }>;
  contextSnippet?: string;
  contextBlocks?: Array<{ blockId: string; modality: string; text: string; isHit?: boolean; page?: number; slide?: number }>;
  markdownSnippet?: string;
  contentFormat?: string;
  formatFeatures?: string[];
};

type SearchConfig = {
  topK: number;
  includeAssets: boolean;
  mode: 'hybrid' | 'vector' | 'bm25' | 'wiki' | 'graph';
  fast: boolean;
  similarityThreshold: number;
  bm25Candidates: number;
  vectorWeight: number;
  bm25Weight: number;
};

type RetrievalPlan = {
  schemaVersion: string;
  intent: string;
  requestedRoute: string;
  route: 'wiki' | 'graph' | 'vector' | 'composite' | string;
  reason: string;
  subQuestions: string[];
  fallback: boolean;
  fallbackReason: string;
};

type WikiEvidence = {
  id: string;
  preferredLabel: string;
  summary: string;
  aliases?: string[];
  definitions?: Array<{ definition: string; blockId?: string; confidence?: number }>;
  evidence?: Array<{ location?: string; snippet?: string }>;
  confidence?: number;
};

type GraphEvidence = {
  id: string;
  sourceLabel: string;
  targetLabel: string;
  label: string;
  relationType: string;
  weight?: number;
  hops?: number;
  pathLabels?: string[];
  evidenceCoverage?: number;
  relations?: Array<{
    sourceLabel?: string;
    targetLabel?: string;
    label?: string;
    relationType?: string;
    weight?: number;
  }>;
  evidence?: Array<{ location?: string; snippet?: string }>;
  degraded?: boolean;
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

const defaultSearchConfig: SearchConfig = {
  topK: 8,
  includeAssets: true,
  mode: 'hybrid',
  fast: false,
  similarityThreshold: 0,
  bm25Candidates: 50,
  vectorWeight: 0.7,
  bm25Weight: 0.3,
};

export function KnowledgeBaseView() {
  const searchParams = useSearchParams();
  const currentUser = useA3CurrentUser();
  const canManageKnowledgeBase = currentUser?.role === 'teacher' || currentUser?.role === 'admin';
  const canUploadKnowledgeBase = Boolean(currentUser);
  const [resources, setResources] = useState<KnowledgeResource[]>([]);
  const [jobs, setJobs] = useState<KnowledgeJob[]>([]);
  const [jobsPanelExpanded, setJobsPanelExpanded] = useState(true);
  const [stats, setStats] = useState<KnowledgeStats>(emptyStats);
  const [activeScope, setActiveScope] = useState<ResourceScope>(canManageKnowledgeBase ? 'teacher' : 'personal');
  const [uploadScope, setUploadScope] = useState<ResourceScope>(canManageKnowledgeBase ? 'teacher' : 'personal');
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [searchConfig, setSearchConfig] = useState<SearchConfig>(defaultSearchConfig);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [retrieval, setRetrieval] = useState<RetrievalPlan | null>(null);
  const [wikiEvidence, setWikiEvidence] = useState<WikiEvidence[]>([]);
  const [graphEvidence, setGraphEvidence] = useState<GraphEvidence[]>([]);
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [forceReparsing, setForceReparsing] = useState(false);
  const [batchRebuildingWiki, setBatchRebuildingWiki] = useState(false);
  const [resettingDerived, setResettingDerived] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [reparsingResourceIds, setReparsingResourceIds] = useState<Set<string>>(() => new Set());
  const [rebuildingWikiResourceIds, setRebuildingWikiResourceIds] = useState<Set<string>>(() => new Set());
  const [resourceFeedback, setResourceFeedback] = useState<Record<string, { tone: 'blue' | 'green' | 'red'; text: string }>>({});
  const [searching, setSearching] = useState(false);

  const loadResources = useCallback(async () => {
    setLoading(true);
    const result = await a3GetJson<{ success: boolean; error?: string; resources: KnowledgeResource[]; stats: KnowledgeStats }>('/api/kb/resources/');
    setLoading(false);
    if (!result.success) {
      setLoadError(result.error ?? '资料读取失败');
      return;
    }
    setLoadError('');
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

  const visibleJobs = jobs.slice(0, 6);
  const interruptedResources = useMemo(
    () => resources.filter(isInterruptedResource),
    [resources],
  );
  const interruptedJobs = useMemo(
    () => jobs.filter((job) => isUnresolvedInterruptedJob(job, resources)),
    [jobs, resources],
  );

  const scopeTabs = useMemo(
    () => [
      { key: 'personal' as const, label: '我的资料', count: resources.filter((item) => item.scope === 'personal').length },
      { key: 'teacher' as const, label: '教师资料', count: resources.filter((item) => item.scope === 'teacher' || item.scope === 'class').length },
      { key: 'global' as const, label: '全局资料', count: resources.filter((item) => item.scope === 'global').length },
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
    setMessage('上传新资料会自动完成文本、图片、PDF/PPT 页面等多模态解析和索引。');
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

  async function batchRebuildWiki() {
    if (!canUploadKnowledgeBase) {
      setMessage('请先登录后再重建 Wiki 词条。');
      return;
    }
    setBatchRebuildingWiki(true);
    const result = await a3PostJson<{ success: boolean; error?: string; job?: KnowledgeJob; resources?: KnowledgeResource[]; stats?: KnowledgeStats }>('/api/kb/wiki/rebuild/', {});
    setBatchRebuildingWiki(false);
    if (!result.success) {
      setMessage(result.error ?? '批量重建 Wiki 词条失败。');
      return;
    }
    setResources(result.resources ?? resources);
    setStats(result.stats ?? stats);
    if (result.job) {
      setJobs((current) => [result.job!, ...current.filter((job) => job.id !== result.job!.id)]);
    }
    setMessage(result.job ? `已提交 Wiki 重建任务：${result.job.totalFiles || result.resources?.length || 0} 个资料。` : '已提交 Wiki 重建任务。');
    await loadJobs();
  }

  async function resetDerivedKnowledgeBase() {
    if (!canUploadKnowledgeBase) {
      setMessage('请先登录后再重置知识库。');
      return;
    }
    if (!window.confirm('将保留原始资料，只清理已构建出的解析块、向量索引、实体、关系和 Wiki；不会自动重建。确定继续吗？')) return;
    setResettingDerived(true);
    const result = await a3PostJson<{ success: boolean; error?: string; resources?: KnowledgeResource[]; stats?: KnowledgeStats }>(
      '/api/kb/reset/',
      { action: 'reset_derived' },
    );
    setResettingDerived(false);
    if (!result.success) {
      setMessage(result.error ?? '重置知识库失败。');
      return;
    }
    setResources(result.resources ?? resources);
    setStats(result.stats ?? stats);
    setResults([]);
    setRetrieval(null);
    setWikiEvidence([]);
    setGraphEvidence([]);
    setMessage('已清理已构建数据。需要重新构建时，请点击“重新解析已有资料”。');
    await loadResources();
    await loadJobs();
  }

  async function clearKnowledgeBase() {
    if (!canUploadKnowledgeBase) {
      setMessage('请先登录后再清空知识库。');
      return;
    }
    const confirmText = window.prompt('此操作会删除资料文件、解析块、向量索引、实体、关系和 Wiki。请输入“清空知识库”确认。');
    if (confirmText !== '清空知识库') {
      setMessage('已取消清空知识库。');
      return;
    }
    setClearingAll(true);
    const result = await a3PostJson<{ success: boolean; error?: string; resources?: KnowledgeResource[]; stats?: KnowledgeStats }>(
      '/api/kb/reset/',
      { action: 'clear_all', confirmText },
    );
    setClearingAll(false);
    if (!result.success) {
      setMessage(result.error ?? '清空知识库失败。');
      return;
    }
    setResources(result.resources ?? []);
    setStats(result.stats ?? emptyStats);
    setJobs([]);
    setResults([]);
    setRetrieval(null);
    setWikiEvidence([]);
    setGraphEvidence([]);
    setMessage('已清空知识库；后续检索将不会命中这些资料。');
    await loadResources();
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

  async function rebuildResourceWiki(resource: KnowledgeResource) {
    if (rebuildingWikiResourceIds.has(resource.id)) return;
    setRebuildingWikiResourceIds((current) => new Set(current).add(resource.id));
    setResourceFeedback((current) => ({
      ...current,
      [resource.id]: { tone: 'blue', text: '正在重建 Wiki 词条...' },
    }));
    const result = await a3PostJson<{ success: boolean; error?: string; wiki?: KnowledgeWikiSummary; resource?: KnowledgeResource }>(`/api/kb/resources/${resource.id}/wiki/rebuild/`, {});
    if (!result.success) {
      setResourceFeedback((current) => ({
        ...current,
        [resource.id]: { tone: 'red', text: result.error ?? 'Wiki 词条重建失败，请先确认资料已完成索引。' },
      }));
      setMessage(result.error ?? 'Wiki 词条重建失败。');
    } else {
      const updatedResource = result.resource ? { ...resource, ...result.resource } : { ...resource, wiki: result.wiki ?? resource.wiki };
      setResources((current) => current.map((item) => (item.id === resource.id ? updatedResource : item)));
      setResourceFeedback((current) => ({
        ...current,
        [resource.id]: { tone: 'green', text: `Wiki 已重建：${result.wiki?.conceptCount ?? updatedResource.wiki?.conceptCount ?? 0} 个词条。` },
      }));
      setMessage(`已重建 Wiki 词条：${resource.name}`);
      await loadResources();
    }
    setRebuildingWikiResourceIds((current) => {
      const next = new Set(current);
      next.delete(resource.id);
      return next;
    });
  }

  async function deleteResource(resource: KnowledgeResource) {
    if (!window.confirm(`确定删除“${resource.name}”吗？此操作不可撤销。`)) return;
    const result = await a3DeleteJson<{ success: boolean; error?: string }>(`/api/kb/resources/${resource.id}/`);
    if (result.success) {
      setMessage(`已删除：${resource.name}`);
      setResources((current) => current.filter((item) => item.id !== resource.id));
      await loadResources();
      await loadJobs();
      return;
    }
    if (String(result.error || '').includes('404')) {
      setResources((current) => current.filter((item) => item.id !== resource.id));
      setMessage(`资料记录已不存在，已从列表移除：${resource.name}`);
      await loadResources();
      await loadJobs();
      return;
    }
    setMessage(result.error ?? '删除失败。');
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
    const requestUrl = `/api/kb/search/?q=${encodeURIComponent(keyword)}&top_k=${searchConfig.topK}&include_assets=${searchConfig.includeAssets ? '1' : '0'}&mode=${searchConfig.mode}&fast=${searchConfig.fast ? '1' : '0'}&similarity_threshold=${searchConfig.similarityThreshold}&bm25_candidates=${searchConfig.bm25Candidates}&vector_weight=${searchConfig.vectorWeight}&bm25_weight=${searchConfig.bm25Weight}`;
    const result = await a3GetJson<{
      success: boolean;
      error?: string;
      retrieval?: RetrievalPlan;
      wikiEvidence?: WikiEvidence[];
      graphEvidence?: GraphEvidence[];
      results: SearchResult[];
    }>(requestUrl);
    setSearching(false);
    if (!result.success) {
      setResults([]);
      setRetrieval(null);
      setWikiEvidence([]);
      setGraphEvidence([]);
      setMessage(result.error ?? '检索失败。');
      return;
    }
    setRetrieval(result.retrieval ?? null);
    setWikiEvidence(result.wikiEvidence ?? []);
    setGraphEvidence(result.graphEvidence ?? []);
    setResults(result.results ?? []);
  }, [
    searchConfig.bm25Candidates,
    searchConfig.bm25Weight,
    searchConfig.fast,
    searchConfig.includeAssets,
    searchConfig.mode,
    searchConfig.similarityThreshold,
    searchConfig.topK,
    searchConfig.vectorWeight,
  ]);

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
              上传新资料会自动完成文本、图片、PDF/PPT 页面等多模态解析和索引；重新解析已有资料不会新增文件，只会刷新证据和结构化知识。
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
                <option value="teacher">教师资料</option>
                <option value="global">全局资料</option>
              </select>
            )}
            <label className={`inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-[var(--a3-border)] px-3 text-sm font-medium ${canUploadKnowledgeBase ? '' : 'pointer-events-none opacity-50'}`}>
              <FileUp className="size-4" />
              选择新资料
              <input data-testid="a3-kb-file-input" className="hidden" type="file" multiple accept=".pdf,.pptx,.xlsx,.png,.jpg,.jpeg,.webp" disabled={!canUploadKnowledgeBase} onChange={(event) => setSelectedFiles(event.target.files)} />
            </label>
            <Button data-testid="a3-kb-upload-submit" type="button" onClick={() => void uploadFiles(selectedFiles)} disabled={!canUploadKnowledgeBase || uploading || !selectedFiles?.length}>
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
              {canManageKnowledgeBase ? '上传新资料' : '上传我的资料'}
            </Button>
            <Button type="button" variant="outline" onClick={() => void rebuildIndex()} disabled={!canManageKnowledgeBase || rebuilding}>
              {rebuilding ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              重建索引
            </Button>
            <Button data-testid="a3-kb-force-reparse" type="button" variant="outline" onClick={() => void forceReparseAll()} disabled={!canUploadKnowledgeBase || forceReparsing}>
              {forceReparsing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              重新解析已有资料
            </Button>
            <Button data-testid="a3-kb-batch-rebuild-wiki" type="button" variant="outline" onClick={() => void batchRebuildWiki()} disabled={!canUploadKnowledgeBase || batchRebuildingWiki}>
              {batchRebuildingWiki ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
              重建 Wiki 层
            </Button>
            <Button data-testid="a3-kb-reset-derived" type="button" variant="outline" onClick={() => void resetDerivedKnowledgeBase()} disabled={!canUploadKnowledgeBase || resettingDerived}>
              {resettingDerived ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              清理已构建数据
            </Button>
            <Button data-testid="a3-kb-clear-all" type="button" variant="outline" onClick={() => void clearKnowledgeBase()} disabled={!canUploadKnowledgeBase || clearingAll}>
              {clearingAll ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              清空知识库
            </Button>
            <Button asChild variant="outline">
              <Link href="/a3/knowledge-graph">资料图谱</Link>
            </Button>
          </div>
        </div>
        {selectedFiles?.length ? <p className="mt-4 text-xs text-[var(--a3-text-muted)]">已选择 {selectedFiles.length} 个文件：{Array.from(selectedFiles).map((file) => file.name).join('、')}</p> : null}
      </section>

      {loadError ? (
        <div data-testid="a3-kb-load-error" role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <span>{loadError}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadResources()}>
            <RefreshCw className="size-4" />重试
          </Button>
        </div>
      ) : null}
      {message ? <div data-testid="a3-kb-message" className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">{message}</div> : null}
      {interruptedResources.length || interruptedJobs.length ? (
        <div data-testid="a3-kb-interrupted-notice" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold">检测到资料处理被中断</div>
              <p className="mt-1 leading-6">
                后端重启或任务队列中断后，{interruptedResources.length ? `${interruptedResources.length} 个资料` : '部分资料'} 已停止处理。你可以点击“重解析”重新入队，或点击“删除”清理失败资料。
              </p>
            </div>
          </div>
        </div>
      ) : null}

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
                    const isRebuildingWiki = rebuildingWikiResourceIds.has(resource.id);
                    return (
                    <tr key={resource.id} data-testid="a3-kb-resource-row" className="border-t border-[var(--a3-border)]">
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--a3-text)]">{resource.name}</div>
                        <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{resource.type}{resource.courseKey ? ` 路 ${resource.courseKey}` : ''}</div>
                      </td>
                      <td className="px-4 py-3"><ScopePill scope={resource.scope} label={resource.scopeLabel} /></td>
                      <td className="px-4 py-3">
                        <StatusPill status={resource.status} />
                        {isInterruptedResource(resource) ? (
                          <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-5 text-amber-800">
                            处理被中断，可重解析或删除。
                          </div>
                        ) : null}
                      </td>
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
                          <Button
                            data-testid="a3-kb-rebuild-wiki"
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isRebuildingWiki || !canRebuildWiki(resource)}
                            onClick={() => void rebuildResourceWiki(resource)}
                          >
                            {isRebuildingWiki ? <Loader2 className="size-4 animate-spin" /> : <Database className="size-4" />}
                            {isRebuildingWiki ? '重建中' : '重建 Wiki'}
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

        <A3Card
          title="后台任务"
          action={
            <button
              type="button"
              data-testid="a3-kb-jobs-panel-toggle"
              aria-expanded={jobsPanelExpanded}
              onClick={() => setJobsPanelExpanded((value) => !value)}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 py-1.5 text-xs font-medium text-[var(--a3-text)] transition hover:border-blue-300 hover:text-blue-700"
            >
              <span>最近 {Math.min(jobs.length, 6)} 条</span>
              <span className="text-[var(--a3-text-muted)]">{jobsPanelExpanded ? '收起' : '展开'}</span>
              <ChevronDown className={`size-3.5 transition-transform ${jobsPanelExpanded ? 'rotate-180' : ''}`} />
            </button>
          }
        >
          {jobsPanelExpanded ? (
            <div className="overflow-hidden rounded-xl border border-[var(--a3-border)]" data-testid="a3-kb-jobs-panel">
              {visibleJobs.map((job) => (
                <div key={job.id} data-testid="a3-kb-job-item" className="border-b border-[var(--a3-border)] p-4 last:border-b-0">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-[var(--a3-text)]">{jobTypeLabel(job)}</span>
                        <span className="text-xs text-[var(--a3-text-muted)]">{formatJobTime(job)}</span>
                      </div>
                      <div className="mt-1 truncate text-sm text-[var(--a3-text)]">{jobResourceTitle(job)}</div>
                      <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{job.progressDetail?.phaseLabel || jobSummaryText(job)}</div>
                    </div>
                    <div className="shrink-0">
                      <StatusPill status={jobDisplayStatus(job)} />
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--a3-surface-muted)]">
                    <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--a3-text-muted)]">
                    <span>{jobSummaryText(job)}</span>
                    <span>{Math.min(100, Math.max(0, Math.round(job.progress)))}%</span>
                  </div>
                  <div data-testid="a3-kb-job-expanded" className="mt-3 rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-muted)]/50 p-3">
                    <JobProgressDetail job={job} />
                    {job.status === 'running' && job.currentFile ? <p className="mt-2 text-xs text-blue-700">正在处理：{job.currentFile}</p> : null}
                    {isInterruptedJob(job) ? <p className="mt-2 text-xs text-amber-700">任务被中断，相关资料可重新解析或删除。</p> : null}
                    {job.error ? <p className="mt-2 text-xs text-red-600">{job.error}</p> : null}
                    {job.status === 'failed' ? (
                      <div className="mt-3 flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => void retryJob(job.id)}><RotateCcw className="size-3" />重试</Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
              {!jobs.length ? <EmptyState icon={<RefreshCw className="size-8" />} title="暂无后台任务" desc="上传资料、重建索引或重新解析后，这里会显示进度和失败原因。" /> : null}
            </div>
          ) : (
            <button
              type="button"
              data-testid="a3-kb-jobs-panel-collapsed"
              onClick={() => setJobsPanelExpanded(true)}
              className="flex w-full items-center justify-between rounded-xl border border-dashed border-[var(--a3-border)] bg-[var(--a3-surface-muted)]/60 px-4 py-3 text-left text-sm text-[var(--a3-text-muted)] transition hover:border-blue-300 hover:bg-blue-50/60"
            >
              <span>后台任务已收起，点击展开查看上传、解析和索引进度。</span>
              <ChevronDown className="size-4 -rotate-90" />
            </button>
          )}
        </A3Card>
      </div>

      <A3Card title="知识库检索" action={<Search className="size-4 text-blue-600" />}>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <form
              className="rounded-2xl border border-cyan-200 bg-[var(--a3-surface-solid)] p-4 shadow-sm shadow-cyan-100/50 focus-within:border-cyan-400"
              onSubmit={(event) => {
                event.preventDefault();
                void searchKnowledge(query);
              }}
            >
              <textarea
                data-testid="a3-kb-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-h-24 w-full resize-none bg-transparent text-sm font-medium leading-6 text-[var(--a3-text)] outline-none placeholder:text-[var(--a3-text-muted)]"
                placeholder="输入课程问题，例如：进程调度为什么会产生饥饿？"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-[var(--a3-text-muted)]">
                  Enter 检索已构建资料，当前返回 {searchConfig.topK} 个 Chunk
                </div>
                <Button data-testid="a3-kb-search-submit" type="submit" disabled={searching}>
                  {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                  检索
                </Button>
              </div>
            </form>

            <div data-testid="a3-kb-quality-panel" data-agent="PersonalMaterialAgent" className="mt-4 grid gap-3 rounded-xl border border-cyan-100 bg-cyan-50 p-4 text-sm text-cyan-950 md:grid-cols-4">
              <div data-testid="a3-kb-quality-upload-evidence">
                <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700">上传证据</div>
                <div className="mt-1 font-medium">{resources.length} 个资源</div>
              </div>
              <div data-testid="a3-kb-quality-index-evidence">
                <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700">索引证据</div>
                <div className="mt-1 font-medium">{stats.indexedDocuments} 个片段</div>
              </div>
              <div data-testid="a3-kb-quality-search-evidence">
                <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700">检索证据</div>
                <div data-testid="a3-kb-quality-search-count" className="mt-1 font-medium">{results.length} 条结果</div>
              </div>
              <div data-testid="a3-kb-quality-classroom-evidence">
                <div className="text-xs font-semibold uppercase tracking-wide text-cyan-700">课堂引用</div>
                <Link className="mt-1 inline-flex font-medium text-cyan-700 hover:text-cyan-950" href="/a3/classroom">进入 AI 课堂</Link>
              </div>
            </div>

            {retrieval ? (
              <div data-testid="a3-kb-retrieval-route" className="mt-4 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <A3Pill tone={retrieval.fallback ? 'orange' : routeTone(retrieval.route)}>{routeLabel(retrieval.route)}</A3Pill>
                  <A3Pill tone="slate">{intentLabel(retrieval.intent)}</A3Pill>
                  <A3Pill tone="blue">topK {searchConfig.topK}</A3Pill>
                  {searchConfig.includeAssets ? <A3Pill tone="green">含多模态资源</A3Pill> : null}
                  {retrieval.fallback ? <A3Pill tone="orange">已降级</A3Pill> : null}
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">
                  {retrieval.fallback ? retrieval.fallbackReason : retrieval.reason}
                </p>
                {retrieval.subQuestions?.length ? (
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--a3-text-muted)]">
                    {retrieval.subQuestions.slice(0, 3).map((item) => (
                      <span key={item} className="rounded-full bg-[var(--a3-surface-solid)] px-2.5 py-1">{item}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {(wikiEvidence.length || graphEvidence.length) ? (
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {wikiEvidence.length ? (
                  <div data-testid="a3-kb-wiki-evidence" className="rounded-xl border border-[var(--a3-border)] p-4">
                    <div className="text-sm font-semibold text-[var(--a3-text)]">Wiki 结构化证据</div>
                    <div className="mt-3 space-y-3">
                      {wikiEvidence.slice(0, 3).map((item) => (
                        <div key={item.id} className="text-sm">
                          <div className="font-medium text-[var(--a3-text)]">{item.preferredLabel}</div>
                          <p className="mt-1 line-clamp-2 text-[var(--a3-text-muted)]">{item.definitions?.[0]?.definition || item.summary}</p>
                          {item.aliases?.length ? <div className="mt-1 text-xs text-[var(--a3-text-muted)]">别名：{item.aliases.slice(0, 4).join('、')}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {graphEvidence.length ? (
                  <div data-testid="a3-kb-graph-evidence" className="rounded-xl border border-[var(--a3-border)] p-4">
                    <div className="text-sm font-semibold text-[var(--a3-text)]">图谱路径证据</div>
                    <div className="mt-3 space-y-3">
                      {graphEvidence.slice(0, 3).map((item) => (
                        <div key={item.id} className="text-sm">
                          <div className="font-medium text-[var(--a3-text)]">{graphPathLabel(item)}</div>
                          <p className="mt-1 text-[var(--a3-text-muted)]">{item.label || item.relationType}{item.weight ? ` 路 ${formatScore(item.weight)}` : ''}</p>
                          {item.relations?.length ? (
                            <div data-testid="a3-kb-graph-path-evidence" className="mt-2 space-y-1 rounded-lg bg-[var(--a3-surface-muted)] p-2 text-xs text-[var(--a3-text-muted)]">
                              {item.relations.slice(0, 4).map((relation, relationIndex) => (
                                <div key={`${item.id}-relation-${relationIndex}`}>
                                  {relation.sourceLabel || '节点'} → {relation.targetLabel || '节点'}：{relation.label || relation.relationType || '相关'}
                                </div>
                              ))}
                              <div>
                                {item.hops ? `${item.hops} 跳` : `${item.relations.length} 段关系`}
                                {typeof item.evidenceCoverage === 'number' ? ` · 证据覆盖 ${percent(item.evidenceCoverage)}` : ''}
                              </div>
                            </div>
                          ) : null}
                          {item.evidence?.[0]?.snippet ? <p className="mt-1 line-clamp-2 text-xs text-[var(--a3-text-muted)]">{item.evidence[0].snippet}</p> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 space-y-3">
              {results.map((result, index) => (
                <div key={`${displayTitle(result.metadata, index)}-${index}`} data-testid="a3-kb-search-result" className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-cyan-700">#{index + 1}</span>
                    <A3Pill tone="blue">{sourceOrigin(result.metadata)}</A3Pill>
                    <A3Pill tone="slate">{sourceType(result.metadata)}</A3Pill>
                    <span className="rounded-full bg-[var(--a3-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--a3-text-muted)]">相似度 {formatScore(result.score)}</span>
                  </div>
                  <div className="mt-3 font-medium text-[var(--a3-text)]">{displayTitle(result.metadata, index)}</div>
                  <div className="mt-2 rounded-lg bg-[var(--a3-surface-muted)] p-3 text-sm leading-6 text-[var(--a3-text-muted)]">
                    {result.contextSnippet ? <div className="mb-2 text-xs font-semibold text-cyan-700">命中上下文</div> : null}
                    <A3Markdown>{searchResultSnippet(result)}</A3Markdown>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--a3-border)] pt-3 text-xs text-[var(--a3-text-muted)]">
                    <span>{formatEvidenceLocation(result)}</span>
                    <span>score {formatScore(result.score)}</span>
                    {result.metadata.chunk_index !== undefined ? <span>块索引 {String(result.metadata.chunk_index)}</span> : null}
                    {result.metadata.file_id ? <span>文件 ID {String(result.metadata.file_id)}</span> : null}
                  </div>
                </div>
              ))}
              {!results.length ? <EmptyState icon={<FileText className="size-8" />} title="还没有检索结果" desc={stats.indexedDocuments > 0 ? '输入问题后，系统会展示真实召回来源、页码、幻灯片和相似度。' : '当前没有已构建片段，请先上传资料或重新解析已有资料。'} /> : null}
            </div>
          </div>

          <aside className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 lg:sticky lg:top-4 lg:self-start" data-testid="a3-kb-search-config">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--a3-border)] pb-4">
              <div>
                <h3 className="text-base font-semibold text-[var(--a3-text)]">检索配置</h3>
                <p className="mt-1 text-xs text-[var(--a3-text-muted)]">只启用已有后端真实支持的参数。</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setSearchConfig(defaultSearchConfig)}>
                恢复默认
              </Button>
            </div>

            <div className="mt-4 space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-[var(--a3-text)]">检索模式</span>
                <select
                  data-testid="a3-kb-search-mode"
                  value={searchConfig.mode}
                  onChange={(event) => setSearchConfig((current) => ({ ...current, mode: event.target.value as SearchConfig['mode'] }))}
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm text-[var(--a3-text)] outline-none focus:border-cyan-400"
                >
                  <option value="hybrid">混合检索</option>
                  <option value="vector">向量检索</option>
                  <option value="bm25">BM25 检索</option>
                  <option value="wiki">Wiki 优先</option>
                  <option value="graph">图谱优先</option>
                </select>
                <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">真实映射到 `mode`，用于控制检索路由和召回策略。</span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--a3-text)]">最终返回 Chunk 数</span>
                <input
                  data-testid="a3-kb-search-top-k"
                  type="number"
                  min={1}
                  max={20}
                  value={searchConfig.topK}
                  onChange={(event) => {
                    const nextTopK = Math.min(20, Math.max(1, Number(event.target.value) || defaultSearchConfig.topK));
                    setSearchConfig((current) => ({ ...current, topK: nextTopK }));
                  }}
                  className="mt-2 h-10 w-full rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm outline-none focus:border-cyan-400"
                />
                <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">真实映射到 `/api/kb/search/` 的 `top_k`。</span>
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--a3-border)] p-3">
                <span>
                  <span className="block text-sm font-medium text-[var(--a3-text)]">包含多模态资源</span>
                  <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">真实映射到 `include_assets`。</span>
                </span>
                <input
                  data-testid="a3-kb-search-include-assets"
                  type="checkbox"
                  checked={searchConfig.includeAssets}
                  onChange={(event) => setSearchConfig((current) => ({ ...current, includeAssets: event.target.checked }))}
                  className="size-5 accent-cyan-700"
                />
              </label>

              <label className="flex items-center justify-between gap-3 rounded-xl border border-[var(--a3-border)] p-3">
                <span>
                  <span className="block text-sm font-medium text-[var(--a3-text)]">快速检索</span>
                  <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">真实映射到 `fast`，开启后优先使用 BM25/关键词。</span>
                </span>
                <input
                  data-testid="a3-kb-search-fast"
                  type="checkbox"
                  checked={searchConfig.fast}
                  onChange={(event) => setSearchConfig((current) => ({ ...current, fast: event.target.checked }))}
                  className="size-5 accent-cyan-700"
                />
              </label>

              <NumberSearchConfigField
                testId="a3-kb-search-similarity-threshold"
                label="相似度阈值（0 到 1）"
                value={searchConfig.similarityThreshold}
                min={0}
                max={1}
                step={0.01}
                help="真实映射到 `similarity_threshold`，后端会过滤低分结果。"
                onChange={(value) => setSearchConfig((current) => ({ ...current, similarityThreshold: value }))}
              />
              <NumberSearchConfigField
                testId="a3-kb-search-bm25-candidates"
                label="BM25 召回数量"
                value={searchConfig.bm25Candidates}
                min={1}
                max={200}
                step={1}
                help="真实映射到 `bm25_candidates`，控制关键词候选数量。"
                onChange={(value) => setSearchConfig((current) => ({ ...current, bm25Candidates: Math.round(value) }))}
              />
              <NumberSearchConfigField
                testId="a3-kb-search-vector-weight"
                label="向量检索权重"
                value={searchConfig.vectorWeight}
                min={0}
                max={1}
                step={0.05}
                help="真实映射到 `vector_weight`，影响混合排序分数。"
                onChange={(value) => setSearchConfig((current) => ({ ...current, vectorWeight: value }))}
              />
              <NumberSearchConfigField
                testId="a3-kb-search-bm25-weight"
                label="BM25 权重"
                value={searchConfig.bm25Weight}
                min={0}
                max={1}
                step={0.05}
                help="真实映射到 `bm25_weight`，影响混合排序分数。"
                onChange={(value) => setSearchConfig((current) => ({ ...current, bm25Weight: value }))}
              />
            </div>
          </aside>
        </div>
      </A3Card>
    </div>
  );
}

function NumberSearchConfigField({
  testId,
  label,
  value,
  min,
  max,
  step,
  help,
  onChange,
}: {
  testId: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  help: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-[var(--a3-text)]">{label}</span>
      <input
        data-testid={testId}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const nextValue = Number(event.target.value);
          if (Number.isFinite(nextValue)) onChange(Math.min(max, Math.max(min, nextValue)));
        }}
        className="mt-2 h-10 w-full rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm text-[var(--a3-text)] outline-none focus:border-cyan-400"
      />
      <span className="mt-1 block text-xs text-[var(--a3-text-muted)]">{help}</span>
    </label>
  );
}

function resourceMatchesTab(resource: KnowledgeResource, activeScope: ResourceScope) {
  if (activeScope === 'teacher') return resource.scope === 'teacher' || resource.scope === 'class';
  return resource.scope === activeScope;
}

function jobTypeLabel(job: KnowledgeJob) {
  if (job.type === 'rebuild') return '全量重建';
  if (job.type === 'parse') return '多模态解析';
  if (job.type === 'wiki') return 'Wiki 重建';
  return '上传索引';
}

function jobResourceTitle(job: KnowledgeJob) {
  const names = (job.resources ?? []).map((resource) => resource.name).filter(Boolean);
  if (names.length === 1) return names[0];
  if (names.length > 1) return `${names[0]} 等 ${names.length} 个文件`;
  if (job.currentFile) return job.currentFile;
  if (job.type === 'rebuild') return '全量知识库索引';
  if (job.type === 'parse') return '已有资料多模态解析';
  if (job.type === 'wiki') return '结构化 Wiki 词条重建';
  return '上传文件索引';
}

function jobSummaryText(job: KnowledgeJob) {
  const total = Math.max(job.totalFiles || job.resources?.length || 0, 0);
  const processed = Math.min(Math.max(job.processedFiles || 0, 0), total || Number.MAX_SAFE_INTEGER);
  const parsed = job.summary?.parsed ?? (job.resources ?? []).filter((resource) => resource.status === 'indexed' || resource.status === 'indexed_with_warnings').length;
  const rebuilt = job.summary?.rebuilt ?? 0;
  const indexed = job.summary?.indexed ?? (job.resources ?? []).filter((resource) => resource.status === 'indexed' || resource.status === 'indexed_with_warnings').length;
  const failed = job.summary?.failed ?? (job.resources ?? []).filter((resource) => resource.status === 'failed').length;
  const successLabel = job.type === 'parse' ? '解析' : job.type === 'wiki' ? '重建' : '成功';
  const successCount = job.type === 'parse' ? parsed : job.type === 'wiki' ? rebuilt : indexed;
  if (job.status === 'succeeded') return `已处理 ${processed}/${total || processed} 个文件，${successLabel} ${successCount} 个，失败 ${failed} 个`;
  if (job.status === 'failed') return `处理 ${processed}/${total || processed} 个文件，失败 ${failed || 1} 个`;
  if (job.status === 'running') return `处理中 ${processed}/${total || processed} 个文件`;
  return `排队中，共 ${total || 1} 个文件`;
}

function jobDisplayStatus(job: KnowledgeJob) {
  const failed = job.summary?.failed ?? (job.resources ?? []).filter((resource) => resource.status === 'failed').length;
  if (job.status === 'succeeded' && failed > 0) return 'partial_failure' as const;
  return job.status;
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

function JobProgressDetail({ job }: { job: KnowledgeJob }) {
  const counters = jobProgressCounters(job);
  const recentEvents = job.progressDetail?.recentEvents?.slice(-4) ?? [];
  return (
    <div>
      {counters.length ? (
        <div className="flex flex-wrap gap-1.5">
          {counters.map((item) => (
            <span key={item} className="rounded-md bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
              {item}
            </span>
          ))}
        </div>
      ) : null}
      {recentEvents.length ? (
        <div className="mt-3 space-y-1.5" data-testid="a3-kb-job-events">
          {recentEvents.map((event, index) => (
            <div key={`${event.time || event.phase || 'event'}:${index}`} className="flex gap-2 text-xs leading-5 text-[var(--a3-text-muted)]">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-blue-500" />
              <span className="min-w-0">{event.message}</span>
            </div>
          ))}
        </div>
      ) : null}
      {job.resources?.length ? (
        <div className="mt-3 border-t border-[var(--a3-border)] pt-3">
          <div className="mb-1 text-[11px] font-medium text-[var(--a3-text-muted)]">关联资料</div>
          <div className="space-y-1">
            {job.resources.slice(0, 3).map((resource) => (
              <div key={resource.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-[var(--a3-text)]">{resource.name}</span>
                <StatusPill status={resource.status} />
              </div>
            ))}
            {job.resources.length > 3 ? <div className="text-[11px] text-[var(--a3-text-muted)]">还有 {job.resources.length - 3} 个资料</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function jobProgressCounters(job: KnowledgeJob) {
  const detail = job.progressDetail;
  if (!detail) return [];
  return [
    formatProgressCounter('文件', detail.file),
    formatProgressCounter('页', detail.page),
    formatProgressCounter('块', detail.block),
    formatProgressCounter('分片', detail.chunk),
    detail.metrics?.visualAssets ? `视觉证据 ${detail.metrics.visualAssets}` : '',
    detail.metrics?.warnings ? `警告 ${detail.metrics.warnings}` : '',
  ].filter(Boolean);
}

function formatProgressCounter(label: string, counter?: { current?: number; total?: number }) {
  if (!counter) return '';
  const current = typeof counter.current === 'number' ? counter.current : undefined;
  const total = typeof counter.total === 'number' ? counter.total : undefined;
  if (current === undefined && total === undefined) return '';
  if (current !== undefined && total !== undefined && total > 0) return `${label} ${current}/${total}`;
  if (current !== undefined) return `${label} ${current}`;
  return `${label} ${total}`;
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
      <WikiStatusLine wiki={resource.wiki} />
      <div>{provider}{multimodal.warnings?.length ? ` · 警告 ${multimodal.warnings.length}` : ''}</div>
      {resource.error ? (
        <div data-testid="a3-kb-resource-error" className="mt-2 rounded-md bg-red-50 px-2 py-1.5 leading-5 text-red-700">
          {resourceErrorMessage(resource.error)}
        </div>
      ) : null}
    </div>
  );
}

function resourceErrorMessage(error: string) {
  if (error.includes('cryptography>=3.1 is required for AES algorithm')) {
    return 'PDF 使用 AES 加密，但当前解析服务缺少解密组件。更新服务后请点击“重解析”。';
  }
  return `解析失败：${error}`;
}

function WikiStatusLine({ wiki }: { wiki?: KnowledgeWikiSummary }) {
  if (!wiki) {
    return <div data-testid="a3-kb-wiki-status">Wiki 未读取</div>;
  }
  return (
    <div data-testid="a3-kb-wiki-status">
      Wiki {wikiStatusLabel(wiki.status)} · 词条 {wiki.conceptCount} · 定义 {wiki.definitionCount} · 别名 {wiki.aliasCount}
    </div>
  );
}

function wikiStatusLabel(status: string) {
  if (status === 'ready') return '已构建';
  if (status === 'not_built') return '待构建';
  if (status === 'pending') return '等待索引';
  if (status === 'blocked') return '被阻塞';
  if (status === 'empty') return '无词条';
  if (status === 'failed') return '失败';
  return '未就绪';
}

function canRebuildWiki(resource: KnowledgeResource) {
  return resource.status === 'indexed' || resource.status === 'indexed_with_warnings';
}

function isInterruptedResource(resource: KnowledgeResource) {
  return resource.status === 'failed' && isInterruptedText(resource.error);
}

function isInterruptedJob(job: KnowledgeJob) {
  return job.status === 'failed' && isInterruptedText(`${job.error} ${job.progressDetail?.phase || ''} ${job.progressDetail?.phaseLabel || ''}`);
}

function isUnresolvedInterruptedJob(job: KnowledgeJob, resources: KnowledgeResource[]) {
  if (!isInterruptedJob(job)) return false;
  const resourceId = String(job.progressDetail?.resourceId || '').trim();
  if (!resourceId) return true;
  const resource = resources.find((item) => item.id === resourceId);
  if (!resource) return false;
  return resource.status === 'failed' || resource.status === 'indexing';
}

function isInterruptedText(value?: string) {
  const text = String(value || '').toLowerCase();
  return [
    '服务重启',
    '队列中断',
    '任务已中断',
    '任务已取消',
    '取消了未完成',
    'interrupted',
    'cancelled',
    'stale',
  ].some((keyword) => text.includes(keyword.toLowerCase()));
}

function ScopePill({ scope, label }: { scope?: ResourceScope; label?: string }) {
  if (scope === 'personal') return <A3Pill tone="green">{label || '我的资料'}</A3Pill>;
  if (scope === 'global') return <A3Pill tone="slate">{label || '全局知识库'}</A3Pill>;
  if (scope === 'class') return <A3Pill tone="blue">{label || '班级资料'}</A3Pill>;
  return <A3Pill tone="blue">{label || '课程资料'}</A3Pill>;
}

function StatusPill({ status }: { status: KnowledgeResource['status'] | KnowledgeJob['status'] | 'partial_failure' }) {
  const map: Record<string, { label: string; tone: 'green' | 'orange' | 'red' | 'blue' | 'slate' }> = {
    uploaded: { label: '待处理', tone: 'slate' },
    indexing: { label: '处理中', tone: 'blue' },
    indexed: { label: '已完成', tone: 'green' },
    indexed_with_warnings: { label: '有警告', tone: 'orange' },
    failed: { label: '失败', tone: 'red' },
    queued: { label: '排队中', tone: 'slate' },
    running: { label: '运行中', tone: 'blue' },
    succeeded: { label: '成功', tone: 'green' },
    partial_failure: { label: '部分失败', tone: 'orange' },
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

function searchResultSnippet(result: SearchResult) {
  return (
    result.contextSnippet ||
    (result.contentFormat === 'markdown' ? result.markdownSnippet : '') ||
    result.markdownSnippet ||
    result.content ||
    result.text ||
    result.evidence?.[0]?.text ||
    '没有可展示片段'
  );
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

function routeLabel(route: string) {
  if (route === 'wiki') return 'Wiki 词条';
  if (route === 'graph') return '图谱推理';
  if (route === 'composite') return '组合检索';
  return '向量检索';
}

function routeTone(route: string): 'green' | 'orange' | 'red' | 'blue' | 'slate' {
  if (route === 'wiki') return 'green';
  if (route === 'graph') return 'blue';
  if (route === 'composite') return 'orange';
  return 'slate';
}

function intentLabel(intent: string) {
  if (intent === 'definition') return '定义问题';
  if (intent === 'multi_hop') return '多跳问题';
  if (intent === 'composite') return '复合问题';
  return '事实问题';
}

function graphPathLabel(item: GraphEvidence) {
  if (item.pathLabels?.length) return item.pathLabels.join(' → ');
  return `${item.sourceLabel} → ${item.targetLabel}`;
}

function formatScore(score: number | null) {
  if (score === null) return '--';
  return score.toFixed(4);
}
