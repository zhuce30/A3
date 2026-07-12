import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  return execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

function assessmentSession() {
  return {
    id: 'e2e-classroom-practice-session',
    mode: 'practice',
    focus: { knowledgePoint: '根轨迹' },
    status: 'in_progress',
    currentIndex: 0,
    answeredCount: 0,
    totalQuestions: 1,
    score: 0,
    startedAt: '2026-07-03T12:00:00Z',
    completedAt: null,
    currentQuestion: {
      id: 'e2e-classroom-practice-question',
      stem: '根轨迹与闭环极点变化最直接相关的是哪一项？',
      options: [
        { key: 'A', text: '开环增益变化时闭环极点的位置轨迹' },
        { key: 'B', text: '输入信号的采样周期' },
        { key: 'C', text: '传感器外壳材质' },
        { key: 'D', text: '显示器刷新率' },
      ],
      difficulty: 3,
      knowledgePoint: { id: 'kp-root-locus', title: '根轨迹', chapter: '控制系统分析' },
    },
  };
}

test.describe.serial('A3 classroom embedded practice sync evidence', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test('shows wrong notebook, profile weak points, and report evidence after inline grading', async ({ page }) => {
    await page.route('**/api/assessments/start/', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, session: assessmentSession() }),
      });
    });

    await page.route('**/api/assess/grade/', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          isCorrect: false,
          selectedAnswer: 'B',
          correctAnswer: 'A',
          explanation: '根轨迹描述开环增益变化时闭环极点在复平面上的移动轨迹。',
          errorCause: '混淆了采样周期和闭环极点轨迹。',
          session: {
            ...assessmentSession(),
            status: 'completed',
            answeredCount: 1,
            score: 0,
            completedAt: '2026-07-03T12:01:00Z',
            currentQuestion: assessmentSession().currentQuestion,
          },
          profileUpdate: {
            weakPoints: ['根轨迹', '闭环极点'],
            extraProfile: { lastAssessmentSource: 'classroom_inline_practice' },
          },
          report: {
            period: { start: '2026-07-03', end: '2026-07-03' },
            metrics: {
              studyMinutes: 18,
              studyDays: 1,
              masteredKnowledgePoints: 2,
              totalKnowledgePoints: 10,
              answeredQuestions: 6,
              accuracy: 72,
              activeWrongQuestions: 3,
              masteredWrongQuestions: 1,
              pathProgress: 41,
            },
            trends: [],
            capabilityAxes: [],
            suggestions: [],
          },
          nextAction: { label: '查看错题本', href: '/a3/wrong-notebook', reason: '本题答错后进入复习队列' },
        }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/classroom');

    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-classroom-practice-card').first()).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-classroom-practice-start').first().click();
    await expect(page.getByTestId('a3-classroom-embedded-question')).toContainText('根轨迹', { timeout: 30_000 });

    await page.getByTestId('a3-classroom-embedded-option').nth(1).click();
    await page.getByTestId('a3-classroom-embedded-submit').click();

    const syncEvidence = page.getByTestId('a3-classroom-practice-sync-evidence');
    await expect(syncEvidence).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('a3-classroom-wrong-sync')).toContainText('已进入错题本或复习队列');
    await expect(page.getByTestId('a3-classroom-profile-sync')).toContainText('根轨迹');
    await expect(page.getByTestId('a3-classroom-profile-sync')).toContainText('闭环极点');
    await expect(page.getByTestId('a3-classroom-report-sync')).toContainText('72%');
    await expect(page.getByTestId('a3-classroom-report-sync')).toContainText('3');
    await expect(page.getByTestId('a3-classroom-report-sync')).toContainText('41%');
  });
});
