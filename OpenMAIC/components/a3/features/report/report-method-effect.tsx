import Link from 'next/link';
import { ArrowRight, CircleHelp, FlaskConical, ShieldCheck } from 'lucide-react';
import type { LearningMethodEffect } from '@/lib/a3/report-view-model';

export function ReportMethodEffect({ methods }: { methods: LearningMethodEffect[] }) {
  return (
    <section aria-labelledby="report-method-title">
      <div className="mb-4">
        <h2 id="report-method-title" className="text-xl font-semibold text-[var(--a3-text)]">哪些学习方式对我有效</h2>
        <p className="mt-1 text-sm text-[var(--a3-text-muted)]">只有形成学习前后证据时才给出效果结论。</p>
      </div>
      <div className={`grid gap-3 ${methods.length > 1 ? 'lg:grid-cols-2' : ''}`}>
        {methods.map((method) => {
          const ready = method.evidenceState === 'ready';
          const Icon = ready ? ShieldCheck : method.evidenceState === 'partial' ? FlaskConical : CircleHelp;
          return (
            <article key={method.title} className="rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5">
              <div className="flex items-start gap-3">
                <span className={`flex size-9 shrink-0 items-center justify-center rounded-md ${ready ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200' : 'bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]'}`}>
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold text-[var(--a3-text)]">{method.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{method.conclusion}</p>
                </div>
              </div>
              <ul className="mt-4 space-y-2 border-t border-[var(--a3-border)] pt-4 text-xs leading-5 text-[var(--a3-text-muted)]">
                {method.evidence.map((item) => <li key={item}>证据：{item}</li>)}
              </ul>
              {method.action && (
                <Link href={method.action.href} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-blue-700 hover:text-blue-800">
                  {method.action.label}
                  <ArrowRight className="size-4" />
                </Link>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
