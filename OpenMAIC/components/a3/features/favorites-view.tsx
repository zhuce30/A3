'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookmarkCheck, FileText, Loader2, PlayCircle, Search, Star, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3DeleteJson, a3GetJson } from '@/lib/a3/api-client';
import type { A3Favorite, A3FavoritesResponse } from '@/lib/a3/engagement-types';
import { A3Card, A3Pill } from '../ui/a3-card';

const typeIcons = {
  video: PlayCircle,
  courseware: FileText,
  knowledge_card: BookmarkCheck,
  exercise: BookmarkCheck,
  note: Star,
};

export function FavoritesView() {
  const [favorites, setFavorites] = useState<A3Favorite[]>([]);
  const [summary, setSummary] = useState<A3FavoritesResponse['summary']>({ total: 0, groups: [], types: [] });
  const [activeGroup, setActiveGroup] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const loadFavorites = useCallback(async (group = '', keyword = '') => {
    setLoading(true);
    const params = new URLSearchParams();
    if (group) params.set('group', group);
    if (keyword.trim()) params.set('q', keyword.trim());
    const result = await a3GetJson<A3FavoritesResponse>(`/api/engagement/favorites/${params.size ? `?${params}` : ''}`);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '收藏数据加载失败');
      return;
    }
    setFavorites(result.favorites);
    setSummary(result.summary);
    setMessage('');
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFavorites('', '');
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFavorites]);

  async function deleteFavorite(item: A3Favorite) {
    if (!window.confirm(`确认从收藏夹移除“${item.title}”吗？`)) return;
    const result = await a3DeleteJson<{ success: boolean; error?: string }>(`/api/engagement/favorites/${item.id}/`);
    if (!result.success) {
      setMessage(result.error ?? '删除收藏失败');
      return;
    }
    await loadFavorites(activeGroup, query);
  }

  const groupOptions = useMemo(() => summary.groups, [summary.groups]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--a3-text)]">我的收藏</h1>
          <p className="mt-1 text-sm text-[var(--a3-text-muted)]">集中管理收藏的视频、课件、知识卡片、课堂笔记和练习资源。</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void loadFavorites(activeGroup, query); }} className="flex w-full gap-2 md:w-[360px]">
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm outline-none focus:border-blue-400" placeholder="搜索收藏资源" />
          <Button type="submit" variant="outline">
            <Search className="size-4" />
            搜索
          </Button>
        </form>
      </div>

      {message && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <A3Card title={`收藏资源：${summary.total}`} action={loading ? <Loader2 className="size-4 animate-spin text-blue-600" /> : undefined}>
          <div className="grid gap-4 lg:grid-cols-2">
            {favorites.map((item) => {
              const Icon = typeIcons[item.type] ?? Star;
              return (
                <div key={item.id} data-testid="a3-favorite-item" className="rounded-xl border border-[var(--a3-border)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-4">
                      <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-violet-50 text-violet-700">
                        <Icon className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold text-[var(--a3-text)]">{item.title}</h3>
                          <A3Pill tone="violet">{item.typeLabel}</A3Pill>
                        </div>
                        <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{item.source || '用户收藏'}</p>
                        <p className="mt-1 text-xs text-[var(--a3-text-muted)]">收藏夹：{item.group}</p>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => deleteFavorite(item)} title="移除收藏">
                      <Trash2 className="size-4 text-rose-600" />
                    </Button>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-xs text-[var(--a3-text-muted)]">{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                    {item.url ? (
                      <Button asChild variant="outline" size="sm">
                        <Link href={item.url}>打开资源</Link>
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled>暂无链接</Button>
                    )}
                  </div>
                </div>
              );
            })}
            {!loading && favorites.length === 0 && (
              <div className="col-span-full rounded-xl border border-dashed border-[var(--a3-border)] py-12 text-center text-sm text-[var(--a3-text-muted)]">
                当前筛选下暂无收藏资源。
              </div>
            )}
          </div>
        </A3Card>

        <div className="space-y-5">
          <A3Card title="收藏夹分组">
            <div className="space-y-2">
              <button type="button" onClick={() => { setActiveGroup(''); void loadFavorites('', query); }} className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm ${!activeGroup ? 'bg-blue-50 text-blue-700' : 'bg-[var(--a3-surface-muted)] text-[var(--a3-text)]'}`}>
                <span className="font-medium">全部收藏</span>
                <span>{summary.total}</span>
              </button>
              {groupOptions.map((group) => (
                <button key={group.name} type="button" onClick={() => { setActiveGroup(group.name); void loadFavorites(group.name, query); }} className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-sm ${activeGroup === group.name ? 'bg-blue-50 text-blue-700' : 'bg-[var(--a3-surface-muted)] text-[var(--a3-text)]'}`}>
                  <span className="flex items-center gap-2 font-medium">
                    <Star className="size-4 text-amber-500" />
                    {group.name}
                  </span>
                  <span>{group.count}</span>
                </button>
              ))}
            </div>
          </A3Card>

          <A3Card title="类型统计">
            <div className="space-y-3">
              {summary.types.map((item) => (
                <div key={item.type} className="flex items-center justify-between rounded-xl bg-[var(--a3-surface-muted)] px-3 py-3 text-sm">
                  <span className="font-medium text-[var(--a3-text)]">{item.label}</span>
                  <span className="text-[var(--a3-text-muted)]">{item.count}</span>
                </div>
              ))}
              {!summary.types.length && <div className="rounded-xl bg-[var(--a3-surface-muted)] px-3 py-6 text-center text-sm text-[var(--a3-text-muted)]">暂无类型统计</div>}
            </div>
          </A3Card>
        </div>
      </div>
    </div>
  );
}
