'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowRight, Bell, CheckCheck, ChevronDown, CircleHelp, Clock3, Globe2, Loader2, Moon, Search, Sun, XCircle } from 'lucide-react';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3Notification, A3NotificationsResponse } from '@/lib/a3/engagement-types';
import { searchA3HelpArticles } from '@/lib/a3/help-content';
import { getA3LocaleLabel, useA3Locale, type A3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';

type ThemeMode = 'light' | 'dark';
type Panel = 'tasks' | 'notifications' | 'help' | 'language' | null;

type A3TaskProgressCounter = {
  current?: number;
  total?: number;
};

type A3TaskProgressEvent = {
  time?: string;
  phase?: string;
  message: string;
};

type A3TaskProgressDetail = {
  phase?: string;
  phaseLabel?: string;
  resourceName?: string;
  file?: A3TaskProgressCounter;
  page?: A3TaskProgressCounter;
  block?: A3TaskProgressCounter;
  chunk?: A3TaskProgressCounter;
  metrics?: Record<string, number>;
  recentEvents?: A3TaskProgressEvent[];
};

type A3UnifiedTask = {
  id: string;
  type: 'resource_generation' | 'openmaic_video' | 'knowledge_index' | string;
  workflow: string;
  title: string;
  status: string;
  progress: number;
  stage: string;
  message: string;
  source: string;
  actionUrl: string;
  updatedAt: string;
  error?: string;
  progressDetail?: A3TaskProgressDetail;
};

type A3TasksResponse = {
  success: boolean;
  error?: string;
  tasks?: A3UnifiedTask[];
  summary?: {
    total: number;
    running: number;
    failed: number;
    succeeded: number;
  };
};

export function A3TopActions({ compact = false }: { compact?: boolean }) {
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const { locale, messages, setLocale } = useA3Locale();
  const [helpQuery, setHelpQuery] = useState('');
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'light';
    const savedTheme = window.localStorage.getItem('a3-theme');
    return savedTheme === 'dark' ? 'dark' : 'light';
  });
  const [notifications, setNotifications] = useState<A3Notification[]>([]);
  const [tasks, setTasks] = useState<A3UnifiedTask[]>([]);
  const [taskSummary, setTaskSummary] = useState<A3TasksResponse['summary'] | null>(null);
  const [taskError, setTaskError] = useState('');
  const [taskStreamState, setTaskStreamState] = useState<'connecting' | 'live' | 'fallback'>('connecting');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.dataset.a3Theme = theme;
    window.localStorage.setItem('a3-theme', theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    async function loadNotifications() {
      const result = await a3GetJson<A3NotificationsResponse>('/api/engagement/notifications/?limit=5');
      if (!cancelled && result.success) setNotifications(result.notifications);
    }
    void loadNotifications();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadTasks() {
      try {
        const response = await fetch('/api/a3/tasks', { credentials: 'include', cache: 'no-store' });
        const result = (await response.json().catch(() => ({ success: false, error: '任务数据解析失败' }))) as A3TasksResponse;
        if (cancelled) return;
        if (!response.ok || !result.success) {
          setTaskError(result.error || `任务中心加载失败：${response.status}`);
          return;
        }
        setTaskError('');
        setTasks(result.tasks ?? []);
        setTaskSummary(result.summary ?? null);
      } catch (error) {
        if (!cancelled) setTaskError(error instanceof Error ? error.message : '任务中心暂时不可用');
      }
    }

    void loadTasks();
    const eventSource = new EventSource('/api/a3/tasks/stream', { withCredentials: true });
    eventSource.addEventListener('open', () => {
      if (!cancelled) setTaskStreamState('live');
    });
    eventSource.addEventListener('tasks', (event) => {
      const result = safeParseTasksEvent((event as MessageEvent).data);
      if (!result || cancelled) return;
      if (!result.success) {
        setTaskError(result.error || '任务中心暂时不可用');
        return;
      }
      setTaskError('');
      setTasks(result.tasks ?? []);
      setTaskSummary(result.summary ?? null);
      setTaskStreamState('live');
    });
    eventSource.onerror = () => {
      if (!cancelled) setTaskStreamState('fallback');
    };
    const fallbackTimer = window.setInterval(() => void loadTasks(), 15000);
    return () => {
      cancelled = true;
      eventSource.close();
      window.clearInterval(fallbackTimer);
    };
  }, []);

  const unreadCount = useMemo(() => notifications.filter((item) => item.unread).length, [notifications]);
  const runningTaskCount = taskSummary?.running ?? tasks.filter((task) => isTaskRunning(task.status)).length;
  const failedTaskCount = taskSummary?.failed ?? tasks.filter((task) => task.status === 'failed').length;
  const visibleTasks = tasks.slice(0, 6);
  const helpResults = useMemo(() => searchA3HelpArticles(helpQuery, locale).slice(0, 4), [helpQuery, locale]);

  function closePanel() {
    setActivePanel(null);
  }

  function togglePanel(panel: Exclude<Panel, null>) {
    setActivePanel((current) => (current === panel ? null : panel));
  }

  async function markAllRead() {
    const result = await a3PostJson<{ success: boolean }>('/api/engagement/notifications/read-all/', {});
    if (result.success) {
      setNotifications((items) => items.map((item) => ({ ...item, unread: false, readAt: item.readAt ?? new Date().toISOString() })));
    }
  }

  async function markRead(item: A3Notification) {
    if (!item.unread) {
      closePanel();
      return;
    }
    const result = await a3PostJson<{ success: boolean; notification?: A3Notification }>(`/api/engagement/notifications/${item.id}/read/`, {});
    if (result.success && result.notification) {
      setNotifications((items) => items.map((entry) => (entry.id === item.id ? result.notification! : entry)));
    }
    closePanel();
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1 text-[var(--a3-text)] sm:gap-2 md:gap-4">
      <div className="relative">
        <button
          type="button"
          onClick={() => togglePanel('tasks')}
          className={cn(
            'relative flex size-10 items-center justify-center rounded-xl hover:bg-[var(--a3-surface-muted)]',
            activePanel === 'tasks' && 'bg-[var(--a3-surface-muted)]',
          )}
          aria-label="任务中心"
          data-testid="a3-top-tasks-trigger"
        >
          {runningTaskCount > 0 ? <Loader2 className="size-5 animate-spin text-blue-600" /> : <Activity className="size-5" />}
          {(runningTaskCount > 0 || failedTaskCount > 0) && (
            <span className={cn(
              'absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full text-xs font-semibold text-white',
              failedTaskCount > 0 ? 'bg-rose-500' : 'bg-blue-600',
            )}>
              {failedTaskCount > 0 ? failedTaskCount : runningTaskCount}
            </span>
          )}
        </button>
        {activePanel === 'tasks' && (
          <div data-testid="a3-top-tasks-panel" className="absolute right-0 top-12 z-50 w-[390px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 shadow-[var(--a3-shadow)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-[var(--a3-text)]">任务中心</h3>
                <p className="mt-1 text-xs text-[var(--a3-text-muted)]">
                  {taskStreamState === 'live' ? '实时同步生成进度' : taskStreamState === 'fallback' ? '正在使用轮询刷新' : '正在连接任务流'}
                </p>
              </div>
              <div className="rounded-full bg-[var(--a3-surface-muted)] px-2.5 py-1 text-xs font-medium text-[var(--a3-text-muted)]">
                {taskSummary?.running ?? runningTaskCount} 运行中
              </div>
            </div>

            {taskError && (
              <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-700">
                {taskError}
              </div>
            )}

            <div className="mt-3 space-y-2">
              {visibleTasks.map((task) => (
                <Link
                  key={`${task.type}:${task.id}`}
                  href={task.actionUrl || '/a3/recommendations'}
                  onClick={closePanel}
                  data-testid="a3-top-task-item"
                  className="block rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50 dark:hover:bg-blue-950/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-[var(--a3-text)]">{task.title}</span>
                        {isTaskRunning(task.status) && <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-600" />}
                        {task.status === 'failed' && <XCircle className="size-3.5 shrink-0 text-rose-500" />}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{task.message || formatTaskStatus(task.status)}</p>
                    </div>
                    <span className={cn('shrink-0 rounded-md px-2 py-1 text-[11px] font-medium', taskStatusClassName(task.status))}>
                      {formatTaskStatus(task.status)}
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div className={cn('h-full rounded-full', task.status === 'failed' ? 'bg-rose-500' : 'bg-blue-600')} style={{ width: `${clampProgress(task.progress)}%` }} />
                  </div>
                  {task.progressDetail && (
                    <div data-testid="a3-top-task-progress-detail" className="mt-3 rounded-lg border border-blue-100 bg-white/75 px-2.5 py-2 text-[11px] leading-5 text-[var(--a3-text-muted)] dark:border-blue-900/60 dark:bg-slate-950/35">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-[var(--a3-text)]">{task.progressDetail.phaseLabel || task.message}</span>
                        {task.progressDetail.metrics?.warnings ? (
                          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
                            {task.progressDetail.metrics.warnings} warning
                          </span>
                        ) : null}
                      </div>
                      {renderProgressCounters(task.progressDetail)}
                      {task.progressDetail.recentEvents?.length ? (
                        <div className="mt-1.5 space-y-1">
                          {task.progressDetail.recentEvents.slice(-3).map((event, index) => (
                            <div key={`${event.time || event.phase || 'event'}:${index}`} data-testid="a3-top-task-progress-event" className="truncate text-[10px] text-[var(--a3-text-muted)]">
                              {event.message}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--a3-text-muted)]">
                    <span>{taskSourceLabel(task.source)} · {task.stage || task.workflow}</span>
                    <span className="flex items-center gap-1">
                      <Clock3 className="size-3" />
                      {formatTaskTime(task.updatedAt)}
                    </span>
                  </div>
                </Link>
              ))}

              {!visibleTasks.length && !taskError && (
                <div className="rounded-xl bg-[var(--a3-surface-muted)] px-4 py-6 text-center">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">暂无后台任务</div>
                  <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">生成资源、视频或上传资料后，这里会显示进度和失败原因。</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => togglePanel('notifications')}
          className="relative flex size-10 items-center justify-center rounded-xl hover:bg-[var(--a3-surface-muted)]"
          aria-label={messages.openNotifications}
          data-testid="a3-top-notifications-trigger"
        >
          <Bell className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full bg-red-500 text-xs font-semibold text-white">
              {unreadCount}
            </span>
          )}
        </button>
        {activePanel === 'notifications' && (
          <div data-testid="a3-top-notifications-panel" className="absolute right-0 top-12 z-50 w-[360px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 shadow-[var(--a3-shadow)]">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-[var(--a3-text)]">{messages.notifications}</h3>
              <button type="button" onClick={() => void markAllRead()} className="flex items-center gap-1 text-xs font-medium text-blue-600">
                <CheckCheck className="size-4" />{messages.markAllRead}
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {notifications.map((item) => (
                <Link
                  key={item.id}
                  href={item.actionUrl || '/a3/notifications'}
                  onClick={() => void markRead(item)}
                  data-testid="a3-top-notification-item"
                  className="block w-full rounded-xl bg-[var(--a3-surface-muted)] p-3 text-left hover:bg-blue-50 dark:hover:bg-blue-950/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-[var(--a3-text)]">{item.title}</span>
                    {item.unread && <span className="size-2 rounded-full bg-red-500" />}
                  </div>
                  <p className="mt-1 text-sm leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
                  {isTeacherNotification(item) && (
                    <div data-testid="a3-top-teacher-notification-context" className="mt-2 flex flex-wrap gap-1.5">
                      {topTeacherChips(item).map((chip) => (
                        <span key={chip} className="rounded-full bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-800 dark:bg-orange-950/40 dark:text-orange-100">
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                  {isReviewNotification(item) && (
                    <div data-testid="a3-top-review-notification-context" className="mt-2 flex flex-wrap gap-1.5">
                      {topReviewChips(item).map((chip) => (
                        <span key={chip} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                          {chip}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.learningLoop && (
                    <div data-testid="a3-top-notification-learning-loop" className="mt-2 rounded-lg bg-blue-50 px-2.5 py-2 text-xs leading-5 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200">
                      <div>{item.learningLoop.reason}</div>
                      <div className="mt-1">{item.learningLoop.expectedFeedback}</div>
                      {item.learningLoop.planChange?.currentChange && (
                        <div data-testid="a3-top-notification-plan-change" className="mt-2 rounded-md bg-white/80 px-2 py-1.5 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100">
                          <div className="font-semibold">{item.learningLoop.planChange.currentChange.title}</div>
                          {item.learningLoop.planChange.currentChange.detail && (
                            <div className="mt-1">{item.learningLoop.planChange.currentChange.detail}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-[var(--a3-text-muted)]">{new Date(item.createdAt).toLocaleString('zh-CN')}</p>
                </Link>
              ))}
              {!notifications.length && (
                <div className="rounded-xl bg-[var(--a3-surface-muted)] p-4 text-center text-sm text-[var(--a3-text-muted)]">暂无通知</div>
              )}
            </div>
            <Link href="/a3/notifications" onClick={closePanel} className="mt-3 block rounded-xl border border-[var(--a3-border)] py-2 text-center text-sm font-medium text-blue-600 dark:text-blue-300">
              {messages.viewAllNotifications}
            </Link>
          </div>
        )}
      </div>

      <div className="relative">
        <button type="button" onClick={() => togglePanel('help')} className="flex items-center gap-2 rounded-xl px-1.5 py-2 hover:bg-[var(--a3-surface-muted)] sm:px-2">
          <CircleHelp className="size-5" />
          {!compact && <span className="text-sm font-medium">{messages.helpCenter}</span>}
        </button>
        {activePanel === 'help' && (
          <div className="absolute right-0 top-12 z-50 w-[390px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 shadow-[var(--a3-shadow)]">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold text-[var(--a3-text)]">{messages.helpCenter}</h3>
              <Link href="/a3/help" onClick={closePanel} className="text-xs font-semibold text-blue-600">
                {messages.viewAllHelp}
              </Link>
            </div>
            <label className="mt-3 flex h-10 items-center gap-2 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3">
              <Search className="size-4 text-[var(--a3-text-muted)]" />
              <input
                value={helpQuery}
                onChange={(event) => setHelpQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--a3-text)] outline-none placeholder:text-[var(--a3-text-muted)]"
                placeholder={messages.helpSearchPlaceholder}
              />
            </label>
            <div className="mt-3 grid gap-2">
              {helpResults.map((article) => (
                <Link
                  key={article.id}
                  href={article.href}
                  onClick={closePanel}
                  className="group rounded-xl bg-[var(--a3-surface-muted)] px-3 py-3 text-sm hover:bg-blue-50 dark:hover:bg-blue-950/40"
                >
                  <div className="flex items-center justify-between gap-3 font-semibold text-[var(--a3-text)] group-hover:text-blue-700 dark:group-hover:text-blue-200">
                    <span>{article.title[locale]}</span>
                    <ArrowRight className="size-4 shrink-0" />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{article.summary[locale]}</p>
                </Link>
              ))}
              {!helpResults.length && (
                <div className="rounded-xl bg-[var(--a3-surface-muted)] px-3 py-4 text-center text-sm text-[var(--a3-text-muted)]">
                  {messages.noHelpResults}
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
              <CircleHelp className="size-4" />{messages.helpSearchHint}
            </div>
          </div>
        )}
      </div>

      <span className="hidden h-6 w-px bg-[var(--a3-border)] md:block" />

      <div className="relative">
        <button
          type="button"
          onClick={() => togglePanel('language')}
          className={cn(
            'flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-[var(--a3-surface-muted)]',
            activePanel === 'language' && 'bg-[var(--a3-surface-muted)]',
          )}
          aria-expanded={activePanel === 'language'}
          aria-label={messages.switchLanguage}
          title={getA3LocaleLabel(locale)}
        >
          <Globe2 className="size-5" />
          <span
            className={cn(
              'font-medium',
              compact
                ? 'min-w-5 rounded-full bg-blue-50 px-1.5 py-0.5 text-center text-[11px] text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                : 'text-sm',
            )}
          >
            {compact ? messages.languageShort : getA3LocaleLabel(locale)}
          </span>
          <ChevronDown className={cn('size-4 transition-transform', activePanel === 'language' && 'rotate-180')} />
        </button>
        {activePanel === 'language' && (
          <div className="absolute right-0 top-12 z-50 w-[220px] rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-2 shadow-[var(--a3-shadow)]">
            <div className="px-3 py-2 text-xs font-semibold text-[var(--a3-text-muted)]">{messages.languageSettings}</div>
            {(['zh-CN', 'en-US'] as A3Locale[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => {
                  setLocale(item);
                  closePanel();
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm',
                  locale === item
                    ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-200'
                    : 'text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]',
                )}
              >
                {getA3LocaleLabel(item)}
                {locale === item && <CheckCheck className="size-4" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}
        className={cn(
          'hidden h-10 w-[86px] items-center rounded-full border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-1 shadow-sm transition-colors sm:flex',
          theme === 'dark' && 'bg-slate-900',
        )}
        aria-label={messages.themeToggle}
      >
        <span className={cn('flex size-8 items-center justify-center rounded-full transition-all', theme === 'light' ? 'translate-x-0 bg-blue-50 text-slate-800' : 'translate-x-10 bg-slate-700 text-white')}>
          {theme === 'light' ? <Sun className="size-5" /> : <Moon className="size-5" />}
        </span>
      </button>
    </div>
  );
}

function safeParseTasksEvent(data: string): A3TasksResponse | null {
  try {
    return JSON.parse(data) as A3TasksResponse;
  } catch {
    return null;
  }
}

function isTaskRunning(status: string) {
  return status === 'queued' || status === 'running';
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function formatTaskStatus(status: string) {
  if (status === 'queued') return '排队中';
  if (status === 'running') return '生成中';
  if (status === 'succeeded') return '已完成';
  if (status === 'partial') return '部分完成';
  if (status === 'failed') return '失败';
  return status || '未知';
}

function taskStatusClassName(status: string) {
  if (status === 'failed') return 'bg-rose-50 text-rose-700';
  if (status === 'succeeded') return 'bg-emerald-50 text-emerald-700';
  if (status === 'partial') return 'bg-amber-50 text-amber-700';
  if (isTaskRunning(status)) return 'bg-blue-50 text-blue-700';
  return 'bg-slate-100 text-slate-600';
}

function taskSourceLabel(source: string) {
  if (source === 'resource') return '资源生成';
  if (source === 'video') return '视频生成';
  if (source === 'knowledge_base') return '知识库';
  return '后台任务';
}

function renderProgressCounters(detail: A3TaskProgressDetail) {
  const counters = [
    formatCounter('文件', detail.file),
    formatCounter('页', detail.page),
    formatCounter('块', detail.block),
    formatCounter('分片', detail.chunk),
  ].filter(Boolean);
  const metrics = [
    detail.metrics?.visualAssets ? `视觉证据 ${detail.metrics.visualAssets}` : '',
    detail.metrics?.pagesParsed ? `已解析 ${detail.metrics.pagesParsed} 页` : '',
    detail.metrics?.blocksCreated ? `已生成 ${detail.metrics.blocksCreated} 块` : '',
  ].filter(Boolean);
  if (!counters.length && !metrics.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {[...counters, ...metrics].slice(0, 6).map((item) => (
        <span key={item} className="rounded-md bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
          {item}
        </span>
      ))}
    </div>
  );
}

function formatCounter(label: string, counter?: A3TaskProgressCounter) {
  if (!counter) return '';
  const current = typeof counter.current === 'number' ? counter.current : undefined;
  const total = typeof counter.total === 'number' ? counter.total : undefined;
  if (current === undefined && total === undefined) return '';
  if (current !== undefined && total !== undefined && total > 0) return `${label} ${current}/${total}`;
  if (current !== undefined) return `${label} ${current}`;
  return `${label} ${total}`;
}

function formatTaskTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function isTeacherNotification(item: A3Notification) {
  return item.type === 'teacher' || Boolean(item.payload.targetedByTeacher);
}

function isReviewNotification(item: A3Notification) {
  return item.payload.actionKind === 'review' || item.actionUrl.includes('wrong-notebook');
}

function topReviewChips(item: A3Notification) {
  const dueReviews = Number(item.payload.dueReviews ?? 0);
  const knowledgePoints = Array.isArray(item.payload.knowledgePoints) ? item.payload.knowledgePoints : [];
  const primaryPoint = typeof knowledgePoints[0] === 'string' ? knowledgePoints[0] : '';
  const additionalPoints = knowledgePoints.length > 1 ? `+${knowledgePoints.length - 1}` : '';
  return [
    '错题复盘',
    dueReviews > 0 ? `到期 ${dueReviews}` : '待巩固',
    primaryPoint,
    additionalPoints,
    item.payload.wrongQuestionIds ? '来自错题本' : '',
  ].filter(Boolean);
}

function topTeacherChips(item: A3Notification) {
  return [
    item.payload.targetedByTeacher ? '教师定向干预' : '教师班级提醒',
    topTeacherTaskLabel(item),
    topTeacherTargetLabel(item),
  ].filter(Boolean);
}

function topTeacherTaskLabel(item: A3Notification) {
  const taskType = typeof item.payload.taskType === 'string' ? item.payload.taskType : '';
  if (taskType === 'intervention') return '错题复盘';
  if (taskType === 'assessment') return '阶段测评';
  if (taskType === 'report') return '学习报告';
  if (taskType === 'knowledge_base') return '知识库处理';
  if (taskType === 'resource_pack_reminder') return '资源包复习';
  return item.actionUrl.includes('wrong-notebook') ? '错题复盘' : '学习任务';
}

function topTeacherTargetLabel(item: A3Notification) {
  return item.payload.targetedByTeacher ? '目标学生' : '';
}
