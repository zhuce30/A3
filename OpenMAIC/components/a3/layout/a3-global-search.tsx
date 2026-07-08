'use client';

import Link from 'next/link';
import { FormEvent, useMemo, useRef, useState } from 'react';
import { ArrowRight, Database, Loader2, Search } from 'lucide-react';
import { a3GetJson } from '@/lib/a3/api-client';
import {
  buildA3GlobalSearchResults,
  mapA3KnowledgeSearchResults,
  type A3GlobalSearchResult,
  type A3KnowledgeSearchResult,
} from '@/lib/a3/global-search';
import { useA3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';

type KnowledgeSearchResponse = {
  success: boolean;
  error?: string;
  results: A3KnowledgeSearchResult[];
};

export function A3GlobalSearch({ className }: { className?: string }) {
  const { messages } = useA3Locale();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [knowledgeResults, setKnowledgeResults] = useState<A3GlobalSearchResult[]>([]);
  const blurTimerRef = useRef<number | null>(null);

  const routeResults = useMemo(() => buildA3GlobalSearchResults(query, 5), [query]);
  const visibleResults = [...routeResults, ...knowledgeResults].slice(0, 8);
  const hasQuery = query.trim().length > 0;

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const keyword = query.trim();
    if (!keyword) {
      setKnowledgeResults([]);
      setOpen(true);
      return;
    }

    setOpen(true);
    setLoading(true);
    setError('');
    const result = await a3GetJson<KnowledgeSearchResponse>(
      `/api/kb/search/?q=${encodeURIComponent(keyword)}&top_k=5&include_assets=1&fast=1`,
    );
    setLoading(false);
    if (!result.success) {
      setKnowledgeResults([]);
      setError(result.error ?? '全局搜索暂时不可用，请稍后重试。');
      return;
    }
    setKnowledgeResults(mapA3KnowledgeSearchResults(keyword, result.results ?? []));
  }

  function handleFocus() {
    if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
    setOpen(true);
  }

  function handleBlur() {
    blurTimerRef.current = window.setTimeout(() => setOpen(false), 140);
  }

  function closeSearch() {
    setOpen(false);
  }

  return (
    <div className={cn('relative hidden md:block', className)}>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex h-10 w-[360px] items-center gap-2 rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 text-sm text-[var(--a3-text-muted)] transition-colors focus-within:border-blue-300 focus-within:bg-[var(--a3-surface-solid)]"
        role="search"
      >
        <Search className="size-4 shrink-0" />
        <input
          data-testid="a3-global-search-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setKnowledgeResults([]);
            setError('');
            setOpen(true);
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--a3-text)] outline-none placeholder:text-[var(--a3-text-muted)]"
          placeholder={messages.searchPlaceholder}
          aria-label={messages.searchPlaceholder}
        />
        {loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-blue-600" />
        ) : (
          <button type="submit" className="rounded-md px-1.5 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50">
            搜索
          </button>
        )}
      </form>

      {open && (
        <div
          data-testid="a3-global-search-results"
          className="absolute left-0 top-12 z-50 w-[520px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-3 shadow-[var(--a3-shadow)]"
        >
          {!hasQuery ? (
            <div className="rounded-xl bg-[var(--a3-surface-muted)] px-4 py-3 text-sm leading-6 text-[var(--a3-text-muted)]">
              输入课程、知识点、资料名或页面名称，回车后会检索本地知识库来源。
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between px-1 text-xs text-[var(--a3-text-muted)]">
                <span>全局搜索</span>
                <span>回车检索知识库</span>
              </div>
              <div className="max-h-[440px] space-y-2 overflow-y-auto">
                {visibleResults.map((item) => (
                  <SearchResultRow key={item.id} item={item} onOpen={closeSearch} />
                ))}
                {!visibleResults.length && !loading && (
                  <div className="rounded-xl bg-[var(--a3-surface-muted)] px-4 py-5 text-center text-sm leading-6 text-[var(--a3-text-muted)]">
                    没有找到匹配入口。按回车检索知识库，或换一个更贴近课程资料的问题。
                  </div>
                )}
                {loading && (
                  <div className="flex items-center gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
                    <Loader2 className="size-4 animate-spin" />
                    正在检索知识库真实来源
                  </div>
                )}
              </div>
              {error && <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({ item, onOpen }: { item: A3GlobalSearchResult; onOpen: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onOpen}
      className="group flex items-start gap-3 rounded-xl px-3 py-3 hover:bg-blue-50"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700 group-hover:bg-white">
        {item.type === 'knowledge' ? <Database className="size-4" /> : <Search className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
          <span className="shrink-0 rounded-full bg-[var(--a3-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--a3-text-muted)]">
            {item.sourceLabel}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.description}</p>
        {item.score !== undefined && item.score !== null && (
          <div className="mt-1 text-[11px] font-medium text-blue-600">相关度 {item.score}</div>
        )}
      </div>
      <ArrowRight className="mt-1 size-4 shrink-0 text-[var(--a3-text-muted)] group-hover:text-blue-700" />
    </Link>
  );
}
