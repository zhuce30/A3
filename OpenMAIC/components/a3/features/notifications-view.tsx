'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Bell, BookOpenCheck, CalendarClock, CheckCircle2, CheckCheck, Clock, FileQuestion, Loader2, MessageSquare, Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3Notification, A3NotificationActionGroup, A3NotificationsResponse } from '@/lib/a3/engagement-types';
import { buildNotificationRhythm } from '@/lib/a3/notification-rhythm';
import { A3Card, A3Pill } from '../ui/a3-card';

const toneByType = {
  learning_task: 'blue',
  assessment: 'violet',
  knowledge_base: 'green',
  system: 'slate',
  teacher: 'orange',
} as const;

const actionMeta = {
  today: { label: '今日任务', href: '/a3/today', icon: BookOpenCheck, tone: 'blue' },
  review: { label: '错题复盘', href: '/a3/wrong-notebook', icon: FileQuestion, tone: 'orange' },
  plan: { label: '学习计划', href: '/a3/study-plan', icon: Route, tone: 'green' },
  assessment: { label: '阶段测评', href: '/a3/assessment', icon: CheckCircle2, tone: 'violet' },
  report: { label: '学习报告', href: '/a3/report', icon: CalendarClock, tone: 'slate' },
} as const;

type ActionKind = keyof typeof actionMeta;
type ActionFilter = 'all' | ActionKind;
type ActionItem = Omit<(typeof actionMeta)[ActionKind], 'href'> & {
  kind: ActionKind;
  href: string;
  count: number;
  unread: number;
  description: string;
  reason: string;
  recent: A3Notification;
};

const filters: Array<{ key: ActionFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日任务' },
  { key: 'review', label: '错题复盘' },
  { key: 'plan', label: '学习计划' },
  { key: 'assessment', label: '阶段测评' },
  { key: 'report', label: '学习报告' },
];

