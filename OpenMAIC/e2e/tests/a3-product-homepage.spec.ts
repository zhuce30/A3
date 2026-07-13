import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results');
const TERMINAL_RENDERERS = ['vrm', 'vrm_idle_animation', 'primitive', 'static_fallback'];
const RESOURCE_TYPE_LABELS = [
  '课程讲解文档',
  '知识点速记卡',
  '知识点思维导图',
  '专项练习题',
  '工程实践案例',
  '代码类实操案例',
  '短视频/动画脚本',
] as const;

test.setTimeout(90_000);

async function stubAnonymousUser(page: Page, delayMs = 0) {
  await page.route('**/api/auth/me/', async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    });
  });
}

async function compositedPixelStats(locator: Locator, centerRatio = 1) {
  const screenshot = await locator.screenshot();
  const source = sharp(screenshot);
  const metadata = await source.metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const cropWidth = Math.max(1, Math.floor(width * centerRatio));
  const cropHeight = Math.max(1, Math.floor(height * centerRatio));
  const { data } = await source
    .extract({
      left: Math.floor((width - cropWidth) / 2),
      top: Math.floor((height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    })
    .resize(32, 32, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  let minimum = 255;
  let maximum = 0;
  let edges = 0;
  const colors = new Set<string>();

  for (let index = 0; index < data.length; index += 4) {
    const lightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
    if (data[index + 3] > 0) opaque += 1;
    minimum = Math.min(minimum, lightness);
    maximum = Math.max(maximum, lightness);
    colors.add(`${data[index] >> 3}:${data[index + 1] >> 3}:${data[index + 2] >> 3}`);
    if (index >= 4) {
      const previous = (data[index - 4] + data[index - 3] + data[index - 2]) / 3;
      if (Math.abs(lightness - previous) > 10) edges += 1;
    }
  }

  return { edges, opaque, uniqueColors: colors.size, variance: maximum - minimum };
}

function boxesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

async function expectProductImagesReadable(page: Page) {
  const images = page.locator('section[data-story] figure img');
  expect(await images.count()).toBeGreaterThanOrEqual(5);

  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        image.evaluate((node) => ({
          complete: node.complete,
          naturalWidth: node.naturalWidth,
          naturalHeight: node.naturalHeight,
          objectFit: getComputedStyle(node).objectFit,
          imageBox: node.getBoundingClientRect().toJSON(),
          frameBox: node.parentElement?.getBoundingClientRect().toJSON() ?? null,
        })),
      )
      .toMatchObject({ complete: true, objectFit: 'contain' });

    const geometry = await image.evaluate((node) => ({
      naturalWidth: node.naturalWidth,
      naturalHeight: node.naturalHeight,
      imageBox: node.getBoundingClientRect().toJSON(),
      frameBox: node.parentElement?.getBoundingClientRect().toJSON() ?? null,
    }));
    expect(geometry.naturalWidth).toBeGreaterThan(300);
    expect(Math.min(geometry.naturalWidth, geometry.naturalHeight)).toBeGreaterThan(120);
    expect(geometry.naturalWidth * geometry.naturalHeight).toBeGreaterThan(40_000);
    expect(geometry.frameBox).not.toBeNull();
    expect(geometry.imageBox.left).toBeGreaterThanOrEqual((geometry.frameBox?.left ?? 0) - 1);
    expect(geometry.imageBox.right).toBeLessThanOrEqual((geometry.frameBox?.right ?? 0) + 1);
  }
}

async function expectResourceShowcaseReadable(page: Page) {
  const section = page.getByTestId('a3-homepage-resources');
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();

  for (const label of RESOURCE_TYPE_LABELS) {
    await expect(section.getByText(label, { exact: true })).toBeVisible();
  }

  const image = section.getByRole('img', { name: '个性化多模态资源包界面' });
  const index = section.getByRole('list', { name: '多模态资源类型' });
  const cta = section.getByRole('link', { name: '查看个性化资源' });
  await expect(image).toBeVisible();
  await expect(cta).toBeVisible();
  await expect.poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0)).toBe(true);
  expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await cta.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);

  const [indexBox, imageBox] = await Promise.all([index.boundingBox(), image.boundingBox()]);
  expect(indexBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(boxesOverlap(indexBox!, imageBox!)).toBe(false);
}

