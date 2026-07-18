'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, CheckCircle2, Clock3, Download, ExternalLink, Eye, Loader2, RefreshCw, ShieldCheck, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import { normalizeA3SystemResource, type A3SystemResource, type A3SystemResourceDetailResponse } from '@/lib/a3/library-types';
import { trackLearningEvent } from '@/lib/a3/learning-event-client';
import { buildSystemResourceFavorite, saveResourceFavorite } from '@/lib/a3/resource-favorites';
import { A3Markdown } from '../ui/a3-markdown';
import { A3Pill } from '../ui/a3-card';

export function SystemResourceDetailView({ resourceCode }: { resourceCode: string }) {
  const [resource, setResource] = useState<A3SystemResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [savingFavorite, setSavingFavorite] = useState(false);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [previewError, setPreviewError] = useState('');
  const [previewObjectUrl, setPreviewObjectUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await a3GetJson<A3SystemResourceDetailResponse>(`/api/kb/library/${encodeURIComponent(resourceCode)}/`);
      if (cancelled) return;
      setLoading(false);
      if (!result.success || !result.resource) {
        setError(result.error ?? '系统资料加载失败。');
        return;
      }
      setResource(normalizeA3SystemResource(result.resource));
      void trackLearningEvent({
        eventType: 'resource_opened',
        targetType: 'curated_resource',
        targetId: result.resource.resourceCode,
        resourceType: result.resource.resourceType,
        sourcePage: `/a3/library/${result.resource.resourceCode}`,
        knowledgePointId: result.resource.knowledgePoints[0]?.id ?? '',
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [resourceCode]);

  useEffect(() => {
    return () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    };
  }, [previewObjectUrl]);

  async function record(eventType: 'resource_skipped' | 'resource_completed', successMessage: string) {
    if (!resource) return;
    setMessageIsError(false);
    const result = await trackLearningEvent({
      eventType,
      targetType: 'curated_resource',
      targetId: resource.resourceCode,
      resourceType: resource.resourceType,
      sourcePage: `/a3/library/${resource.resourceCode}`,
      knowledgePointId: resource.knowledgePoints[0]?.id ?? '',
      metadata: { title: resource.title, courseCode: resource.course.code },
    });
    setMessageIsError(!result.success);
    setMessage(result.success ? successMessage : result.error ?? '学习记录写入失败，请重试。');
  }

  async function favoriteResource() {
    if (!resource) return;
    setSavingFavorite(true);
    setMessage('');
    setMessageIsError(false);
    const favoriteResult = await saveResourceFavorite(buildSystemResourceFavorite(resource));
    setSavingFavorite(false);
    if (!favoriteResult.success) {
      setMessageIsError(true);
      setMessage(favoriteResult.error ?? '收藏保存失败，请重试。');
      return;
    }
    setMessage(favoriteResult.created ? '已加入“我的收藏”，可随时回来继续学习。' : '该资料已在“我的收藏”中。');
    void trackLearningEvent({
      eventType: 'resource_favorited',
      targetType: 'curated_resource',
      targetId: resource.resourceCode,
      resourceType: resource.resourceType,
      sourcePage: `/a3/library/${resource.resourceCode}`,
      knowledgePointId: resource.knowledgePoints[0]?.id ?? '',
      metadata: { title: resource.title, courseCode: resource.course.code, provider: resource.provider },
    });
  }

  function recordDocumentAction(action: 'preview' | 'download') {
    if (!resource) return;
    void trackLearningEvent({
      eventType: 'resource_opened',
      targetType: 'curated_resource',
      targetId: resource.resourceCode,
      resourceType: resource.resourceType,
      sourcePage: `/a3/library/${resource.resourceCode}`,
      knowledgePointId: resource.knowledgePoints[0]?.id ?? '',
      metadata: { action, title: resource.title, courseCode: resource.course.code },
    });
  }

  async function loadDocumentPreview() {
    if (!resource || resource.action.external || !resource.action.preview.available) return;
    recordDocumentAction('preview');
    setPreviewState('loading');
    setPreviewError('');
    try {
      const response = await fetch(resolveA3Endpoint(resource.action.preview.href), {
        credentials: 'include',
        cache: 'no-store',
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) {
        const payload = contentType.includes('application/json')
          ? await response.json().catch(() => null) as { error?: string } | null
          : null;
        throw new Error(payload?.error || 'Word 在线预览暂时不可用，可下载原文档。');
      }
      if (!contentType.includes('application/pdf')) {
        throw new Error('预览服务未返回有效 PDF，可下载原文档继续学习。');
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('预览 PDF 内容为空，请重新加载或下载原文档。');
      setPreviewObjectUrl(URL.createObjectURL(blob));
      setPreviewState('ready');
    } catch (previewFailure) {
      setPreviewState('error');
      setPreviewError(previewFailure instanceof Error ? previewFailure.message : 'Word 在线预览暂时不可用，可下载原文档。');
    }
  }

  function openExternalResource() {
    if (!resource || !resource.action.external) return;
    window.open(resource.action.href, '_blank', 'noopener,noreferrer');
  }

  if (loading) return <div className="flex min-h-[55vh] items-center justify-center gap-2 text-sm text-[var(--a3-text-muted)]"><Loader2 className="size-5 animate-spin text-blue-600" />正在加载系统资料</div>;
  if (error || !resource) return (
    <div className="mx-auto max-w-xl border border-rose-200 bg-rose-50 p-6 text-center text-sm text-rose-800">
      <p>{error || '没有找到该系统资料。'}</p>
      <Button asChild variant="outline" className="mt-4"><Link href="/a3/library">返回系统资料库</Link></Button>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="a3-system-resource-detail">
      <Link href="/a3/library" className="inline-flex items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-900"><ArrowLeft className="size-4" />返回系统资料库</Link>
      <header className="grid gap-6 border-b border-[var(--a3-border)] pb-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div>
          <div className="flex flex-wrap gap-2"><A3Pill tone="blue">{resource.resourceTypeLabel}</A3Pill><A3Pill tone="slate">{resource.difficultyLabel}</A3Pill><A3Pill tone="green">平台已核验</A3Pill></div>
          <h1 className="mt-3 text-2xl font-semibold leading-9 text-[var(--a3-text)]">{resource.title}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--a3-text-muted)]">{resource.summary}</p>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-[var(--a3-text-muted)]">
            <span className="inline-flex items-center gap-1.5"><Clock3 className="size-4" />预计 {resource.estimatedMinutes} 分钟</span>
            <span>{resource.course.title}</span>
            {resource.provider ? <span>来源：{resource.provider}</span> : null}
          </div>
        </div>
        <div className="border-l border-[var(--a3-border)] pl-5">
          <div className="text-sm font-semibold text-[var(--a3-text)]">为什么推荐给你</div>
          <div className="mt-2 text-3xl font-semibold text-blue-700">{resource.personalization.score}<span className="ml-1 text-sm font-normal text-[var(--a3-text-muted)]">匹配分</span></div>
          <p className="mt-3 text-sm leading-6 text-[var(--a3-text-muted)]">{resource.personalization.reason}</p>
          {resource.action.external ? (
            <Button type="button" className="mt-4 w-full" onClick={openExternalResource}>{resource.action.label}<ExternalLink className="size-4" /></Button>
          ) : (
            <div className="mt-4 grid gap-2">
              <Button type="button" className="w-full" onClick={() => void loadDocumentPreview()} disabled={!resource.action.preview.available || previewState === 'loading'}>
                {previewState === 'loading' ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
                {previewState === 'loading' ? '正在准备预览' : resource.action.preview.label}
              </Button>
              <Button asChild variant="outline" className="w-full">
                <a href={resolveA3Endpoint(resource.action.download.href)} target="_blank" rel="noreferrer" onClick={() => recordDocumentAction('download')}>
                  <Download className="size-4" />{resource.action.download.label}
                </a>
              </Button>
            </div>
          )}
        </div>
      </header>

      {message ? <div className={messageIsError ? 'rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800' : 'rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'}>{message}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0 space-y-6">
          {resource.deliveryMode === 'internal_document' && !resource.action.external ? (
            <section data-testid="a3-docx-preview-section">
              <h2 className="text-lg font-semibold text-[var(--a3-text)]">资料内容预览</h2>
              <div className="mt-3 border-t border-[var(--a3-border)] pt-4">
                {previewState === 'idle' ? (
                  <div className="flex min-h-56 flex-col items-center justify-center border border-dashed border-[var(--a3-border)] px-5 py-10 text-center">
                    <FilePreviewPrompt available={resource.action.preview.available} onPreview={() => void loadDocumentPreview()} />
                  </div>
                ) : null}
                {previewState === 'loading' ? (
                  <div data-testid="a3-docx-preview-loading" className="flex min-h-[320px] items-center justify-center gap-2 bg-[var(--a3-surface-muted)] text-sm text-[var(--a3-text-muted)] md:min-h-[640px]">
                    <Loader2 className="size-5 animate-spin text-blue-600" />正在转换并加载 PDF 预览
                  </div>
                ) : null}
                {previewState === 'error' ? (
                  <div data-testid="a3-docx-preview-error" className="border border-rose-200 bg-rose-50 px-5 py-6 text-sm text-rose-800">
                    <p>{previewError}</p>
                    <Button type="button" variant="outline" className="mt-4" onClick={() => void loadDocumentPreview()}><RefreshCw className="size-4" />重新加载</Button>
                  </div>
                ) : null}
                {previewState === 'ready' && previewObjectUrl ? (
                  <div>
                    <iframe data-testid="a3-docx-preview-frame" title={`${resource.title} PDF 预览`} src={previewObjectUrl} className="hidden min-h-[720px] w-full border border-[var(--a3-border)] bg-white md:block" onError={() => { setPreviewState('error'); setPreviewError('PDF 预览加载失败，请重新加载或下载原文档。'); }} />
                    <a data-testid="a3-docx-preview-mobile-open" href={previewObjectUrl} target="_blank" rel="noreferrer" className="flex w-full items-center justify-center gap-2 border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700 md:hidden">
                      <ExternalLink className="size-4" />打开 PDF 预览
                    </a>
                  </div>
                ) : null}
              </div>

              <div data-testid="a3-docx-markdown-fallback" className="mt-6 border-t border-[var(--a3-border)] pt-5">
                <h3 className="text-sm font-semibold text-[var(--a3-text)]">解析内容</h3>
                <div className="mt-3 space-y-4">
                  {resource.contentPreview?.length ? resource.contentPreview.map((block, index) => (
                    <div key={`${block.modality}-${index}`} className="min-w-0 border-b border-[var(--a3-border)] pb-4 last:border-0">
                      <A3Markdown className="min-w-0 text-sm leading-7 text-[var(--a3-text)]">{block.markdown}</A3Markdown>
                    </div>
                  )) : <div className="border border-dashed border-[var(--a3-border)] py-10 text-center text-sm text-[var(--a3-text-muted)]">正文仍在索引，可先预览或下载原始文档学习。</div>}
                </div>
              </div>
            </section>
          ) : (
            <section className="border border-amber-200 bg-amber-50 p-5">
              <h2 className="flex items-center gap-2 font-semibold text-amber-950"><ExternalLink className="size-4" />外部视频说明</h2>
              <p className="mt-2 text-sm leading-6 text-amber-900">视频链接已做目录核验。没有字幕或转写证据时，不作为回答引用；观看后请回到本页标记完成。</p>
            </section>
          )}
        </main>

        <aside className="space-y-5">
          <DetailSection title="学习目标" items={resource.learningObjectives} />
          <DetailSection title="完成标准" items={resource.completionCriteria} />
          <section className="border border-[var(--a3-border)] p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]"><ShieldCheck className="size-4 text-emerald-600" />核验状态</h2>
            <p className="mt-2 text-xs leading-6 text-[var(--a3-text-muted)]">{resource.verification.note}</p>
          </section>
          <section className="border-t border-[var(--a3-border)] pt-4">
            <div className="grid gap-2">
              <Button type="button" variant="outline" disabled={savingFavorite} onClick={() => void favoriteResource()}>{savingFavorite ? <Loader2 className="size-4 animate-spin" /> : <Bookmark className="size-4" />}{savingFavorite ? '正在收藏' : '收藏'}</Button>
              <Button type="button" variant="outline" onClick={() => void record('resource_skipped', '已记录暂不推荐，系统会降低近期排序。')}><ThumbsDown className="size-4" />暂不推荐</Button>
              <Button type="button" onClick={() => void record('resource_completed', '已标记完成，学习报告和后续推荐会使用这条记录。')}><CheckCircle2 className="size-4" />标记完成</Button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function FilePreviewPrompt({ available, onPreview }: { available: boolean; onPreview: () => void }) {
  return <><Eye className="size-7 text-blue-600" /><div className="mt-3 text-sm font-semibold text-[var(--a3-text)]">{available ? '完整排版预览' : '该文档暂不支持在线预览'}</div>{available ? <Button type="button" variant="outline" className="mt-4" onClick={onPreview}><Eye className="size-4" />在线预览</Button> : null}</>;
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  return <section className="border-b border-[var(--a3-border)] pb-4"><h2 className="text-sm font-semibold text-[var(--a3-text)]">{title}</h2>{items.length ? <ul className="mt-2 space-y-2 text-sm leading-6 text-[var(--a3-text-muted)]">{items.map((item) => <li key={item} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-blue-500" />{item}</li>)}</ul> : <p className="mt-2 text-sm text-[var(--a3-text-muted)]">暂未设置</p>}</section>;
}
