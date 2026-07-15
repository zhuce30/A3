import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { a3GetActiveNavHref, a3NavItems } from '@/lib/a3/navigation';

const root = process.cwd();
const todayView = readFileSync(join(root, 'components/a3/features/today-learning-view.tsx'), 'utf8');
const studyPlanView = readFileSync(join(root, 'components/a3/features/study-plan-view.tsx'), 'utf8');
const assessmentView = readFileSync(join(root, 'components/a3/features/assessment-view.tsx'), 'utf8');
const classroomView = readFileSync(join(root, 'components/a3/features/classroom-view.tsx'), 'utf8');
const knowledgeBaseView = readFileSync(join(root, 'components/a3/features/knowledge-base-view.tsx'), 'utf8');

describe('A3 student navigation consolidation', () => {
  it('keeps the student sidebar focused on six primary learning jobs', () => {
    expect(a3NavItems.filter((item) => !item.roles).map((item) => [item.href, item.label])).toEqual([
      ['/a3/today', '今日学习'],
      ['/a3/study-plan', '学习规划'],
      ['/a3/assessment', '练习复盘'],
      ['/a3/classroom', 'AI 学习'],
      ['/a3/knowledge-base', '知识库'],
      ['/a3/report', '学习报告'],
    ]);
  });

  it('puts secondary pages directly under their owning primary sidebar items', () => {
    const studentGroups = Object.fromEntries(
      a3NavItems
        .filter((item) => !item.roles)
        .map((item) => [item.href, (item.children ?? []).map((child) => [child.href, child.label])]),
    );

    expect(studentGroups['/a3/today']).toEqual([
      ['/a3/dashboard', '首页'],
      ['/a3/notifications', '通知消息'],
    ]);
    expect(studentGroups['/a3/study-plan']).toEqual([
      ['/a3/admission-diagnostic', '入学诊断'],
      ['/a3/profile-setup', '学习画像'],
      ['/a3/learning-path', '学习路径'],
      ['/a3/courses', '课程学习'],
    ]);
    expect(studentGroups['/a3/assessment']).toEqual([
      ['/a3/wrong-notebook', '错题本'],
    ]);
    expect(studentGroups['/a3/classroom']).toEqual([
      ['/a3/coaching', '面对面辅导'],
      ['/a3/recommendations', '资源包生成'],
      ['/a3/library', '系统资料'],
      ['/a3/resources', '资源记录'],
      ['/a3/favorites', '我的收藏'],
    ]);
    expect(studentGroups['/a3/knowledge-base']).toEqual([
      ['/a3/knowledge-graph', '知识图谱'],
    ]);
    expect(studentGroups['/a3/report']).toEqual([]);
  });

  it('removes secondary, demo, and personal utility pages from the student sidebar', () => {
    const studentHrefs = a3NavItems.filter((item) => !item.roles).map((item) => item.href);

    expect(studentHrefs).not.toContain('/a3/dashboard');
    expect(studentHrefs).not.toContain('/a3/admission-diagnostic');
    expect(studentHrefs).not.toContain('/a3/demo-flow');
    expect(studentHrefs).not.toContain('/a3/capabilities');
    expect(studentHrefs).not.toContain('/a3/learning-path');
    expect(studentHrefs).not.toContain('/a3/courses');
    expect(studentHrefs).not.toContain('/a3/knowledge-graph');
    expect(studentHrefs).not.toContain('/a3/recommendations');
    expect(studentHrefs).not.toContain('/a3/library');
    expect(studentHrefs).not.toContain('/a3/resources');
    expect(studentHrefs).not.toContain('/a3/wrong-notebook');
    expect(studentHrefs).not.toContain('/a3/coaching');
    expect(studentHrefs).not.toContain('/a3/favorites');
    expect(studentHrefs).not.toContain('/a3/notifications');
    expect(studentHrefs).not.toContain('/a3/settings');
  });

  it('highlights the owning primary nav item when a secondary page is open', () => {
    expect(a3GetActiveNavHref('/a3/dashboard')).toBe('/a3/today');
    expect(a3GetActiveNavHref('/a3/notifications')).toBe('/a3/today');
    expect(a3GetActiveNavHref('/a3/admission-diagnostic')).toBe('/a3/study-plan');
    expect(a3GetActiveNavHref('/a3/profile-setup')).toBe('/a3/study-plan');
    expect(a3GetActiveNavHref('/a3/learning-path')).toBe('/a3/study-plan');
    expect(a3GetActiveNavHref('/a3/courses')).toBe('/a3/study-plan');
    expect(a3GetActiveNavHref('/a3/wrong-notebook')).toBe('/a3/assessment');
    expect(a3GetActiveNavHref('/a3/coaching')).toBe('/a3/classroom');
    expect(a3GetActiveNavHref('/a3/recommendations')).toBe('/a3/classroom');
    expect(a3GetActiveNavHref('/a3/library/OS-DOC-001')).toBe('/a3/classroom');
    expect(a3GetActiveNavHref('/a3/resources/demo-pack')).toBe('/a3/classroom');
    expect(a3GetActiveNavHref('/a3/favorites')).toBe('/a3/classroom');
    expect(a3GetActiveNavHref('/a3/knowledge-graph')).toBe('/a3/knowledge-base');
  });

  it('surfaces hidden pages as visible secondary actions inside their owning primary pages', () => {
    expect(todayView).toContain('href="/a3/dashboard"');
    expect(todayView).toContain('href="/a3/notifications"');

    expect(studyPlanView).toContain('href="/a3/admission-diagnostic"');
    expect(studyPlanView).toContain('href="/a3/profile-setup"');
    expect(studyPlanView).toContain('href="/a3/learning-path"');
    expect(studyPlanView).toContain('href="/a3/courses"');

    expect(assessmentView).toContain('href="/a3/wrong-notebook"');

    expect(classroomView).toContain('href="/a3/coaching"');
    expect(classroomView).toContain('href="/a3/recommendations"');
    expect(classroomView).toContain('href="/a3/favorites"');

    expect(knowledgeBaseView).toContain('href="/a3/knowledge-graph"');
  });
});
