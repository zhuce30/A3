import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

const PROFILE_PAGES = [
  { path: '/a3/profile-setup', viewTestId: 'a3-profile-setup-view', name: 'profile-setup' },
  { path: '/a3/report', viewTestId: 'a3-report-view', name: 'report' },
  { path: '/a3/dashboard', viewText: /早上好|上午好|下午好|晚上好/, name: 'dashboard' },
] as const;

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
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

test.describe.serial('A3 shared dynamic profile panel', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test('profile setup, report, and dashboard render the shared dynamic profile component', async ({ page }, testInfo: TestInfo) => {
    await loginAsStudent(page);

    for (const target of PROFILE_PAGES) {
      await test.step(`shared profile panel on ${target.name}`, async () => {
        await page.goto(target.path);
        if ('viewTestId' in target) {
          await expect(page.getByTestId(target.viewTestId)).toBeVisible({ timeout: 60_000 });
        } else {
          await expect(page.getByRole('heading', { name: target.viewText })).toBeVisible({ timeout: 60_000 });
        }

        const panel = page.getByTestId('a3-dynamic-profile-insight').first();
        await expect(panel).toBeVisible({ timeout: 60_000 });
        await expect(panel).toContainText(/画像|维度|事件|错因/);

        const screenshot = await panel.screenshot();
        await testInfo.attach(`dynamic-profile-${target.name}`, {
          body: screenshot,
          contentType: 'image/png',
        });
      });
    }
  });
});
