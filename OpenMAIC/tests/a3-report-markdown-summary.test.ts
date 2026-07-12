import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const reportViewPath = path.resolve(process.cwd(), 'components/a3/features/report-view.tsx');

describe('A3 report Markdown summaries', () => {
  it('wires report summary generation to the real learning API and Markdown renderer', () => {
    const source = fs.readFileSync(reportViewPath, 'utf8');

    expect(source).toContain("import { A3Markdown } from '../ui/a3-markdown';");
    expect(source).toContain("a3GetJson<LearningSummaryDocumentsResponse>('/api/learning/report-summaries/?limit=20')");
    expect(source).toContain("a3PostJson<LearningSummaryDocumentsResponse>('/api/learning/report-summaries/'");
    expect(source).toContain('data-testid="a3-report-summary-tool"');
    expect(source).toContain('data-testid="a3-report-summary-prompt"');
    expect(source).toContain('data-testid="a3-report-summary-generate"');
    expect(source).toContain('data-testid="a3-report-summary-history"');
    expect(source).toContain('data-testid="a3-report-summary-markdown"');
    expect(source).toContain('<A3Markdown');
  });
});
