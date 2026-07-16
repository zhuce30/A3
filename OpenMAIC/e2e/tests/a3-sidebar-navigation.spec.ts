import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';
const BACKEND_BASE_URL = process.env.A3_E2E_BACKEND_URL
  ?? process.env.NEXT_PUBLIC_A3_API_BASE_URL
  ?? 'http://localhost:8000';

function seedDemoData() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, 'seed_demo_data'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.request.get(new URL('/api/auth/csrf/', BACKEND_BASE_URL).toString(), { timeout: 10_000 });
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

test.describe.serial('A3 sidebar navigation affordance', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('group labels disclose page links while standalone entries navigate directly', async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsStudent(page);
    await page.goto('/a3/learning-path');

    const planningGroup = page.getByTestId('a3-sidebar-group--a3-study-plan');
    const planningChildren = page.getByTestId('a3-sidebar-children--a3-study-plan');
    await expect(planningGroup).toHaveAttribute('aria-expanded', 'true');
    await expect(planningChildren).toBeVisible();
    await expect(planningChildren.getByRole('link', { name: '计划总览', exact: true })).toHaveAttribute('href', '/a3/study-plan');

    await planningGroup.click();
    await expect(page).toHaveURL(/\/a3\/learning-path$/);
    await expect(planningGroup).toHaveAttribute('aria-expanded', 'false');
    await expect(planningChildren).toHaveCount(0);

    await planningGroup.click();
    await planningChildren.getByRole('link', { name: '计划总览', exact: true }).click();
    await expect(page).toHaveURL(/\/a3\/study-plan$/);

    const reportLink = page.getByTestId('a3-sidebar-page--a3-report');
    await expect(reportLink).toHaveAttribute('href', '/a3/report');
    await expect(page.getByTestId('a3-sidebar-group--a3-report')).toHaveCount(0);

    await page.screenshot({
      path: testInfo.outputPath('a3-sidebar-navigation-1440x900.png'),
      fullPage: false,
    });
  });
});
