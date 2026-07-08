import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const learningTypes = readFileSync(join(root, 'lib/a3/learning-types.ts'), 'utf8');
const admissionView = readFileSync(join(root, 'components/a3/features/admission-diagnostic-view.tsx'), 'utf8');
const todayView = readFileSync(join(root, 'components/a3/features/today-learning-view.tsx'), 'utf8');
const assessmentView = readFileSync(join(root, 'components/a3/features/assessment-view.tsx'), 'utf8');
const wrongView = readFileSync(join(root, 'components/a3/features/wrong-notebook-view.tsx'), 'utf8');

describe('A3 learning loop evidence on real business pages', () => {
  it('types backend loop evidence as a first-class contract', () => {
    expect(learningTypes).toContain('LearningLoopEvidence');
    expect(learningTypes).toContain('a3.learning-loop-evidence.v1');
    expect(learningTypes).toContain('writeBacks');
  });

  it('shows admission diagnostic writeback evidence on the diagnostic page', () => {
    expect(admissionView).toContain('data-testid="a3-admission-loop-evidence"');
    expect(admissionView).toContain('result.diagnostic.loopEvidence');
    expect(admissionView).toContain('writeBacks.map');
  });

  it('shows today task completion evidence from backend feedback', () => {
    expect(todayView).toContain('data-testid="a3-today-loop-evidence"');
    expect(todayView).toContain('feedback.loopEvidence');
    expect(todayView).toContain('writeBacks.map');
  });

  it('keeps assessment and wrong-notebook closed loop evidence on real pages', () => {
    expect(assessmentView).toContain('data-testid="a3-assessment-loop-evidence"');
    expect(assessmentView).toContain('feedback.loopEvidence');
    expect(assessmentView).toContain('feedback.profileUpdate');
    expect(assessmentView).toContain('feedback.studyPlan');
    expect(wrongView).toContain('data-testid="a3-wrong-loop-evidence"');
    expect(wrongView).toContain('result.retryFeedback');
    expect(wrongView).toContain('result.studyPlan');
  });
});
