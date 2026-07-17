import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const completeUser = {
  id: 'student-report-e2e',
  role: 'student',
  displayName: '报告测试同学',
  phoneBound: true,
  privacyAccepted: true,
  profileCompleted: true,
  onboardingStep: 'complete',
  createdAt: '2026-07-01T08:00:00+08:00',
  updatedAt: '2026-07-17T10:00:00+08:00',
};

function reportPayload(period: '7d' | '30d' | 'term', empty = false) {
  const labels = { '7d': '近 7 天', '30d': '近 30 天', term: '本学期' };
  const answered = empty ? 0 : period === '7d' ? 8 : period === '30d' ? 24 : 42;
  const activeWrong = empty ? 0 : 2;
  return {
    period: { key: period, label: labels[period], start: '2026-07-01', end: '2026-07-17' },
    metrics: {
      studyMinutes: empty ? 0 : 220,
      studyDays: empty ? 0 : 8,
      masteredKnowledgePoints: empty ? 0 : 4,
      totalKnowledgePoints: empty ? 0 : 10,
      answeredQuestions: answered,
      accuracy: empty ? 0 : 75,
      activeWrongQuestions: activeWrong,
      masteredWrongQuestions: empty ? 0 : 3,
      pathProgress: empty ? 0 : 40,
    },
    trends: empty ? [] : [
      { label: '07.01-07.07', questions: 8, accuracy: 66.7, start: '2026-07-01', end: '2026-07-07' },
      { label: '07.08-07.14', questions: 12, accuracy: 75, start: '2026-07-08', end: '2026-07-14' },
    ],
    capabilityAxes: empty ? [] : [
      { label: '知识掌握', value: 75 },
      { label: '学习进度', value: 40 },
      { label: '持续学习', value: 68 },
    ],
    suggestions: [],
    studentSummary: empty ? undefined : {
      schemaVersion: 'a3.student-report-summary.v1',
      headline: `${labels[period]}答题表现正在改善`,
      summary: `${labels[period]}完成 ${answered} 次作答，当前有 2 道错题待巩固。`,
      progressSignal: '正确率较上一周期提升 8.3 个百分点',
      primaryRisk: '2 道错题尚未巩固',
      primaryAction: { label: '复盘 2 道错题', href: '/a3/wrong-notebook', estimatedMinutes: 12, expectedOutcome: '复盘后重新测评，更新掌握状态。' },
      evidence: [],
    },
    comparisons: empty ? undefined : {
      periodKey: period,
      currentWindow: { start: '2026-07-01', end: '2026-07-17', answeredCount: answered, correctCount: Math.round(answered * 0.75), accuracy: 75 },
      previousWindow: period === 'term' ? null : { start: '2026-06-01', end: '2026-06-30', answeredCount: 12, correctCount: 8, accuracy: 66.7 },
      accuracy: period === 'term'
        ? { availability: 'unavailable', comparable: false, currentValue: 75, previousValue: null, percentagePointChange: null, reason: '本学期暂无真实上一学期窗口。' }
        : { availability: 'available', comparable: true, currentValue: 75, previousValue: 66.7, percentagePointChange: 8.3, reason: '两个周期样本充足。' },
    },
    knowledgePointInsights: empty ? [] : [{
      knowledgePoint: '进程调度', answeredCount: 6, wrongCount: 2, latestResult: 'incorrect', activeWrongQuestions: 1,
      status: 'needs_review', reason: '当前有 1 道相关错题待巩固。',
      action: { label: '复习相关错题', href: '/a3/wrong-notebook', estimatedMinutes: 12 },
    }],
    dataQuality: {
      evidenceState: empty ? 'insufficient' : 'ready',
      answeredQuestions: answered,
      knowledgePointCount: empty ? 0 : 1,
      comparisonAvailable: !empty && period !== 'term',
      missingReasons: empty ? ['当前周期暂无作答数据。'] : [],
      lastUpdatedAt: '2026-07-17T10:00:00+08:00',
    },
    updatedAt: '2026-07-17T10:00:00+08:00',
  };
}

