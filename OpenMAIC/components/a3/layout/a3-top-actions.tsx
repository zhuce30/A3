'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bell, CheckCheck, ChevronDown, CircleHelp, Globe2, Moon, Search, Sun } from 'lucide-react';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3Notification, A3NotificationsResponse } from '@/lib/a3/engagement-types';
import { searchA3HelpArticles } from '@/lib/a3/help-content';
import { getA3LocaleLabel, useA3Locale, type A3Locale } from '@/lib/a3/i18n';
import { cn } from '@/lib/utils';

type ThemeMode = 'light' | 'dark';
type Panel = 'notifications' | 'help' | 'language' | null;

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

  const unreadCount = useMemo(() => notifications.filter((item) => item.unread).length, [notifications]);
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
