'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FlaskConical,
  Gauge,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlgorithmLabId } from '@/lib/a3/algorithm-lab/contracts';
import {
  fetchAlgorithmLabCatalog,
  type AlgorithmLabCatalogItem,
  type AlgorithmLabCatalogResponse,
} from '@/lib/a3/algorithm-lab/client';
import {
  clearLabSession,
  loadLabSession,
  type AlgorithmLabSession,
} from '@/lib/a3/algorithm-lab/session';
import { useA3Locale, type A3Locale } from '@/lib/a3/i18n';

type CatalogLab = AlgorithmLabCatalogItem & { recommended?: boolean };
type SessionMap = Partial<Record<AlgorithmLabId, AlgorithmLabSession>>;

const catalogMessages = {
  'zh-CN': {
    eyebrow: '操作系统 · 可验证学习实验',
    title: '交互式算法实验',
    description: '先预测，再逐步运行算法。系统会记录关键判断与复查过程，并把验证结果写回学习报告。',
    loading: '正在读取实验进度',
    reload: '重新加载',
    empty: '暂无可用实验',
    emptyDetail: '实验目录暂时没有返回内容，请稍后重新加载。',
    resumeTitle: '继续上次实验',
    resumeDetail: '浏览器中保存了一次未结束的实验，可从离开的位置继续。',
    clear: '清除记录',
    recommended: '建议先做',
    completed: '已完成',
    start: '开始实验',
    continue: '继续实验',
    repeat: '再次实验',
    minutes: '分钟',
    algorithms: '可比较算法',
    verifiedRuns: '次验证完成',
    bestScore: '最好成绩',
    noScore: '尚未评分',
    errorFallback: '实验目录加载失败，请检查网络后重试。',
  },
  'en-US': {
    eyebrow: 'Operating Systems · Verified Learning Labs',
    title: 'Interactive Algorithm Labs',
    description: 'Predict first, then run each algorithm step by step. Verified decisions and reviews flow back into your learning report.',
    loading: 'Loading lab progress',
    reload: 'Reload',
    empty: 'No labs available',
    emptyDetail: 'The lab catalog returned no items. Please reload in a moment.',
    resumeTitle: 'Resume your last lab',
    resumeDetail: 'An unfinished lab is stored in this browser. Continue from where you left off.',
    clear: 'Clear session',
    recommended: 'Recommended first',
    completed: 'Completed',
    start: 'Start lab',
    continue: 'Continue lab',
    repeat: 'Run again',
    minutes: 'min',
    algorithms: 'Algorithms',
    verifiedRuns: 'verified runs',
    bestScore: 'Best score',
    noScore: 'Not scored yet',
    errorFallback: 'Unable to load the lab catalog. Check your connection and try again.',
  },
} as const;

const labTranslations: Record<AlgorithmLabId, { title: string; description: string }> = {
  'cpu-scheduling': {
    title: 'CPU Scheduling Lab',
    description: 'Compare how scheduling strategies affect waiting, turnaround, and response time.',
  },
  'page-replacement': {
    title: 'Page Replacement Lab',
    description: 'Track memory frames and compare page faults and hit rates across replacement strategies.',
  },
};

const algorithmLabels: Record<string, string> = {
  fcfs: 'FCFS',
  sjf: 'SJF',
  priority: 'Priority',
  rr: 'Round Robin',
  fifo: 'FIFO',
  lru: 'LRU',
  opt: 'OPT',
};

