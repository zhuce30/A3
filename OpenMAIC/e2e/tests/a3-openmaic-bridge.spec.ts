import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';
const OPENMAIC_OWNERSHIP_TITLE = '\u004f\u0070\u0065\u006e\u004d\u0041\u0049\u0043 \u63a5\u5165\u603b\u89c8';
const SMOKE_WRITEBACK_LABEL = '\u5199\u56de\u6700\u8fd1 \u0073\u006d\u006f\u006b\u0065 \u89c6\u9891\u5230\u8d44\u6e90\u5305';
const SMOKE_WRITEBACK_GUARD = '\u53ea\u6709\u771f\u5b9e \u0070\u0072\u006f\u0076\u0069\u0064\u0065\u0072 \u0073\u006d\u006f\u006b\u0065 \u6210\u529f\u5e76\u751f\u6210 \u0076\u0069\u0064\u0065\u006f\u0055\u0072\u006c \u540e\u624d\u5141\u8bb8\u5199\u56de';
const SMOKE_WRITEBACK_READY = '\u5c06\u5199\u56de\u8d44\u6e90\u5305';
const SMOKE_WRITEBACK_AUTO = '\u672a\u6307\u5b9a\u8d44\u6e90\u5305\u65f6\u5c06\u81ea\u52a8\u5199\u56de\u6700\u8fd1\u4e00\u4e2a \u0041\u0033 \u8d44\u6e90\u5305';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await loginAs(page, STUDENT_PHONE);
}

async function loginAsTeacher(page: Page) {
  await loginAs(page, TEACHER_PHONE);
}

