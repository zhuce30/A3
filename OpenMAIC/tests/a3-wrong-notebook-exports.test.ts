import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const apiClient = readFileSync(join(root, 'lib/a3/api-client.ts'), 'utf8');
const types = readFileSync(join(root, 'lib/a3/assessment-types.ts'), 'utf8');
const view = readFileSync(join(root, 'components/a3/features/wrong-notebook-view.tsx'), 'utf8');
const actions = readFileSync(join(root, 'components/a3/features/wrong-notebook-actions.tsx'), 'utf8');

describe('wrong notebook export and review handout contracts', () => {
  it('uses a CSRF protected binary POST helper for real file downloads', () => {
    expect(apiClient).toContain('export async function a3PostDownload');
    expect(apiClient).toContain('a3CsrfFetch');
    expect(apiClient).toContain('Content-Disposition');
    expect(apiClient).toContain('URL.createObjectURL');
  });

  it('defines backend-aligned export and handout types', () => {
    expect(types).toContain("export type WrongExportScope = 'active' | 'due' | 'mastered' | 'all'");
    expect(types).toContain("export type WrongExportFormat = 'docx' | 'xlsx' | 'pdf'");
    expect(types).toContain('export type ReviewHandoutJob');
    expect(types).toContain('docxDownloadUrl?: string');
    expect(types).toContain('pdfDownloadUrl?: string');
  });

  it('offers all scopes and formats with real job actions', () => {
    for (const label of ['待巩固', '今日到期', '已掌握', '全部']) {
      expect(actions).toContain(label);
    }
    for (const format of ['Word', 'Excel', 'PDF']) {
      expect(actions).toContain(format);
    }
    expect(actions).toContain('/api/assessments/wrong-questions/export/');
    expect(actions).toContain('/api/assessments/wrong-questions/review-handouts/');
    expect(actions).toContain('/cancel/');
    expect(actions).toContain('/retry/');
    expect(actions).toContain('docxDownloadUrl');
    expect(actions).toContain('pdfDownloadUrl');
  });

  it('integrates the actions into the real wrong notebook page', () => {
    expect(view).toContain('WrongNotebookActions');
    expect(view).toContain('reviewSummary={reviewSummary}');
    expect(actions).toContain('data-testid="a3-wrong-notebook-actions"');
  });
});