export function AlgorithmLabCatalogView() {
  const { locale } = useA3Locale();
  const copy = catalogMessages[locale];
  const [labs, setLabs] = useState<CatalogLab[]>([]);
  const [sessions, setSessions] = useState<SessionMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const applyCatalogResult = useCallback((result: AlgorithmLabCatalogResponse) => {
    if (!result.success) {
      setLabs([]);
      setSessions({});
      setError(result.error || catalogMessages['zh-CN'].errorFallback);
      setLoading(false);
      return;
    }

    setLabs(result.labs);
    setSessions(Object.fromEntries(
      result.labs
        .map((lab) => [lab.id, loadLabSession(lab.id)] as const)
        .filter((entry): entry is [AlgorithmLabId, AlgorithmLabSession] => entry[1] !== null),
    ));
    setLoading(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError('');
    applyCatalogResult(await fetchAlgorithmLabCatalog());
  }, [applyCatalogResult]);

  useEffect(() => {
    let active = true;
    void fetchAlgorithmLabCatalog().then((result) => {
      if (active) applyCatalogResult(result);
    });
    return () => {
      active = false;
    };
  }, [applyCatalogResult]);

  const sortedLabs = useMemo(
    () => labs
      .map((lab, index) => ({ lab, index }))
      .sort((left, right) => Number(Boolean(right.lab.recommended)) - Number(Boolean(left.lab.recommended)) || left.index - right.index)
      .map(({ lab }) => lab),
    [labs],
  );
  const resumeLab = sortedLabs.find((lab) => sessions[lab.id]);

  function clearResume(labId: AlgorithmLabId) {
    clearLabSession(labId);
    setSessions((current) => {
      const next = { ...current };
      delete next[labId];
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-[52vh] items-center justify-center text-sm text-[var(--a3-text-muted)]" role="status">
        <Loader2 className="mr-2 size-5 animate-spin text-amber-600" />
        {copy.loading}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex min-h-[52vh] max-w-lg flex-col items-center justify-center text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
          <RotateCcw className="size-5" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">{copy.errorFallback}</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{error}</p>
        <button
          type="button"
          onClick={() => void loadCatalog()}
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <RotateCcw className="size-4" />
          {copy.reload}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="a3-algorithm-lab-catalog" className="mx-auto max-w-6xl pb-10">
      <header className="border-b border-[var(--a3-border)] pb-6 pt-1">
        <div className="text-xs font-semibold uppercase text-amber-700 dark:text-amber-300">{copy.eyebrow}</div>
        <h1 className="mt-2 text-2xl font-semibold text-[var(--a3-text)] sm:text-3xl">{copy.title}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--a3-text-muted)] sm:text-base">{copy.description}</p>
      </header>

      {resumeLab ? (
        <section className="my-6 flex flex-col gap-4 border-y border-amber-200 bg-amber-50/80 px-4 py-4 dark:border-amber-900/70 dark:bg-amber-950/25 sm:flex-row sm:items-center sm:justify-between" aria-label={copy.resumeTitle}>
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 className="font-semibold text-[var(--a3-text)]">{copy.resumeTitle}</h2>
              <p className="mt-1 text-sm leading-6 text-[var(--a3-text-muted)]">{copy.resumeDetail}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => clearResume(resumeLab.id)}
              className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-[var(--a3-text-muted)] transition-colors hover:bg-amber-100 hover:text-[var(--a3-text)] dark:hover:bg-amber-900/50"
            >
              <Trash2 className="size-4" />
              {copy.clear}
            </button>
            <Link
              href={`/a3/labs/${resumeLab.id}`}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-500 px-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {copy.resumeTitle}
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      ) : null}

      {sortedLabs.length === 0 ? (
        <section className="flex min-h-[38vh] flex-col items-center justify-center text-center">
          <FlaskConical className="size-10 text-[var(--a3-text-muted)]" />
          <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">{copy.empty}</h2>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{copy.emptyDetail}</p>
          <button type="button" onClick={() => void loadCatalog()} className="mt-5 text-sm font-semibold text-amber-700 hover:text-amber-600 dark:text-amber-300">
            {copy.reload}
          </button>
        </section>
      ) : (
        <section className="mt-6 grid gap-4 lg:grid-cols-2" aria-label={copy.title}>
          {sortedLabs.map((lab) => {
            const localSession = sessions[lab.id];
            const actionLabel = localSession ? copy.continue : lab.progress.completed ? copy.repeat : copy.start;
            const localizedLab = getLocalizedLab(locale, lab);
            return (
              <article
                key={lab.id}
                data-testid="a3-algorithm-lab-item"
                className="flex min-h-[320px] flex-col rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5 shadow-sm sm:p-6"
              >
                <div className="flex items-start justify-between gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                    {lab.id === 'cpu-scheduling' ? <Gauge className="size-5" /> : <FlaskConical className="size-5" />}
                  </span>
                  <div className="flex flex-wrap justify-end gap-2">
                    {lab.recommended ? <StatusPill icon={Sparkles} label={copy.recommended} tone="amber" /> : null}
                    {lab.progress.completed ? <StatusPill icon={CheckCircle2} label={copy.completed} tone="green" /> : null}
                  </div>
                </div>

                <h2 className="mt-5 text-xl font-semibold text-[var(--a3-text)]">{localizedLab.title}</h2>
                <p className="mt-2 min-h-12 text-sm leading-6 text-[var(--a3-text-muted)]">{localizedLab.description}</p>

                <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-y border-[var(--a3-border)] py-3 text-sm text-[var(--a3-text-muted)]">
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 className="size-4" />
                    {lab.estimatedMinutes} {copy.minutes}
                  </span>
                  <span>{copy.algorithms} · {lab.algorithms.map((algorithm) => algorithmLabels[algorithm] ?? algorithm).join(' / ')}</span>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-[var(--a3-text-muted)]">{copy.verifiedRuns}</div>
                    <div className="mt-1 text-xl font-semibold text-[var(--a3-text)]">{lab.progress.verifiedRuns}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--a3-text-muted)]">{copy.bestScore}</div>
                    <div className="mt-1 text-xl font-semibold text-[var(--a3-text)]">
                      {lab.progress.bestScore === null ? copy.noScore : `${lab.progress.bestScore}`}
                    </div>
                  </div>
                </div>

                <Link
                  href={`/a3/labs/${lab.id}`}
                  data-testid="a3-algorithm-lab-action"
                  className="mt-auto inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                >
                  {actionLabel}
                  <ArrowRight className="size-4" />
                </Link>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function getLocalizedLab(locale: A3Locale, lab: CatalogLab) {
  return locale === 'en-US' ? labTranslations[lab.id] : { title: lab.title, description: lab.description };
}

function StatusPill({ icon: Icon, label, tone }: { icon: typeof Sparkles; label: string; tone: 'amber' | 'green' }) {
  const toneClass = tone === 'green'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-200'
    : 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${toneClass}`}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}
