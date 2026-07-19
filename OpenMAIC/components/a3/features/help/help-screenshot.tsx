'use client';

import Image from 'next/image';
import { Maximize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { A3HelpScreenshot } from '@/lib/a3/help-content';
import { useA3Locale } from '@/lib/a3/i18n';

export function HelpScreenshot({ screenshot }: { screenshot: A3HelpScreenshot }) {
  const { locale } = useA3Locale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="group relative mt-4 block w-full overflow-hidden rounded-md border border-[#18231f]/12 bg-[#f4f7f5] text-left shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#245c48]"
        aria-label={locale === 'zh-CN' ? `放大查看：${screenshot.alt[locale]}` : `Enlarge: ${screenshot.alt[locale]}`}
      >
        <Image src={screenshot.src} alt={screenshot.alt[locale]} width={1600} height={900} className="h-auto w-full" sizes="(max-width: 1024px) calc(100vw - 48px), 900px" />
        {screenshot.markers?.map((marker) => (
          <span key={`${marker.label}-${marker.x}-${marker.y}`} className="absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] border-white bg-[#245c48] text-xs font-bold text-white shadow-md" style={{ left: `${marker.x}%`, top: `${marker.y}%` }} aria-hidden="true">
            {marker.label}
          </span>
        ))}
        <span className="absolute bottom-3 right-3 flex items-center gap-2 rounded-md bg-[#18231f]/85 px-3 py-2 text-xs font-semibold text-white">
          <Maximize2 className="size-4" />
          {locale === 'zh-CN' ? '放大查看' : 'Enlarge'}
        </span>
      </button>

      {open ? (
        <div role="dialog" aria-modal="true" aria-label={screenshot.alt[locale]} className="fixed inset-0 z-[100] flex items-center justify-center bg-[#101713]/90 p-3 sm:p-8">
          <button type="button" className="absolute inset-0 cursor-default" aria-label={locale === 'zh-CN' ? '关闭图片预览' : 'Close image preview'} onClick={() => setOpen(false)} />
          <div className="relative z-10 max-h-[calc(100dvh-32px)] max-w-[min(96vw,1680px)] overflow-auto rounded-md bg-white p-2 shadow-2xl sm:p-3">
            <Image src={screenshot.src} alt={screenshot.alt[locale]} width={1920} height={1080} className="h-auto max-h-[calc(100dvh-72px)] w-auto max-w-full object-contain" sizes="96vw" priority />
            <button ref={closeRef} type="button" onClick={() => setOpen(false)} className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-full bg-[#18231f] text-white shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={locale === 'zh-CN' ? '关闭图片预览' : 'Close image preview'}>
              <X className="size-5" />
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
