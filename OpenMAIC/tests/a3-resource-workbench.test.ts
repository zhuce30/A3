import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const standalonePath = path.join(root, 'components/a3/features/resource-standalone-view.tsx');
const workbenchRoot = path.join(root, 'components/a3/features/resource-workbench');

function read(file: string) {
  return fs.readFileSync(file, 'utf8');
}

describe('A3 professional resource workbenches', () => {
  it('delegates the three interactive resource types to dedicated workbenches', () => {
    const source = read(standalonePath);

    expect(source).toContain("from './resource-workbench/practice-set-workbench'");
    expect(source).toContain("from './resource-workbench/case-study-workbench'");
    expect(source).toContain("from './resource-workbench/code-lab-workbench'");
    expect(source).toContain('<PracticeSetWorkbench');
    expect(source).toContain('<CaseStudyWorkbench');
    expect(source).toContain('<CodeLabWorkbench');
  });

  it('uses a balanced desktop shell with a sticky learning rail', () => {
    const shell = read(path.join(workbenchRoot, 'resource-workbench-shell.tsx'));
    const rail = read(path.join(workbenchRoot, 'resource-learning-rail.tsx'));

    expect(shell).toContain('xl:grid-cols-[minmax(0,1fr)_320px]');
    expect(shell).toContain('xl:sticky');
    expect(shell).toContain('xl:top-24');
    expect(rail).toContain('学习进度');
    expect(rail).toContain('资料证据');
  });

  it('reveals practice feedback only after the current question is submitted', () => {
    const source = read(path.join(workbenchRoot, 'practice-set-workbench.tsx'));

    expect(source).toContain('submittedQuestionIds');
    expect(source).toContain('submitCurrentQuestion');
    expect(source).toContain('isCurrentQuestionSubmitted');
    expect(source).toContain('提交本题');
    expect(source).toContain('常见错因');
    expect(source).toContain('其他选项为什么不对');
  });

  it('keeps expert case analysis locked until the learner submits a judgment', () => {
    const source = read(path.join(workbenchRoot, 'case-study-workbench.tsx'));

    expect(source).toContain('judgmentSubmitted');
    expect(source).toContain('submitJudgment');
    expect(source).toContain('提交判断并查看专家拆解');
    expect(source).toContain('专家拆解');
    expect(source).toContain('评价标准');
  });

  it('places the code editor and runner result side by side on desktop', () => {
    const source = read(path.join(workbenchRoot, 'code-lab-workbench.tsx'));

    expect(source).toContain('lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,.85fr)]');
    expect(source).toContain('代码编辑器');
    expect(source).toContain('运行与判题');
    expect(source).toContain('/code-lab/run/');
  });

  it('normalizes legacy resources before rendering interactive workbenches', () => {
    const source = read(path.join(workbenchRoot, 'resource-workbench-utils.ts'));

    expect(source).toContain('normalizePracticeQuestions');
    expect(source).toContain('normalizeCaseStudy');
    expect(source).toContain('normalizeCodeLab');
    expect(source).toContain('safeWorkbenchText');
  });
});
