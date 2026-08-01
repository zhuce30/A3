import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const apiClient = readFileSync(join(root, 'lib/a3/api-client.ts'), 'utf8');
const types = readFileSync(join(root, 'lib/a3/assessment-types.ts'), 'utf8');
const view = readFileSync(join(root, 'components/a3/features/wrong-notebook-view.tsx'), 'utf8');
const actions = readFileSync(join(root, 'components/a3/features/wrong-notebook-actions.tsx'), 'utf8');

describe('wrong notebook export and review handout contracts', () => {
  it('uses authenticated download only after a background job succeeds', () => {
    expect(apiClient).toContain('a3CsrfFetch');
    expect(apiClient).toContain('Content-Disposition');
    expect(apiClient).toContain('URL.createObjectURL');
    expect(actions).toContain('a3DownloadFile');
    expect(actions).not.toContain('a3PostDownload');
  });

  it('defines backend-aligned export and handout types', () => {
    expect(types).toContain("export type WrongExportScope = 'active' | 'due' | 'mastered' | 'all'");
    expect(types).toContain("export type WrongExportFormat = 'docx' | 'xlsx' | 'pdf'");
    expect(types).toContain('export type WrongQuestionExportJob');
    expect(types).toContain('export type ReviewHandoutJob');
    expect(types).toContain('downloadUrl?: string');
    expect(types).toContain('docxDownloadUrl?: string');
    expect(types).toContain('pdfDownloadUrl?: string');
    expect(types).toContain('degradedReasons: string[]');
    expect(types).toContain('llmAudit: AssessmentContentAudit');
  });

  it('offers all scopes and formats through separate background job histories', () => {
    for (const label of ['待巩固', '今日到期', '已掌握', '全部']) {
      expect(actions).toContain(label);
    }
    for (const format of ['Word', 'Excel', 'PDF']) {
      expect(actions).toContain(format);
    }
    expect(actions).toContain('/api/assessments/wrong-questions/exports/');
    expect(actions).toContain('/api/assessments/wrong-questions/review-handouts/');
    expect(actions).toContain('导出历史');
    expect(actions).toContain('讲义历史');
    expect(actions).toContain('/cancel/');
    expect(actions).toContain('/retry/');
    expect(actions).toContain('downloadUrl');
    expect(actions).toContain('docxDownloadUrl');
    expect(actions).toContain('pdfDownloadUrl');
  });

  it('polls while either export or handout jobs are active', () => {
    expect(actions).toContain('exportJobs.some');
    expect(actions).toContain('handoutJobs.some');
    expect(actions).toContain('window.setInterval');
    expect(actions).toContain('2000');
    expect(actions).toContain('loadExportJobs(true)');
    expect(actions).toContain('loadHandoutJobs(true)');
  });

  it('shows task stage, time, model audit and safe degradation state', () => {
    expect(actions).toContain('stageLabel(job.stage)');
    expect(actions).toContain('formatJobTime(job.updatedAt)');
    expect(actions).toContain('job.degradedReasons');
    expect(actions).toContain('job.llmAudit.model');
    expect(actions).toContain('job.llmAudit.attempts');
  });

  it('integrates the actions into the real wrong notebook page', () => {
    expect(view).toContain('WrongNotebookActions');
    expect(view).toContain('reviewSummary={reviewSummary}');
    expect(actions).toContain('data-testid="a3-wrong-notebook-actions"');
  });
});
