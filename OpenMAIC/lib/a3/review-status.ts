export type ReviewStatusTone = 'green' | 'orange' | 'red' | 'slate';

export type ReviewStatusInput = {
  mastered?: boolean;
  reviewAfter?: string | null;
  status?: 'due' | 'scheduled' | 'mastered';
};

export type ReviewStatusMeta = {
  label: string;
  tone: ReviewStatusTone;
  priority: number;
  description: string;
};

export function getReviewStatusMeta(item: ReviewStatusInput, now = new Date()): ReviewStatusMeta {
  if (item.mastered || item.status === 'mastered') {
    return {
      label: '已掌握',
      tone: 'green',
      priority: 3,
      description: '该错题已完成巩固，不再进入复习队列。',
    };
  }

  if (item.status === 'due') {
    return {
      label: '今日到期',
      tone: 'orange',
      priority: 1,
      description: '今天需要完成复习，处理错因后再进入新内容。',
    };
  }

  if (!item.reviewAfter) {
    return {
      label: '今日到期',
      tone: 'orange',
      priority: 1,
      description: '尚未设置复习时间，建议现在处理。',
    };
  }

  const reviewAt = new Date(item.reviewAfter);
  if (Number.isNaN(reviewAt.getTime())) {
    return {
      label: '待确认',
      tone: 'slate',
      priority: 2,
      description: '复习时间需要重新生成计划后确认。',
    };
  }

  const reviewDay = startOfLocalDay(reviewAt).getTime();
  const today = startOfLocalDay(now).getTime();
  if (reviewDay < today) {
    return {
      label: '已逾期',
      tone: 'red',
      priority: 0,
      description: '复习已经逾期，建议优先处理。',
    };
  }
  if (reviewDay === today) {
    return {
      label: '今日到期',
      tone: 'orange',
      priority: 1,
      description: '今天需要完成复习，处理错因后再进入新内容。',
    };
  }
  return {
    label: '待到期',
    tone: 'slate',
    priority: 2,
    description: '该错题已排入后续间隔复习。',
  };
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}