async function mockReportApis(page: Page, empty = false, failingPeriod?: '7d' | '30d' | 'term') {
  await page.route('**/api/auth/me/', (route) => route.fulfill({ json: { user: completeUser } }));
  await page.route('**/api/assessments/report/**', (route) => {
    const requested = new URL(route.request().url()).searchParams.get('period');
    const period = requested === '7d' || requested === 'term' ? requested : '30d';
    if (period === failingPeriod) return route.fulfill({ status: 503, json: { success: false, error: '周期报告暂时不可用' } });
    return route.fulfill({ json: { success: true, report: reportPayload(period, empty) } });
  });
  await page.route('**/api/learning/effect/report/**', (route) => route.fulfill({ json: { success: true, effectReport: null } }));
  await page.route('**/api/learning/study-plan/**', (route) => route.fulfill({ json: { success: true, plan: null } }));
  await page.route('**/api/profiles/dynamic-profile/**', (route) => route.fulfill({ json: { success: true, dynamicProfile: null, timeline: [], confirmationQueue: [] } }));
  await page.route('**/api/learning/report-summaries/**', (route) => route.fulfill({ json: { success: true, documents: [] } }));
}

test.describe('student learning report redesign', () => {
  test.setTimeout(120_000);

  test('shows one first-viewport action, switches periods and reveals details on demand', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockReportApis(page);
    await page.goto('/a3/report', { waitUntil: 'domcontentloaded', timeout: 90_000 });

    const view = page.getByTestId('a3-report-view');
    await expect(view).toBeVisible({ timeout: 60_000 });
    const primaryAction = page.getByTestId('a3-report-primary-action');
    await expect(primaryAction).toBeVisible({ timeout: 30_000 });
    const actionBox = await primaryAction.boundingBox();
    expect(actionBox && actionBox.y + actionBox.height).toBeLessThanOrEqual(900);
    await expect(page.getByRole('heading', { name: /近 30 天答题表现正在改善/ })).toBeVisible();

    const outerDetails = page.locator('details').filter({ hasText: '详细分析与报告工具' }).first();
    await expect(outerDetails).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('a3-report-detail-trends')).not.toBeVisible();
    await outerDetails.locator('summary').first().click();
    await expect(page.getByTestId('a3-report-detail-trends')).toBeVisible();

    await page.getByRole('button', { name: '近 7 天' }).click();
    await expect(page.getByRole('heading', { name: /近 7 天答题表现正在改善/ })).toBeVisible();
    await page.getByRole('button', { name: '本学期' }).click();
    await expect(page.getByRole('heading', { name: /本学期答题表现正在改善/ })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/eventStream|decisionHistory|schemaVersion|v2 事件|候选数|决策分/);

    await page.screenshot({ path: test.info().outputPath('student-report-desktop.png'), fullPage: true });
    await primaryAction.click();
    await expect(page).toHaveURL(/\/a3\/wrong-notebook/, { timeout: 30_000 });
  });

  test('renders a readable empty state at 390px without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockReportApis(page, true);
    await page.goto('/a3/report', { waitUntil: 'domcontentloaded', timeout: 90_000 });

    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /测评/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('还没有知识点级证据')).toBeVisible();
    await expect(page.getByText('学习方式效果待验证')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('a3-report-primary-action')).toBeVisible();
    await expect(page.getByTestId('a3-report-view')).not.toContainText('0%');

    await page.screenshot({ path: test.info().outputPath('student-report-mobile-empty.png'), fullPage: true });
  });

  test('keeps the previous report and explains a failed period update', async ({ page }) => {
    await mockReportApis(page, false, '7d');
    await page.goto('/a3/report', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /近 30 天答题表现正在改善/ })).toBeVisible();

    await page.getByRole('button', { name: '近 7 天' }).click();

    await expect(page.getByRole('heading', { name: /近 30 天答题表现正在改善/ })).toBeVisible();
    await expect(page.getByText(/新周期加载失败.*周期报告暂时不可用/)).toBeVisible();
  });
});
