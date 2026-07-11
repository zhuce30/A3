import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { installCaptureRequestPolicy } from './a3-homepage-capture-policy.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, '..');
const outputDir = path.join(projectDir, 'public/a3/assets/homepage');
const baseURL = (process.env.A3_CAPTURE_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const password = process.env.A3_CAPTURE_PASSWORD ?? 'Demo@123456';
const defaultViewport = { width: 1440, height: 1000 };

const blockedWrites = [];
const failedResponses = [];
const browserErrors = [];

const studentAssets = [
  {
    route: '/a3/profile-setup',
    filename: 'profile.webp',
    testId: 'a3-profile-setup-view',
    ready: async (page) => page.getByText('已同步', { exact: true }).waitFor({ timeout: 60_000 }),
    height: 920,
  },
  {
    route: '/a3/admission-diagnostic',
    filename: 'diagnostic.webp',
    testId: 'a3-admission-diagnostic-view',
    ready: async (page) =>
      page.getByTestId('a3-admission-question').first().waitFor({ timeout: 60_000 }),
    height: 920,
  },
  {
    route: '/a3/knowledge-base',
    filename: 'knowledge-base.webp',
    testId: 'a3-knowledge-base-view',
    ready: async (page) =>
      page.getByTestId('a3-kb-resource-row').first().waitFor({ timeout: 60_000 }),
    height: 960,
  },
  {
    route: '/a3/classroom',
    filename: 'classroom.webp',
    testId: 'a3-classroom-view',
    focusTestId: 'a3-classroom-dialogue',
    focusAncestor: 'section',
    viewport: { width: 1920, height: 1080 },
    ready: async (page) => {
      await page.getByTestId('a3-classroom-input').waitFor({ timeout: 60_000 });
      await page
        .getByTestId('a3-classroom-view')
        .locator('.animate-spin')
        .first()
        .waitFor({ state: 'detached', timeout: 60_000 });
    },
    height: 900,
  },
  {
    route: '/a3/coaching',
    filename: 'teacher-fallback.webp',
    testId: 'a3-digital-human-avatar',
    canvasTestId: 'a3-digital-human-three-canvas',
    resizeWidth: 720,
    allowEnlargement: true,
    ready: async (page) => {
      const stage = page.getByTestId('a3-digital-human-three-stage');
      await stage.waitFor({ timeout: 60_000 });
      await page.waitForFunction(
        () => {
          const element = document.querySelector('[data-testid="a3-digital-human-three-stage"]');
          return element?.getAttribute('data-avatar-renderer')?.startsWith('vrm');
        },
        undefined,
        { timeout: 60_000 },
      );
      await page.getByTestId('a3-digital-human-three-canvas').waitFor({ timeout: 60_000 });
    },
    height: 700,
  },
];

const teacherAssets = [
  {
    route: '/a3/teacher',
    filename: 'teacher-workbench.webp',
    testId: 'a3-teacher-workbench',
    ready: async (page) => {
      const heading = page.getByText('班级学情概览', { exact: true });
      await heading.waitFor({ timeout: 60_000 });
      await heading
        .locator('xpath=ancestor::section[1]')
        .locator('tbody tr')
        .first()
        .waitFor({ timeout: 60_000 });
    },
    focusHeading: '班级学情概览',
    height: 430,
  },
];

function watchPage(page) {
  let monitorFailedResponses = false;

  page.on('pageerror', (error) => {
    if (monitorFailedResponses) browserErrors.push(error.message);
  });

  page.on('response', (response) => {
    if (!monitorFailedResponses) return;
    if (response.status() < 400) return;
    const url = response.url();
    if (url.startsWith(baseURL) || url.includes('/api/')) {
      failedResponses.push(`${response.status()} ${url}`);
    }
  });

  return () => {
    monitorFailedResponses = true;
  };
}

async function login(page, identifier) {
  await page.goto(`${baseURL}/a3/login`, { waitUntil: 'domcontentloaded' });
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(identifier);
  await inputs.nth(1).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/a3/login'), { timeout: 60_000 });
}

async function capture(page, asset) {
  await page.setViewportSize(asset.viewport ?? defaultViewport);
  await page.goto(`${baseURL}${asset.route}`, { waitUntil: 'domcontentloaded' });
  const pageTarget = page.getByTestId(asset.testId).first();
  await pageTarget.waitFor({ state: 'visible', timeout: 60_000 });
  await pageTarget.scrollIntoViewIfNeeded();
  await asset.ready(page);
  let target = asset.focusHeading
    ? pageTarget
        .getByRole('heading', { name: asset.focusHeading, exact: true })
        .locator('xpath=ancestor::section[1]')
    : pageTarget;
  if (asset.focusTestId) {
    target = pageTarget.getByTestId(asset.focusTestId).first();
    if (asset.focusAncestor) target = target.locator(`xpath=ancestor::${asset.focusAncestor}[1]`);
  }
  await target.waitFor({ state: 'visible', timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(asset.filename === 'teacher-fallback.webp' ? 2_000 : 400);

  const targetText = await target.innerText();
  const sensitivePatterns = [
    /\b1[3-9]\d{9}\b/,
    /\b[A-Z]:\\/i,
    /\b[A-Z]:\//i,
    /(?:api[_-]?key|secret|token)\s*[:=]/i,
    /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/,
  ];
  for (const pattern of sensitivePatterns) {
    if (pattern.test(targetText)) {
      throw new Error(`${asset.filename} contains sensitive text matching ${pattern}`);
    }
  }
  if (asset.filename === 'teacher-workbench.webp' && /OpenMAIC/i.test(targetText)) {
    throw new Error('teacher-workbench.webp includes the hidden platform brand');
  }
  if (
    /正在进入智学引擎|正在准备入学诊断|正在读取资料|数字助教加载中|教师工作台加载失败/.test(
      targetText,
    )
  ) {
    throw new Error(`${asset.filename} still contains a loading or error state`);
  }

  let png;
  if (asset.canvasTestId) {
    const dataUrl = await page.getByTestId(asset.canvasTestId).evaluate(
      (canvas) =>
        new Promise((resolve) => {
          requestAnimationFrame(() => resolve(canvas.toDataURL('image/png')));
        }),
    );
    png = Buffer.from(dataUrl.split(',', 2)[1], 'base64');
  } else {
    png = await target.screenshot({ type: 'png', animations: 'disabled' });
  }
  const metadata = await sharp(png).metadata();
  if (!metadata.width || !metadata.height)
    throw new Error(`Unable to read ${asset.filename} dimensions`);

  const top = Math.min(asset.cropTop ?? 0, Math.max(0, metadata.height - 1));
  const height = Math.min(asset.height, metadata.height - top);
  if (height < 360) throw new Error(`${asset.filename} crop is only ${height}px tall`);

  const outputPath = path.join(outputDir, asset.filename);
  await sharp(png)
    .extract({ left: 0, top, width: metadata.width, height })
    .resize({
      width: asset.resizeWidth ?? 1440,
      withoutEnlargement: !asset.allowEnlargement,
    })
    .webp({ quality: 84, effort: 5 })
    .toFile(outputPath);

  const result = await sharp(outputPath).metadata();
  console.log(`${asset.filename}: ${result.width}x${result.height}`);
}

async function captureForAccount(browser, identifier, assets) {
  const context = await browser.newContext({
    viewport: defaultViewport,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  await installCaptureRequestPolicy(context, {
    allowedOrigin: new URL(baseURL).origin,
    onBlockedWrite: (write) => blockedWrites.push(write),
  });
  const page = await context.newPage();
  const monitorFailedResponses = watchPage(page);

  try {
    await login(page, identifier);
    monitorFailedResponses();
    for (const asset of assets) await capture(page, asset);
  } finally {
    await context.close();
  }
}

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();

try {
  await captureForAccount(browser, '13800000001', studentAssets);
  await captureForAccount(browser, '13800000002', teacherAssets);
} finally {
  await browser.close();
}

if (blockedWrites.length) {
  throw new Error(
    `Capture blocked forbidden business writes before sending:\n${blockedWrites
      .map((write) => `${write.method} ${write.url}`)
      .join('\n')}`,
  );
}

if (failedResponses.length) {
  throw new Error(`Capture observed failed page or API responses:\n${failedResponses.join('\n')}`);
}

if (browserErrors.length) {
  throw new Error(`Capture observed browser errors:\n${browserErrors.join('\n')}`);
}
