import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

const VIEWPORTS = [
  { name: 'desktop', size: { width: 1440, height: 1000 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
] as const;

const PROFILE_RATIONALE_PAGES = [
  {
    name: 'today',
    route: '/a3/today',
    viewTestId: 'a3-today-view',
    rationaleTestId: 'a3-task-profile-rationale',
  },
  {
    name: 'study-plan',
    route: '/a3/study-plan',
    viewTestId: 'a3-study-plan-view',
    rationaleTestId: 'a3-task-profile-rationale',
  },
  {
    name: 'recommendations',
    route: '/a3/recommendations',
    viewTestId: 'a3-recommendations-view',
    rationaleTestId: 'a3-recommendation-profile-rationale',
  },
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
  await waitForBackend(page);
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function waitForBackend(page: Page) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await page.request.get('http://localhost:8000/api/auth/csrf/', { timeout: 5_000 });
      if (response.ok()) return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error('A3 backend is not reachable on localhost:8000');
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(root.scrollWidth, body.scrollWidth);
    return {
      clientWidth: root.clientWidth,
      scrollWidth,
      overflowPx: scrollWidth - root.clientWidth,
    };
  });

  expect(overflow.overflowPx, JSON.stringify(overflow)).toBeLessThanOrEqual(2);
}

test.describe.serial('A3 profile rationale visual inspection', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} today, study plan, and recommendations show stable profile rationale layout`, async ({ page }, testInfo: TestInfo) => {
      await page.setViewportSize(viewport.size);
      await loginAsStudent(page);

      for (const target of PROFILE_RATIONALE_PAGES) {
        await test.step(`${viewport.name} ${target.name}`, async () => {
          await page.goto(target.route);
          await expect(page.getByTestId(target.viewTestId)).toBeVisible({ timeout: 60_000 });
          await expect(page.locator('body')).not.toContainText(/Application error|This page could not be found/);
          await expect(page.getByTestId(target.rationaleTestId).first()).toBeVisible({ timeout: 60_000 });
          await expectNoHorizontalOverflow(page);

          const screenshotPath = testInfo.outputPath(`a3-${target.name}-${viewport.name}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await testInfo.attach(`a3-${target.name}-${viewport.name}`, {
            path: screenshotPath,
            contentType: 'image/png',
          });
        });
      }
    });
  }
});
