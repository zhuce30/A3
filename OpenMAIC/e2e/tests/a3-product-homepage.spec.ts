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

async function waitForStableHomepage(page: Page) {
  await page.waitForFunction(async () => {
    const root = document.querySelector('[data-testid="a3-product-homepage"]');
    if (!root) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    return (
      root.isConnected && root === document.querySelector('[data-testid="a3-product-homepage"]')
    );
  });
}

async function scrollHomepageTeacherIntoView(page: Page) {
  await waitForStableHomepage(page);
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>(
      'main [data-testid="a3-homepage-teacher-stage"]',
    );
    return stage?.isConnected && stage.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('main [data-testid="a3-homepage-teacher-stage"]')
      ?.scrollIntoView({ block: 'center' });
  });
  return page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
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

async function visibleBoundingBox(locator: Locator) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const box = await locator.evaluateAll((nodes) => {
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });
    if (box) return box;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
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
      isTopLayer: (() => {
        const box = node.getBoundingClientRect();
        return (
          document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node
        );
      })(),
    }));
    expect(geometry.naturalWidth).toBeGreaterThan(300);
    expect(Math.min(geometry.naturalWidth, geometry.naturalHeight)).toBeGreaterThan(120);
    expect(geometry.naturalWidth * geometry.naturalHeight).toBeGreaterThan(40_000);
    expect(geometry.isTopLayer).toBe(true);
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
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);
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
  const headerCta = header.getByRole('link', { name: '开始体验' });
  const heading = page.getByRole('heading', {
    name: '智学引擎 把每一次学习，接到下一步。',
  });
  const support = page.getByRole('main').getByText(
    '从诊断、今日计划到课堂、测评和错题复习，每一次结果都会更新后续安排。',
  );
  const heroCta = page.getByRole('main').getByRole('link', { name: '开始体验', exact: true });
  const firstImage = page
    .getByTestId('a3-homepage-hero-stage')
    .getByRole('img', { name: '今日任务与学习计划界面' });

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
    visibleBoundingBox(brand),
    visibleBoundingBox(headerCta),
    visibleBoundingBox(heading),
    visibleBoundingBox(support),
    visibleBoundingBox(heroCta),
    visibleBoundingBox(firstImage),
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
    .getByRole('main')
    .getByTestId('a3-homepage-today')
    .evaluate((node) => node.getBoundingClientRect().top);
  expect(nextSectionTop).toBeLessThan(viewportHeight - 8);
  expect(nextSectionTop).toBeGreaterThan(viewportHeight * 0.78);
  const nextChapterLabel = page.getByRole('main').getByTestId('a3-homepage-today').getByText('01 / TODAY');
  const nextChapterBox = await nextChapterLabel.boundingBox();
  expect(nextChapterBox).not.toBeNull();
  expect(nextChapterBox?.y).toBeLessThan(viewportHeight - 8);
}

test('renders the public product homepage without starting an auth check', async ({ page }) => {
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
  const unrelatedRequests: string[] = [];
  await page.route('**/api/auth/me/', async (route) => {
    unrelatedRequests.push('/api/auth/me/');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    });
  });
  await page.route('**/api/server-providers', async (route) => {
    unrelatedRequests.push('/api/server-providers');
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/access-code/status', async (route) => {
    unrelatedRequests.push('/api/access-code/status');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, authenticated: false }),
    });
  });
  await page.goto('/a3', { waitUntil: 'commit' });
  const productHomepage = page.getByTestId('a3-product-homepage').first();
  await expect(productHomepage).toBeVisible();
  await expect(productHomepage).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  await expect(
    page.getByRole('heading', { name: '智学引擎 把每一次学习，接到下一步。' }),
  ).toBeVisible();
  const primaryCta = page.getByRole('main').getByRole('link', { name: '开始体验', exact: true });
  await expect(primaryCta).toBeVisible();
  await expect(primaryCta).toHaveCSS('background-color', 'rgb(36, 92, 72)');
  await page.waitForTimeout(500);
  expect(unrelatedRequests).toEqual([]);
  const homepagePaintMs = await page.evaluate(
    () => (window as typeof window & { __a3HomepagePaintMs: number | null }).__a3HomepagePaintMs,
  );
  const responseEndMs = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return navigation?.responseEnd ?? 0;
  });
  expect(homepagePaintMs).not.toBeNull();
  expect((homepagePaintMs ?? Number.POSITIVE_INFINITY) - responseEndMs).toBeLessThan(1_000);
});

test('login entry opens the real login page without a review shortcut', async ({ page }) => {
  await stubAnonymousUser(page);
  await page.goto('/a3');
  await page.getByRole('link', { name: '登录', exact: true }).first().click();

  await expect(page).toHaveURL(/\/a3\/login$/, { timeout: 30_000 });
  await expect(page.getByLabel('账号')).toBeVisible();
  await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
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
  for (const anchor of ['#daily-learning', '#product-evidence', '#evidence', '#teacher']) {
    await desktopNav.locator(`a[href="${anchor}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${anchor}$`));
    await expect(page.locator(anchor)).toBeInViewport();
  }

  const evidence = page.getByTestId('a3-homepage-evidence');
  await expect(evidence).toContainText('53 条用例');
  await expect(evidence).toContainText('18 条流程');
  await expect(evidence).toContainText('六类资源');

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
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  const teacherStage = await scrollHomepageTeacherIntoView(page);
  await teacherStage.getByRole('link', { name: '进入实时辅导' }).click();
  await expect(page).toHaveURL(/\/a3\/login\?next=%2Fa3%2Fcoaching$/, { timeout: 30_000 });
  expect(new URL(page.url()).searchParams.get('next')).toBe('/a3/coaching');
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test(`${viewport.name} layout keeps the complete product story readable`, async ({ page }) => {
    await stubAnonymousUser(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/a3', { waitUntil: 'domcontentloaded' });
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
    const copyright = footer.getByText('智学引擎产品团队');
    const help = footer.getByRole('link', { name: '产品帮助中心' });
    await expect(copyright).toBeVisible();
    await expect(help).toBeVisible();
    const [copyrightBox, helpBox] = await Promise.all([
      copyright.boundingBox(),
      help.boundingBox(),
    ]);
    expect(copyrightBox).not.toBeNull();
    expect(helpBox).not.toBeNull();
    const boxesOverlap = !(
      (copyrightBox?.x ?? 0) + (copyrightBox?.width ?? 0) <= (helpBox?.x ?? 0) ||
      (helpBox?.x ?? 0) + (helpBox?.width ?? 0) <= (copyrightBox?.x ?? 0) ||
      (copyrightBox?.y ?? 0) + (copyrightBox?.height ?? 0) <= (helpBox?.y ?? 0) ||
      (helpBox?.y ?? 0) + (helpBox?.height ?? 0) <= (copyrightBox?.y ?? 0)
    );
    expect(boxesOverlap).toBe(false);
    expect(await copyright.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
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
    await page.goto('/a3', { waitUntil: 'domcontentloaded' });
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
    .getByRole('img', { name: '今日任务与学习计划界面' });
  await expect(firstHeroImage).toBeVisible();
  await expect
    .poll(() => firstHeroImage.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);

  for (const testId of [
    'a3-homepage-today',
    'a3-homepage-profile',
    'a3-homepage-diagnostic',
    'a3-homepage-knowledge',
    'a3-homepage-resources',
    'a3-homepage-classroom',
    'a3-homepage-coaching',
    'a3-homepage-assessment-review',
    'a3-homepage-progress-refresh',
    'a3-homepage-teacher',
    'a3-homepage-evidence',
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
