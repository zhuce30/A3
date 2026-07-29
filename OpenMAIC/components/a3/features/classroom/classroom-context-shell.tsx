'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';

export type ClassroomContextSummary = {
  title: string;
  tutorLabel: string;
  statusLabel: string;
  statusTone: 'neutral' | 'warning';
};

type VisibilityOptions = {
  storageKey: string;
  scrollRootRef: RefObject<HTMLElement | null>;
};

const contextStorageListeners = new Set<() => void>();

function subscribeContextStorage(listener: () => void) {
  const handleStorage = () => listener();
  contextStorageListeners.add(listener);
  window.addEventListener('storage', handleStorage);
  return () => {
    contextStorageListeners.delete(listener);
    window.removeEventListener('storage', handleStorage);
  };
}

function readContextExpanded(key: string) {
  return window.sessionStorage.getItem(key) !== 'collapsed';
}

function readServerContextExpanded() {
  return true;
}

function writeContextExpanded(key: string, expanded: boolean) {
  window.sessionStorage.setItem(key, expanded ? 'expanded' : 'collapsed');
  contextStorageListeners.forEach((listener) => listener());
}

export function useClassroomContextVisibility({ storageKey, scrollRootRef }: VisibilityOptions) {
  const regionRef = useRef<HTMLElement | null>(null);
  const regionId = `a3-classroom-context-${useId().replaceAll(':', '')}`;
  const key = `a3:classroom-context:${storageKey || 'waiting-target'}`;
  const getExpandedSnapshot = useCallback(() => readContextExpanded(key), [key]);
  const expanded = useSyncExternalStore(
    subscribeContextStorage,
    getExpandedSnapshot,
    readServerContextExpanded,
  );
  const [visibility, setVisibility] = useState({ key, contextInView: true });
  if (visibility.key !== key) {
    setVisibility({ key, contextInView: true });
  }
  const contextInView = visibility.key === key ? visibility.contextInView : true;

  useLayoutEffect(() => {
    scrollRootRef.current?.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [key, scrollRootRef]);

  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => setVisibility({ key, contextInView: entry.isIntersecting }),
      { root: scrollRootRef.current, threshold: 0 },
    );
    observer.observe(region);
    return () => observer.disconnect();
  }, [key, scrollRootRef]);

  const setContextExpanded = useCallback((value: boolean) => {
    writeContextExpanded(key, value);
  }, [key]);

  const openFromSticky = useCallback(() => {
    setContextExpanded(true);
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    regionRef.current?.scrollIntoView({
      block: 'start',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    window.requestAnimationFrame(() => regionRef.current?.focus({ preventScroll: true }));
  }, [setContextExpanded]);

  return {
    regionRef,
    regionId,
    expanded,
    contextInView,
    collapse: () => setContextExpanded(false),
    expand: () => setContextExpanded(true),
    openFromSticky,
  };
}

export function ClassroomContextShell({
  regionRef,
  regionId,
  expanded,
  summary,
  summaryAction,
  collapseLabel,
  expandLabel,
  onCollapse,
  onExpand,
  children,
}: {
  regionRef: Ref<HTMLElement>;
  regionId: string;
  expanded: boolean;
  summary: ClassroomContextSummary;
  summaryAction?: ReactNode;
  collapseLabel: string;
  expandLabel: string;
  onCollapse: () => void;
  onExpand: () => void;
  children: ReactNode;
}) {
  return (
    <section
      ref={regionRef}
      id={regionId}
      tabIndex={-1}
      data-testid="a3-classroom-context-region"
      className="border-b border-slate-200 bg-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
    >
      {expanded ? (
        <div
          data-testid="a3-classroom-context-expanded"
          className="relative"
        >
          <button
            type="button"
            aria-expanded="true"
            aria-controls={regionId}
            aria-label={collapseLabel}
            onClick={onCollapse}
            className="absolute right-4 top-3 z-10 inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-sm text-slate-600 transition hover:bg-slate-100"
          >
            <ChevronUp className="size-4" aria-hidden="true" />
            {collapseLabel}
          </button>
          {children}
        </div>
      ) : (
        <div
          data-testid="a3-classroom-context-summary"
          className="flex min-h-12 items-center px-4 md:px-6"
        >
          <button
            type="button"
            aria-expanded="false"
            aria-controls={regionId}
            aria-label={expandLabel}
            onClick={onExpand}
            className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950">
              {summary.title}
            </span>
            <span className="hidden text-xs text-slate-600 sm:inline">{summary.tutorLabel}</span>
            <span
              className={cn(
                'hidden text-xs md:inline',
                summary.statusTone === 'warning' ? 'text-amber-700' : 'text-slate-500',
              )}
            >
              {summary.statusLabel}
            </span>
            <ChevronDown className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
          </button>
          {summaryAction}
        </div>
      )}
    </section>
  );
}

export function ClassroomStickyContextBar({
  visible,
  regionId,
  summary,
  actions,
  mobileActions,
  onOpen,
  openLabel,
}: {
  visible: boolean;
  regionId: string;
  summary: ClassroomContextSummary;
  actions: ReactNode;
  mobileActions?: ReactNode;
  onOpen: () => void;
  openLabel: string;
}) {
  if (!visible) return null;

  return (
    <div
      data-testid="a3-classroom-sticky-context"
      className="absolute inset-x-0 top-0 z-30 flex h-12 items-center gap-3 border-b border-slate-200 bg-white px-4 shadow-sm md:px-6"
    >
      <button
        type="button"
        aria-controls={regionId}
        aria-label={openLabel}
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="truncate text-sm font-semibold text-slate-950">{summary.title}</span>
        <span className="hidden text-xs text-slate-600 sm:inline">{summary.tutorLabel}</span>
        <span
          className={cn(
            'hidden text-xs lg:inline',
            summary.statusTone === 'warning' ? 'text-amber-700' : 'text-slate-500',
          )}
        >
          {summary.statusLabel}
        </span>
      </button>
      <div className="shrink-0 sm:hidden">{mobileActions}</div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">{actions}</div>
    </div>
  );
}
