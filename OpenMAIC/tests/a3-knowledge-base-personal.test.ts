import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const knowledgeBaseViewPath = path.resolve(process.cwd(), 'components/a3/features/knowledge-base-view.tsx');
const classroomViewPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');
const studyPlanViewPath = path.resolve(process.cwd(), 'components/a3/features/study-plan-view.tsx');
const recommendationsViewPath = path.resolve(process.cwd(), 'components/a3/features/recommendations-view.tsx');

describe('A3 student personal knowledge base UI', () => {
  it('lets students upload personal materials and separates resource scopes', () => {
    const source = fs.readFileSync(knowledgeBaseViewPath, 'utf8');

    expect(source).toContain("type ResourceScope = 'personal' | 'teacher' | 'class' | 'global'");
    expect(source).toContain("label: '我的资料'");
    expect(source).toContain("label: '教师资料'");
    expect(source).toContain("label: '全局资料'");
    expect(source).toContain("scope: uploadScope");
    expect(source).toContain('上传我的资料');
    expect(source).toContain('data-testid="a3-kb-scope-tabs"');
    expect(source).toContain('PersonalMaterialAgent');
  });

  it('renders classroom citations with sourceScope labels', () => {
    const source = fs.readFileSync(classroomViewPath, 'utf8');

    expect(source).toContain('sourceScope?: string');
    expect(source).toContain('function CitationScopePill');
    expect(source).toContain("citation.sourceScope === 'personal'");
    expect(source).toContain('我的资料');
  });

  it('surfaces personal material tasks in the study plan', () => {
    const source = fs.readFileSync(studyPlanViewPath, 'utf8');

    expect(source).toContain("task.source === 'personal_material'");
    expect(source).toContain('来自我的资料');
    expect(source).toContain('sourceResourceName');
  });

  it('formats recommendation citations with sourceScope', () => {
    const source = fs.readFileSync(recommendationsViewPath, 'utf8');

    expect(source).toContain('function formatSourceOrigin');
    expect(source).toContain("source.sourceScope === 'personal'");
    expect(source).toContain('我的资料');
  });
});
