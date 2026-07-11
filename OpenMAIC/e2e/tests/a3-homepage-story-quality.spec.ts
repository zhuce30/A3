import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

const TERMINAL_RENDERERS = ['vrm', 'vrm_idle_animation', 'primitive', 'static_fallback'];

async function installDormantIntersectionObserver(page: Page) {
  await page.addInitScript(() => {
    class DormantIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];

      disconnect() {}
      observe() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    }

    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: DormantIntersectionObserver,
    });
  });
}

async function assertContainedTeacherPortrait(page: Page, screenshotName: string) {
  const stage = page.getByTestId('a3-homepage-teacher-stage');
  await stage.scrollIntoViewIfNeeded();
  const visual = page.getByTestId('a3-homepage-teacher-visual');
  const fallback = page.getByTestId('a3-homepage-teacher-fallback');
  const image = fallback.locator('img');

  await expect(fallback).toBeVisible();
  await expect
    .poll(() => image.evaluate((node) => node.complete && node.naturalWidth > 0))
    .toBe(true);

  const geometry = await image.evaluate((node) => {
    const container = node.parentElement?.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!container) return null;
    const scale = Math.min(
      container.width / node.naturalWidth,
      container.height / node.naturalHeight,
    );
    const width = node.naturalWidth * scale;
    const height = node.naturalHeight * scale;
    return {
      containerWidth: container.width,
      containerHeight: container.height,
      objectFit: style.objectFit,
      renderedWidth: width,
      renderedHeight: height,
      insetX: (container.width - width) / 2,
      insetY: (container.height - height) / 2,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.objectFit).toBe('contain');
  expect(geometry?.renderedWidth).toBeGreaterThan(300);
  expect(geometry?.renderedHeight).toBeGreaterThan(480);
  expect(geometry?.insetX).toBeGreaterThanOrEqual(0);
  expect(geometry?.insetY).toBeGreaterThanOrEqual(0);

  const screenshot = await visual.screenshot({ path: test.info().outputPath(screenshotName) });
  const metadata = await sharp(screenshot).metadata();
  expect(metadata.width).toBeGreaterThan(300);
  expect(metadata.height).toBeGreaterThan(480);
  const stats = await sharp(screenshot)
    .extract({
      left: Math.floor((metadata.width ?? 1) * 0.3),
      top: Math.floor((metadata.height ?? 1) * 0.25),
      width: Math.max(1, Math.floor((metadata.width ?? 1) * 0.4)),
      height: Math.max(1, Math.floor((metadata.height ?? 1) * 0.6)),
    })
    .stats();
  expect(stats.channels.some((channel) => channel.max - channel.min > 70)).toBe(true);
}

test('desktop and mobile keep the full real teacher portrait visible before activation', async ({
  page,
}) => {
  await installDormantIntersectionObserver(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');
  await assertContainedTeacherPortrait(page, 'teacher-fallback-desktop.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await assertContainedTeacherPortrait(page, 'teacher-fallback-mobile.png');
});

test('teacher fallback covers loading and hands off without an empty frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');
  const stage = page.getByTestId('a3-homepage-teacher-stage');
  await stage.scrollIntoViewIfNeeded();

  const samples = await stage.evaluate(async (root, terminalRenderers) => {
    const results: Array<{ empty: boolean; loadingExposed: boolean }> = [];
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        Number(style.opacity) > 0.05 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    for (let index = 0; index < 50; index += 1) {
      const fallback = root.querySelector('[data-testid="a3-homepage-teacher-fallback"]');
      const renderer = root.querySelector('[data-avatar-renderer]');
      const rendererName = renderer?.getAttribute('data-avatar-renderer') ?? '';
      const terminalVisible = terminalRenderers.includes(rendererName) && visible(renderer);
      let loadingExposed = false;

      if (rendererName === 'loading' && renderer instanceof HTMLElement) {
        const rect = renderer.getBoundingClientRect();
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        loadingExposed = top === renderer || renderer.contains(top);
      }

      results.push({ empty: !visible(fallback) && !terminalVisible, loadingExposed });
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return results;
  }, TERMINAL_RENDERERS);

  expect(samples.some((sample) => sample.empty)).toBe(false);
  expect(samples.some((sample) => sample.loadingExposed)).toBe(false);
  await expect(stage.locator('[data-avatar-renderer]').first()).toHaveAttribute(
    'data-avatar-renderer',
    new RegExp(TERMINAL_RENDERERS.join('|')),
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('a3-homepage-teacher-fallback')).toHaveCount(0, {
    timeout: 5_000,
  });
});

test('homepage anchor navigation clears the sticky header', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');
  const header = page.locator('header');

  for (const anchor of ['#capabilities', '#learning-loop', '#evidence', '#contact']) {
    await page.locator(`nav[aria-label="首页导航"] a[href="${anchor}"]`).click();
    await expect
      .poll(async () => {
        const targetTop = await page
          .locator(anchor)
          .evaluate((node) => node.getBoundingClientRect().top);
        const headerBottom = await header.evaluate((node) => node.getBoundingClientRect().bottom);
        return targetTop >= headerBottom - 1;
      })
      .toBe(true);
  }
});
