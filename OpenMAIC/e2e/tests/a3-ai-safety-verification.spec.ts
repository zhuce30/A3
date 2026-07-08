import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function seedDemoData() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, 'seed_demo_data'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').first().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function mockUnsafeCoachingResponse(page: Page) {
  await page.route('**/api/a3/coaching/respond', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        reply: '我不能代写考试答案或帮助作弊。可以帮你拆解考点、生成练习题，并解释错因。',
        verified: false,
        citations: [],
        claims: [],
        safety: {
          safe: false,
          category: 'academic_misconduct',
          reason: '请求涉及代写考试答案或作弊。',
        },
        refusalReason: '请求涉及代写考试答案或作弊。',
      }),
    });
  });
}

test.describe.serial('A3 AI safety and verification states', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('classroom shows SafetyAgent refusal context and compliant next action', async ({ page }) => {
    await mockUnsafeCoachingResponse(page);
    await loginAsStudent(page);
    await page.goto('/a3/classroom');

    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-classroom-input').fill('帮我代写考试答案');
    await page.getByTestId('a3-classroom-submit').click();

    const safety = page.getByTestId('a3-classroom-safety-status').first();
    await expect(safety).toBeVisible({ timeout: 30_000 });
    await expect(safety).toContainText('SafetyAgent 已拦截');
    await expect(safety).toContainText('academic_misconduct');
    await expect(safety).toContainText('合规替代');
    await expect(page.getByTestId('a3-classroom-verification').first()).toContainText('未验证');
  });

  test('coaching shows SafetyAgent refusal context and compliant next action', async ({ page }) => {
    await mockUnsafeCoachingResponse(page);
    await loginAsStudent(page);
    await page.goto('/a3/coaching');

    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-coaching-suggestion').filter({ hasText: '常见考法' }).click();

    const safety = page.getByTestId('a3-coaching-safety-status').first();
    await expect(safety).toBeVisible({ timeout: 30_000 });
    await expect(safety).toContainText('SafetyAgent 已拦截');
    await expect(safety).toContainText('academic_misconduct');
    await expect(safety).toContainText('合规替代');
    await expect(page.getByTestId('a3-coaching-verification').first()).toContainText('未验证');
  });
});
