import { describe, expect, it } from 'vitest';
import { getReviewStatusMeta } from '@/lib/a3/review-status';

describe('getReviewStatusMeta', () => {
  const now = new Date('2026-06-29T10:00:00+08:00');

  it('marks mastered items as completed', () => {
    expect(getReviewStatusMeta({ mastered: true, reviewAfter: now.toISOString() }, now)).toMatchObject({
      label: '已掌握',
      tone: 'green',
      priority: 3,
    });
  });

  it('marks overdue review items before today', () => {
    expect(getReviewStatusMeta({ mastered: false, reviewAfter: '2026-06-28T09:00:00+08:00' }, now)).toMatchObject({
      label: '已逾期',
      tone: 'red',
      priority: 0,
    });
  });

  it('marks same-day review items as due today', () => {
    expect(getReviewStatusMeta({ mastered: false, reviewAfter: '2026-06-29T18:00:00+08:00' }, now)).toMatchObject({
      label: '今日到期',
      tone: 'orange',
      priority: 1,
    });
  });

  it('marks future review items as scheduled', () => {
    expect(getReviewStatusMeta({ mastered: false, reviewAfter: '2026-07-01T09:00:00+08:00' }, now)).toMatchObject({
      label: '待到期',
      tone: 'slate',
      priority: 2,
    });
  });
});
