import { expect, test, type Page } from '@playwright/test';

async function stubAnonymousUser(page: Page) {
  await page.route('**/api/auth/me/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    }),
  );
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

test.beforeEach(async ({ page }) => {
  await stubAnonymousUser(page);
});

test('keeps product media readable and geometrically stable when every image fails', async ({
  page,
}) => {
  await page.route('**/_next/image**', (route) => route.abort('failed'));
  await page.route('**/a3/assets/homepage/*.webp', (route) => route.abort('failed'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a3');
  await waitForStableHomepage(page);

  const hero = page.getByTestId('a3-homepage-hero-stage');
  const cta = page.getByRole('main').getByRole('link', { name: '开始体验', exact: true });
  await expect(hero).toBeVisible();
  await expect(cta).toBeVisible();
  await cta.click({ trial: true });
  await expect(hero.getByRole('img', { name: '今日任务与学习计划界面' })).toBeVisible();

  const profileSection = page.getByTestId('a3-homepage-profile');
  await profileSection.scrollIntoViewIfNeeded();
  await expect(profileSection.getByText('产品界面暂未加载')).toBeVisible();
  const storyFrame = profileSection.locator('figure');
  await expect(storyFrame.getByText('产品界面暂未加载')).toBeVisible();
  await expect(storyFrame.getByText('你仍可继续浏览完整学习流程。')).toBeVisible();

  const storyBox = await storyFrame.boundingBox();
  expect(storyBox?.width).toBeGreaterThan(300);
  expect((storyBox?.width ?? 0) / (storyBox?.height ?? 1)).toBeCloseTo(4 / 3, 1);

  const teacherStage = page.getByTestId('a3-homepage-teacher-stage');
  await teacherStage.scrollIntoViewIfNeeded();
  await expect(teacherStage.getByRole('img', { name: '数字教师实时辅导界面' })).toContainText(
    '数字教师画面暂未加载',
  );
  expect(
    (await teacherStage.getByTestId('a3-homepage-teacher-visual').boundingBox())?.height,
  ).toBeGreaterThan(400);
});

test('does not initialize the teacher renderer or observer with reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const state = { rootMargins: [] as string[] };
    Object.defineProperty(window, '__a3ObserverState', { value: state });
    class TrackingIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        state.rootMargins.push(options?.rootMargin ?? '');
      }
      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: TrackingIntersectionObserver,
    });
  });
  await page.goto('/a3');
  const stage = await scrollHomepageTeacherIntoView(page);

  await expect(stage.getByTestId('a3-homepage-teacher-fallback')).toBeVisible();
  await expect(stage.getByTestId('a3-digital-human-avatar')).toHaveCount(0);
  await expect(stage.locator('canvas')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __a3ObserverState: { rootMargins: string[] } }
        ).__a3ObserverState.rootMargins.filter((value) => value === '160px').length,
    ),
  ).toBe(0);
});

test('keeps the static reduced-motion hero screen framed on desktop and mobile', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/a3');
    await waitForStableHomepage(page);

    const screens = page.getByTestId('a3-homepage-hero-stage').locator('figure');
    const firstScreen = screens.first();
    await expect(firstScreen).toBeVisible();
    await expect(screens.nth(1)).toBeHidden();

    const geometry = await firstScreen.evaluate((screen) => {
      const screenBox = screen.getBoundingClientRect();
      const heroBox = screen.closest('section')?.getBoundingClientRect();
      if (!heroBox) return null;
      const visibleWidth = Math.max(
        0,
        Math.min(screenBox.right, heroBox.right) - Math.max(screenBox.left, heroBox.left),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(screenBox.bottom, heroBox.bottom) - Math.max(screenBox.top, heroBox.top),
      );
      return {
        heroTop: heroBox.top,
        heroBottom: heroBox.bottom,
        screenTop: screenBox.top,
        screenBottom: screenBox.bottom,
        visibleRatio: (visibleWidth * visibleHeight) / (screenBox.width * screenBox.height),
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry?.screenTop).toBeGreaterThanOrEqual((geometry?.heroTop ?? 0) - 1);
    expect(geometry?.screenBottom).toBeLessThanOrEqual((geometry?.heroBottom ?? 0) + 2);
    expect(geometry?.visibleRatio).toBeGreaterThanOrEqual(0.8);
  }
});