async function expectHeaderAndHero(page: Page, viewportHeight: number) {
  const header = page.locator('header');
  const brand = page.getByRole('link', { name: '智学引擎首页' });
  const headerCta = header.getByRole('link', { name: '开启旅程' });
  const heading = page.getByRole('heading', { name: '每一步学习， 都更懂你。' });
  const support = page.getByText('一群懂学习的智能体，陪你找到自己的节奏。');
  const heroCta = page.getByRole('link', { name: '开启我的智学旅程' }).first();
  const firstImage = page
    .getByTestId('a3-homepage-hero-stage')
    .getByRole('img', { name: '学习画像界面' });

  await expect(brand).toBeVisible();
  await expect(headerCta).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(support).toBeVisible();
  await expect(heroCta).toBeVisible();
  await expect(firstImage).toBeVisible();
  await expect
    .poll(() => firstImage.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);

  const [brandBox, headerCtaBox, headingBox, supportBox, heroCtaBox, imageBox] = await Promise.all([
    brand.boundingBox(),
    headerCta.boundingBox(),
    heading.boundingBox(),
    support.boundingBox(),
    heroCta.boundingBox(),
    firstImage.boundingBox(),
  ]);
  expect(brandBox).not.toBeNull();
  expect(headerCtaBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  expect(supportBox).not.toBeNull();
  expect(heroCtaBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect((brandBox?.x ?? 0) + (brandBox?.width ?? 0)).toBeLessThan(headerCtaBox?.x ?? 0);
  expect((headingBox?.y ?? 0) + (headingBox?.height ?? 0)).toBeLessThan(supportBox?.y ?? 0);
  expect((supportBox?.y ?? 0) + (supportBox?.height ?? 0)).toBeLessThan(heroCtaBox?.y ?? 0);
  expect(boxesOverlap(heroCtaBox!, imageBox!)).toBe(false);

  const nextSectionTop = await page
    .getByTestId('a3-homepage-profile')
    .evaluate((node) => node.getBoundingClientRect().top);
  expect(nextSectionTop).toBeLessThan(viewportHeight - 8);
  expect(nextSectionTop).toBeGreaterThan(viewportHeight * 0.78);
  const nextChapterLabel = page.getByTestId('a3-homepage-profile').getByText('01 / PROFILE');
  const nextChapterBox = await nextChapterLabel.boundingBox();
  expect(nextChapterBox).not.toBeNull();
  expect(nextChapterBox?.y).toBeLessThan(viewportHeight - 8);
}

test('renders the public product homepage before a slow auth check resolves', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__a3HomepagePaintMs', {
      configurable: true,
      value: null,
      writable: true,
    });
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[data-testid="a3-product-homepage"]')) return;
      (window as typeof window & { __a3HomepagePaintMs: number | null }).__a3HomepagePaintMs =
        performance.now();
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  let authStarted = false;
  let authResolved = false;
  let releaseAuth: (() => void) | undefined;
  const deferredAuth = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  await page.route('**/api/auth/me/', async (route) => {
    authStarted = true;
    await deferredAuth;
    authResolved = true;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    });
  });
  await page.goto('/a3', { waitUntil: 'commit' });
  await expect(page.getByTestId('a3-product-homepage')).toBeVisible();
  await expect(page.getByRole('heading', { name: '每一步学习， 都更懂你。' })).toBeVisible();
  await expect(page.getByRole('link', { name: '开启我的智学旅程' }).first()).toBeVisible();
  await expect.poll(() => authStarted).toBe(true);
  expect(authResolved).toBe(false);
  const homepagePaintMs = await page.evaluate(
    () => (window as typeof window & { __a3HomepagePaintMs: number | null }).__a3HomepagePaintMs,
  );
  expect(homepagePaintMs).not.toBeNull();
  expect(homepagePaintMs).toBeLessThan(1_000);
  releaseAuth?.();
  await expect.poll(() => authResolved).toBe(true);
});

test('review entry exposes the approved account without bypassing login', async ({ page }) => {
  await stubAnonymousUser(page);
  await page.goto('/a3');
  await page.getByRole('link', { name: '评审体验' }).first().click();

  await expect(page).toHaveURL(/\/a3\/login\?mode=review$/);
  await expect(page.getByTestId('a3-review-login-panel')).toBeVisible();
  await page.getByTestId('a3-review-fill-account').click();
  await expect(page.getByLabel('账号')).toHaveValue('13800000001');
  await expect(page.locator('input[autocomplete="current-password"]')).toHaveValue('Demo@123456');
  await expect(page).toHaveURL(/\/a3\/login/);
});

