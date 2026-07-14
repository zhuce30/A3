import { expect, test } from '../fixtures/base';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/me/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, user: null }),
    }),
  );
});

test('closes the mobile menu when the viewport crosses into the desktop layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a3');

  const menuButton = page.getByRole('button', { name: '打开导航' });
  await menuButton.click();
  const mobileNav = page.getByRole('navigation', { name: '移动端首页导航' });
  await expect(mobileNav).toBeVisible();
  await mobileNav.getByRole('link', { name: '学习闭环' }).focus();

  await page.setViewportSize({ width: 1440, height: 1000 });

  await expect(mobileNav).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '首页导航' })).toBeVisible();
  await expect(page.getByRole('link', { name: '智学引擎首页' })).toBeFocused();
  await page
    .getByRole('main')
    .getByRole('link', { name: '开始体验', exact: true })
    .click({ trial: true });
  await page.getByRole('navigation', { name: '首页导航' }).getByRole('link').first().click({
    trial: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(mobileNav).toHaveCount(0);
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(mobileNav).toBeVisible();
  await page.getByRole('button', { name: '关闭导航' }).click();
  await expect(mobileNav).toHaveCount(0);
});

test('keeps multiple hero screen edges visible with distinct layered transforms', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/a3');

  const stage = page.getByTestId('a3-homepage-hero-stage');
  await expect(stage).toBeVisible();
  await expect(stage).not.toHaveAttribute('tabindex', /.+/);

  const screens = stage.locator('figure');
  await expect(screens).toHaveCount(4);
  const layers = await screens.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        display: style.display,
        opacity: Number(style.opacity),
        transform: style.transform,
        zIndex: Number(style.zIndex),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      };
    }),
  );

  expect(layers.filter((layer) => layer.display !== 'none' && layer.opacity >= 0.16)).toHaveLength(
    4,
  );
  expect(new Set(layers.map((layer) => layer.transform)).size).toBeGreaterThanOrEqual(4);
  expect(new Set(layers.map((layer) => `${layer.left}:${layer.top}`)).size).toBeGreaterThanOrEqual(
    4,
  );
  expect(Math.max(...layers.map((layer) => layer.opacity))).toBeGreaterThanOrEqual(0.9);
  expect(Math.max(...layers.map((layer) => layer.zIndex))).toBeGreaterThanOrEqual(10);
});
