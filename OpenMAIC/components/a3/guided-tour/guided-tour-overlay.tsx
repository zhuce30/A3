'use client';

import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { A3GuidedTour, A3TourStep } from '@/lib/a3/guided-tour';
import { useA3Locale } from '@/lib/a3/i18n';

type TargetRect = { top: number; left: number; right: number; bottom: number; width: number; height: number };

export function A3GuidedTourOverlay({
  tour,
  step,
  stepIndex,
  stepCount,
  onPrevious,
  onNext,
  onDismiss,
}: {
  tour: A3GuidedTour;
  step: A3TourStep;
  stepIndex: number;
  stepCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onDismiss: () => void;
}) {
  const { locale } = useA3Locale();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const lastStep = stepIndex === stepCount - 1;

  useEffect(() => {
    const update = () => {
      const target = document.querySelector<HTMLElement>(step.target);
      if (!target) {
        setTargetRect(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const padding = 7;
      setTargetRect({
        top: Math.max(6, rect.top - padding),
        left: Math.max(6, rect.left - padding),
        right: Math.min(window.innerWidth - 6, rect.right + padding),
        bottom: Math.min(window.innerHeight - 6, rect.bottom + padding),
        width: Math.min(window.innerWidth - 12, rect.width + padding * 2),
        height: Math.min(window.innerHeight - 12, rect.height + padding * 2),
      });
    };
    const target = document.querySelector<HTMLElement>(step.target);
    target?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step.target]);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onDismiss();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [onDismiss, step.id]);

  const tooltipStyle = useMemo(() => getTooltipStyle(targetRect, step.placement), [step.placement, targetRect]);
  if (typeof document === 'undefined' || !targetRect) return null;

  return createPortal(
    <div data-testid="a3-guided-tour-overlay" className="fixed inset-0 z-[110]" aria-label={tour.id}>
      <div className="fixed left-0 right-0 top-0 bg-black/55" style={{ height: targetRect.top }} />
      <div className="fixed left-0 bg-black/55" style={{ top: targetRect.top, width: targetRect.left, height: targetRect.height }} />
      <div className="fixed right-0 bg-black/55" style={{ top: targetRect.top, left: targetRect.right, height: targetRect.height }} />
      <div className="fixed bottom-0 left-0 right-0 bg-black/55" style={{ top: targetRect.bottom }} />
      <div className="pointer-events-none fixed rounded-md border-2 border-[#fff2ad] shadow-[0_0_0_3px_rgba(36,92,72,0.45)]" style={{ top: targetRect.top, left: targetRect.left, width: targetRect.width, height: targetRect.height }} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="a3-tour-title"
        aria-describedby="a3-tour-description"
        className="fixed z-[111] w-[min(390px,calc(100vw-24px))] rounded-md border border-[#18231f]/12 bg-[#fffdf3] p-5 text-[#18231f] shadow-2xl max-sm:inset-x-3 max-sm:bottom-3 max-sm:top-auto max-sm:w-auto"
        style={tooltipStyle}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold text-[#245c48]">{locale === 'zh-CN' ? `第 ${stepIndex + 1} 步 · 共 ${stepCount} 步` : `Step ${stepIndex + 1} of ${stepCount}`}</p>
            <h2 id="a3-tour-title" className="mt-2 text-lg font-semibold leading-6">{step.title[locale]}</h2>
          </div>
          <button type="button" onClick={onDismiss} className="flex size-10 shrink-0 items-center justify-center rounded-md border border-[#18231f]/12 text-[#59655f] hover:bg-white" aria-label={locale === 'zh-CN' ? '跳过页面引导' : 'Skip tour'}>
            <X className="size-5" />
          </button>
        </div>
        <p id="a3-tour-description" className="mt-3 text-sm leading-6 text-[#59655f]">{step.description[locale]}</p>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#18231f]/10 pt-4">
          <button type="button" onClick={onDismiss} className="min-h-10 px-1 text-sm font-semibold text-[#6d7772]">{locale === 'zh-CN' ? '跳过' : 'Skip'}</button>
          <div className="flex gap-2">
            <button type="button" onClick={onPrevious} disabled={stepIndex === 0} className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-[#18231f]/12 px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40">
              <ArrowLeft className="size-4" />{locale === 'zh-CN' ? '上一步' : 'Previous'}
            </button>
            <button type="button" onClick={onNext} className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-[#245c48] px-3 text-sm font-semibold text-white">
              {lastStep ? <Check className="size-4" /> : null}
              {lastStep ? (locale === 'zh-CN' ? '完成' : 'Finish') : (locale === 'zh-CN' ? '下一步' : 'Next')}
              {!lastStep ? <ArrowRight className="size-4" /> : null}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function getTooltipStyle(rect: TargetRect | null, placement: A3TourStep['placement']): React.CSSProperties | undefined {
  if (!rect || typeof window === 'undefined' || window.innerWidth < 640) return undefined;
  const width = Math.min(390, window.innerWidth - 24);
  const estimatedHeight = 230;
  const gap = 14;
  let top = rect.bottom + gap;
  let left = rect.left;
  if (placement === 'top') top = rect.top - estimatedHeight - gap;
  if (placement === 'right') { top = rect.top; left = rect.right + gap; }
  if (placement === 'left') { top = rect.top; left = rect.left - width - gap; }
  return {
    top: Math.max(12, Math.min(window.innerHeight - estimatedHeight - 12, top)),
    left: Math.max(12, Math.min(window.innerWidth - width - 12, left)),
  };
}
