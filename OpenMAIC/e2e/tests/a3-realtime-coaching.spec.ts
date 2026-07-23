import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { test } from '../fixtures/base';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
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
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe('A3 realtime coaching', () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('shows fallback call state, visual evidence thumbnails, frame capture and capability metrics', async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`[browser console] ${message.text()}`);
    });
    page.on('pageerror', (error) => console.error(`[browser pageerror] ${error.message}`));
    await page.addInitScript(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      context!.fillStyle = '#2563eb';
      context!.fillRect(0, 0, canvas.width, canvas.height);
      context!.fillStyle = '#ffffff';
      context!.fillText('root locus', 24, 64);
      const stream = canvas.captureStream(5);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => stream,
          getDisplayMedia: async () => stream,
        },
      });
    });
    const browserVisionAssetRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/models/a3-detection/') || request.url().includes('/vendor/mediapipe/')) {
        browserVisionAssetRequests.push(request.url());
      }
    });

    await page.route('**/api/a3/coaching/realtime/session', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          provider: 'local_fallback_record_then_respond',
          model: 'a3-local-fallback',
          connection: { type: 'fallback', readyForBrowserMedia: false },
          coachingSessionId: 'coaching-realtime-e2e',
          fallbackReason: '测试环境未配置实时 provider，已降级到录音转写问答',
          instructions: {
            targetTitle: '根轨迹基础',
            safetyPolicyVersion: 'a3.realtime-safety.v1',
            retrievalPolicyVersion: 'a3.hybrid-rag.v1',
          },
        }),
      });
    });
    await page.route('**/api/a3/coaching/realtime/message', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, session: {} }) });
    });
    await page.route('**/api/a3/coaching/realtime/end', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, summary: {} }) });
    });
    await page.route('**/api/a3/coaching/realtime/tool', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          evidence: [{
            title: '根轨迹课件',
            location: '第 4 章 / 幻灯片 12',
            snippet: '根轨迹渐近线由极点和零点数量差决定。',
            score: 0.91,
            sourceType: 'visual',
            previewUrl: TINY_PNG,
          }],
        }),
      });
    });
    let frameRequestCount = 0;
    let lastFramePayload: Record<string, unknown> | null = null;
    await page.route('**/api/a3/coaching/realtime/frame', async (route) => {
      frameRequestCount += 1;
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      lastFramePayload = payload;
      expect(payload.imageDataUrl).toContain('data:image/jpeg;base64,');
      expect(['camera', 'screen']).toContain(payload.source);
      expect(payload.fast).toBe(true);
      if (payload.region) expect(payload.prompt).toContain('框选区域');
      else expect(payload.prompt).toContain('请看这里');
      expect(payload.prompt).not.toContain('auto_shared_screen');
      expect(payload.prompt).not.toContain('screen_share_auto_frame');
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          reply: '视觉帧已识别：画面里是根轨迹相关题目。',
          verified: true,
          citations: [{
            title: '视觉证据',
            location: '实时截图',
            snippet: '截图包含 root locus 关键文字。',
            sourceType: 'visual',
            previewUrl: TINY_PNG,
          }],
        }),
      });
    });
    await page.route('**/api/demo/status**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildDemoStatusPayload()),
      });
    });
    await page.route('**/api/learning/effect/report/', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, effectReport: {} }) });
    });
    await page.route('**/api/learning/study-plan/**', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, plan: { days: [] } }) });
    });
    await page.route('**/api/a3/system/runtime', async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, overallStatus: 'ok', checks: [] }) });
    });

    await loginAsStudent(page);
    await page.goto('/a3/coaching');
    const call = page.getByTestId('a3-realtime-coaching-call');
    await expect(call).toBeVisible({ timeout: 60_000 });
    await call.getByTestId('a3-realtime-start').click();
    await call.getByTestId('a3-realtime-panel-tab-evidence').click();
    await expect(call.getByTestId('a3-realtime-status')).toContainText('已降级');
    await expect(call).toContainText('测试环境未配置实时 provider');

    await call.getByTestId('a3-realtime-share-screen').click();
    await expect(call).toContainText('屏幕共享已开启。需要 AI 分析当前画面时，请点击“看这里/截屏分析”。');
    await expect.poll(() => frameRequestCount).toBe(0);

    await call.getByLabel('实时检索问题').fill('根轨迹渐近线');
    await call.getByRole('button', { name: '检索' }).click();
    await expect(call.getByTestId('a3-realtime-evidence-list')).toContainText('根轨迹课件');
    await expect(call.locator('img').first()).toBeVisible();

    await call.getByRole('button', { name: '开启摄像头' }).click();
    const cameraPreview = call.getByTestId('a3-realtime-camera-preview');
    const cameraTile = call.getByTestId('a3-realtime-camera-tile');
    await expect(cameraPreview).toBeVisible();
    await expect.poll(() => cameraPreview.evaluate((video) => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await cameraPreview.evaluate((element) => {
      (window as Window & { __a3CameraPreview?: Element }).__a3CameraPreview = element;
    });
    await call.getByTestId('a3-realtime-capture-frame').click();
    await expect.poll(() => frameRequestCount).toBe(1);
    await expect(call).toContainText('视觉帧已识别');

    await cameraTile.click();
    await expect(cameraTile).toHaveAttribute('data-focused', 'true');
    await expect.poll(() => cameraPreview.evaluate((element) => (
      (window as Window & { __a3CameraPreview?: Element }).__a3CameraPreview === element
    ))).toBe(true);

    expect(browserVisionAssetRequests).toHaveLength(0);
    await call.getByTestId('a3-realtime-detection-toggle').click();
    const detectionStatus = call.getByTestId('a3-realtime-detection-status');
    await expect(detectionStatus).toContainText('本地识别已开启', { timeout: 90_000 });
    expect(browserVisionAssetRequests.some((url) => url.endsWith('efficientdet-lite0-int8-v1.tflite'))).toBe(true);
    expect(browserVisionAssetRequests.some((url) => url.includes('/vendor/mediapipe/tasks-vision/0.10.35/wasm/'))).toBe(true);
    expect(frameRequestCount).toBe(1);
    await call.getByTestId('a3-realtime-detection-toggle').click();
    await expect(detectionStatus).toBeHidden();

    await call.getByTestId('a3-realtime-region-toggle').click();
    const regionOverlay = call.getByTestId('a3-realtime-region-overlay');
    const overlayBox = await regionOverlay.boundingBox();
    expect(overlayBox).not.toBeNull();
    if (!overlayBox) throw new Error('Realtime region overlay has no bounding box');
    await page.mouse.move(overlayBox.x + overlayBox.width * 0.35, overlayBox.y + overlayBox.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(overlayBox.x + overlayBox.width * 0.68, overlayBox.y + overlayBox.height * 0.67, { steps: 8 });
    await page.mouse.up();
    await expect(call.getByTestId('a3-realtime-selected-region')).toBeVisible();

    await call.getByTestId('a3-realtime-region-analyze').click();
    await expect.poll(() => frameRequestCount).toBe(2);
    const region = lastFramePayload?.region as Record<string, number> | undefined;
    expect(lastFramePayload?.source).toBe('camera');
    expect(region).toBeDefined();
    expect(region?.x).toBeGreaterThanOrEqual(0);
    expect(region?.y).toBeGreaterThanOrEqual(0);
    expect(region?.width).toBeGreaterThan(0.1);
    expect(region?.height).toBeGreaterThan(0.1);
    expect((region?.x ?? 0) + (region?.width ?? 0)).toBeLessThanOrEqual(1);
    expect((region?.y ?? 0) + (region?.height ?? 0)).toBeLessThanOrEqual(1);

    await call.getByTestId('a3-realtime-focus-return').click();
    await expect(cameraTile).toHaveAttribute('data-focused', 'false');
    await cameraTile.click();
    await expect(cameraTile).toHaveAttribute('data-focused', 'true');
    await page.keyboard.press('Escape');
    await expect(cameraTile).toHaveAttribute('data-focused', 'false');
    await expect.poll(() => cameraPreview.evaluate((element) => (
      (window as Window & { __a3CameraPreview?: Element }).__a3CameraPreview === element
    ))).toBe(true);

    await page.goto('/a3/capabilities', { waitUntil: 'domcontentloaded' });
    const capability = page.getByTestId('a3-realtime-coaching-capability');
    await expect(capability).toBeVisible({ timeout: 60_000 });
    await expect(capability).toContainText('Realtime Coaching');
    await expect(capability).toContainText('visual frames');
    await expect(capability).toContainText('a3.realtime-coaching-metrics.v1');
  });
});

