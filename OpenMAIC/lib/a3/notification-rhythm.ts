import type { A3NotificationActionGroup, A3NotificationActionKind } from './engagement-types';

export type NotificationRhythmItem = {
  kind: Extract<A3NotificationActionKind, 'today' | 'review' | 'report'>;
  label: string;
  status: 'pending' | 'ready' | 'quiet';
  unread: number;
  href: string;
  reason: string;
  expectedFeedback: string;
};

const DEFAULTS: NotificationRhythmItem[] = [
  {
    kind: 'today',
    label: '今日学习提醒',
    status: 'quiet',
    unread: 0,
    href: '/a3/today',
    reason: '当前没有新的今日任务提醒。',
    expectedFeedback: '完成任务后会同步学习计划、报告和通知状态。',
  },
  {
    kind: 'review',
    label: '错题复盘提醒',
    status: 'quiet',
    unread: 0,
    href: '/a3/wrong-notebook',
    reason: '当前没有到期错题提醒。',
    expectedFeedback: '重练后会更新掌握状态和下次复习时间。',
  },
  {
    kind: 'report',
    label: '报告回流提醒',
    status: 'quiet',
    unread: 0,
    href: '/a3/report',
    reason: '当前没有新的报告回流提醒。',
    expectedFeedback: '查看报告后可继续进入今日任务、错题复盘或计划调整。',
  },
];

export function buildNotificationRhythm(groups: A3NotificationActionGroup[]): NotificationRhythmItem[] {
  return DEFAULTS.map((item) => {
    const group = groups.find((entry) => entry.kind === item.kind);
    if (!group) return item;
    return {
      ...item,
      status: group.unread > 0 ? 'pending' : 'ready',
      unread: group.unread,
      href: group.primaryAction.href || item.href,
      reason: group.learningLoop?.reason ?? group.primaryAction.reason ?? group.description,
      expectedFeedback: group.learningLoop?.expectedFeedback ?? item.expectedFeedback,
    };
  });
}
