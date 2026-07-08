import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const profileSetup = readFileSync(join(root, 'components/a3/auth/a3-auth-pages.tsx'), 'utf8');
const studyPlan = readFileSync(join(root, 'components/a3/features/study-plan-view.tsx'), 'utf8');
const learningPath = readFileSync(join(root, 'components/a3/features/learning-path-view.tsx'), 'utf8');
const courses = readFileSync(join(root, 'components/a3/features/courses-view.tsx'), 'utf8');

describe('A3 planning workspace personalization', () => {
  it('turns profile setup into a course-aware planning input page without hard-coded automation examples', () => {
    expect(profileSetup).toContain('画像与规划输入');
    expect(profileSetup).toContain('buildProfileInterviewPlaceholder(optionsCourse)');
    expect(profileSetup).toContain('buildProfileInterviewExample(optionsCourse)');
    expect(profileSetup).toContain('data-testid="a3-profile-planning-impact"');
    expect(profileSetup).toContain('interviewResult');
    expect(profileSetup).toContain('dynamicProfile');
    expect(profileSetup).not.toContain('我是自动化大二');
    expect(profileSetup).not.toContain('根轨迹和频率响应比较薄弱');
  });

  it('keeps profile interview message bubbles aligned with the form width', () => {
    expect(profileSetup).toContain("data-testid=\"a3-profile-interview-thread\"");
    expect(profileSetup).toContain("bg-slate-50 p-2");
    expect(profileSetup).toContain("w-full rounded-2xl bg-blue-600");
    expect(profileSetup).toContain("w-full rounded-2xl border border-slate-200");
    expect(profileSetup).not.toContain("sm:ml-4");
    expect(profileSetup).not.toContain("sm:mr-4");
    expect(profileSetup).not.toContain("'ml-8 rounded-2xl bg-blue-600");
    expect(profileSetup).not.toContain("'mr-8 rounded-2xl border border-slate-200");
  });

  it('makes study plan the planning hub driven by planContext, profile, path, and today bindings', () => {
    expect(studyPlan).toContain('data-testid="a3-study-plan-hub"');
    expect(studyPlan).toContain('plan?.course');
    expect(studyPlan).toContain('planContext?.learningPath.currentItem');
    expect(studyPlan).toContain('explanation?.profileSignals');
    expect(studyPlan).toContain('weakMastery');
    expect(studyPlan).toContain('todayBindings');
    expect(studyPlan).toContain('后台协作');
    expect(studyPlan).toContain('planContext?.agentRoles');
  });

  it('renders learning path as a personalized map with evidence and next actions per node', () => {
    expect(learningPath).toContain('个性化路径地图');
    expect(learningPath).toContain('data-testid="a3-learning-path-node-evidence"');
    expect(learningPath).toContain('path?.rationale');
    expect(learningPath).toContain('plan?.planContext?.todayBindings');
    expect(learningPath).toContain('AgentDecisionEvidence');
    expect(learningPath).toContain('DiagnosticAgent');
    expect(learningPath).toContain('ProfileAgent');
  });

  it('makes courses a course-learning entry centered on the current path node', () => {
    expect(courses).toContain('课程学习入口');
    expect(courses).toContain('/api/learning/study-plan/?auto=1');
    expect(courses).toContain('/api/learning/paths/current/');
    expect(courses).toContain('currentPathItem');
    expect(courses).toContain('当前该学');
    expect(courses).toContain('课程入口决策证据');
    expect(courses).toContain('AgentDecisionEvidence');
    expect(courses).toContain('/a3/classroom');
    expect(courses).toContain('/a3/assessment');
  });
});
