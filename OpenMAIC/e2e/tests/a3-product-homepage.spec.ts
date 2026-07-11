import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results');
const TERMINAL_RENDERERS = ['vrm', 'vrm_idle_animation', 'primitive', 'static_fallback'];

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

async function compositedPixelStats(locator: Locator) {
  const screenshot = await locator.screenshot();
  const { data } = await sharp(screenshot)
    .resize(32, 32, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  let minimum = 255;
  let maximum = 0;

  for (let index = 0; index < data.length; index += 4) {
    const lightness = (data[index] + data[index + 1] + data[index + 2]) / 3;
    if (data[index + 3] > 0) opaque += 1;
    minimum = Math.min(minimum, lightness);
    maximum = Math.max(maximum, lightness);
  }

  return { opaque, variance: maximum - minimum };
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
    expect(geometry.naturalHeight).toBeGreaterThan(180);
    expect(geometry.frameBox).not.toBeNull();
    expect(geometry.imageBox.left).toBeGreaterThanOrEqual((geometry.frameBox?.left ?? 0) - 1);
    expect(geometry.imageBox.right).toBeLessThanOrEqual((geometry.frameBox?.right ?? 0) + 1);
  }
}

async function expectHeaderAndHero(page: Page, viewportHeight: number) {
  const header = page.locator('header');
  const brand = page.getByRole('link', { name: '智学引擎首页' });
  const headerCta = header.getByRole('link', { name: '开启旅程' });
  const heading = page.getByRole('heading', { name: '每一步学习， 都更懂你。' });
  const heroCta = page.getByRole('link', { name: '开启我的智学旅程' }).first();
  const firstImage = page
    .getByTestId('a3-homepage-hero-stage')
    .getByRole('img', { name: '学习画像界面' });

  await expect(brand).toBeVisible();
  await expect(headerCta).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(heroCta).toBeVisible();
  await expect(firstImage).toBeVisible();
  await expect
    .poll(() => firstImage.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);

  const [brandBox, headerCtaBox, headingBox, heroCtaBox] = await Promise.all([
    brand.boundingBox(),
    headerCta.boundingBox(),
    heading.boundingBox(),
    heroCta.boundingBox(),
  ]);
  expect(brandBox).not.toBeNull();
  expect(headerCtaBox).not.toBeNull();
  expect((brandBox?.x ?? 0) + (brandBox?.width ?? 0)).toBeLessThan(headerCtaBox?.x ?? 0);
  expect((headingBox?.y ?? 0) + (headingBox?.height ?? 0)).toBeLessThan(heroCtaBox?.y ?? 0);

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
  await page.route('**/api/auth/me/', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    });
  });
  await page.goto('/a3', { waitUntil: 'commit' });
  await expect(page.getByTestId('a3-product-homepage')).toBeVisible();
  await expect(page.getByRole('heading', { name: '每一步学习， 都更懂你。' })).toBeVisible();
  await expect(page.getByRole('link', { name: '开启我的智学旅程' }).first()).toBeVisible();
  const homepagePaintMs = await page.evaluate(
    () =>
      (window as typeof window & { __a3HomepagePaintMs: number | null }).__a3HomepagePaintMs,
  );
  expect(homepagePaintMs).not.toBeNull();
  expect(homepagePaintMs).toBeLessThan(1_000);
});

test('review entry exposes the approved account without bypassing login', async ({ page }) => {
  await stubAnonymousUser(page);
  await page.goto('/a3');
  await page.getByRole('link', { name: '评审体验' }).first().click();

  await expect(page).toHaveURL(/\/a3\/login\?mode=review$/);
  await expect(page.getByTestId('a3-review-login-panel')).toBeVisible();
  await page.getByTestId('a3-review-fill-account').click();
  await expect(page.getByLabel('账号')).toHaveValue('13800000001');
  await expect(page.locator('input[autocomplete="current-password"]')).toHaveValue(
    'Demo@123456',
  );
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
    expect(
      await competition.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
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

test('normal motion hands the teacher stage to a nonblank terminal renderer', async ({ page }) => {
  await stubAnonymousUser(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');

  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute('data-renderer', 'terminal', { timeout: 30_000 });
  const renderer = stage.locator('[data-avatar-renderer]');
  await expect(renderer).toHaveAttribute('data-avatar-renderer', new RegExp(TERMINAL_RENDERERS.join('|')));
  await expect(renderer).not.toHaveAttribute('data-avatar-renderer', 'loading');
  const rendererName = await renderer.getAttribute('data-avatar-renderer');
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
  const [visualBox, rendererBox] = await Promise.all([visual.boundingBox(), renderer.boundingBox()]);
  expect(rendererBox).not.toBeNull();
  expect(rendererBox?.x).toBeGreaterThanOrEqual((visualBox?.x ?? 0) - 1);
  expect(rendererBox?.y).toBeGreaterThanOrEqual((visualBox?.y ?? 0) - 1);
  expect((rendererBox?.x ?? 0) + (rendererBox?.width ?? 0)).toBeLessThanOrEqual(
    (visualBox?.x ?? 0) + (visualBox?.width ?? 0) + 1,
  );
  expect((rendererBox?.y ?? 0) + (rendererBox?.height ?? 0)).toBeLessThanOrEqual(
    (visualBox?.y ?? 0) + (visualBox?.height ?? 0) + 1,
  );

  const compositorTarget =
    rendererName === 'primitive'
      ? fallback
      : (await stage.getByTestId('a3-digital-human-three-canvas').count())
        ? stage.getByTestId('a3-digital-human-three-canvas')
        : renderer;
  const stats = await compositedPixelStats(compositorTarget);
  expect(stats.opaque).toBeGreaterThan(700);
  expect(stats.variance).toBeGreaterThan(12);
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await visual.screenshot({ path: path.join(SCREENSHOT_DIR, 'a3-homepage-teacher.png') });
});