function buildDemoStatusPayload() {
  return {
    success: true,
    summary: {
      profileReady: true,
      pathReady: true,
      recommendationsReady: true,
      verifiedQaReady: true,
      safetyReady: true,
      assessmentLoopReady: true,
    },
    profile: { grade: '大二', majorDirection: '自动化', foundationLevel: '基础', weakPoints: ['根轨迹'], learningGoals: ['掌握控制原理'] },
    path: { title: '自动控制原理个性化学习路径', progress: 42, itemCount: 10 },
    recommendation: { count: 3, sourceCount: 3, fallbackUsed: false },
    verification: { verified: true, citationCount: 2, claimCount: 2, verifiedClaims: 2 },
    safety: { safe: false, category: 'unsafe', reason: '演示安全拦截' },
    evaluation: {
      totalCases: 50,
      groundedCases: 20,
      unsafeCases: 10,
      missingEvidenceCases: 20,
      targetCases: 50,
      scaleReady: true,
      latestMetricsFile: 'backend/tmp/demo_retrieval_metrics.json',
      metrics: { available: true, retrievalTop3HitRate: 95, verifiedCoverage: 90, safetyRefusalRate: 100, missingEvidenceRefusalRate: 100 },
    },
    apis: [],
    system: { overallStatus: 'ok', checks: [] },
    agentRuns: [],
    realtimeCoaching: {
      schemaVersion: 'a3.realtime-coaching-metrics.v1',
      available: true,
      latestProvider: 'dashscope_qwen_omni_realtime',
      sessionCount: 2,
      averageLatencyMs: 920,
      ragToolCallCount: 4,
      ragHitRate: 0.75,
      visualFrameCount: 1,
      verifiedAnswerRate: 0.5,
      fallbackCount: 1,
      latestSessionId: 'coaching-realtime-e2e',
    },
  };
}
