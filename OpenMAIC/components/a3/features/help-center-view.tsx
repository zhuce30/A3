'use client';

import Link from 'next/link';
import { ArrowRight, BookOpenCheck, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { HelpLayout, type A3HelpCategoryFilter } from '@/components/a3/features/help/help-layout';
import {
  a3HelpArticles,
  a3HelpCategories,
  getA3HelpArticleHref,
  searchA3HelpArticles,
} from '@/lib/a3/help-content';
import { useA3Locale } from '@/lib/a3/i18n';

const quickStartIds = ['quick-start-overview', 'today-and-study-plan', 'generate-personal-resources'] as const;

export function HelpCenterView() {
  const { locale } = useA3Locale();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<A3HelpCategoryFilter>('all');
  const articles = useMemo(
    () => searchA3HelpArticles(query, locale).filter((item) => category === 'all' || item.categoryId === category),
    [category, locale, query],
  );
  const quickStarts = quickStartIds
    .map((id) => a3HelpArticles.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return (
    <HelpLayout activeCategory={category} onCategoryChange={setCategory}>
      <section className="max-w-4xl">
        <p className="text-xs font-bold uppercase text-[#245c48]">Help center</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight text-[#18231f] sm:text-4xl">
          {locale === 'zh-CN' ? '现在需要解决什么问题？' : 'What do you need help with?'}
        </h1>
        <p className="mt-3 text-sm leading-7 text-[#59655f] sm:text-base">
          {locale === 'zh-CN' ? '搜索功能、页面名称或遇到的现象，找到可以直接执行的操作步骤。' : 'Search a feature, page, or symptom to find actionable steps.'}
        </p>
        <label data-testid="a3-help-search" className="mt-7 flex min-h-12 items-center gap-3 rounded-md border border-[#18231f]/15 bg-white px-4 shadow-sm focus-within:border-[#245c48] focus-within:ring-2 focus-within:ring-[#245c48]/15">
          <Search className="size-5 shrink-0 text-[#245c48]" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#7b8580]" placeholder={locale === 'zh-CN' ? '例如：生成个性化资源、一直解析中、错题本' : 'Try: generate resources, indexing stuck, wrong notebook'} />
        </label>
      </section>

      {!query && category === 'all' ? (
        <nav data-testid="a3-help-quick-start" aria-label={locale === 'zh-CN' ? '快速开始' : 'Quick start'} className="mt-10 grid overflow-hidden rounded-md border border-[#18231f]/10 bg-[#18231f]/10 md:grid-cols-3">
          {quickStarts.map((item, index) => (
            <Link key={item.id} href={getA3HelpArticleHref(item.id)} className="group bg-white p-5 transition-colors hover:bg-[#fff8d8]">
              <span className="text-xs font-bold text-[#245c48]">0{index + 1}</span>
              <strong className="mt-3 block text-base text-[#18231f]">{item.title[locale]}</strong>
              <p className="mt-2 text-sm leading-6 text-[#59655f]">{item.summary[locale]}</p>
            </Link>
          ))}
        </nav>
      ) : null}

      <section className="mt-11" aria-live="polite">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#18231f]/12 pb-4">
          <div>
            <h2 className="text-xl font-semibold text-[#18231f]">
              {category === 'all' ? (locale === 'zh-CN' ? '常用操作' : 'Common tasks') : a3HelpCategories.find((item) => item.id === category)?.label[locale]}
            </h2>
            <p className="mt-1 text-sm text-[#59655f]">{locale === 'zh-CN' ? `找到 ${articles.length} 篇帮助` : `${articles.length} articles`}</p>
          </div>
          {category !== 'all' ? <button type="button" onClick={() => setCategory('all')} className="text-sm font-semibold text-[#245c48]">{locale === 'zh-CN' ? '查看全部分类' : 'View all categories'}</button> : null}
        </div>

        <div className="divide-y divide-[#18231f]/10">
          {articles.map((article) => (
            <Link key={article.id} href={getA3HelpArticleHref(article.id)} className="group grid gap-3 py-5 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center">
              <span className="flex size-10 items-center justify-center rounded-md bg-[#e2eee8] text-[#245c48]"><BookOpenCheck className="size-5" /></span>
              <span className="min-w-0">
                <strong className="block text-base text-[#18231f] group-hover:text-[#245c48]">{article.title[locale]}</strong>
                <span className="mt-1 block text-sm leading-6 text-[#59655f]">{article.summary[locale]}</span>
                <span className="mt-2 flex flex-wrap gap-3 text-xs text-[#78827d]"><span>{a3HelpCategories.find((item) => item.id === article.categoryId)?.label[locale]}</span><span>{locale === 'zh-CN' ? `约 ${article.estimatedMinutes} 分钟` : `${article.estimatedMinutes} min`}</span></span>
              </span>
              <ArrowRight className="hidden size-5 text-[#245c48] sm:block" />
            </Link>
          ))}
        </div>

        {!articles.length ? (
          <div className="py-16 text-center">
            <Sparkles className="mx-auto size-7 text-[#9a6a00]" />
            <h2 className="mt-4 text-lg font-semibold text-[#18231f]">{locale === 'zh-CN' ? '没有找到相关答案' : 'No matching answer'}</h2>
            <p className="mt-2 text-sm text-[#59655f]">{locale === 'zh-CN' ? '换一个关键词，或者恢复全部分类。' : 'Try another keyword or restore all help.'}</p>
            <button type="button" onClick={() => { setQuery(''); setCategory('all'); }} className="mt-5 rounded-md bg-[#245c48] px-4 py-2.5 text-sm font-semibold text-white">{locale === 'zh-CN' ? '查看全部帮助' : 'View all help'}</button>
          </div>
        ) : null}
      </section>
    </HelpLayout>
  );
}
