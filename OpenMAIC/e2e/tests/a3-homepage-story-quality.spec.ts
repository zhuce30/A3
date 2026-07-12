import { expect, test, type Locator, type Page } from '@playwright/test';
import sharp from 'sharp';

const TERMINAL_RENDERERS = ['vrm', 'vrm_idle_animation', 'primitive', 'static_fallback'];

type HandoffSample = {
  connected: boolean;
  empty: boolean;
  fallbackInDom: boolean;
  fallbackStyle: string;
  loadingExposed: boolean;
  renderer: string;
  stageRenderer: string;
};

async function readCompositedPixelStats(locator: Locator, centerRatio = 1) {
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

async function delayTeacherRendererChunk(page: Page, delayMs = 3_000) {
  let delayedRequests = 0;

  await page.route('**/*', async (route) => {
    const url = decodeURIComponent(route.request().url());
    if (url.includes('digital-human-three-stage') && /\.js(?:\?|$)/.test(url)) {
      delayedRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await route.continue();
  });

  return () => delayedRequests;
}

async function delayTeacherModelAsset(page: Page, delayMs: number) {
  let delayedRequests = 0;

  await page.route('**/*', async (route) => {
    const url = decodeURIComponent(route.request().url());
    if (url.includes('/a3/assets/teacher-avatar/teacher.vrm')) {
      delayedRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await route.continue();
  });

  return () => delayedRequests;
}

type TeacherSequenceSample = {
  elapsed: number;
  fallbackVisible: boolean;
  phase: string | null;
  promptVisible: boolean;
  statusText: string;
  statusVisible: boolean;
};

async function observeControlledTeacherSequence(stage: Locator) {
  return stage.evaluate(
    (element) =>
      new Promise<TeacherSequenceSample[]>((resolve, reject) => {
        type ControlledWindow = Window & { __triggerA3Intersections?: () => void };
        const samples: TeacherSequenceSample[] = [];
        let startedAt: number | null = null;
        let previousPhase: string | null = null;
        let triggerIntervalId: number | null = null;
        const visible = (node: Element | null) => {
          if (!(node instanceof HTMLElement)) return false;
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            Number(style.opacity) > 0.05 &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const timeoutId = window.setTimeout(() => {
          if (triggerIntervalId !== null) window.clearInterval(triggerIntervalId);
          observer.disconnect();
          reject(
            new Error(
              `Teacher sequence timed out: ${JSON.stringify(samples)} active=${element.getAttribute('data-demo-active')} visualReady=${element.getAttribute('data-visual-ready')}`,
            ),
          );
        }, 10_500);
        const record = () => {
          const phase = element.getAttribute('data-demo-phase');
          if (phase === 'static' || phase === previousPhase) return;
          if (phase === 'appear') {
            startedAt = performance.now();
          }
          const status = element.querySelector('[data-testid="a3-homepage-teacher-status"]');
          const prompt = element.querySelector('[data-testid="a3-homepage-teacher-prompt"]');
          const fallback = element.querySelector('[data-testid="a3-homepage-teacher-fallback"]');
          samples.push({
            elapsed: startedAt === null ? 0 : performance.now() - startedAt,
            fallbackVisible: visible(fallback),
            phase,
            promptVisible: visible(prompt),
            statusText: status?.textContent?.trim() ?? '',
            statusVisible: visible(status),
          });
          previousPhase = phase;
          if (phase === 'complete') {
            window.clearTimeout(timeoutId);
            if (triggerIntervalId !== null) window.clearInterval(triggerIntervalId);
            observer.disconnect();
            resolve(samples);
          }
        };
        const observer = new MutationObserver(record);
        observer.observe(element, { attributes: true, attributeFilter: ['data-demo-phase'] });
        record();
        const trigger = () => (window as ControlledWindow).__triggerA3Intersections?.();
        triggerIntervalId = window.setInterval(trigger, 20);
        trigger();
      }),
  );
}

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

async function installControlledIntersectionObserver(page: Page) {
  await page.addInitScript(() => {
    type ControlledWindow = Window & { __triggerA3Intersections?: () => void };
    const observers = new Set<ControlledIntersectionObserver>();

    class ControlledIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      private readonly targets = new Set<Element>();

      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.add(this);
      }

      disconnect() {
        this.targets.clear();
        observers.delete(this);
      }

      observe(target: Element) {
        this.targets.add(target);
      }

      takeRecords() {
        return [];
      }

      unobserve(target: Element) {
        this.targets.delete(target);
      }

      trigger() {
        const entries = [...this.targets].map(
          (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
        );
        this.callback(entries, this as unknown as IntersectionObserver);
      }
    }

    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: ControlledIntersectionObserver,
    });
    (window as ControlledWindow).__triggerA3Intersections = () => {
      for (const observer of observers) observer.trigger();
    };
  });
}

async function assertContainedTeacherPortrait(page: Page, screenshotName: string) {
  await page.waitForFunction(() => {
    const currentStage = document.querySelector<HTMLElement>(
      'main [data-testid="a3-homepage-teacher-stage"]',
    );
    return currentStage?.isConnected && currentStage.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('main [data-testid="a3-homepage-teacher-stage"]')
      ?.scrollIntoView({ block: 'center' });
  });
  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await expect(stage).toBeVisible();
  const visual = stage.getByTestId('a3-homepage-teacher-visual');
  const fallback = stage.getByTestId('a3-homepage-teacher-fallback');
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

test('teacher fallback keeps the user-visible handoff complete and nonblank', async ({ page }) => {
  const delayedRendererRequests = await delayTeacherRendererChunk(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const currentStage = document.querySelector<HTMLElement>(
      '[data-testid="a3-homepage-teacher-stage"]',
    );
    if (!currentStage?.isConnected) return false;
    const rect = currentStage.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  await page.evaluate(() => {
    const currentStage = document.querySelector<HTMLElement>(
      '[data-testid="a3-homepage-teacher-stage"]',
    );
    if (!currentStage?.isConnected) throw new Error('Connected teacher stage not found');
    const rect = currentStage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Teacher stage has no geometry');
    currentStage.scrollIntoView({ block: 'center' });
  });
  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await expect(stage).toBeVisible();
  const initialFallback = stage.getByTestId('a3-homepage-teacher-fallback');
  const fallbackImage = initialFallback.locator('img');
  if ((await fallbackImage.count()) > 0) {
    await expect
      .poll(() =>
        fallbackImage.evaluate(
          (node) => node.complete && node.naturalWidth > 0 && node.naturalHeight > 0,
        ),
      )
      .toBe(true);
  }

  const samples: HandoffSample[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate((terminalRenderers) => {
      const currentRoot = document.querySelector<HTMLElement>(
        '[data-testid="a3-homepage-teacher-stage"]',
      );
      if (!currentRoot?.isConnected) {
        return {
          connected: false,
          empty: true,
          fallbackInDom: false,
          fallbackStyle: 'disconnected',
          loadingExposed: false,
          renderer: '',
          stageRenderer: '',
        };
      }
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

      const fallback = currentRoot.querySelector('[data-testid="a3-homepage-teacher-fallback"]');
      const renderer = currentRoot.querySelector('[data-avatar-renderer]');
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

      return {
        connected: true,
        empty: !visible(fallback) && !terminalVisible,
        fallbackInDom: fallback !== null,
        fallbackStyle:
          fallback instanceof HTMLElement
            ? (() => {
                const style = getComputedStyle(fallback);
                const rect = fallback.getBoundingClientRect();
                return `${style.display}/${style.opacity}/${rect.width}x${rect.height}`;
              })()
            : 'missing',
        loadingExposed,
        renderer: rendererName,
        stageRenderer: currentRoot.getAttribute('data-renderer') ?? '',
      };
    }, TERMINAL_RENDERERS);
    samples.push(sample);
    if (
      sample.connected &&
      (!sample.fallbackInDom ||
        (sample.renderer === 'primitive' && sample.stageRenderer === 'terminal'))
    ) {
      break;
    }
    await page.waitForTimeout(50);
  }

  expect(delayedRendererRequests()).toBeGreaterThan(0);
  const finalSample = samples.at(-1);
  expect(
    finalSample?.connected &&
      (!finalSample.fallbackInDom ||
        (finalSample.renderer === 'primitive' && finalSample.stageRenderer === 'terminal')),
  ).toBe(true);
  expect(
    samples.filter((sample) => !sample.connected),
    JSON.stringify(samples),
  ).toEqual([]);
  const observedStates = samples.map((sample) => sample.renderer).filter(Boolean);
  const loadingIndex = observedStates.indexOf('loading');
  const terminalIndex = observedStates.findIndex((renderer) =>
    TERMINAL_RENDERERS.includes(renderer),
  );
  expect(loadingIndex).toBeGreaterThanOrEqual(0);
  expect(terminalIndex).toBeGreaterThan(loadingIndex);
  const emptySamples = samples.filter((item) => item.fallbackInDom && item.empty);
  expect(emptySamples, JSON.stringify(samples)).toEqual([]);
  for (const sample of samples.filter((item) => item.fallbackInDom)) {
    expect(sample.loadingExposed).toBe(false);
  }

  const terminalRenderer = observedStates.at(-1);
  expect(TERMINAL_RENDERERS).toContain(terminalRenderer);
  if (terminalRenderer === 'primitive') {
    const homepageFallback = stage.getByTestId('a3-homepage-teacher-fallback');
    await expect(homepageFallback).toBeVisible();
    const stats = await readCompositedPixelStats(homepageFallback);
    expect(stats.opaque).toBeGreaterThan(700);
    expect(stats.variance).toBeGreaterThan(8);
    expect(stats.uniqueColors).toBeGreaterThan(8);
  } else if (terminalRenderer === 'static_fallback') {
    const staticFallback = stage.getByTestId('a3-digital-human-static-fallback');
    await expect(staticFallback).toBeVisible();
    const stats = await readCompositedPixelStats(staticFallback);
    expect(stats.opaque).toBeGreaterThan(700);
    expect(stats.variance).toBeGreaterThan(8);
    expect(stats.uniqueColors).toBeGreaterThan(8);
  } else {
    const canvas = stage.getByTestId('a3-digital-human-three-canvas');
    await expect(canvas).toBeVisible();
    await expect
      .poll(
        async () => {
          const stats = await readCompositedPixelStats(canvas);
          return stats.opaque > 700 && stats.variance > 8;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  }
});

test('teacher canvas stays independently nonblank beneath the homepage overlay', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const currentStage = document.querySelector<HTMLElement>(
      'main [data-testid="a3-homepage-teacher-stage"]',
    );
    return currentStage?.isConnected && currentStage.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('main [data-testid="a3-homepage-teacher-stage"]')
      ?.scrollIntoView({ block: 'center' });
  });
  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await expect(stage).toBeVisible();
  await expect(stage).toHaveAttribute('data-renderer', 'terminal', { timeout: 30_000 });

  const renderer = stage.locator('[data-avatar-renderer]');
  const rendererName = await renderer.getAttribute('data-avatar-renderer');
  const canvas = stage.getByTestId('a3-digital-human-three-canvas');
  if (rendererName === 'static_fallback') {
    await expect(canvas).toHaveCount(0);
    const builtInFallback = stage.getByTestId('a3-digital-human-static-fallback');
    await expect(builtInFallback).toBeVisible();
    const stats = await readCompositedPixelStats(builtInFallback, 0.5);
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
  const stats = await readCompositedPixelStats(canvas, 0.5);
  expect(stats.opaque).toBeGreaterThan(700);
  expect(stats.variance).toBeGreaterThan(12);
  expect(stats.uniqueColors).toBeGreaterThan(6);
  expect(stats.edges).toBeGreaterThan(6);
});

test('teacher runs one silent eight-second sequence and retains the question', async ({ page }) => {
  await installControlledIntersectionObserver(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const currentStage = document.querySelector<HTMLElement>(
      'main [data-testid="a3-homepage-teacher-stage"]',
    );
    return currentStage?.isConnected && currentStage.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('main [data-testid="a3-homepage-teacher-stage"]')
      ?.scrollIntoView({ block: 'center' });
  });
  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await expect(stage).toBeVisible();

  const observed = await observeControlledTeacherSequence(stage);

  expect(observed.map((sample) => sample.phase)).toEqual([
    'appear',
    'listen',
    'question',
    'complete',
  ]);
  const completedAt = observed.at(-1)?.elapsed ?? 0;
  expect(completedAt).toBeGreaterThanOrEqual(6_000);
  expect(completedAt).toBeLessThanOrEqual(10_000);
  await expect(stage.getByText('正在倾听：进程调度为什么会发生饥饿？')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(stage).toHaveAttribute('data-demo-phase', 'complete');
});

test('delayed VRM keeps every silent phase visible on the ready fallback', async ({ page }) => {
  await installControlledIntersectionObserver(page);
  const delayedRendererRequests = await delayTeacherModelAsset(page, 12_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const currentStage = document.querySelector<HTMLElement>(
      'main [data-testid="a3-homepage-teacher-stage"]',
    );
    return currentStage?.isConnected && currentStage.getBoundingClientRect().height > 0;
  });
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>('main [data-testid="a3-homepage-teacher-stage"]')
      ?.scrollIntoView({ block: 'center' });
  });
  const stage = page.getByRole('main').getByTestId('a3-homepage-teacher-stage');
  await expect(stage).toBeVisible();

  const observed = await observeControlledTeacherSequence(stage);
  await expect.poll(delayedRendererRequests, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(observed.map((sample) => sample.phase)).toEqual([
    'appear',
    'listen',
    'question',
    'complete',
  ]);
  expect(observed.every((sample) => sample.fallbackVisible)).toBe(true);
  const listen = observed.find((sample) => sample.phase === 'listen');
  expect(listen).toMatchObject({ statusText: '正在倾听', statusVisible: true });
  const question = observed.find((sample) => sample.phase === 'question');
  expect(question?.promptVisible).toBe(true);
  expect(observed.at(-1)?.elapsed).toBeGreaterThanOrEqual(6_000);
  expect(observed.at(-1)?.elapsed).toBeLessThanOrEqual(10_000);
});

test('homepage anchor navigation clears the sticky header', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');
  const header = page.locator('header').first();

  for (const anchor of ['#capabilities', '#learning-loop', '#evidence', '#contact']) {
    await page.locator(`header nav[aria-label="首页导航"] a[href="${anchor}"]`).first().click();
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
