import { describe, expect, it } from 'vitest';
import { buildTeacherResourcePackFilter } from '@/lib/a3/teacher-resource-pack-filter';
import type { TeacherWorkbenchStudent } from '@/lib/a3/teacher-types';

function student(id: string, totalRuns: number): TeacherWorkbenchStudent {
  return {
    id,
    name: `学生${id}`,
    grade: '大二',
    majorDirection: '自动化',
    progress: 50,
    currentPoint: '根轨迹',
    wrongSignal: 0,
    riskLevel: 'medium',
    resourcePack: {
      totalRuns,
      verifiedSourceCount: totalRuns * 2,
      practiceStartedCount: totalRuns,
      latestGoal: totalRuns ? '根轨迹专项' : '',
      latestAt: '',
      nextAction: {
        label: totalRuns ? '推送专项练习' : '推送推荐资源',
        href: totalRuns ? '/a3/assessment' : '/a3/recommendations',
        type: totalRuns ? 'assessment' : 'notification',
      },
    },
  };
}

describe('buildTeacherResourcePackFilter', () => {
  it('filters students who have not converted a resource pack', () => {
    const result = buildTeacherResourcePackFilter([student('1', 0), student('2', 2), student('3', 0)], 'unconverted');

    expect(result.students.map((item) => item.id)).toEqual(['1', '3']);
    expect(result.counts).toEqual({ all: 3, unconverted: 2, converted: 1 });
    expect(result.emptyText).toContain('未完成资源包');
  });

  it('filters converted students', () => {
    const result = buildTeacherResourcePackFilter([student('1', 0), student('2', 2)], 'converted');

    expect(result.students.map((item) => item.id)).toEqual(['2']);
    expect(result.emptyText).toContain('已转化');
  });
});
