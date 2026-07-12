import { expect, test, type Page, type Route } from '@playwright/test';

const completedStudent = {
  id: 'review-student',
  role: 'student',
  displayName: '评审学生',
  phoneBound: true,
  privacyAccepted: true,
  profileCompleted: true,
  onboardingStep: 'complete',
  createdAt: '2026-07-11T00:00:00Z',
  updatedAt: '2026-07-11T00:00:00Z',
};

function corsHeaders(route: Route) {
  return {
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'Content-Type, X-CSRFToken',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': route.request().headers().origin ?? 'http://localhost:3002',
  };
}

async function fulfillJson(route: Route, payload: unknown) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: corsHeaders(route) });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: corsHeaders(route),
    body: JSON.stringify(payload),
  });
}

async function mockLoggedOutSession(page: Page) {
  await page.route('**/api/auth/me/', (route) => fulfillJson(route, { success: true, user: null }));
  await page.route('**/api/auth/csrf/', (route) =>
    fulfillJson(route, { success: true, csrfToken: 'review-csrf' }),
  );
}

test.describe('A3 review login integration', () => {
  test('fills the real form and keeps the approved return target after login', async ({ page }) => {
    await mockLoggedOutSession(page);
    await page.route('**/api/auth/login/', (route) =>
      fulfillJson(route, { success: true, user: completedStudent }),
    );

    await page.goto('/a3/login?mode=review&next=%2Fa3%2Fcoaching%3Fsource%3Dreview');
    await page.getByTestId('a3-review-fill-account').click();

    await expect(page.getByLabel('账号')).toHaveValue('13800000001');
    await expect(page.locator('input[autocomplete="current-password"]')).toHaveValue('Demo@123456');
    await expect(page.getByRole('status')).toHaveText('评审账号已填入，可以登录。');
    await page.getByRole('button', { name: '登录', exact: true }).click();

    await expect(page).toHaveURL(/\/a3\/coaching\?source=review$/, { timeout: 15_000 });
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
      '/a3/coaching?source=review',
    );
  });

  test('shows an accessible error and re-enables login after a failed response', async ({
    page,
  }) => {
    await mockLoggedOutSession(page);
    await page.route('**/api/auth/login/', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders(route) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: corsHeaders(route),
        body: '{invalid json',
      });
    });

    await page.goto('/a3/login?mode=review');
    await page.getByTestId('a3-review-fill-account').click();
    const submit = page.getByRole('button', { name: '登录', exact: true });
    await submit.click();

    await expect(
      page.getByRole('alert').filter({ hasText: /无法连接|登录请求失败|请.*重试/ }),
    ).toContainText(/无法连接|登录请求失败|请.*重试/);
    await expect(submit).toBeEnabled();
  });
});
