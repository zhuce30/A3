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

function resetCoachingNotes() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import UserFavorite

user = User.objects.get(phone="${STUDENT_PHONE}")
UserFavorite.objects.filter(user=user, group="AI 辅导笔记").delete()
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

test.describe.serial('A3 coaching notes', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    resetCoachingNotes();
  });

  test('student can save a verified coaching answer as a note and continue to favorites', async ({ page }) => {
    await page.route('**/api/a3/coaching/respond', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          reply: '面对面辅导会结合当前学习目标、路径节点和知识库来源，先解释概念，再给出下一步练习建议。',
          verified: true,
          citations: [
            {
              id: 'coaching-source-1',
              title: '面对面辅导课堂资料',
              location: '第 2 章',
              type: '课程知识点',
              score: 0.93,
              snippet: '辅导回答应结合学习目标、路径节点和知识库来源。',
            },
          ],
          claims: [{ id: 'claim-1', text: '辅导回答结合当前学习目标和知识库来源。', verified: true, overlap: 0.82 }],
          refusalReason: '',
        }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: /例子|分步|考法/ }).first().click();
    await expect(page.getByTestId('a3-coaching-verification').first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: '存为笔记' }).first().click();
    await expect(page.getByTestId('a3-coaching-error')).toContainText('已保存', { timeout: 30_000 });

    await page.getByTestId('a3-coaching-open-favorites').click();
    await expect(page).toHaveURL(/\/a3\/favorites/, { timeout: 30_000 });
    await expect(page.getByTestId('a3-favorite-item').filter({ hasText: '辅导笔记' })).toBeVisible({ timeout: 60_000 });
  });
});
