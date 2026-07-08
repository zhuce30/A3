import { describe, expect, it } from 'vitest';
import { buildLearningReportCsv } from '@/lib/a3/report-export';
import type { LearningReport } from '@/lib/a3/assessment-types';

const baseReport: LearningReport = {
  period: { start: '2026-06-24', end: '2026-06-30' },
  metrics: {
    studyMinutes: 180,
    studyDays: 5,
    masteredKnowledgePoints: 8,
    totalKnowledgePoints: 12,
    answeredQuestions: 20,
    accuracy: 85,
    activeWrongQuestions: 3,
    masteredWrongQuestions: 2,
    pathProgress: 67,
  },
  trends: [],
  capabilityAxes: [],
  suggestions: [],
  wrongReviewInsight: {
    schemaVersion: 'a3.wrong-review-insight.v1',
    headline: '错题复盘仍是当前优先项',
    summary: '当前还有 3 道待巩固错题，已掌握 2 道。',
    activeWrongQuestions: 3,
    masteredWrongQuestions: 2,
    recentKnowledgePoints: ['根轨迹', '奈奎斯特稳定判据'],
    nextAction: {
      label: '进入错题本',
      href: '/a3/wrong-notebook',
      reason: '先处理错因，再进入新内容。',
    },
  },
  updatedAt: '2026-06-30T10:00:00+08:00',
};

describe('buildLearningReportCsv', () => {
  it('exports wrong review insight for offline reports', () => {
    const csv = buildLearningReportCsv(baseReport);

    expect(csv).toContain('错题复盘洞察');
    expect(csv).toContain('错题复盘结论,错题复盘仍是当前优先项');
    expect(csv).toContain('错题复盘说明,当前还有 3 道待巩固错题，已掌握 2 道。');
    expect(csv).toContain('待巩固错题,3');
    expect(csv).toContain('已掌握错题,2');
    expect(csv).toContain('最近错题知识点,根轨迹 / 奈奎斯特稳定判据');
    expect(csv).toContain('错题复盘下一步,进入错题本');
    expect(csv).toContain('错题复盘下一步原因,先处理错因，再进入新内容。');
  });

  it('exports resource pack conversion metrics when report includes resourcePackEffect', () => {
    const csv = buildLearningReportCsv({
      ...baseReport,
      resourcePackEffect: {
        schemaVersion: 'a3.resource-pack-effect.v1',
        totalRuns: 2,
        verifiedSourceCount: 5,
        practiceStartedCount: 1,
        conversionRate: 50,
        latestRun: {
          taskId: 'resource-pack-1',
          learningGoal: '根轨迹专项突破',
          verifiedSourceCount: 3,
          confidence: 'high',
          practiceHref: '/a3/assessment?practice=1',
          completedAt: '2026-06-30T09:00:00+08:00',
          nextStepReason: '进入专项测评确认掌握度',
        },
        recentRuns: [],
        conversionMessage: '已完成 2 次推荐资源包，其中 1 次进入专项练习。',
        nextAction: {
          label: '继续专项练习',
          href: '/a3/assessment',
          reason: '用测评结果反哺错题本和画像。',
        },
      },
    });

    expect(csv).toContain('资源包闭环率（%）,50');
    expect(csv).toContain('完成资源包次数,2');
    expect(csv).toContain('资源包验证来源数,5');
    expect(csv).toContain('资源包专项练习次数,1');
    expect(csv).toContain('最近资源包目标,根轨迹专项突破');
    expect(csv).toContain('资源包下一步,继续专项练习');
  });

  it('exports weekly prescription diagnosis fields', () => {
    const csv = buildLearningReportCsv({
      ...baseReport,
      weeklyPrescription: {
        weeklyTarget: { label: '完成 5 个任务', current: 3, target: 5, progress: 60, reason: '本周有顺延任务' },
        diagnosis: {
          headline: '错题压力是下周优先风险',
          summary: '当前待巩固错题会影响新知识吸收。',
          evidence: ['计划完成率 60%', '任务完成 3/5', '待巩固错题 3 道', '测评正确率 85%'],
        },
        focusAreas: [],
        completionCriteria: [],
        primaryAction: { label: '先复盘错题', href: '/a3/wrong-notebook', reason: '错题影响后续知识吸收。' },
        nextWeekActions: [],
      },
    });

    expect(csv).toContain('学情诊断');
    expect(csv).toContain('诊断结论,错题压力是下周优先风险');
    expect(csv).toContain('诊断说明,当前待巩固错题会影响新知识吸收。');
    expect(csv).toContain('诊断依据1,计划完成率 60%');
    expect(csv).toContain('诊断依据4,测评正确率 85%');
    expect(csv).toContain('下周首要行动,先复盘错题');
    expect(csv).toContain('行动理由,错题影响后续知识吸收。');
  });

  it('escapes commas and quotes in csv cells', () => {
    const csv = buildLearningReportCsv({
      ...baseReport,
      resourcePackEffect: {
        schemaVersion: 'a3.resource-pack-effect.v1',
        totalRuns: 1,
        verifiedSourceCount: 1,
        practiceStartedCount: 0,
        conversionRate: 0,
        latestRun: null,
        recentRuns: [],
        conversionMessage: '需要补充 "资源包,练习" 闭环',
        nextAction: {
          label: '去推荐页',
          href: '/a3/recommendations',
          reason: '先把推荐资源加入今日任务。',
        },
      },
    });

    expect(csv).toContain('资源包转化说明,"需要补充 ""资源包,练习"" 闭环"');
  });

  it('exports recent resource pack run rows as an evidence chain', () => {
    const csv = buildLearningReportCsv({
      ...baseReport,
      resourcePackEffect: {
        schemaVersion: 'a3.resource-pack-effect.v1',
        totalRuns: 2,
        verifiedSourceCount: 4,
        practiceStartedCount: 2,
        conversionRate: 100,
        latestRun: null,
        recentRuns: [
          {
            runId: 'run-1',
            taskId: 'task-1',
            taskTitle: '推荐资源包一',
            learningGoal: '根轨迹专项突破',
            verifiedSourceCount: 2,
            confidence: 'high',
            practiceHref: '/a3/assessment?practice=1&focus=root',
            source: 'recommendation',
            completedAt: '2026-06-30T09:00:00+08:00',
            nextStepReason: '完成资源包后进入专项练习',
          },
          {
            runId: 'run-2',
            taskId: 'task-2',
            learningGoal: '频域稳定性复习',
            verifiedSourceCount: 2,
            confidence: 'medium',
            practiceHref: '/a3/assessment?practice=1&focus=frequency',
            completedAt: '2026-06-29T20:00:00+08:00',
          },
        ],
        conversionMessage: '资源包已形成练习闭环。',
        nextAction: {
          label: '查看专项练习',
          href: '/a3/assessment',
          reason: '继续用测评验证资源包效果。',
        },
      },
    });

    expect(csv).toContain('资源包运行明细');
    expect(csv).toContain('序号,任务ID,任务标题,学习目标,验证来源数,置信度,来源,完成时间,练习入口,下一步理由');
    expect(csv).toContain('1,task-1,推荐资源包一,根轨迹专项突破,2,high,recommendation,2026-06-30T09:00:00+08:00,/a3/assessment?practice=1&focus=root,完成资源包后进入专项练习');
    expect(csv).toContain('2,task-2,暂无,频域稳定性复习,2,medium,resource_pack,2026-06-29T20:00:00+08:00,/a3/assessment?practice=1&focus=frequency,继续专项练习，把资源包学习转化为测评反馈。');
  });
});
