import sharp from 'sharp';
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { test } from '../fixtures/base';

async function expectCanvasHasRenderedPixels(canvas: Locator) {
  await expect(canvas).toBeVisible();
  const image = await canvas.screenshot();
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let min = 255;
  let max = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const value = Math.round((data[index] + data[index + 1] + data[index + 2]) / 3);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  expect(max - min).toBeGreaterThan(18);
}

async function mockCoachingPageDependencies(page: Page) {
  await page.route('**/api/access-code/status', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, authenticated: true }),
    });
  });

  await page.route('**/api/auth/me/', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: {
          id: 'digital-human-student',
          phone: '13800000001',
          role: 'student',
          phoneBound: true,
          privacyAccepted: true,
          profileCompleted: true,
          onboardingStep: 'completed',
        },
      }),
    });
  });

  await page.route('**/api/learning/classroom/', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        classroom: {
          target: { id: 'kp-realtime', title: '函数单调性面对面辅导' },
          sources: [],
          recommended: [],
        },
      }),
    });
  });

  await page.route('**/api/learning/coaching/session/', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        session: {
          schemaVersion: 'a3.coaching-session.v1',
          id: 'digital-human-session',
          status: 'active',
          messages: [],
          summary: '',
          updatedAt: '2026-07-09T00:00:00.000Z',
        },
      }),
    });
  });

  await page.route(/\/api\/learning\/coaching\/sessions\/\?limit=20$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, sessions: [] }),
    });
  });

  await page.route('**/api/assessments/current/', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'e2e visual test skips assessment data' }),
    });
  });
}

test.describe('A3 digital human coaching avatar', () => {
  test.setTimeout(180_000);

  test('shows digital human avatar in realtime coaching panel', async ({ page }) => {
    await mockCoachingPageDependencies(page);

    await page.route('**/api/a3/coaching/realtime/session', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          provider: 'local_fallback_record_then_respond',
          model: 'a3-local-fallback',
          connection: { type: 'fallback', readyForBrowserMedia: false },
          coachingSessionId: 'digital-human-e2e',
          fallbackReason: '测试环境未配置实时 provider，已降级到录音转写问答。',
          instructions: {
            targetTitle: '面对面辅导',
            safetyPolicyVersion: 'a3.realtime-safety.v1',
            retrievalPolicyVersion: 'a3.hybrid-rag.v1',
          },
        }),
      });
    });

    await page.route('**/api/a3/coaching/realtime/message', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, session: {} }),
      });
    });

    await page.goto('/a3/coaching', { waitUntil: 'domcontentloaded' });

    const call = page.getByTestId('a3-realtime-coaching-call');
    await expect(call).toBeVisible({ timeout: 60_000 });
    await expect(call.getByTestId('a3-digital-human-avatar')).toBeVisible();
    await expect(call.getByTestId('a3-digital-human-three-stage')).toBeVisible();
    await expect(call.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-renderer',
      'vrm_idle_animation',
      { timeout: 120_000 },
    );
    await expect(call.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-asset',
      '/a3/assets/teacher-avatar/teacher.optimized.vrm?v=20260718-v1',
    );
    await expect(call.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-idle-animation',
      '/a3/assets/teacher-avatar/idle.vrma',
    );
    await expect(call.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-idle-animation-state',
      'loaded',
    );
    await expectCanvasHasRenderedPixels(call.getByTestId('a3-digital-human-three-canvas'));
    await expect(call).toContainText('数字助教');

    await call.getByTestId('a3-realtime-start').click();
    await expect(call.getByTestId('a3-digital-human-avatar')).toHaveAttribute(
      'data-state',
      'degraded',
      { timeout: 20_000 },
    );
    await expect(call).toContainText('测试环境未配置实时 provider');

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileCall = page.getByTestId('a3-realtime-coaching-call');
    await expect(mobileCall.getByTestId('a3-digital-human-three-stage')).toBeVisible({
      timeout: 60_000,
    });
    await expect(mobileCall.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-renderer',
      'vrm_idle_animation',
      { timeout: 120_000 },
    );
    await expect(mobileCall.getByTestId('a3-digital-human-three-stage')).toHaveAttribute(
      'data-avatar-idle-animation-state',
      'loaded',
    );
  });
});
