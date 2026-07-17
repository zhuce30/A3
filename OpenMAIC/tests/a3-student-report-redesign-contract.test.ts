import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const reportViewPath = path.resolve(root, 'components/a3/features/report-view.tsx');
const reportDetailsPath = path.resolve(root, 'components/a3/features/report/report-details.tsx');
const capabilitiesPath = path.resolve(root, 'components/a3/features/capabilities-view.tsx');
const componentPaths = [
  'report-overview-panel.tsx',
  'report-change-summary.tsx',
  'report-weak-points.tsx',
  'report-seven-day-plan.tsx',
  'report-method-effect.tsx',
].map((fileName) => path.resolve(root, 'components/a3/features/report', fileName));

describe('A3 student report redesign contract', () => {
  it('uses a pure view model and five dedicated student-facing sections', () => {
    const reportView = fs.readFileSync(reportViewPath, 'utf8');

    expect(reportView).toContain("import { buildStudentReportViewModel } from '@/lib/a3/report-view-model';");
    expect(reportView).toContain('buildStudentReportViewModel({');
    for (const componentPath of componentPaths) {
      expect(fs.existsSync(componentPath), componentPath).toBe(true);
      const source = fs.readFileSync(componentPath, 'utf8');
      expect(source).toContain('export function');
    }
    expect(reportView).toContain('<ReportOverviewPanel');
    expect(reportView).toContain('<ReportChangeSummary');
    expect(reportView).toContain('<ReportWeakPoints');
    expect(reportView).toContain('<ReportSevenDayPlan');
    expect(reportView).toContain('<ReportMethodEffect');
  });

  it('keeps one overview CTA and bounded actionable content', () => {
    const overview = fs.readFileSync(componentPaths[0], 'utf8');
    const weakPoints = fs.readFileSync(componentPaths[2], 'utf8');
    const sevenDayPlan = fs.readFileSync(componentPaths[3], 'utf8');

    expect(overview.match(/data-testid="a3-report-primary-action"/g)).toHaveLength(1);
    expect(weakPoints).toContain('weakKnowledgePoints.slice(0, 3)');
    expect(weakPoints).toContain('estimatedMinutes');
    expect(sevenDayPlan).toContain('从今天开始的 7 天行动');
    expect(sevenDayPlan).toContain('completionCriteria');
    expect(sevenDayPlan).toContain('feedback');
  });

  it('does not render technical audit language in the five core sections', () => {
    const studentCore = componentPaths.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');

    for (const internalLabel of ['eventStream', 'decisionHistory', 'schemaVersion', 'v2 事件', '候选数', '决策分', 'pending']) {
      expect(studentCore).not.toContain(internalLabel);
    }
  });

  it('keeps charts, profile, summary and exports in a closed details disclosure', () => {
    const reportView = fs.readFileSync(reportViewPath, 'utf8');
    expect(fs.existsSync(reportDetailsPath)).toBe(true);
    const details = fs.readFileSync(reportDetailsPath, 'utf8');

    expect(reportView).toContain('<ReportDetails');
    expect(details).toContain('<details');
    expect(details).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
    expect(details).toContain('详细分析与报告工具');
    expect(details).toContain('testId="a3-report-detail-trends"');
    expect(details).toContain('testId="a3-report-detail-capability"');
    expect(details).toContain('testId="a3-report-dynamic-profile"');
    expect(details).toContain('testId="a3-report-detail-exports"');
    expect(details).toContain('data-testid="a3-report-detail-coverage"');
    expect(details).toContain('补充数据加载中');
    expect(details).toContain('补充数据暂不可用');
  });

  it('moves technical report evidence to a collapsed capabilities section', () => {
    const reportView = fs.readFileSync(reportViewPath, 'utf8');
    const capabilities = fs.readFileSync(capabilitiesPath, 'utf8');

    expect(capabilities).toContain('data-testid="a3-learning-report-audit-evidence"');
    expect(capabilities).toContain('学习报告计算与策略证据');
    expect(capabilities).toContain('<details');
    for (const internalLabel of ['a3-report-event-stream-evidence', 'a3-report-optimization-policy', 'a3-report-optimization-decision-history']) {
      expect(reportView).not.toContain(internalLabel);
    }
  });
});
