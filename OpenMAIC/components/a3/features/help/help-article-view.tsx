'use client';

import Link from 'next/link';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Compass, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { HelpLayout } from '@/components/a3/features/help/help-layout';
import { HelpScreenshot } from '@/components/a3/features/help/help-screenshot';
import { a3HelpCategories, type A3HelpArticle } from '@/lib/a3/help-content';
import { useA3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';

export function HelpArticleView({ article }: { article: A3HelpArticle }) {
  const { locale } = useA3Locale();
  const router = useRouter();
  const category = a3HelpCategories.find((item) => item.id === article.categoryId);
  const replayHref = article.tourId && article.action
    ? `${article.action.href}${article.action.href.includes('?') ? '&' : '?'}tour=${article.tourId}`
    : null;

  return (
    <HelpLayout
      activeCategory={article.categoryId}
      onCategoryChange={(next) => router.push(next === 'all' ? '/a3/help' : `/a3/help?category=${next}`)}
    >
      <div className="grid gap-10 xl:grid-cols-[minmax(0,900px)_180px] xl:justify-between">
        <article className="min-w-0">
          <Link href="/a3/help" className="inline-flex items-center gap-2 text-sm font-semibold text-[#245c48]">
            <ArrowLeft className="size-4" />
            {locale === 'zh-CN' ? '返回帮助中心' : 'Back to help'}
          </Link>
          <div className="mt-7 border-b border-[#18231f]/12 pb-7">
            <p className="text-xs font-bold text-[#245c48]">{category?.label[locale]}</p>
            <h1 className="mt-3 text-3xl font-semibold leading-tight text-[#18231f] sm:text-4xl">{article.title[locale]}</h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[#59655f]">{article.summary[locale]}</p>
            <div className="mt-4 flex flex-wrap gap-4 text-xs text-[#748079]">
              <span className="inline-flex items-center gap-1.5"><Clock3 className="size-4" />{locale === 'zh-CN' ? `阅读约 ${article.estimatedMinutes} 分钟` : `${article.estimatedMinutes} min`}</span>
              <span>{locale === 'zh-CN' ? `更新于 ${article.updatedAt}` : `Updated ${article.updatedAt}`}</span>
            </div>
          </div>

          {article.prerequisites[locale].length ? (
            <section id="before-you-start" className="mt-9 rounded-md border border-[#245c48]/18 bg-[#eaf3ee] p-5">
              <h2 className="flex items-center gap-2 text-base font-semibold text-[#18231f]"><CheckCircle2 className="size-5 text-[#245c48]" />{locale === 'zh-CN' ? '开始前' : 'Before you start'}</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-[#4f5e56]">
                {article.prerequisites[locale].map((item) => <li key={item}>• {item}</li>)}
              </ul>
            </section>
          ) : null}

          <div className="mt-10 space-y-12">
            {article.sections.map((section) => (
              <section key={section.id} id={section.id} className={cn(section.tone === 'warning' && 'rounded-md border-l-4 border-[#b98418] bg-[#fff8df] p-5', section.tone === 'success' && 'rounded-md border-l-4 border-[#245c48] bg-[#eaf3ee] p-5')}>
                <h2 className="flex items-center gap-2 text-xl font-semibold text-[#18231f]">
                  {section.tone === 'warning' ? <TriangleAlert className="size-5 text-[#9a6a00]" /> : null}
                  {section.title[locale]}
                </h2>
                {section.paragraphs?.[locale].map((paragraph) => <p key={paragraph} className="mt-3 text-sm leading-7 text-[#59655f]">{paragraph}</p>)}
                {section.steps?.[locale].length ? (
                  <ol className="mt-5 divide-y divide-[#18231f]/10 border-y border-[#18231f]/10">
                    {section.steps[locale].map((step, index) => (
                      <li key={step} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 py-4 text-sm leading-7 text-[#3f4e46]">
                        <span className="flex size-7 items-center justify-center rounded-full bg-[#245c48] text-xs font-bold text-white">{index + 1}</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {section.screenshot ? <HelpScreenshot screenshot={section.screenshot} /> : null}
              </section>
            ))}
          </div>

          {article.action ? (
            <div className="mt-12 flex flex-wrap gap-3 border-t border-[#18231f]/12 pt-7">
              <Link href={article.action.href} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-[#245c48] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1d4b3b]">
                {article.action.label[locale]}<ArrowRight className="size-4" />
              </Link>
              {replayHref ? (
                <Link href={replayHref} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[#245c48] px-4 py-2.5 text-sm font-semibold text-[#245c48]">
                  <Compass className="size-4" />{locale === 'zh-CN' ? '重新播放页面引导' : 'Replay page tour'}
                </Link>
              ) : null}
            </div>
          ) : null}
        </article>

        <aside className="hidden xl:block">
          <nav aria-label={locale === 'zh-CN' ? '本页目录' : 'On this page'} className="sticky top-24 border-l border-[#18231f]/12 pl-4">
            <strong className="text-xs text-[#6c7771]">{locale === 'zh-CN' ? '本页目录' : 'On this page'}</strong>
            {article.prerequisites[locale].length ? <a href="#before-you-start" className="mt-3 block text-sm text-[#59655f] hover:text-[#245c48]">{locale === 'zh-CN' ? '开始前' : 'Before you start'}</a> : null}
            {article.sections.map((section) => <a key={section.id} href={`#${section.id}`} className="mt-3 block text-sm leading-5 text-[#59655f] hover:text-[#245c48]">{section.title[locale]}</a>)}
          </nav>
        </aside>
      </div>
    </HelpLayout>
  );
}