test('anchors reveal real evidence and classroom citations without mutating data', async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.route('**/*', async (route) => {
    const method = route.request().method();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      mutations.push(`${method} ${route.request().url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await stubAnonymousUser(page);
  await page.goto('/a3');

  const desktopNav = page.getByRole('navigation', { name: '首页导航' });
  for (const anchor of ['#capabilities', '#learning-loop', '#evidence', '#contact']) {
    await desktopNav.locator(`a[href="${anchor}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${anchor}$`));
    await expect(page.locator(anchor)).toBeInViewport();
  }

  const evidence = page.getByTestId('a3-homepage-evidence');
  await expect(evidence).toContainText('资料可检索');
  await expect(evidence).toContainText('来源可验证');
  await expect(evidence).toContainText('结果会写回');

  const classroomModes = page.getByRole('group', { name: '课堂展示模式' });
  await classroomModes.getByRole('button', { name: '引用' }).click();
  await expect(page.getByText('操作系统 / 第 3 章 / 课程 PPT')).toBeVisible();
  await expect(page.getByText('进程调度 / 知识总结')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  expect(mutations).toEqual([]);
});

test('deep coaching entry sends a guest through login with a safe return target', async ({
  page,
}) => {
  await stubAnonymousUser(page);
  await page.goto('/a3');
  await page.getByTestId('a3-homepage-teacher-stage').scrollIntoViewIfNeeded();
  await page.getByRole('link', { name: '进入实时辅导' }).click();
  await expect(page).toHaveURL(/\/a3\/login\?next=%2Fa3%2Fcoaching$/);
  expect(new URL(page.url()).searchParams.get('next')).toBe('/a3/coaching');
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test(`${viewport.name} layout keeps the complete product story readable`, async ({ page }) => {
    await stubAnonymousUser(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/a3');
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

    await expectNoHorizontalOverflow(page);
    await expectHeaderAndHero(page, viewport.height);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `a3-homepage-${viewport.name}-hero.png`),
      animations: 'disabled',
    });
    await expectProductImagesReadable(page);
    await expectResourceShowcaseReadable(page);

    const footer = page.locator('footer');
    await footer.scrollIntoViewIfNeeded();
    const competition = footer.getByText(
      '比赛：A3-基于大模型的个性化资源生成与学习多智能体系统开发',
    );
    const email = footer.getByRole('link', { name: '邮箱：3062221819@qq.com' });
    await expect(competition).toBeVisible();
    await expect(email).toBeVisible();
    const [competitionBox, emailBox] = await Promise.all([
      competition.boundingBox(),
      email.boundingBox(),
    ]);
    expect(competitionBox).not.toBeNull();
    expect(emailBox).not.toBeNull();
    const boxesOverlap = !(
      (competitionBox?.x ?? 0) + (competitionBox?.width ?? 0) <= (emailBox?.x ?? 0) ||
      (emailBox?.x ?? 0) + (emailBox?.width ?? 0) <= (competitionBox?.x ?? 0) ||
      (competitionBox?.y ?? 0) + (competitionBox?.height ?? 0) <= (emailBox?.y ?? 0) ||
      (emailBox?.y ?? 0) + (emailBox?.height ?? 0) <= (competitionBox?.y ?? 0)
    );
    expect(boxesOverlap).toBe(false);
    expect(await competition.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(
      true,
    );
    await expectNoHorizontalOverflow(page);
    await footer.screenshot({
      path: path.join(SCREENSHOT_DIR, `a3-homepage-${viewport.name}-footer.png`),
      animations: 'disabled',
    });

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `a3-homepage-${viewport.name}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}

for (const viewport of [
  { name: 'short-mobile', width: 390, height: 667 },
  { name: 'compact-mobile', width: 375, height: 568 },
] as const) {
  test(`${viewport.name} keeps the entire hero and next chapter cue in one viewport`, async ({
    page,
  }) => {
    await stubAnonymousUser(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/a3');
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

    await expectNoHorizontalOverflow(page);
    await expectHeaderAndHero(page, viewport.height);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `a3-homepage-${viewport.name}-hero.png`),
      animations: 'disabled',
    });
  });
}

test('reduced motion keeps every key chapter and the static hero readable', async ({ page }) => {
  await stubAnonymousUser(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');

  const firstHeroImage = page
    .getByTestId('a3-homepage-hero-stage')
    .getByRole('img', { name: '学习画像界面' });
  await expect(firstHeroImage).toBeVisible();
  await expect
    .poll(() => firstHeroImage.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);

  for (const testId of [
    'a3-homepage-profile',
    'a3-homepage-diagnostic',
    'a3-homepage-knowledge',
    'a3-homepage-resources',
    'a3-homepage-classroom',
    'a3-homepage-coaching',
    'a3-homepage-evidence',
    'a3-homepage-teacher',
  ]) {
    const chapter = page.getByTestId(testId);
    await chapter.scrollIntoViewIfNeeded();
    await expect(chapter).toBeVisible();
  }

  const teacher = page.getByTestId('a3-homepage-teacher-stage');
  await expect(teacher.locator('canvas')).toHaveCount(0);
  await expect(teacher.getByTestId('a3-digital-human-avatar')).toHaveCount(0);
  await expect(teacher.getByTestId('a3-homepage-teacher-fallback')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

async function loadTerminalTeacher(page: Page) {
  await stubAnonymousUser(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute('data-renderer', 'terminal', { timeout: 30_000 });
  const renderer = stage.locator('[data-avatar-renderer]');
  await expect(renderer).toHaveAttribute(
    'data-avatar-renderer',
    new RegExp(TERMINAL_RENDERERS.join('|')),
  );
  await expect(renderer).not.toHaveAttribute('data-avatar-renderer', 'loading');
  const rendererName = await renderer.getAttribute('data-avatar-renderer');
  return { renderer, rendererName, stage };
}

test('normal motion presents a complete nonblank teacher to the user', async ({ page }) => {
  const { renderer, rendererName, stage } = await loadTerminalTeacher(page);
  const fallback = stage.getByTestId('a3-homepage-teacher-fallback');
  if (rendererName === 'primitive') {
    await expect(fallback).toBeVisible();
    await expect
      .poll(() =>
        fallback
          .locator('img')
          .evaluate((node) => node.complete && node.naturalWidth > 0 && node.naturalHeight > 0),
      )
      .toBe(true);
  } else {
    await expect(fallback).toHaveCount(0, { timeout: 5_000 });
  }

  const visual = stage.getByTestId('a3-homepage-teacher-visual');
  const [visualBox, rendererBox] = await Promise.all([
    visual.boundingBox(),
    renderer.boundingBox(),
  ]);
  expect(rendererBox).not.toBeNull();
  expect(rendererBox?.x).toBeGreaterThanOrEqual((visualBox?.x ?? 0) - 1);
  expect(rendererBox?.y).toBeGreaterThanOrEqual((visualBox?.y ?? 0) - 1);
  expect((rendererBox?.x ?? 0) + (rendererBox?.width ?? 0)).toBeLessThanOrEqual(
    (visualBox?.x ?? 0) + (visualBox?.width ?? 0) + 1,
  );
  expect((rendererBox?.y ?? 0) + (rendererBox?.height ?? 0)).toBeLessThanOrEqual(
    (visualBox?.y ?? 0) + (visualBox?.height ?? 0) + 1,
  );

  const stats = await compositedPixelStats(visual, 0.5);
  expect(stats.opaque).toBeGreaterThan(700);
  expect(stats.variance).toBeGreaterThan(12);
  expect(stats.uniqueColors).toBeGreaterThan(8);
  expect(stats.edges).toBeGreaterThan(8);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await visual.screenshot({ path: path.join(SCREENSHOT_DIR, 'a3-homepage-teacher.png') });
});

test('normal motion independently renders a nonblank underlying teacher canvas', async ({
  page,
}) => {
  const { renderer, rendererName, stage } = await loadTerminalTeacher(page);
  const canvas = stage.getByTestId('a3-digital-human-three-canvas');

  if (rendererName === 'static_fallback') {
    await expect(canvas).toHaveCount(0);
    const builtInFallback = stage.getByTestId('a3-digital-human-static-fallback');
    await expect(builtInFallback).toBeVisible();
    const stats = await compositedPixelStats(builtInFallback, 0.5);
    expect(stats.opaque).toBeGreaterThan(700);
    expect(stats.uniqueColors).toBeGreaterThan(8);
    return;
  }

  await expect(renderer).toHaveAttribute(
    'data-avatar-renderer',
    /vrm|vrm_idle_animation|primitive/,
  );
  await expect(canvas).toBeVisible();
  await page.addStyleTag({
    content: `
      [data-testid='a3-homepage-teacher-fallback'],
      [data-testid='a3-homepage-teacher-stage'] > :not([data-testid='a3-homepage-teacher-visual']) {
        visibility: hidden !important;
      }
    `,
  });
  const stats = await compositedPixelStats(canvas, 0.5);
  expect(stats.opaque).toBeGreaterThan(700);
  expect(stats.variance).toBeGreaterThan(12);
  expect(stats.uniqueColors).toBeGreaterThan(6);
  expect(stats.edges).toBeGreaterThan(6);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await canvas.screenshot({ path: path.join(SCREENSHOT_DIR, 'a3-homepage-teacher-canvas.png') });
});
