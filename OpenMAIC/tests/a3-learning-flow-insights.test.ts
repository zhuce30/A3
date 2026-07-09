import { describe, expect, it } from 'vitest';

import {
  buildClassroomContextInsight,
  buildProfileChangeInsight,
  buildRecommendationEffectInsight,
  buildStudyPlanFlowInsights,
  buildTodayFlowInsights,
} from '@/lib/a3/learning-flow-insights';
import type { A3Recommendation } from '@/lib/a3/recommendation-types';
import type { StudyPlan } from '@/lib/a3/learning-types';

const basePlan: StudyPlan = {
  planId: 'plan-1',
  title: '操作系统冲刺计划',
  course: { id: 'os', title: '操作系统' },
  durationDays: 14,
  dailyMinutes: 45,
  level: { code: 'standard', label: '标准', description: '标准节奏', pathProgress: 30, wrongPressure: 2 },
  generatedAt: '2026-07-08T00:00:00Z',
  targetDate: '2026-07-21',
  overallProgress: 30,
  mastery: [],
  reviewQueue: [],
  coachTip: '先补进程同步',
  days: [
    {
      dayIndex: 1,
      date: '2026-07-08',
      title: '第 1 天',
      focus: '进程同步',
      estimatedMinutes: 45,
      status: 'today',
      progress: 0,
      tasks: [
        {
          id: 'task-1',
          type: 'practice',
          title: '进程同步专项练习',
          subtitle: '完成 8 道互斥与信号量题目',
          href: '/a3/assessment',
          estimatedMinutes: 20,
          knowledgePointId: 'kp-sync',
          status: 'pending',
          reason: '最近错题集中在进程同步',
        },
      ],
    },
  ],
  planContext: {
    schemaVersion: 'a3.study-plan-context.v1',
    relationship: {
      path: '学习路径决定知识点顺序',
      plan: '学习计划把路径排到日期',
      today: '今日只执行当前任务',
      writeback: '完成后写回路径和报告',
    },
    learningPath: {
      source: 'active_learning_path',
      id: 'path-1',
      version: 1,
      progress: 30,
      totalItems: 10,
      completedItems: 3,
      currentItem: {
        pathItemId: 'path-item-4',
        knowledgePointId: 'kp-sync',
        title: '进程同步与互斥',
        chapter: '进程管理',
        order: 4,
        status: 'current',
        progress: 35,
        estimatedMinutes: 60,
        reason: '诊断显示进程同步薄弱',
      },
    },
    todayBindings: [
      {
        taskId: 'task-1',
        taskType: 'practice',
        title: '进程同步专项练习',
        knowledgePointId: 'kp-sync',
        pathItemId: 'path-item-4',
        pathStatus: 'current',
        pathProgress: 35,
        chapter: '进程管理',
        writeback: '完成后更新路径掌握度',
      },
    ],
    durationOptions: [],
    agentRoles: [],
  },
};

describe('learning flow insights', () => {
  it('explains why today changed from learning effect evidence', () => {
    const insights = buildTodayFlowInsights({
      plan: {
        ...basePlan,
        lastLearningEffectAdjustment: {
          strategy: 'add_spaced_review',
          reason: '7 天窗口内同类错题仍在重复出现',
          evidence: { confidence: 'high', riskLevel: 'medium', effectScore: 62, targetKnowledgePointId: 'kp-sync' },
          action: { type: 'add_task', taskType: 'review', title: '进程同步错题复盘', estimatedMinutes: 12 },
          taskId: 'review-1',
          applied: true,
        },
      },
      today: basePlan.days[0],
    });

    expect(insights[0]).toMatchObject({
      title: '今天加了一次复习',
      href: '/a3/wrong-notebook',
      tone: 'orange',
    });
    expect(insights[0].detail).toContain('7 天窗口');
    expect(insights.some((item) => item.title.includes('进程同步专项练习'))).toBe(true);
  });

  it('turns resource feedback into a student-facing plan insight', () => {
    const insights = buildStudyPlanFlowInsights({
      plan: {
        ...basePlan,
        lastResourceFeedbackAdjustment: {
          strategy: 'increase_practice',
          reason: '练习集完成率高，后续继续安排同类资源',
          evidence: { averageFeedbackScore: 4.6, completed: 5, opened: 6, latestGoal: '进程同步' },
          nextAction: { label: '继续专项练习', href: '/a3/assessment' },
        },
      },
    });

    expect(insights[0].title).toBe('计划参考了你的资源反馈');
    expect(insights[0].detail).toContain('进程同步');
    expect(insights[0].meta).toContain('评分 4.6');
    expect(insights[0].href).toBe('/a3/assessment');
  });

  it('summarizes recommendation effect attribution without exposing raw internals', () => {
    const recommendation = {
      id: 'r1',
      rank: 1,
      title: '信号量例题讲解',
      type: 'practice_set',
      score: 91,
      reason: '匹配当前薄弱点',
      href: '/a3/resources/1',
      citation: null,
      evidence: {
        profileMatch: { matched: true, signals: ['薄弱点：进程同步'], reason: '匹配画像' },
        rankingBasis: [],
        sourceEvidence: null,
        fallback: false,
        resourceEffect: {
          resourceType: 'practice_set',
          historicalEffectiveness: 0.78,
          effectConfidence: 'medium',
          explorationRecommended: false,
          completed: 4,
          opened: 5,
          postAssessmentGain: 0.12,
        },
      },
    } satisfies A3Recommendation;

    const insight = buildRecommendationEffectInsight(recommendation);

    expect(insight.label).toBe('历史有效性');
    expect(insight.detail).toContain('78%');
    expect(insight.detail).toContain('中等置信度');
    expect(insight.detail).not.toContain('historicalEffectiveness');
  });

  it('explains classroom context from current path and today task', () => {
    const insight = buildClassroomContextInsight({ plan: basePlan });

    expect(insight.title).toBe('课堂会围绕进程同步与互斥展开');
    expect(insight.detail).toContain('进程同步专项练习');
    expect(insight.evidence).toContain('当前路径节点');
  });
  it('summarizes pending profile changes for normal learning pages', () => {
    const insight = buildProfileChangeInsight({
      success: true,
      confirmationQueue: [{
        id: 'puc-1',
        changedDimensions: ['weakPoints'],
        previousValue: ['根轨迹'],
        nextValue: ['根轨迹', '虚拟内存'],
        source: 'assessment',
        confidence: 0.88,
        status: 'pending',
      }],
      timeline: [],
    });

    expect(insight).toMatchObject({
      title: '画像有 1 条变化待确认',
      href: '/a3/profile-setup',
      tone: 'orange',
    });
    expect(insight?.detail).toContain('薄弱点');
  });
});
