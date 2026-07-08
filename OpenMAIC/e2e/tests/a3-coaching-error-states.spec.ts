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

test.describe.serial('A3 coaching error states', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('student gets an actionable camera prompt when taking a photo before enabling camera', async ({ page }) => {
    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    const photoButton = page.getByTestId('a3-coaching-photo-question');
    await expect(photoButton).toBeEnabled();
    await photoButton.click();

    const error = page.getByTestId('a3-coaching-error');
    await expect(error).toContainText('请先开启摄像头');
    await expect(error).toHaveClass(/bg-rose-50/);
    await expect(page.getByTestId('a3-coaching-start-media-from-error')).toBeVisible();
  });

  test('student gets retry and text fallback when microphone permission is denied', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
        },
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    const speakButton = page.getByTestId('a3-coaching-voice-input');
    await expect(speakButton).toBeEnabled();
    await speakButton.click();

    const error = page.getByTestId('a3-coaching-error');
    await expect(error).toContainText('麦克风');
    await expect(error).toHaveClass(/bg-rose-50/);
    await expect(page.getByTestId('a3-coaching-retry-microphone')).toBeVisible();
    await expect(page.getByTestId('a3-coaching-text-fallback')).toBeVisible();
  });

  test('student can retry or switch to text when visual coaching fails', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const context = canvas.getContext('2d');
            context?.fillRect(0, 0, canvas.width, canvas.height);
            return canvas.captureStream(1);
          },
        },
      });
    });

    await page.route('**/api/a3/coaching/vision', async (route) => {
      await route.fulfill({
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: '视觉辅导服务暂时不可用，请稍后重试' }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: '开启音视频' }).click();
    await expect(page.getByTestId('a3-coaching-photo-question')).toBeEnabled();
    await page.getByTestId('a3-coaching-photo-question').click();

    const error = page.getByTestId('a3-coaching-error');
    await expect(error).toContainText('视觉辅导');
    await expect(error).toHaveClass(/bg-rose-50/);
    await expect(page.getByTestId('a3-coaching-retry-vision')).toBeVisible();
    await expect(page.getByTestId('a3-coaching-text-fallback')).toBeVisible();
  });

  test('student keeps the current quiz question and can retry when grading fails', async ({ page }) => {
    await page.route('**/api/assess/grade/', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: '判分服务暂时不可用，请稍后重试' }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: '随堂测验' }).click();
    const quiz = page.getByTestId('a3-coaching-quiz');
    await expect(quiz).toBeVisible({ timeout: 30_000 });

    const questionBefore = (await quiz.getByTestId('a3-coaching-quiz-question').innerText()).trim();
    await quiz.getByTestId('a3-coaching-quiz-option').first().click();

    await expect(quiz.getByTestId('a3-coaching-quiz-error')).toContainText('判分服务暂时不可用', { timeout: 30_000 });
    await expect(quiz.getByTestId('a3-coaching-quiz-question')).toHaveText(questionBefore);
    await expect(quiz.getByTestId('a3-coaching-quiz-retry')).toBeVisible();
    await expect(quiz.getByRole('link', { name: '去练习页' })).toBeVisible();
  });

  test('student keeps the question and gets recovery actions when AI reply fails', async ({ page }) => {
    await page.route('**/api/a3/coaching/respond', async (route) => {
      await route.fulfill({
        status: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'AI 辅导服务暂时不可用，请稍后重试' }),
      });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });

    const question = '可以分步骤解释一下吗？';
    await page.getByTestId('a3-coaching-suggestion').filter({ hasText: question }).click();

    await expect(page.getByTestId('a3-coaching-message-user').filter({ hasText: question })).toBeVisible();
    const error = page.getByTestId('a3-coaching-error');
    await expect(error).toContainText('AI 辅导服务暂时不可用', { timeout: 30_000 });
    await expect(error).toHaveClass(/bg-rose-50/);
    await expect(page.getByTestId('a3-coaching-retry-last-question')).toBeVisible();
    await expect(page.getByTestId('a3-coaching-open-classroom')).toBeVisible();
  });
});
