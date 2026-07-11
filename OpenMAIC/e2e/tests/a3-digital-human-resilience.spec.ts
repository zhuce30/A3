import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { test } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function seedDemoData() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const worktreeBackendRoot = path.join(projectRoot, 'backend');
  const originalBackendRoot = path.resolve(projectRoot, '..', '..', 'A3', 'backend');
  const backendRoot = fs.existsSync(
    path.join(worktreeBackendRoot, '.venv', 'Scripts', 'python.exe'),
  )
    ? worktreeBackendRoot
    : originalBackendRoot;
  const localPython = path.join(backendRoot, '.venv', 'Scripts', 'python.exe');
  const python =
    process.env.A3_BACKEND_PYTHON ??
    (fs.existsSync(localPython)
      ? localPython
      : path.resolve(projectRoot, '..', '..', 'A3', 'backend', '.venv', 'Scripts', 'python.exe'));
  execFileSync(python, [path.join(backendRoot, 'manage.py'), 'seed_demo_data'], {
    cwd: backendRoot,
    env: { ...process.env, DJANGO_DEBUG: '1' },
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe('A3 digital teacher resilience', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('keeps the teacher stage usable at desktop and mobile viewports', async ({
    page,
  }, testInfo) => {
    await loginAsStudent(page);

    const viewports = [
      { name: 'desktop-1280', width: 1280, height: 900, minimumAvatarWidth: 520 },
      { name: 'desktop-1440', width: 1440, height: 900, minimumAvatarWidth: 600 },
      { name: 'mobile', width: 390, height: 844, minimumAvatarWidth: 320 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/a3/coaching');

      const avatar = page.getByTestId('a3-digital-human-avatar');
      const stage = page.getByTestId('a3-digital-human-three-stage');
      await expect(avatar).toBeVisible({ timeout: 60_000 });
      await expect(stage).toBeVisible({ timeout: 60_000 });

      const avatarBox = await avatar.boundingBox();
      const stageBox = await stage.boundingBox();
      expect(avatarBox?.width).toBeGreaterThanOrEqual(viewport.minimumAvatarWidth);
      expect(stageBox?.height).toBeGreaterThanOrEqual(420);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);

      const screenshot = await avatar.screenshot();
      expect(screenshot.byteLength).toBeGreaterThan(20_000);
      await testInfo.attach(`digital-teacher-${viewport.name}`, {
        body: screenshot,
        contentType: 'image/png',
      });
    }
  });

  test('falls back to a static teacher without breaking coaching controls when WebGL is unavailable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function getContext(
        contextId: string,
        ...args: unknown[]
      ) {
        if (contextId === 'webgl' || contextId === 'webgl2' || contextId === 'experimental-webgl') {
          return null;
        }
        return originalGetContext.call(this, contextId as '2d', ...(args as [])) as never;
      } as typeof HTMLCanvasElement.prototype.getContext;
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');

    const call = page.getByTestId('a3-realtime-coaching-call');
    await expect(call.getByTestId('a3-digital-human-static-fallback')).toBeVisible({
      timeout: 60_000,
    });
    await expect(call.getByTestId('a3-digital-human-three-canvas')).toHaveCount(0);
    await expect(call.getByTestId('a3-realtime-start')).toBeEnabled();
    await expect(call.getByRole('button', { name: '开启麦克风' })).toBeVisible();
  });
});
