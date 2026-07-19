import { expect, test, type Page, type Route } from '@playwright/test';

test.setTimeout(90_000);

const studentUser = {
  id: 'help-tour-student',
  phone: '13800000001',
  nickname: '测试学生',
  role: 'student',
  phoneBound: true,
  privacyAccepted: true,
  profileCompleted: true,
  onboardingStep: 'completed',
};

async function fulfillJson(route: Route, body: unknown) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function stubStudentWorkspace(page: Page) {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me/') {
      await fulfillJson(route, { success: true, user: studentUser });
      return;
    }
    if (pathname.startsWith('/api/engagement/notifications/')) {
      await fulfillJson(route, {
        success: true,
        notifications: [],
        summary: { total: 0, unread: 0 },
      });
      return;
    }
    if (pathname === '/api/a3/tasks') {
      await fulfillJson(route, {
        success: true,
        tasks: [],
        summary: { total: 0, running: 0, failed: 0, succeeded: 0 },
      });
      return;
    }
    await fulfillJson(route, { success: false, error: 'E2E 页面数据占位响应' });
  });
}

test('public help supports task search and category filtering', async ({ page }) => {
  await page.goto('/a3/help');

  await expect(page.getByTestId('a3-help-quick-start').getByRole('link')).toHaveCount(3);
  const search = page.getByTestId('a3-help-search').getByRole('textbox');
  await search.fill('一直解析中');
  await expect(page.getByRole('link', { name: /如何上传资料并完成知识库解析/ })).toBeVisible();
  await expect(page.getByText(/找到 \d+ 篇帮助/)).toBeVisible();

  await search.clear();
  await page.getByLabel('帮助分类').getByRole('button', { name: /知识库管理/ }).click();
  await expect(page.getByRole('heading', { name: '知识库管理' })).toBeVisible();
  await expect(page.getByRole('link', { name: /如何上传资料并完成知识库解析/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /第一次使用，从哪里开始/ })).toHaveCount(0);
});

test('help article enlarges its screenshot and keeps workflow actions separate', async ({ page }) => {
  await page.goto('/a3/help/generate-personal-resources');

  await expect(page.getByRole('heading', { name: '如何生成一套适合自己的学习资料？' })).toBeVisible();
  const screenshot = page.getByRole('button', { name: '放大查看：资源推荐与生成页面' });
  await screenshot.click();
  await expect(page.getByRole('dialog', { name: '资源推荐与生成页面' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '资源推荐与生成页面' })).toHaveCount(0);
  await expect(screenshot).toBeFocused();

  await expect(page.getByRole('link', { name: /前往资源推荐/ })).toHaveAttribute('href', '/a3/recommendations');
  await expect(page.getByRole('link', { name: /重新播放页面引导/ })).toHaveAttribute(
    'href',
    '/a3/recommendations?tour=resource-generation',
  );
});

test('tour completes once and query replay opens it again', async ({ page }) => {
  await stubStudentWorkspace(page);
  await page.goto('/a3/recommendations');

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '先确认生成依据' })).toBeVisible();
  for (const title of ['说明你卡在哪里', '选择合适的资源类型', '生成后到记录中查看']) {
    await dialog.getByRole('button', { name: '下一步' }).click();
    await expect(dialog.getByRole('heading', { name: title })).toBeVisible();
  }
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('a3-tour:help-tour-student:resource-generation:1'))).toContain('completed');

  await page.reload();
  await page.waitForTimeout(1_200);
  await expect(page.getByTestId('a3-guided-tour-overlay')).toHaveCount(0);

  await page.goto('/a3/recommendations?tour=resource-generation');
  await expect(page.getByRole('dialog').getByRole('heading', { name: '先确认生成依据' })).toBeVisible();
});

test('dismissal persists and a student cannot force the teacher indexing tour', async ({ page }) => {
  await stubStudentWorkspace(page);
  await page.goto('/a3/recommendations');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('a3-tour:help-tour-student:resource-generation:1'))).toContain('dismissed');

  await page.reload();
  await page.waitForTimeout(1_200);
  await expect(page.getByTestId('a3-guided-tour-overlay')).toHaveCount(0);

  await page.goto('/a3/knowledge-base?tour=knowledge-base-indexing');
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('a3-guided-tour-overlay')).toHaveCount(0);
});

test('missing targets do not leave a stuck overlay', async ({ page }) => {
  await stubStudentWorkspace(page);
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '[data-tour-id^="resource-generation"] { display: none !important; }';
      document.head.append(style);
    });
  });
  await page.goto('/a3/recommendations');
  await page.waitForTimeout(4_200);
  await expect(page.getByTestId('a3-guided-tour-overlay')).toHaveCount(0);
  await expect(page.getByTestId('a3-recommendations-view')).toBeVisible();
});

test('mobile tour uses a contained bottom sheet', async ({ page }) => {
  await stubStudentWorkspace(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a3/recommendations');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(10);
  expect(box!.x + box!.width).toBeLessThanOrEqual(380);
  expect(box!.y).toBeGreaterThan(400);
  expect(box!.y + box!.height).toBeLessThanOrEqual(834);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