async function loginAs(page: Page, phone: string) {
  await page.context().clearCookies();
  const csrfResponse = await page.request.get('http://localhost:8000/api/auth/csrf/');
  const csrf = await csrfResponse.json().catch(() => ({})) as { csrfToken?: string };
  const loginResponse = await page.request.post('http://localhost:8000/api/auth/login/', {
    headers: csrf.csrfToken ? { 'X-CSRFToken': csrf.csrfToken } : undefined,
    data: { identifier: phone, password: DEMO_PASSWORD },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const payload = await loginResponse.json();
  expect(payload.success).toBeTruthy();
}

async function generateA3ResourcePack(page: Page) {
  await page.goto('/a3/recommendations');
  await expect(page.getByTestId('a3-recommendations-view')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('a3-resource-pack-v2-generate').click();
  await expect(page.getByTestId('a3-resource-pack-v2')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('a3-resource-pack-v2-resource')).toHaveCount(7, { timeout: 60_000 });
}

async function openResourcePackDetail(page: Page) {
  const detailLink = page.getByTestId('a3-resource-pack-detail-open');
  await expect(detailLink).toBeVisible({ timeout: 30_000 });
  await detailLink.click();
  await expect(page.getByTestId('a3-resource-pack-detail')).toBeVisible({ timeout: 60_000 });
}

async function postDjangoJson(page: Page, apiPath: string, data: unknown) {
  const cookies = await page.context().cookies('http://localhost:8000');
  const csrfToken = cookies.find((cookie) => cookie.name === 'csrftoken')?.value ?? '';
  return page.request.post(`http://localhost:8000${apiPath}`, {
    headers: csrfToken ? { 'X-CSRFToken': csrfToken } : undefined,
    data,
  });
}

async function mockOpenMAICClassroomBridge(page: Page, scenario: 'succeeded' | 'failed') {
  const jobId = scenario === 'succeeded' ? 'job-e2e-succeeded' : 'job-e2e-failed';
  await page.route('**/api/a3/resources/openmaic-classroom', async (route) => {
    const body = route.request().postDataJSON() as { action?: string; resourcePackId: string };
    const resourcePackId = body.resourcePackId;
    if (body.action === 'sync') {
      const succeeded = scenario === 'succeeded';
      const artifactPayload = {
        jobId,
        status: scenario,
        classroomId: succeeded ? 'classroom-e2e-001' : '',
        classroomUrl: succeeded ? '/classroom/classroom-e2e-001' : '',
        scenesCount: succeeded ? 5 : 0,
        pptxExportable: succeeded,
        provider: 'openmaic-generate-classroom',
        elapsedMs: 1000,
        degradedReason: succeeded ? '' : 'OpenMAIC classroom rendering failed',
      };
      const persisted = await postDjangoJson(page, `/api/resources/packs/${resourcePackId}/openmaic-classroom/`, artifactPayload);
      const payload = await persisted.json();
      await route.fulfill({
        status: persisted.ok() ? 200 : 502,
        contentType: 'application/json',
        body: JSON.stringify({
          success: persisted.ok(),
          jobId,
          status: scenario,
          artifact: payload.artifact,
          resourcePack: payload.resourcePack,
          traceId: payload.traceId,
          error: payload.error,
        }),
      });
      return;
    }

    const queuedPayload = {
      jobId,
      status: 'queued',
      classroomId: '',
      classroomUrl: '',
      scenesCount: 0,
      pptxExportable: false,
      provider: 'openmaic-generate-classroom',
      elapsedMs: 1,
      degradedReason: '',
    };
    await postDjangoJson(page, `/api/resources/packs/${resourcePackId}/openmaic-classroom/`, queuedPayload);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        jobId,
        status: 'queued',
        step: 'queued',
        pollUrl: `/api/a3/e2e-openmaic-job/${jobId}`,
        pollIntervalMs: 100,
        startedAt: Date.now(),
      }),
    });
  });
  await page.route(`**/api/a3/e2e-openmaic-job/${jobId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        jobId,
        status: scenario,
        done: true,
        error: scenario === 'failed' ? 'OpenMAIC classroom rendering failed' : undefined,
        result: scenario === 'succeeded'
          ? { classroomId: 'classroom-e2e-001', url: '/classroom/classroom-e2e-001', scenesCount: 5 }
          : undefined,
      }),
    });
  });
}

async function mockOpenMAICVideoBridge(page: Page) {
  await page.route('**/api/a3/resources/openmaic-video', async (route) => {
    const body = route.request().postDataJSON() as { resourcePackId: string; resourceType?: string; provider?: string };
    const artifactPayload = {
      type: 'openmaic_video',
      status: 'failed',
      provider: body.provider || 'seedance',
      resourceType: body.resourceType || 'micro_video_script',
      videoUrl: '',
      duration: 0,
      width: 0,
      height: 0,
      elapsedMs: 300,
      degradedReason: 'No API key configured for video provider: seedance',
    };
    const persisted = await postDjangoJson(page, `/api/resources/packs/${body.resourcePackId}/openmaic-video/`, artifactPayload);
    const payload = await persisted.json();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        success: persisted.ok(),
        artifact: payload.artifact,
        resourcePack: payload.resourcePack,
        traceId: payload.traceId,
        degraded: true,
        error: payload.error,
      }),
    });
  });
}

test.describe.serial('A3 OpenMAIC resource pack bridge', () => {
  test.setTimeout(180_000);

  test.beforeEach(() => {
    runManage('seed_demo_data');
  });

  test('resource pack queues OpenMAIC classroom, writes back success, and capabilities display it', async ({ page }) => {
    await mockOpenMAICClassroomBridge(page, 'succeeded');
    await loginAsStudent(page);
    await generateA3ResourcePack(page);
    await page.getByTestId('a3-openmaic-classroom-generate').click();

    await expect(page.getByTestId('a3-openmaic-classroom-open')).toBeVisible({ timeout: 90_000 });

    await openResourcePackDetail(page);
    await expect(page.getByTestId('a3-resource-pack-artifact-history')).toContainText('job-e2e-succeeded');

    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-openmaic-entry')).toContainText('job-e2e-succeeded', { timeout: 60_000 });

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    await expect(page.getByTestId('a3-openmaic-evidence-summary')).toContainText('OpenMAIC 接入证据总览', { timeout: 60_000 });
    await expect(page.getByTestId('a3-openmaic-evidence-summary')).toContainText('页面分工');
    await expect(page.getByTestId('a3-openmaic-evidence-commands')).toContainText('a3-openmaic-bridge.spec.ts');
    await expect(page.getByTestId('a3-openmaic-classroom-capability')).toContainText('job-e2e-succeeded', { timeout: 60_000 });
    await expect(page.getByTestId('a3-openmaic-classroom-capability')).toContainText('exportable');
    await expect(page.getByTestId('a3-openmaic-verification-status')).toContainText('a3-openmaic-bridge.spec.ts');
    await expect(page.getByTestId('a3-openmaic-verification-status')).toContainText('video provider');
    await expect(page.getByTestId('a3-openmaic-smoke-report')).toContainText('tmp/a3-openmaic-smoke-report.json');
    await expect(page.getByTestId('a3-openmaic-smoke-writeback')).toContainText(SMOKE_WRITEBACK_LABEL);
    await expect(page.getByTestId('a3-openmaic-handoff-sync')).toContainText('OpenMAIC 页面分工文档同步');
    await expect(page.getByTestId('a3-openmaic-handoff-sync')).toContainText('100% synced');
    await expect(page.getByTestId('a3-openmaic-handoff-sync')).toContainText('a3-openmaic-page-ownership.test.ts');
    await expect(page.getByTestId('a3-openmaic-readable-ownership')).toContainText(OPENMAIC_OWNERSHIP_TITLE);
    await expect(page.getByTestId('a3-openmaic-readable-ownership')).toContainText('/a3/recommendations');
    await expect(page.getByTestId('a3-openmaic-page-ownership')).toHaveCount(0);

    await loginAsTeacher(page);
    await page.goto('/a3/teacher');
    await expect(page.getByTestId('a3-teacher-workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-teacher-openmaic-artifacts')).toContainText('job-e2e-succeeded');
  });

  test('failed OpenMAIC classroom job writes back degraded artifact and capabilities display it', async ({ page }) => {
    await mockOpenMAICClassroomBridge(page, 'failed');
    await loginAsStudent(page);
    await generateA3ResourcePack(page);
    await page.getByTestId('a3-openmaic-classroom-generate').click();

    await expect(page.getByTestId('a3-openmaic-classroom-summary')).toContainText('OpenMAIC classroom rendering failed', { timeout: 90_000 });

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    await expect(page.getByTestId('a3-openmaic-classroom-capability')).toContainText('failed', { timeout: 60_000 });
    await expect(page.getByTestId('a3-openmaic-classroom-capability')).toContainText('OpenMAIC classroom rendering failed');
  });

  test('micro video script posts to OpenMAIC video API, writes back missing-provider degradation, and capabilities display it', async ({ page }) => {
    await mockOpenMAICVideoBridge(page);
    await loginAsStudent(page);
    await generateA3ResourcePack(page);
    await page.getByTestId('a3-openmaic-video-generate').click();

    await expect(page.getByTestId('a3-openmaic-video-summary')).toContainText('No API key configured', { timeout: 90_000 });

    await openResourcePackDetail(page);
    await expect(page.getByTestId('a3-resource-pack-artifact-history')).toContainText('No API key configured');

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    await expect(page.getByTestId('a3-openmaic-evidence-summary')).toContainText('剩余动作', { timeout: 60_000 });
    await expect(page.getByTestId('a3-openmaic-video-capability')).toContainText('failed', { timeout: 60_000 });
    await expect(page.getByTestId('a3-openmaic-video-capability')).toContainText('seedance');
    await expect(page.getByTestId('a3-openmaic-video-capability')).toContainText('No API key configured');
    await expect(page.getByTestId('a3-openmaic-verification-status')).toContainText('pnpm smoke:a3-video');
    await expect(page.getByTestId('a3-openmaic-smoke-report')).toContainText(/skipped|failed|succeeded|not_run/);
    await expect(page.getByTestId('a3-openmaic-smoke-writeback')).toBeVisible();
    await expect(page.getByTestId('a3-openmaic-smoke-report')).toContainText(
      new RegExp(`${SMOKE_WRITEBACK_GUARD}|${SMOKE_WRITEBACK_READY}|${SMOKE_WRITEBACK_AUTO}`),
    );
  });
});
