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

function resetSourceFavorites() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserFavorite

user = User.objects.get(phone="${STUDENT_PHONE}")
UserFavorite.objects.filter(user=user, group="知识库来源").delete()
`,
  ]);
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

test.describe.serial('A3 source favorites', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    resetSourceFavorites();
  });

  test('student can favorite a classroom source and review it from favorites', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });

    const firstSource = page.getByTestId('a3-classroom-source').first();
    await expect(firstSource).toBeVisible({ timeout: 30_000 });
    const sourceTitle = (await firstSource.getByTestId('a3-source-title').innerText()).trim();

    await firstSource.getByTestId('a3-source-favorite').click();
    await expect(page.getByTestId('a3-source-favorite-message')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('a3-source-open-favorites').click();

    await expect(page).toHaveURL(/\/a3\/favorites/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: sourceTitle }).filter({ hasText: '知识库来源' })).toBeVisible({ timeout: 60_000 });
  });

  test('student can favorite a coaching source and review it from favorites', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    const firstSource = page.getByTestId('a3-coaching-source').first();
    await expect(firstSource).toBeVisible({ timeout: 30_000 });
    const sourceTitle = (await firstSource.getByTestId('a3-source-title').innerText()).trim();

    await firstSource.getByTestId('a3-source-favorite').click();
    await expect(page.getByTestId('a3-source-favorite-message')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('a3-source-open-favorites').click();

    await expect(page).toHaveURL(/\/a3\/favorites/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: sourceTitle }).filter({ hasText: '知识库来源' })).toBeVisible({ timeout: 60_000 });
  });

  test('student sees an actionable error when source favorite fails', async ({ page }) => {
    await page.route('**/api/engagement/favorites/create/', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: '收藏服务暂时不可用，请稍后重试' }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });

    const firstSource = page.getByTestId('a3-classroom-source').first();
    await expect(firstSource).toBeVisible({ timeout: 30_000 });
    await firstSource.getByTestId('a3-source-favorite').click();

    const message = page.getByTestId('a3-source-favorite-message');
    await expect(message).toContainText('收藏服务暂时不可用', { timeout: 30_000 });
    await expect(message).toHaveClass(/bg-rose-50/);
    await expect(page.getByTestId('a3-source-open-favorites')).toHaveCount(0);
  });
});
