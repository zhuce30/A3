import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function A3Card({
  title,
  subtitle,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-[14px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] shadow-[var(--a3-shadow)]',
        className,
      )}
    >
      {(title || subtitle || action) && (
        <div className="flex items-start justify-between gap-4 border-b border-[var(--a3-border)] px-5 py-4">
          <div>
            {title && <h2 className="text-[17px] font-semibold text-[var(--a3-text)]">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-[var(--a3-text-muted)]">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function A3Pill({
  children,
  tone = 'blue',
}: {
  children: ReactNode;
  tone?: 'blue' | 'green' | 'violet' | 'orange' | 'red' | 'slate';
}) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700',
    green: 'bg-emerald-50 text-emerald-700',
    violet: 'bg-violet-50 text-violet-700',
    orange: 'bg-orange-50 text-orange-700',
    red: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-100 text-slate-600',
  };

  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}
