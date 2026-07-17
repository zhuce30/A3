import { describe, expect, it } from 'vitest';
import type { LearningReport } from '@/lib/a3/assessment-types';
import type { StudyPlan } from '@/lib/a3/learning-types';
import {
  buildStudentReportViewModel,
  type LearningEffectReport,
} from '@/lib/a3/report-view-model';

function reportFixture(overrides: Partial<LearningReport> = {}): LearningReport {
  return {
    period: { key: '30d', label: '近 30 天', start: '2026-06-18', end: '2026-07-17' },
    metrics: {
      studyMinutes: 240,
      studyDays: 9,
      masteredKnowledgePoints: 4,
      totalKnowledgePoints: 10,
      answeredQuestions: 12,
      accuracy: 75,
      activeWrongQuestions: 2,
      masteredWrongQuestions: 3,
      pathProgress: 40,
    },
    trends: [],
    capabilityAxes: [],
    suggestions: [],
    studentSummary: {
      schemaVersion: 'a3.student-report-summary.v1',
      headline: '答题表现正在改善',
      summary: '近 30 天完成 12 次作答，当前有 2 道错题待巩固。',
      progressSignal: '正确率较上一周期提升 8.3 个百分点',
      primaryRisk: '2 道错题尚未巩固',
      primaryAction: {
        label: '复盘 2 道错题',
        href: '/a3/wrong-notebook',
        estimatedMinutes: 12,
        expectedOutcome: '复盘后重新测评，更新掌握状态。',
      },
      evidence: [],
    },
    comparisons: {
      periodKey: '30d',
      currentWindow: {
        start: '2026-06-18',
        end: '2026-07-17',
        answeredCount: 12,
        correctCount: 9,
        accuracy: 75,
      },
      previousWindow: {
        start: '2026-05-19',
        end: '2026-06-17',
        answeredCount: 12,
        correctCount: 8,
        accuracy: 66.7,
      },
      accuracy: {
        availability: 'available',
        comparable: true,
        currentValue: 75,
        previousValue: 66.7,
        percentagePointChange: 8.3,
        reason: '两个周期样本均达到比较要求。',
      },
    },
    knowledgePointInsights: [
      {
        knowledgePoint: '进程调度',
        answeredCount: 6,
        wrongCount: 2,
        latestResult: 'incorrect',
        activeWrongQuestions: 1,
        status: 'needs_review',
        reason: '当前有 1 道相关错题待巩固。',
        action: { label: '复习相关错题', href: '/a3/wrong-notebook', estimatedMinutes: 12 },
      },
    ],
    dataQuality: {
      evidenceState: 'ready',
      answeredQuestions: 12,
      knowledgePointCount: 1,
      comparisonAvailable: true,
      missingReasons: [],
      lastUpdatedAt: '2026-07-17T10:00:00+08:00',
    },
    updatedAt: '2026-07-17T10:00:00+08:00',
    ...overrides,
  };
}

function studyPlanFixture(): StudyPlan {
  return {
    planId: 'plan-1',
    title: '操作系统 14 天学习计划',
    course: { id: 'course-1', title: '操作系统' },
    durationDays: 14,
    dailyMinutes: 30,
    level: { code: 'developing', label: '发展中', description: '', pathProgress: 40, wrongPressure: 2 },
    generatedAt: '2026-07-17T08:00:00+08:00',
    targetDate: '2026-07-30',
    overallProgress: 35,
    mastery: [],
    reviewQueue: [],
    adjustmentTimeline: [
      {
        id: 'adjustment-1',
        type: 'review',
        title: '增加错题复盘',
        reason: '最近错题仍未巩固。',
        impact: '先复盘再学习新内容。',
        createdAt: '2026-07-17T08:00:00+08:00',
      },
    ],
    coachTip: '先处理错题，再进入新知识点。',
    days: [
      {
        dayIndex: 1,
        date: '2026-07-17',
        title: '第 1 天',
        focus: '进程调度',
        estimatedMinutes: 30,
        status: 'today',
        progress: 0,
        tasks: [
          {
            id: 'task-1',
            type: 'review',
            title: '复盘进程调度错题',
            subtitle: '完成 2 道错题并说明错因',
            href: '/a3/wrong-notebook',
            estimatedMinutes: 15,
            knowledgePointId: 'kp-1',
            status: 'pending',
          },
        ],
      },
      {
        dayIndex: 2,
        date: '2026-07-18',
        title: '第 2 天',
        focus: '处理机调度',
        estimatedMinutes: 25,
        status: 'pending',
        progress: 0,
        tasks: [
          {
            id: 'task-2',
            type: 'learn',
            title: '学习调度算法',
            subtitle: '能比较三种调度算法的适用场景',
            href: '/a3/classroom?task=task-2',
            estimatedMinutes: 25,
            knowledgePointId: 'kp-2',
            status: 'pending',
          },
        ],
      },
    ],
  };
}

