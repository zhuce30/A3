'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BookOpenText, Clock3, Code2, FileText, Filter, Loader2, Search, Sparkles, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson } from '@/lib/a3/api-client';
import type { A3SystemLibraryResponse, A3SystemResource, A3SystemResourceType } from '@/lib/a3/library-types';
import { cn } from '@/lib/utils';
import { A3Pill } from '../ui/a3-card';

const resourceTypes: Array<{ value: '' | A3SystemResourceType; label: string }> = [
  { value: '', label: '全部' },
  { value: 'lecture_doc', label: '讲解文档' },
  { value: 'code_lab', label: '实操案例' },
  { value: 'video', label: '视频' },
];

export function SystemLibraryView() {
  const [data, setData] = useState<A3SystemLibraryResponse | null>(null);
  const [resourceType, setResourceType] = useState<'' | A3SystemResourceType>('');
  const [difficulty, setDifficulty] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadLibrary = useCallback(async (nextType = resourceType, nextDifficulty = difficulty, nextQuery = query) => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (nextType) params.set('type', nextType);
    if (nextDifficulty) params.set('difficulty', nextDifficulty);
    if (nextQuery.trim()) params.set('q', nextQuery.trim());
    params.set('recommended', '6');
    const queryString = `?${params.toString()}`;
    const result = await a3GetJson<A3SystemLibraryResponse>('/api/kb/library/' + queryString);
    setLoading(false);
    if (!result.success) {
      setError(result.error ?? '资料加载失败，请稍后重试。');
      return;
    }
    setData(result);
  }, [difficulty, query, resourceType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLibrary('', '', ''), 0);
    return () => window.clearTimeout(timer);
  }, [loadLibrary]);

  function changeType(value: '' | A3SystemResourceType) {
    setResourceType(value);
    void loadLibrary(value, difficulty, query);
  }

  return (
    <div className="space-y-6" data-testid="a3-system-library-view">
      <header className="flex flex-col justify-between gap-4 border-b border-[var(--a3-border)] pb-5 lg:flex-row lg:items-end">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-700">
            <BookOpenText className="size-4" />
            平台系统资料
          </div>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--a3-text)]">操作系统学习资源库</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">
            由平台统一维护并核验。推荐顺序会结合当前路径、错题、薄弱点、学习时间和历史反馈动态调整。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <SummaryMetric label="全部" value={data?.summary.total ?? 0} />
          <SummaryMetric label="文档/实验" value={data?.summary.documents ?? 0} />
          <SummaryMetric label="视频" value={data?.summary.videos ?? 0} />
        </div>
      </header>

      {error ? (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <span>{error}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadLibrary()}>重试</Button>
        </div>
      ) : null}

      {data?.recommended.length ? (
        <section data-testid="a3-system-library-recommended">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--a3-text)]">
                <Sparkles className="size-5 text-amber-500" />
                适合你先学
              </h2>
              <p className="mt-1 text-sm text-[var(--a3-text-muted)]">每条推荐都可以展开核对实际使用的学习信号。</p>
            </div>
          </div>
          <div className="grid gap-3 xl:grid-cols-3">
            {data.recommended.slice(0, 3).map((resource) => (
              <SystemResourceCard key={resource.resourceCode} resource={resource} emphasized />
            ))}
          </div>
        </section>
      ) : null}

      <section className="border-t border-[var(--a3-border)] pt-5">
        <div className="flex items-center gap-2 text-lg font-semibold text-[var(--a3-text)]">
          <Filter className="size-5 text-blue-600" />
          全部系统资料
        </div>
        <form
          data-testid="a3-system-library-filters"
          className="mt-4 grid gap-3 border-y border-[var(--a3-border)] py-4 lg:grid-cols-[auto_180px_minmax(240px,1fr)_auto]"
          onSubmit={(event) => { event.preventDefault(); void loadLibrary(); }}
        >
          <div className="flex min-w-0 flex-wrap gap-1 rounded-md bg-[var(--a3-surface-muted)] p-1" aria-label="资源类型">
            {resourceTypes.map((item) => (
              <button
                key={item.value || 'all'}
                type="button"
                onClick={() => changeType(item.value)}
                className={cn(
                  'rounded px-3 py-2 text-sm font-medium transition-colors',
                  resourceType === item.value ? 'bg-white text-blue-700 shadow-sm' : 'text-[var(--a3-text-muted)] hover:text-[var(--a3-text)]',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <select
            value={difficulty}
            onChange={(event) => { setDifficulty(event.target.value); void loadLibrary(resourceType, event.target.value, query); }}
            className="h-10 rounded-md border border-[var(--a3-border)] bg-white px-3 text-sm text-[var(--a3-text)] outline-none focus:border-blue-400"
            aria-label="难度"
          >
            <option value="">全部难度</option>
            <option value="foundation">基础</option>
            <option value="intermediate">中等</option>
            <option value="advanced">进阶</option>
          </select>
          <label className="flex h-10 min-w-0 items-center gap-2 rounded-md border border-[var(--a3-border)] bg-white px-3 focus-within:border-blue-400">
            <Search className="size-4 shrink-0 text-[var(--a3-text-muted)]" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索标题或知识点" />
          </label>
          <Button type="submit" disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}搜索</Button>
        </form>

        {loading && !data ? (
          <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-[var(--a3-text-muted)]">
            <Loader2 className="size-5 animate-spin text-blue-600" />正在读取系统资料与个性化排序
          </div>
        ) : data?.resources.length ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {data.resources.map((resource) => <SystemResourceCard key={resource.resourceCode} resource={resource} />)}
          </div>
        ) : (
          <div className="mt-4 border border-dashed border-[var(--a3-border)] py-14 text-center text-sm text-[var(--a3-text-muted)]">
            当前筛选下没有可用资料。
          </div>
        )}
      </section>
    </div>
  );
}

function SystemResourceCard({ resource, emphasized = false }: { resource: A3SystemResource; emphasized?: boolean }) {
  const Icon = resource.resourceType === 'video' ? Video : resource.resourceType === 'code_lab' ? Code2 : FileText;
  return (
    <article className={cn('flex min-h-[300px] flex-col rounded-lg border bg-white p-4', emphasized ? 'border-blue-200 shadow-sm' : 'border-[var(--a3-border)]')}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700"><Icon className="size-5" /></div>
        <div className="flex flex-wrap justify-end gap-2">
          <A3Pill tone={resource.resourceType === 'video' ? 'violet' : resource.resourceType === 'code_lab' ? 'green' : 'blue'}>{resource.resourceTypeLabel}</A3Pill>
          <A3Pill tone="slate">{resource.difficultyLabel}</A3Pill>
        </div>
      </div>
      <h3 className="mt-4 text-base font-semibold leading-6 text-[var(--a3-text)]">{resource.title}</h3>
      <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--a3-text-muted)]">{resource.summary}</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--a3-text-muted)]">
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3.5" />{resource.estimatedMinutes} 分钟</span>
        {resource.knowledgePoints.slice(0, 2).map((point) => <span key={point.code}>· {point.title}</span>)}
      </div>
      <div className="mt-4 rounded-md bg-blue-50 p-3 text-sm leading-6 text-blue-900">
        <div className="font-medium">推荐理由 · {resource.personalization.score} 分</div>
        <p className="mt-1">{resource.personalization.reason}</p>
        {resource.personalization.matchedKnowledgePoints.length ? (
          <p className="mt-1 text-xs text-blue-700">命中：{resource.personalization.matchedKnowledgePoints.join('、')}</p>
        ) : null}
      </div>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <p className="line-clamp-2 min-w-0 text-xs leading-5 text-[var(--a3-text-muted)]">
          完成标准：{resource.completionCriteria.join('；') || '按详情页要求完成学习'}
        </p>
        <Button asChild size="sm" className="shrink-0"><Link href={`/a3/library/${resource.resourceCode}`}>查看详情</Link></Button>
      </div>
    </article>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return <div className="min-w-20 border-l border-[var(--a3-border)] px-3"><div className="text-xl font-semibold text-[var(--a3-text)]">{value}</div><div className="text-xs text-[var(--a3-text-muted)]">{label}</div></div>;
}
