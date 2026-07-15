'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, CheckCircle2, Clock3, ExternalLink, FileText, Loader2, ShieldCheck, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { A3SystemResource, A3SystemResourceDetailResponse } from '@/lib/a3/library-types';
import { trackLearningEvent } from '@/lib/a3/learning-event-client';
import { A3Markdown } from '../ui/a3-markdown';
import { A3Pill } from '../ui/a3-card';

export function SystemResourceDetailView({ resourceCode }: { resourceCode: string }) {
  const [resource, setResource] = useState<A3SystemResource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

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
      setResource(result.resource);
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

  async function record(eventType: 'resource_favorited' | 'resource_skipped' | 'resource_completed', successMessage: string) {
    if (!resource) return;
    const result = await trackLearningEvent({
      eventType,
      targetType: 'curated_resource',
      targetId: resource.resourceCode,
      resourceType: resource.resourceType,
      sourcePage: `/a3/library/${resource.resourceCode}`,
      knowledgePointId: resource.knowledgePoints[0]?.id ?? '',
      metadata: { title: resource.title, courseCode: resource.course.code },
    });
    setMessage(result.success ? successMessage : result.error ?? '学习记录写入失败，请重试。');
  }

  function openResource() {
    if (!resource) return;
    const href = resource.action.external ? resource.action.href : resolveA3Endpoint(resource.action.href);
    window.open(href, '_blank', 'noopener,noreferrer');
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
          <Button type="button" className="mt-4 w-full" onClick={openResource}>{resource.action.label}{resource.action.external ? <ExternalLink className="size-4" /> : <FileText className="size-4" />}</Button>
        </div>
      </header>

      {message ? <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <main className="min-w-0 space-y-6">
          {resource.deliveryMode === 'internal_document' ? (
            <section>
              <h2 className="text-lg font-semibold text-[var(--a3-text)]">资料内容预览</h2>
              <div className="mt-3 space-y-4 border-t border-[var(--a3-border)] pt-4">
                {resource.contentPreview?.length ? resource.contentPreview.map((block, index) => (
                  <div key={`${block.modality}-${index}`} className="min-w-0 border-b border-[var(--a3-border)] pb-4 last:border-0">
                    <A3Markdown className="min-w-0 text-sm leading-7 text-[var(--a3-text)]">{block.markdown}</A3Markdown>
                  </div>
                )) : <div className="border border-dashed border-[var(--a3-border)] py-10 text-center text-sm text-[var(--a3-text-muted)]">正文仍在索引，可先打开原始文档学习。</div>}
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
              <Button type="button" variant="outline" onClick={() => void record('resource_favorited', '已记录收藏偏好，后续推荐会参考。')}><Bookmark className="size-4" />收藏</Button>
              <Button type="button" variant="outline" onClick={() => void record('resource_skipped', '已记录暂不推荐，系统会降低近期排序。')}><ThumbsDown className="size-4" />暂不推荐</Button>
              <Button type="button" onClick={() => void record('resource_completed', '已标记完成，学习报告和后续推荐会使用这条记录。')}><CheckCircle2 className="size-4" />标记完成</Button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function DetailSection({ title, items }: { title: string; items: string[] }) {
  return <section className="border-b border-[var(--a3-border)] pb-4"><h2 className="text-sm font-semibold text-[var(--a3-text)]">{title}</h2>{items.length ? <ul className="mt-2 space-y-2 text-sm leading-6 text-[var(--a3-text-muted)]">{items.map((item) => <li key={item} className="flex gap-2"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-blue-500" />{item}</li>)}</ul> : <p className="mt-2 text-sm text-[var(--a3-text-muted)]">暂未设置</p>}</section>;
}