const effectFixture: LearningEffectReport = {
  assessment: {
    attemptCount: 8,
    averageScore: 78,
    correctRate: 75,
    wrongQuestionCount: 3,
    reviewedWrongQuestionCount: 2,
  },
  knowledgePoints: [
    {
      knowledgePointId: 'kp-1',
      name: '进程调度',
      preScore: 55,
      postScore: 75,
      learningGain: 20,
      attemptCount: 6,
      correctRate: 75,
      wrongCount: 2,
      reviewCount: 2,
      trend: 'improving',
      confidence: 'high',
    },
  ],
  resourceUsage: { opened: 4, completed: 3, skipped: 0, favorited: 1, totalFeedback: 3 },
  eventStream: { schemaVersion: 'v2', v2EventCount: 20 },
  optimizationPolicy: { selectedStrategy: 'pending', candidates: [{ strategy: 'assessment' }] },
};

describe('buildStudentReportViewModel', () => {
  it('builds a bounded student-facing report from complete evidence', () => {
    const viewModel = buildStudentReportViewModel({
      report: reportFixture(),
      studyPlan: studyPlanFixture(),
      effectReport: effectFixture,
    });

    expect(viewModel.overview.headline).toBe('答题表现正在改善');
    expect(viewModel.overview.primaryAction.href).toBe('/a3/wrong-notebook');
    expect(Object.keys(viewModel.overview).filter((key) => key === 'primaryAction')).toHaveLength(1);
    expect(viewModel.changes.length).toBeLessThanOrEqual(3);
    expect(viewModel.weakKnowledgePoints.length).toBeLessThanOrEqual(3);
    expect(viewModel.sevenDayPlan.title).toBe('从今天开始的 7 天行动');
    expect(viewModel.sevenDayPlan.actions).toHaveLength(2);
    expect(viewModel.effectiveMethods[0]?.evidenceState).toBe('ready');

    const serialized = JSON.stringify(viewModel);
    for (const internalLabel of ['eventStream', 'decisionHistory', 'schemaVersion', 'v2 事件', '候选数', '决策分', 'pending']) {
      expect(serialized).not.toContain(internalLabel);
    }
  });

  it('does not invent percentages or progress for an empty report', () => {
    const viewModel = buildStudentReportViewModel({
      report: reportFixture({
        metrics: {
          studyMinutes: 0,
          studyDays: 0,
          masteredKnowledgePoints: 0,
          totalKnowledgePoints: 0,
          answeredQuestions: 0,
          accuracy: 0,
          activeWrongQuestions: 0,
          masteredWrongQuestions: 0,
          pathProgress: 0,
        },
        studentSummary: undefined,
        comparisons: undefined,
        knowledgePointInsights: [],
        dataQuality: undefined,
      }),
      studyPlan: null,
      effectReport: null,
    });

    expect(viewModel.evidenceState).toBe('insufficient');
    expect(viewModel.overview.headline).toContain('测评');
    expect(viewModel.overview.progressSignal).not.toContain('0%');
    expect(viewModel.changes.every((change) => !change.comparison.includes('提升'))).toBe(true);
  });

  it('explains insufficient comparison samples without calculating a trend', () => {
    const report = reportFixture();
    report.comparisons = {
      ...report.comparisons!,
      accuracy: {
        availability: 'insufficient_sample',
        comparable: false,
        currentValue: 75,
        previousValue: 80,
        percentagePointChange: null,
        reason: '当前周期和上一周期都至少 3 次作答后才能比较。',
      },
    };

    const viewModel = buildStudentReportViewModel({ report, studyPlan: studyPlanFixture() });

    expect(viewModel.changes[0]?.comparison).toContain('样本不足');
    expect(JSON.stringify(viewModel.changes)).not.toContain('下降 5');
  });

  it('uses the saved plan action when there are no active wrong questions', () => {
    const report = reportFixture({
      studentSummary: undefined,
      metrics: { ...reportFixture().metrics, activeWrongQuestions: 0 },
      knowledgePointInsights: [],
    });

    const viewModel = buildStudentReportViewModel({ report, studyPlan: studyPlanFixture() });

    expect(viewModel.overview.primaryAction.href).toBe('/a3/wrong-notebook');
    expect(viewModel.overview.primaryAction.label).toBe('复盘进程调度错题');
  });

  it('offers plan creation when no study plan is available', () => {
    const viewModel = buildStudentReportViewModel({ report: reportFixture(), studyPlan: null });

    expect(viewModel.sevenDayPlan.title).toBe('从今天开始的 7 天行动');
    expect(viewModel.sevenDayPlan.actions[0]?.href).toBe('/a3/study-plan');
    expect(viewModel.sevenDayPlan.actions[0]?.completionCriteria).toContain('生成');
  });

  it('marks learning methods as unassessed when effect evidence is absent', () => {
    const viewModel = buildStudentReportViewModel({ report: reportFixture(), effectReport: null });

    expect(viewModel.effectiveMethods).toHaveLength(1);
    expect(viewModel.effectiveMethods[0]?.evidenceState).toBe('insufficient');
    expect(viewModel.effectiveMethods[0]?.conclusion).toContain('还需要');
    expect(JSON.stringify(viewModel.effectiveMethods)).not.toContain('0%');
  });

  it.each([
    ['7d', '近 7 天'],
    ['30d', '近 30 天'],
    ['term', '本学期'],
  ] as const)('normalizes the %s period label', (key, label) => {
    const viewModel = buildStudentReportViewModel({
      report: reportFixture({ period: { key, start: '2026-07-01', end: '2026-07-17' } }),
    });

    expect(viewModel.period.label).toBe(label);
    expect(viewModel.sevenDayPlan.title).toBe('从今天开始的 7 天行动');
  });
});