export function NotificationsView() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<A3Notification[]>([]);
  const [summary, setSummary] = useState<A3NotificationsResponse['summary']>({ total: 0, unread: 0, byType: [] });
  const [actionGroups, setActionGroups] = useState<A3NotificationActionGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [actionFilter, setActionFilter] = useState<ActionFilter>('all');

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    const query = actionFilter === 'all' ? '' : `?action=${actionFilter}`;
    const result = await a3GetJson<A3NotificationsResponse>(`/api/engagement/notifications/${query}`);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '通知消息加载失败');
      return;
    }
    setNotifications(result.notifications);
    setSummary(result.summary);
    setActionGroups(result.actionGroups ?? []);
    setMessage('');
  }, [actionFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadNotifications();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadNotifications]);

  async function markRead(item: A3Notification) {
    const result = await a3PostJson<{ success: boolean; error?: string; notification?: A3Notification }>(`/api/engagement/notifications/${item.id}/read/`, {});
    if (!result.success || !result.notification) {
      setMessage(result.error ?? '标记已读失败');
      return;
    }
    setNotifications((current) => current.map((entry) => (entry.id === item.id ? result.notification! : entry)));
    setSummary((current) => ({ ...current, unread: Math.max(0, current.unread - (item.unread ? 1 : 0)) }));
  }

  async function openNotificationAction(item: A3Notification, href = item.actionUrl || '/a3/notifications') {
    if (item.unread) {
      const result = await a3PostJson<{ success: boolean; error?: string; notification?: A3Notification }>(`/api/engagement/notifications/${item.id}/read/`, {});
      if (!result.success || !result.notification) {
        setMessage(result.error ?? '处理提醒失败，请稍后重试');
        return;
      }
      setNotifications((current) => current.map((entry) => (entry.id === item.id ? result.notification! : entry)));
      setSummary((current) => ({ ...current, unread: Math.max(0, current.unread - 1) }));
      setActionGroups((current) => refreshActionGroupsAfterRead(current, item.id));
    }
    router.push(href);
  }

  async function markAllRead() {
    const result = await a3PostJson<{ success: boolean; error?: string; summary?: A3NotificationsResponse['summary'] }>('/api/engagement/notifications/read-all/', {});
    if (!result.success || !result.summary) {
      setMessage(result.error ?? '全部标记已读失败');
      return;
    }
    setNotifications((current) => current.map((item) => ({ ...item, unread: false, readAt: item.readAt ?? new Date().toISOString() })));
    setSummary(result.summary);
  }

  const actionItems: ActionItem[] = actionGroups.length ? actionGroups.map(normalizeActionGroup) : buildActionItems(notifications);
  const notificationRhythm = buildNotificationRhythm(actionGroups);

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]" data-testid="a3-notifications-view">
      <A3Card
        title="学习行动中心"
        subtitle="系统会根据今日任务、错题复盘和计划顺延自动生成提醒，点击即可回到对应学习动作。"
        action={
          loading ? (
            <Loader2 className="size-4 animate-spin text-blue-600" />
          ) : (
            <Button data-testid="a3-notifications-read-all" variant="outline" size="sm" onClick={markAllRead} disabled={summary.unread === 0}>
              <CheckCheck className="size-4" />
              全部已读
            </Button>
          )
        }
      >
        {message && <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</div>}
        <div className="mb-5 flex flex-wrap gap-2">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setActionFilter(filter.key)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                actionFilter === filter.key
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)] text-[var(--a3-text-muted)] hover:border-blue-300 hover:text-blue-700'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {!loading && actionItems.length > 0 && (
          <div className="mb-5 grid gap-3 lg:grid-cols-3">
            {actionItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.kind}
                  type="button"
                  data-testid={`a3-notification-action-${item.kind}`}
                  onClick={() => openNotificationAction(item.recent, item.href)}
                  className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                      <Icon className="size-5" />
                    </div>
                    <A3Pill tone={item.tone}>{item.unread ? `${item.unread} 未读` : `${item.count} 条`}</A3Pill>
                  </div>
                  <div className="mt-4 text-base font-semibold text-[var(--a3-text)]">{item.label}</div>
                  <p className="mt-2 min-h-10 text-sm leading-5 text-[var(--a3-text-muted)]">{item.description}</p>
                  <div
                    className="mt-3 rounded-xl bg-[var(--a3-surface-muted)] p-3 text-xs leading-5 text-[var(--a3-text-muted)]"
                    data-testid={`a3-notification-action-reason-${item.kind}`}
                  >
                    {item.reason}
                  </div>
                  {item.recent.learningLoop && (
                    <div
                      className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-800"
                      data-testid={`a3-notification-action-loop-${item.kind}`}
                    >
                      <div className="font-semibold">连续学习提醒</div>
                      <div className="mt-1">{item.recent.learningLoop.expectedFeedback}</div>
                      {item.recent.learningLoop.planChange?.currentChange && (
                        <div className="mt-2 rounded-lg bg-white/80 p-2 text-blue-900">
                          <div className="font-semibold">{item.recent.learningLoop.planChange.currentChange.title}</div>
                          {item.recent.learningLoop.planChange.currentChange.detail && (
                            <div className="mt-1 text-blue-800">{item.recent.learningLoop.planChange.currentChange.detail}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-700" data-testid={`a3-notification-action-cta-${item.kind}`}>
                    去处理
                    <ArrowRight className="size-4" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <div className="space-y-4">
          {notifications.map((item) => (
            <div key={item.id} data-testid="a3-notification-item" className="flex gap-4 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4">
              <div className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700">
                <Bell className="size-5" />
                {item.unread && <span className="absolute right-0 top-0 size-2 rounded-full bg-red-500" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-[var(--a3-text)]">{item.title}</h3>
                  <A3Pill tone={toneByType[item.type]}>{item.typeLabel}</A3Pill>
                </div>
                <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{item.detail}</p>
                <ReminderContext item={item} />
                <LearningLoopContext item={item} />
                <TeacherNotificationContext item={item} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-[var(--a3-text-muted)]">{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                  <div className="flex gap-2">
                    {item.unread && (
                      <Button variant="outline" size="sm" onClick={() => markRead(item)}>
                        标记已读
                      </Button>
                    )}
                    {item.actionUrl && (
                      <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => openNotificationAction(item)}>
                        前往处理
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {loading && (
            <div className="rounded-xl border border-dashed border-[var(--a3-border)] py-12 text-center text-sm text-[var(--a3-text-muted)]">
              正在加载通知消息...
            </div>
          )}
          {!loading && notifications.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--a3-border)] py-12 text-center text-sm text-[var(--a3-text-muted)]">
              {actionFilter === 'all' ? '暂无通知消息。完成学习任务或触发提醒后，这里会出现可处理事项。' : '当前筛选下没有待处理事项，可以切换到全部查看。'}
            </div>
          )}
        </div>
      </A3Card>

      <div className="space-y-5">
        <A3Card title="消息概览">
          <div className="space-y-3">
            {[
              { icon: MessageSquare, label: '全部消息', value: summary.total },
              { icon: Clock, label: '未读消息', value: summary.unread },
              { icon: CheckCircle2, label: '已读消息', value: Math.max(0, summary.total - summary.unread) },
            ].map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded-xl bg-[var(--a3-surface-muted)] p-4">
                <div className="flex items-center gap-3">
                  <item.icon className="size-5 text-blue-600" />
                  <span className="text-sm font-medium text-[var(--a3-text)]">{item.label}</span>
                </div>
                <span className="text-xl font-semibold text-[var(--a3-text)]">{item.value}</span>
              </div>
            ))}
          </div>
        </A3Card>

        <A3Card title="提醒策略">
          <div className="space-y-3 text-sm leading-6 text-[var(--a3-text-muted)]">
            <p>通知不是普通公告，系统会在你打开页面时检查今日计划、顺延任务和到期错题。</p>
            <div className="rounded-xl bg-blue-50 p-3 text-blue-800">有待完成任务时，引导回今日学习。</div>
            <div className="rounded-xl bg-orange-50 p-3 text-orange-800">有到期错题时，引导回错题本复盘。</div>
            <div className="rounded-xl bg-emerald-50 p-3 text-emerald-800">教师推送会保留独立入口，方便学生直接处理。</div>
          </div>
        </A3Card>

        <A3Card title="提醒节奏">
          <div className="space-y-3" data-testid="a3-notification-rhythm">
            {notificationRhythm.map((item) => (
              <button
                key={item.kind}
                type="button"
                onClick={() => router.push(item.href)}
                data-testid={`a3-notification-rhythm-${item.kind}`}
                className="w-full rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-[var(--a3-text)]">{item.label}</span>
                  <A3Pill tone={item.status === 'pending' ? 'orange' : item.status === 'ready' ? 'green' : 'slate'}>
                    {item.status === 'pending' ? `${item.unread} 待处理` : item.status === 'ready' ? '已生成' : '平稳'}
                  </A3Pill>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.reason}</p>
                <div className="mt-2 rounded-lg bg-white/70 px-2.5 py-2 text-[11px] leading-5 text-[var(--a3-text-muted)]">{item.expectedFeedback}</div>
              </button>
            ))}
          </div>
        </A3Card>

        <A3Card title="消息类型">
          <div className="space-y-2">
            {summary.byType.map((item) => (
              <div key={item.type} className="flex items-center justify-between rounded-xl bg-[var(--a3-surface-muted)] px-3 py-3 text-sm">
                <span className="font-medium text-[var(--a3-text)]">{item.label}</span>
                <span className="text-[var(--a3-text-muted)]">{item.count}</span>
              </div>
            ))}
            {!summary.byType.length && <div className="rounded-xl bg-[var(--a3-surface-muted)] px-3 py-6 text-center text-sm text-[var(--a3-text-muted)]">暂无分类统计</div>}
          </div>
        </A3Card>
      </div>
    </div>
  );
}

function refreshActionGroupsAfterRead(groups: A3NotificationActionGroup[], notificationId: string) {
  return groups.map((group) => {
    if (group.recent.id !== notificationId) return group;
    return {
      ...group,
      unread: Math.max(0, group.unread - 1),
      recent: { ...group.recent, unread: false, readAt: group.recent.readAt ?? new Date().toISOString() },
    };
  });
}

function normalizeActionGroup(group: A3NotificationActionGroup): ActionItem {
  const meta = actionMeta[group.kind];
  return {
    kind: group.kind,
    ...meta,
    href: group.primaryAction.href || meta.href,
    count: group.count,
    unread: group.unread,
    description: group.description,
    reason: group.primaryAction.reason,
    recent: group.recent,
  };
}

function buildActionItems(notifications: A3Notification[]): ActionItem[] {
  const grouped = new Map<ActionKind, A3Notification[]>();
  notifications.forEach((item) => {
    const kind = getActionKind(item);
    if (!grouped.has(kind)) grouped.set(kind, []);
    grouped.get(kind)?.push(item);
  });
  return Array.from(grouped.entries())
    .map(([kind, items]) => {
      const meta = actionMeta[kind];
      return {
        kind,
        ...meta,
        count: items.length,
        unread: items.filter((item) => item.unread).length,
        description: actionDescription(kind, items[0]),
        reason: items[0]?.detail || actionDescription(kind, items[0]),
        recent: items[0],
      };
    })
    .sort((left, right) => priority(left.kind) - priority(right.kind));
}

function getActionKind(item: A3Notification): ActionKind {
  const payloadKind = typeof item.payload.actionKind === 'string' ? item.payload.actionKind : '';
  if (payloadKind in actionMeta) return payloadKind as ActionKind;
  if (item.actionUrl.includes('wrong-notebook')) return 'review';
  if (item.actionUrl.includes('study-plan') || item.actionUrl.includes('learning-path')) return 'plan';
  if (item.actionUrl.includes('assessment')) return 'assessment';
  if (item.actionUrl.includes('report')) return 'report';
  return 'today';
}

function priority(kind: ActionKind) {
  return { today: 1, review: 2, plan: 3, assessment: 4, report: 5 }[kind];
}

function actionDescription(kind: ActionKind, item: A3Notification) {
  if (kind === 'today') {
    const pendingTasks = Number(item.payload.pendingTasks ?? 0);
    const remainingMinutes = Number(item.payload.remainingMinutes ?? 0);
    if (pendingTasks > 0) return `还有 ${pendingTasks} 个任务，预计 ${remainingMinutes} 分钟。`;
    return '先完成一个最小任务，保持学习节奏。';
  }
  if (kind === 'review') {
    const dueReviews = Number(item.payload.dueReviews ?? 0);
    const pointSummary = notificationKnowledgePointSummary(item);
    if (dueReviews > 0 && pointSummary) return `${dueReviews} 个错题知识点已到复习时间：${pointSummary}。`;
    return dueReviews > 0 ? `${dueReviews} 个错题知识点已到复习时间。` : '处理错因，避免同类题反复出错。';
  }
  if (kind === 'plan') return '查看计划调整、顺延任务和当前周期安排。';
  if (kind === 'assessment') return '完成阶段测评，更新画像和推荐。';
  return '查看本周总结、薄弱趋势和下周建议。';
}

function notificationKnowledgePointSummary(item: A3Notification) {
  const points = notificationKnowledgePoints(item);
  if (!points.length) return '';
  return points.length > 1 ? `${points[0]} +${points.length - 1}` : points[0];
}

function notificationKnowledgePoints(item: A3Notification) {
  const points = Array.isArray(item.payload.knowledgePoints)
    ? item.payload.knowledgePoints.filter((point): point is string => typeof point === 'string' && point.trim().length > 0)
    : [];
  return Array.from(new Set(points.map((point) => point.trim())));
}

function ReminderContext({ item }: { item: A3Notification }) {
  if (item.payload.generatedBy !== 'learning_reminder') return null;
  const knowledgePoints = notificationKnowledgePoints(item);
  const chips = [
    item.payload.pendingTasks ? `待完成 ${item.payload.pendingTasks}` : '',
    item.payload.remainingMinutes ? `剩余 ${item.payload.remainingMinutes} 分钟` : '',
    item.payload.rolloverTasks ? `顺延 ${item.payload.rolloverTasks}` : '',
    item.payload.dueReviews ? `到期复习 ${item.payload.dueReviews}` : '',
  ].filter(Boolean);
  if (!chips.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {chips.map((chip) => (
        <span key={chip} className="rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-700">
          {chip}
        </span>
      ))}
      {knowledgePoints.length > 0 && (
        <span data-testid="a3-notification-review-points" className="rounded-full bg-orange-50 px-2.5 py-1 text-xs text-orange-700">
          {knowledgePoints.join(' / ')}
        </span>
      )}
    </div>
  );
}

function LearningLoopContext({ item }: { item: A3Notification }) {
  if (!item.learningLoop) return null;
  const planChange = item.learningLoop.planChange;
  const currentChange = planChange?.currentChange;
  return (
    <div data-testid="a3-notification-learning-loop" className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs leading-5 text-blue-800">
      <div className="font-semibold">连续学习提醒</div>
      <div className="mt-1">{item.learningLoop.reason}</div>
      <div className="mt-1">{item.learningLoop.expectedFeedback}</div>
      {currentChange && (
        <div data-testid="a3-notification-plan-change" className="mt-3 rounded-lg border border-blue-200 bg-white/80 p-2.5 text-blue-900">
          <div className="font-semibold">计划为什么变了</div>
          <div className="mt-1">{currentChange.title}</div>
          {currentChange.detail && <div className="mt-1 text-blue-800">{currentChange.detail}</div>}
          {currentChange.reason && <div className="mt-1 text-blue-700">{currentChange.reason}</div>}
          {planChange?.nextAction?.reason && <div className="mt-1 text-blue-700">{planChange.nextAction.reason}</div>}
        </div>
      )}
    </div>
  );
}

function TeacherNotificationContext({ item }: { item: A3Notification }) {
  if (item.type !== 'teacher' && !item.payload.targetedByTeacher) return null;
  const chips = [
    item.payload.targetedByTeacher ? '教师定向干预' : '教师班级提醒',
    teacherTaskLabel(item),
    teacherTargetLabel(item),
  ].filter(Boolean);

  return (
    <div data-testid="a3-teacher-notification-context" className="mt-3 flex flex-wrap gap-2">
      {chips.map((chip) => (
        <span key={chip} className="rounded-full bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-800">
          {chip}
        </span>
      ))}
    </div>
  );
}

function teacherTaskLabel(item: A3Notification) {
  const taskType = typeof item.payload.taskType === 'string' ? item.payload.taskType : '';
  if (taskType === 'intervention') return '错题复盘';
  if (taskType === 'assessment') return '阶段测评';
  if (taskType === 'report') return '学习报告';
  if (taskType === 'knowledge_base') return '知识库处理';
  if (item.actionUrl.includes('wrong-notebook')) return '错题复盘';
  if (item.actionUrl.includes('assessment')) return '阶段测评';
  if (item.actionUrl.includes('report')) return '学习报告';
  if (item.actionUrl.includes('knowledge-base')) return '知识库处理';
  return '学习计划';
}

function teacherTargetLabel(item: A3Notification) {
  const actionKind = typeof item.payload.actionKind === 'string' ? item.payload.actionKind : '';
  if (actionKind === 'review') return '下一步：复盘错因';
  if (actionKind === 'assessment') return '下一步：完成测评';
  if (actionKind === 'report') return '下一步：查看报告';
  if (actionKind === 'knowledge_base') return '下一步：检查资料';
  return '下一步：回到计划';
}
