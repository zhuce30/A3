'use client';

import Link from 'next/link';
import { BookOpenCheck, Menu, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  a3HelpCategories,
  type A3HelpCategoryId,
} from '@/lib/a3/help-content';
import { useA3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';

export type A3HelpCategoryFilter = 'all' | A3HelpCategoryId;

export function HelpLayout({
  activeCategory,
  onCategoryChange,
  children,
}: {
  activeCategory: A3HelpCategoryFilter;
  onCategoryChange: (category: A3HelpCategoryFilter) => void;
  children: React.ReactNode;
}) {
  const { locale } = useA3Locale();
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobileOpen]);

  const categoryButtons = (
    <>
      <button
        type="button"
        onClick={() => {
          onCategoryChange('all');
          setMobileOpen(false);
        }}
        className={categoryClass(activeCategory === 'all')}
      >
        {locale === 'zh-CN' ? '全部帮助' : 'All help'}
      </button>
      {a3HelpCategories.map((category) => (
        <button
          key={category.id}
          type="button"
          onClick={() => {
            onCategoryChange(category.id);
            setMobileOpen(false);
          }}
          className={categoryClass(activeCategory === category.id)}
        >
          <span>{category.label[locale]}</span>
          <span className="mt-1 block text-xs font-normal opacity-70">
            {category.description[locale]}
          </span>
        </button>
      ))}
    </>
  );

  return (
    <div className="min-h-screen bg-[#f4f7f5] text-[#18231f]">
      <header className="sticky top-0 z-40 border-b border-[#18231f]/10 bg-[#fff8d8]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1540px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/a3" className="flex min-w-0 items-center gap-3 font-semibold text-[#18231f]">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#245c48] text-white">
              <BookOpenCheck className="size-5" />
            </span>
            <span className="truncate">智学引擎 · {locale === 'zh-CN' ? '帮助与手册' : 'Help'}</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/a3/dashboard" className="rounded-md border border-[#245c48] px-3 py-2 text-sm font-semibold text-[#245c48]">
              {locale === 'zh-CN' ? '返回学习区' : 'Back to learning'}
            </Link>
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex size-11 items-center justify-center rounded-md border border-[#18231f]/15 text-[#245c48] lg:hidden"
              aria-label={locale === 'zh-CN' ? '打开帮助目录' : 'Open help categories'}
            >
              <Menu className="size-5" />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1540px] lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden border-r border-[#18231f]/10 bg-[#fffdf3] px-4 py-8 lg:block">
          <div className="sticky top-24 space-y-1" aria-label={locale === 'zh-CN' ? '帮助分类' : 'Help categories'}>
            {categoryButtons}
          </div>
        </aside>
        <main className="min-w-0 px-4 py-8 sm:px-7 lg:px-10 lg:py-12">{children}</main>
      </div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={locale === 'zh-CN' ? '帮助目录' : 'Help categories'}>
          <button type="button" aria-label={locale === 'zh-CN' ? '关闭目录' : 'Close categories'} onClick={() => setMobileOpen(false)} className="absolute inset-0 bg-black/35" />
          <div className="absolute inset-y-0 left-0 w-[min(86vw,340px)] overflow-y-auto bg-[#fffdf3] p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <strong>{locale === 'zh-CN' ? '按主题查找' : 'Browse topics'}</strong>
              <button ref={closeButtonRef} type="button" onClick={() => setMobileOpen(false)} className="flex size-11 items-center justify-center rounded-md border border-[#18231f]/15" aria-label={locale === 'zh-CN' ? '关闭目录' : 'Close categories'}>
                <X className="size-5" />
              </button>
            </div>
            <div className="space-y-1">{categoryButtons}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function categoryClass(active: boolean) {
  return cn(
    'w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#245c48]',
    active ? 'bg-[#e2eee8] font-semibold text-[#245c48]' : 'text-[#59655f] hover:bg-white hover:text-[#18231f]',
  );
}
