import { describe, expect, it } from 'vitest';
import { buildWeaknessTrendItems } from '@/lib/a3/report-weakness-trends';
import type { LearningReport } from '@/lib/a3/assessment-types';

const baseReport: LearningReport = {
  period: { start: '2026-06-01', end: '2026-06-29' },
  metrics: {
    studyMinutes: 120,
    studyDays: 5,
    masteredKnowledgePoints: 3,
    totalKnowledgePoints: 10,
    answeredQuestions: 12,
    accuracy: 62,
    activeWrongQuestions: 4,
    masteredWrongQuestions: 2,
    pathProgress: 30,
  },
  trends: [
    { label: '06.01-06.07', questions: 3, accuracy: 75 },
    { label: '06.08-06.14', questions: 3, accuracy: 70 },
    { label: '06.15-06.21', questions: 3, accuracy: 68 },
    { label: '06.22-06.28', questions: 3, accuracy: 62 },
  ],
  capabilityAxes: [
    { label: '知识掌握', value: 62 },
    { label: '学习进度', value: 30 },
    { label: '答题稳定性', value: 50 },
    { label: '持续学习', value: 72 },
  ],
  suggestions: [],
  weeklyPrescription: {
    weeklyTarget: { label: '下周完成学习任务', current: 2, target: 4, progress: 50, reason: '需要先稳定节奏。' },
    diagnosis: { headline: '错题压力偏高', summary: '先处理错因。', evidence: ['活跃错题 4 道'] },
    focusAreas: [
      { title: '根轨迹判读', reason: '错题集中在根轨迹渐近线。', href: '/a3/wrong-notebook', priority: 'high' },
      { title: '频域分析', reason: '需要补充伯德图判读。', href: '/a3/learning-path', priority: 'medium' },
    ],
    completionCriteria: [],
    primaryAction: { label: '先复盘错题', href: '/a3/wrong-notebook', reason: '错题会影响新知识吸收。' },
    nextWeekActions: [],
  },
  updatedAt: '2026-06-29T00:00:00',
};

describe('buildWeaknessTrendItems', () => {
  it('prioritizes high-priority focus areas and declining accuracy', () => {
    const items = buildWeaknessTrendItems(baseReport);

    expect(items[0]).toMatchObject({
      title: '根轨迹判读',
      status: 'worsening',
      href: '/a3/wrong-notebook',
    });
    expect(items[0].evidence).toContain('正确率较上周下降');
    expect(items[0].nextAction).toContain('错题本');
  });

  it('adds capability-axis risks when no focus areas are available', () => {
    const report = { ...baseReport, weeklyPrescription: undefined };

    const items = buildWeaknessTrendItems(report);

    expect(items.some((item) => item.title === '学习进度')).toBe(true);
    expect(items.find((item) => item.title === '答题稳定性')?.status).toBe('watch');
  });
});