test('reacts to reduced-motion changes and cleans up the pending observer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    const state = { created: [] as string[], disconnected: [] as string[] };
    Object.defineProperty(window, '__a3ObserverState', { value: state });
    class TrackingIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      readonly trackedRootMargin: string;
      constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.trackedRootMargin = options?.rootMargin ?? '';
        state.created.push(this.trackedRootMargin);
      }
      disconnect() {
        state.disconnected.push(this.trackedRootMargin);
      }
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: TrackingIntersectionObserver,
    });
  });
  await page.goto('/a3');
  await waitForStableHomepage(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __a3ObserverState: { created: string[] } }
          ).__a3ObserverState.created.filter((value) => value === '160px').length,
      ),
    )
    .toBe(1);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __a3ObserverState: { disconnected: string[] } }
          ).__a3ObserverState.disconnected.filter((value) => value === '160px').length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
  const stage = page.getByTestId('a3-homepage-teacher-stage');
  await expect(stage.getByTestId('a3-digital-human-avatar')).toHaveCount(0);
  await expect(stage.getByTestId('a3-homepage-teacher-fallback')).toBeVisible();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __a3ObserverState: { created: string[] } }
          ).__a3ObserverState.created.filter((value) => value === '160px').length,
      ),
    )
    .toBe(2);
});

test('returns focus to the mobile menu trigger after Escape and same-page navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a3');
  await waitForStableHomepage(page);
  const openMenu = page.getByRole('button', { name: '打开导航' });

  await openMenu.click();
  const closeMenu = page.getByRole('button', { name: '关闭导航' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: '移动端首页导航' })).toHaveCount(0);
  await expect(openMenu).toBeFocused();

  await openMenu.click();
  await page
    .getByRole('navigation', { name: '移动端首页导航' })
    .getByRole('link', {
      name: '学习闭环',
    })
    .click();
  await expect(page).toHaveURL(/#daily-learning$/);
  await expect(page.getByRole('navigation', { name: '移动端首页导航' })).toHaveCount(0);
  await expect(openMenu).toBeFocused();
  await expect(closeMenu).toHaveCount(0);
});

test('uses a contained single-column mobile story without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a3');
  await waitForStableHomepage(page);

  const headerBox = await page.locator('header').boundingBox();
  expect(headerBox?.height).toBe(64);
  expect(
    await page
      .locator('header')
      .getByRole('link', { name: /登录|进入学习区/ })
      .isHidden(),
  ).toBe(true);

  const heroBox = await page.locator('main section').first().boundingBox();
  expect(heroBox?.height).toBeLessThanOrEqual(760);
  const heroScreens = page.getByTestId('a3-homepage-hero-stage').locator('figure');
  const visibleLayers = await heroScreens.evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          Number(style.opacity) > 0.12 &&
          box.right <= window.innerWidth + 1 &&
          box.left >= -1
        );
      }).length,
  );
  expect(visibleLayers).toBeGreaterThanOrEqual(3);

  const frame = page.getByTestId('a3-homepage-profile').locator('figure');
  const frameStyle = await frame.evaluate((node) => ({
    aspectRatio: getComputedStyle(node).aspectRatio,
    objectFit: getComputedStyle(node.querySelector('img')!).objectFit,
  }));
  expect(frameStyle).toEqual({ aspectRatio: '4 / 3', objectFit: 'contain' });

  const knowledgeColumns = await page
    .getByLabel('知识库学习依据流向')
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  const evidenceColumns = await page
    .getByTestId('a3-homepage-evidence')
    .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
  expect(knowledgeColumns).toBe(2);
  expect(evidenceColumns).toBe(1);

  const classroomModes = page.getByRole('group', { name: '课堂展示模式' });
  const lessonMode = classroomModes.getByRole('button', { name: '讲解' });
  const citationMode = classroomModes.getByRole('button', { name: '引用' });
  await citationMode.focus();
  await page.keyboard.press('Enter');
  await expect(citationMode).toHaveAttribute('aria-pressed', 'true');
  await expect(lessonMode).toHaveAttribute('aria-pressed', 'false');

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
});
