'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, BookOpenCheck, CircleHelp, Search } from 'lucide-react';
import { a3HelpArticles, searchA3HelpArticles } from '@/lib/a3/help-content';
import { useA3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

const categoryLabels = {
  all: { 'zh-CN': '全部', 'en-US': 'All' },
  account: { 'zh-CN': '账号与设置', 'en-US': 'Account' },
  learning: { 'zh-CN': '学习路径', 'en-US': 'Learning' },
  resources: { 'zh-CN': '资源与知识库', 'en-US': 'Resources' },
  coaching: { 'zh-CN': '面对面辅导', 'en-US': 'Coaching' },
  assessment: { 'zh-CN': '题库与报告', 'en-US': 'Assessment' },
} as const;

type HelpCategory = keyof typeof categoryLabels;

export function HelpCenterView() {
  const { locale } = useA3Locale();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<HelpCategory>('all');
  const categories = useMemo(() => {
    const unique = Array.from(new Set(a3HelpArticles.map((article) => article.category))) as HelpCategory[];
    return ['all', ...unique] as HelpCategory[];
  }, []);
  const articles = useMemo(() => {
    return searchA3HelpArticles(query, locale).filter((article) => category === 'all' || article.category === category);
  }, [category, locale, query]);

  return (
    <div className="space-y-5">
      <A3Card>
        <div className="grid gap-5 lg:grid-cols-[1fr_420px] lg:items-end">
          <div>
            <A3Pill tone="blue">{locale === 'zh-CN' ? '帮助中心' : 'Help Center'}</A3Pill>
            <h1 className="mt-3 text-2xl font-semibold text-[var(--a3-text)]">
              {locale === 'zh-CN' ? '找到智学引擎关键操作答案' : 'Find answers for AI Learning workflows'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--a3-text-muted)]">
              {locale === 'zh-CN'
                ? '覆盖账号引导、学习路径、本地知识库、面对面辅导、题库练习和系统设置。'
                : 'Covers onboarding, learning paths, local knowledge base, coaching, practice, and settings.'}
            </p>
          </div>
          <label className="flex h-12 items-center gap-3 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-4">
            <Search className="size-5 text-blue-600" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--a3-text-muted)]"
              placeholder={locale === 'zh-CN' ? '搜索：知识库、拍照提问、学习路径...' : 'Search: knowledge base, photo question, path...'}
            />
          </label>
        </div>
      </A3Card>

      <div className="grid gap-5 xl:grid-cols-[260px_1fr]">
        <A3Card className="h-fit">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
            <CircleHelp className="size-4 text-blue-600" />
            {locale === 'zh-CN' ? '问题分类' : 'Categories'}
          </div>
          <div className="space-y-2">
            {categories.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setCategory(item)}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm',
                  category === item
                    ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                    : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)] hover:text-[var(--a3-text)]',
                )}
              >
                {categoryLabels[item][locale]}
                <span className="text-xs">{item === 'all' ? a3HelpArticles.length : a3HelpArticles.filter((article) => article.category === item).length}</span>
              </button>
            ))}
          </div>
        </A3Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {articles.map((article) => (
            <A3Card key={article.id} className="flex min-h-[250px] flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-200">
                  <BookOpenCheck className="size-5" />
                </div>
                <A3Pill>{categoryLabels[article.category as HelpCategory][locale]}</A3Pill>
              </div>
              <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">{article.title[locale]}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{article.summary[locale]}</p>
              <ol className="mt-4 flex-1 space-y-2">
                {article.steps[locale].map((step, index) => (
                  <li key={step} className="grid grid-cols-[24px_1fr] gap-2 text-sm leading-6 text-[var(--a3-text)]">
                    <span className="mt-0.5 flex size-5 items-center justify-center rounded-full bg-[var(--a3-surface-muted)] text-xs font-semibold text-blue-600">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <Link href={article.href} className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-blue-600">
                {locale === 'zh-CN' ? '前往处理' : 'Open workflow'}
                <ArrowRight className="size-4" />
              </Link>
            </A3Card>
          ))}
          {!articles.length && (
            <A3Card className="lg:col-span-2">
              <div className="py-12 text-center text-sm text-[var(--a3-text-muted)]">
                {locale === 'zh-CN' ? '没有找到匹配的帮助内容，请换一个关键词。' : 'No matching help articles. Try another keyword.'}
              </div>
            </A3Card>
          )}
        </div>
      </div>
    </div>
  );
}
