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

test.describe.serial('A3 conversational profile interview loop', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test('interview asks follow-up before complete profile and commits path, plan, and trace after confirmation', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/profile-setup');
    await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-profile-interview-input').fill('我是自动化大二，想考研。');
    await page.getByTestId('a3-profile-interview-generate').click();
    await expect(page.getByTestId('a3-profile-interview-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-interview-missing-dimensions')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-profile-interview-confirm').click();
    await expect(page.getByTestId('a3-profile-interview-missing-dimensions')).toBeVisible({ timeout: 60_000 });

    await page
      .getByTestId('a3-profile-interview-input')
      .fill('我每天 40 分钟，控制理论基础一般，根轨迹和频率响应薄弱，喜欢动画、例题和工程案例，目标是 30 天补齐控制系统基础。');
    await page.getByTestId('a3-profile-interview-generate').click();
    await expect(page.getByTestId('a3-profile-interview-result')).toContainText('traceId', { timeout: 60_000 });

    await page.getByTestId('a3-profile-interview-confirm').click();
    await expect(page.getByTestId('a3-profile-setup-save-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-setup-save-result')).toContainText(/14|计划|studyPlan|诊断/);

    await page.goto('/a3/study-plan');
    await expect(page.getByTestId('a3-study-plan-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-study-plan-view')).toContainText(/14|天|任务|计划/);

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    const profileEvidence = page.getByTestId('a3-profile-interview-evidence');
    await expect(profileEvidence).toBeVisible({ timeout: 60_000 });
    await expect(profileEvidence).toContainText(/complete|collecting/);
    await expect(profileEvidence).toContainText(/trace|turns|messages/);
    await expect(profileEvidence).toContainText(/committed|refreshed/);
    await expect(page.getByTestId('a3-profile-interview-commit-evidence')).toContainText(/已刷新|已生成/);
  });
});
