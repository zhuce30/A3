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

function resetClassroomNotes() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserFavorite

user = User.objects.get(phone="${STUDENT_PHONE}")
UserFavorite.objects.filter(user=user, group="AI 课堂笔记").delete()
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

test.describe.serial('A3 classroom notes', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    resetClassroomNotes();
  });

  test('student can save a verified classroom answer as a note and review it from favorites', async ({ page }) => {
    await page.route('**/api/a3/coaching/respond', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          reply: '根轨迹描述闭环极点随参数变化的轨迹，复习时先看当前路径节点和引用来源。',
          verified: true,
          citations: [
            {
              id: 'source-1',
              title: '根轨迹课堂资料',
              location: '第 4 章',
              type: '课程知识点',
              score: 0.91,
              snippet: '根轨迹用于描述闭环极点随参数变化的轨迹。',
            },
          ],
          claims: [{ id: 'claim-1', text: '根轨迹描述闭环极点变化。', verified: true, overlap: 0.8 }],
          refusalReason: '',
        }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-classroom-input').fill('根轨迹是什么？');
    await page.getByTestId('a3-classroom-submit').click();

    await expect(page.getByTestId('a3-classroom-verification').first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('a3-classroom-save-note').first().click();

    await expect(page.getByTestId('a3-classroom-message')).toContainText('已保存', { timeout: 30_000 });
    await page.getByTestId('a3-classroom-open-favorites').click();

    await expect(page).toHaveURL(/\/a3\/favorites/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: '课堂笔记' })).toBeVisible({ timeout: 60_000 });
  });
});
