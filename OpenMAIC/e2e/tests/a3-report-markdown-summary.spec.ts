import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe.serial('A3 report Markdown summary generation', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test('student generates a Markdown summary and sees it in history', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/report');

    await expect(page.getByTestId('a3-report-view')).toBeVisible({ timeout: 60_000 });
    const tool = page.getByTestId('a3-report-summary-tool');
    await expect(tool).toBeVisible({ timeout: 30_000 });

    const marker = `E2E-${Date.now()}`;
    await page.getByTestId('a3-report-summary-prompt').fill(`总结我今天学了什么，标记 ${marker}`);
    const createResponse = page.waitForResponse(
      (response) => response.url().includes('/api/learning/report-summaries/') && response.request().method() === 'POST',
    );
    await page.getByTestId('a3-report-summary-generate').click();
    const response = await createResponse;
    expect(response.status()).toBe(201);

    const history = page.getByTestId('a3-report-summary-history');
    await expect(history).toContainText('今日学习总结', { timeout: 30_000 });
    await expect(history).toContainText(marker, { timeout: 30_000 });

    const markdown = page.getByTestId('a3-report-summary-markdown');
    await expect(markdown).toContainText('今日学习总结', { timeout: 30_000 });
    await expect(markdown.locator('h3, h4').first()).toBeVisible({ timeout: 30_000 });
    await expect(markdown.locator('li').first()).toBeVisible({ timeout: 30_000 });
    await expect(markdown).toContainText(/下一步建议|今天学了什么|证据/, { timeout: 30_000 });
  });
});
