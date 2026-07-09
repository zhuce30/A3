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
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function generatePackAndOpenFirstResource(page: Page) {
  await page.getByTestId('a3-resource-goal-input').fill('E2E 资源反馈闭环：处理机调度、时间片轮转和错题复盘需要一套可学习资源');
  const generateButton = page.getByTestId('a3-resource-generation-primary');
  await expect(generateButton).toBeEnabled({ timeout: 30_000 });
  await generateButton.click();
  await expect(page.getByTestId('a3-resource-result-preview')).toBeVisible({ timeout: 90_000 });

  const firstResource = page.getByTestId('a3-resource-entry').first();
  await expect(firstResource).toBeVisible({ timeout: 60_000 });
  await firstResource.getByTestId('a3-resource-entry-open').click();
  await expect(page.getByTestId('a3-resource-standalone-page')).toBeVisible({ timeout: 60_000 });
}

test.describe.serial('A3 resource feedback learning loop', () => {
  test.setTimeout(180_000);

  test.beforeEach(() => {
    runManage('seed_demo_data');
  });

  test('resource completion feedback writes back to study plan, today task, and agent trace', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/recommendations');
    await expect(page.getByTestId('a3-recommendations-view')).toBeVisible({ timeout: 60_000 });

    await generatePackAndOpenFirstResource(page);
    await page.getByTestId('a3-resource-feedback-completed').click();

    const summary = page.getByTestId('a3-resource-feedback-message');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText('完成');

    await page.goto('/a3/today');
    await expect(page.getByTestId('a3-today-resource-feedback-adjustment')).toBeVisible({ timeout: 60_000 });

    await page.goto('/a3/study-plan');
    const planAdjustment = page.getByTestId('a3-study-plan-resource-feedback-adjustment');
    await expect(planAdjustment).toBeVisible({ timeout: 60_000 });
    await expect(planAdjustment).toContainText('ResourceFeedbackAgent');

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    const feedbackTrace = page.getByTestId('a3-capabilities-resource-feedback-trace');
    await expect(feedbackTrace).toBeVisible({ timeout: 60_000 });
    await expect(feedbackTrace).toContainText('resource_feedback');
    await expect(feedbackTrace).toContainText('ResourceFeedbackAgent');
    await expect(feedbackTrace).toContainText('LearningEffectAgent');
    await expect(feedbackTrace).toContainText('StudyPlanAgent');
  });

  test('skipped resource feedback writes back plan evidence', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/recommendations');
    await expect(page.getByTestId('a3-recommendations-view')).toBeVisible({ timeout: 60_000 });

    await generatePackAndOpenFirstResource(page);
    await page.getByTestId('a3-resource-feedback-skipped').click();
    const summary = page.getByTestId('a3-resource-feedback-message');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText('暂不学习');

    await page.goto('/a3/study-plan');
    const planAdjustment = page.getByTestId('a3-study-plan-resource-feedback-adjustment');
    await expect(planAdjustment).toBeVisible({ timeout: 60_000 });
    await expect(planAdjustment).toContainText('ResourceFeedbackAgent');
    await expect(planAdjustment).toContainText(/reduce_load|keep_current_pace/);
  });

  test('favorited resource feedback creates mastery reinforcement', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/recommendations');
    await expect(page.getByTestId('a3-recommendations-view')).toBeVisible({ timeout: 60_000 });

    await generatePackAndOpenFirstResource(page);
    await page.getByTestId('a3-resource-feedback-favorited').click();
    const summary = page.getByTestId('a3-resource-feedback-message');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary).toContainText('有效资源偏好');

    await page.goto('/a3/study-plan');
    const planAdjustment = page.getByTestId('a3-study-plan-resource-feedback-adjustment');
    await expect(planAdjustment).toBeVisible({ timeout: 60_000 });
    await expect(planAdjustment).toContainText('ResourceFeedbackAgent');
    await expect(planAdjustment).toContainText(/reinforce_mastery|keep_current_pace/);
  });
});
