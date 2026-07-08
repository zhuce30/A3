import { describe, expect, it } from 'vitest';
import { buildNotificationRhythm } from '@/lib/a3/notification-rhythm';
import type { A3NotificationActionGroup } from '@/lib/a3/engagement-types';

function group(kind: A3NotificationActionGroup['kind'], unread: number, reason: string): A3NotificationActionGroup {
  return {
    kind,
    label: kind,
    count: unread || 1,
    unread,
    description: `${kind} description`,
    primaryAction: { label: kind, href: `/a3/${kind}`, reason },
    learningLoop: {
      schemaVersion: 'a3.notification-loop.v1',
      kind,
      reason: `为什么提醒：${reason}`,
      expectedFeedback: '完成后反馈：状态会同步更新。',
      nextAction: { label: kind, href: `/a3/${kind}` },
    },
    recent: {
      id: `${kind}-1`,
      title: kind,
      detail: reason,
      type: 'learning_task',
      typeLabel: '学习任务',
      unread: unread > 0,
      actionUrl: `/a3/${kind}`,
      payload: { actionKind: kind },
      createdAt: '2026-06-29T00:00:00',
      readAt: null,
    },
    priority: 1,
  };
}

describe('buildNotificationRhythm', () => {
  it('summarizes today, review, and report reminders from action groups', () => {
    const rhythm = buildNotificationRhythm([
      group('review', 2, '有到期错题。'),
      group('today', 1, '今日任务未完成。'),
      group('report', 0, '周报已更新。'),
    ]);

    expect(rhythm).toHaveLength(3);
    expect(rhythm[0]).toMatchObject({ kind: 'today', status: 'pending', href: '/a3/today' });
    expect(rhythm[1]).toMatchObject({ kind: 'review', status: 'pending', unread: 2 });
    expect(rhythm[2]).toMatchObject({ kind: 'report', status: 'ready' });
  });

  it('returns calm defaults when a reminder type has no group', () => {
    const rhythm = buildNotificationRhythm([]);

    expect(rhythm.find((item) => item.kind === 'today')?.status).toBe('quiet');
    expect(rhythm.find((item) => item.kind === 'review')?.reason).toContain('没有');
    expect(rhythm.find((item) => item.kind === 'report')?.href).toBe('/a3/report');
  });
});
