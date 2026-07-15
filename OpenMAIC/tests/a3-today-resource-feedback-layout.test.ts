import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'components/a3/features/today-learning-view.tsx'),
  'utf8',
);
const panelStart = source.indexOf('data-testid="a3-today-resource-feedback-adjustment"');
const panelEnd = source.indexOf('{activeTask &&', panelStart);
const feedbackPanel = source.slice(panelStart, panelEnd);

describe('A3 today resource feedback adjustment layout', () => {
  it('keeps the narrow side rail compact and expands details in one column', () => {
    expect(panelStart).toBeGreaterThan(-1);
    expect(feedbackPanel).toContain('<summary');
    expect(feedbackPanel).toContain('group-open:rotate-180');
    expect(feedbackPanel).toContain('max-h-72 overflow-y-auto');
    expect(feedbackPanel).toContain('break-words');
    expect(feedbackPanel).not.toContain('sm:grid-cols-3');
  });

  it('shows a student-facing label instead of the raw strategy code', () => {
    expect(source).toContain('resourceFeedbackStrategyLabel');
    expect(source).not.toContain('<A3Pill tone="green">{resourceFeedbackAdjustment.strategy}</A3Pill>');
  });
});
