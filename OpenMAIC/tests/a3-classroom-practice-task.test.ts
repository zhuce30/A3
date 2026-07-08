import { describe, expect, it } from 'vitest';

import { buildPracticeSyncEvidence, buildPracticeWritebackPayload, findPracticePlanTaskForRecommendation } from '@/lib/a3/classroom-practice';
import type { StudyPlan } from '@/lib/a3/learning-types';
import type { ClassroomRecommendation } from '@/lib/a3/classroom-types';

const plan = {
  days: [
    {
      dayIndex: 1,
      status: 'today',
      tasks: [
        {
          id: 'task-practice-root-locus',
          type: 'practice',
          title: '反馈控制基本概念',
          subtitle: '完成课堂推荐练习',
          href: '/a3/assessment?practice=反馈控制基本概念',
          estimatedMinutes: 10,
          knowledgePointId: 'kp-1',
          status: 'pending',
        },
      ],
    },
  ],
} as StudyPlan;

describe('findPracticePlanTaskForRecommendation', () => {
  it('maps a classroom recommendation to the matching today practice task', () => {
    const recommendation = {
      title: '反馈控制基本概念',
      meta: '第 1 章 · 控制系统基础 · 难度 1',
      href: '/a3/assessment?practice=反馈控制基本概念',
      progress: 0,
    } satisfies ClassroomRecommendation;

    expect(findPracticePlanTaskForRecommendation(recommendation, plan)).toEqual({
      dayIndex: 1,
      taskId: 'task-practice-root-locus',
      completed: false,
    });
  });

  it('uses explicit backend planTask binding before href title matching', () => {
    const recommendation = {
      title: 'unmatched classroom practice',
      meta: 'backend supplied task binding',
      href: '/a3/assessment?practice=unmatched',
      progress: 0,
      planTask: {
        dayIndex: 2,
        taskId: 'backend-practice-task',
        completed: false,
        status: 'pending',
      },
    } satisfies ClassroomRecommendation;

    expect(findPracticePlanTaskForRecommendation(recommendation, plan)).toEqual({
      dayIndex: 2,
      taskId: 'backend-practice-task',
      completed: false,
    });
    expect(buildPracticeWritebackPayload({ recommendation, plan, graded: true })).toEqual({
      dayIndex: 2,
      taskId: 'backend-practice-task',
    });
  });

  it('does not allow writeback when a recommendation has no mapped plan task', () => {
    const recommendation = {
      title: '稳定性与特征方程',
      meta: '第 3 章 · 难度 3',
      href: '/a3/assessment?practice=稳定性与特征方程',
      progress: 0,
    } satisfies ClassroomRecommendation;

    expect(findPracticePlanTaskForRecommendation(recommendation, plan)).toBeNull();
  });

  it('builds a plan writeback payload only after grading succeeds and a task is mapped', () => {
    const recommendation = {
      title: '反馈控制基本概念',
      meta: '第 1 章 · 控制系统基础 · 难度 1',
      href: '/a3/assessment?practice=反馈控制基本概念',
      progress: 0,
    } satisfies ClassroomRecommendation;

    expect(buildPracticeWritebackPayload({ recommendation, plan, graded: true })).toEqual({
      dayIndex: 1,
      taskId: 'task-practice-root-locus',
    });
    expect(buildPracticeWritebackPayload({ recommendation, plan, graded: false })).toBeNull();
  });

  it('summarizes assessment sync evidence for profile, wrong notebook, report, and plan', () => {
    expect(buildPracticeSyncEvidence({
      feedback: {
        isCorrect: false,
        profileUpdate: { weakPoints: ['根轨迹', '稳定性'] },
        report: {
          metrics: { activeWrongQuestions: 3, accuracy: 72, pathProgress: 41 },
        },
      },
      planFeedback: { headline: '练习已记录' },
    })).toEqual({
      weakPoints: ['根轨迹', '稳定性'],
      wrongNotebookText: '已进入错题本或复习队列',
      reportMetrics: [
        { label: '正确率', value: '72%', available: true },
        { label: '活跃错题', value: '3', available: true },
        { label: '路径进度', value: '41%', available: true },
      ],
      planText: '练习已记录',
    });
  });

  it('does not invent report metrics when the grade response omits them', () => {
    expect(buildPracticeSyncEvidence({
      feedback: {
        isCorrect: true,
        profileUpdate: { weakPoints: [] },
        report: null,
      },
      planFeedback: null,
    })).toEqual({
      weakPoints: [],
      wrongNotebookText: '正确作答，错题本无新增',
      reportMetrics: [
        { label: '正确率', value: '未返回', available: false },
        { label: '活跃错题', value: '未返回', available: false },
        { label: '路径进度', value: '未返回', available: false },
      ],
      planText: '判分已完成，等待计划任务匹配',
    });
  });
});
