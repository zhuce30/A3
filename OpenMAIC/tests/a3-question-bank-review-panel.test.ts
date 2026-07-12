import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = readFileSync(join(root, 'components/a3/features/question-bank-review-panel.tsx'), 'utf8');

describe('A3 question bank review panel', () => {
  it('shows question kind and personalization signals for teacher review', () => {
    expect(source).toContain('questionKindLabels');
    expect(source).toContain('data-testid="a3-question-bank-kind"');
    expect(source).toContain('个性化生成依据');
    expect(source).toContain('题型：');
    expect(source).toContain('薄弱点：');
    expect(source).toContain('错因：');
  });

  it('makes approval explicitly promote candidates into the formal bank', () => {
    expect(source).toContain('通过并转正式题');
    expect(source).toContain('const reason = reviewReason.trim();');
    expect(source).toContain('/api/assessments/questions/${question.id}/review/');
  });

  it('supports question-kind filtering, editable reasons, and batch review', () => {
    expect(source).toContain("query.set('questionKind', questionKind)");
    expect(source).toContain('审核理由');
    expect(source).toContain('selectedQuestionIds');
    expect(source).toContain('/api/assessments/questions/batch-review/');
    expect(source).toContain('批量通过');
    expect(source).toContain('批量拒绝');
  });
});
