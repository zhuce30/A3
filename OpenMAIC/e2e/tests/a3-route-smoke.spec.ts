import { execFileSync } from 'node:child_process';
import { test, expect } from '../fixtures/base';
import { resolveA3PlaywrightRuntime } from '../playwright-runtime';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';

const STUDENT_ROUTES = [
  '/a3/today',
  '/a3/dashboard',
  '/a3/study-plan',
  '/a3/learning-path',
  '/a3/knowledge-graph',
  '/a3/recommendations',
  '/a3/classroom',
  '/a3/coaching',
  '/a3/assessment',
  '/a3/wrong-notebook',
  '/a3/report',
  '/a3/favorites',
  '/a3/notifications',
  '/a3/knowledge-base',
  '/a3/capabilities',
  '/a3/demo-flow',
] as const;

function seedDemoData() {
  const runtime = resolveA3PlaywrightRuntime(process.env, process.cwd());
  execFileSync(runtime.backendPython, [runtime.backendManagePy, 'seed_demo_data'], {
    cwd: runtime.backendProjectRoot,
    stdio: 'pipe',
  });
}

async function loginAs(page: import('@playwright/test').Page, phone: string) {
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

async function expectUsableA3Page(page: import('@playwright/test').Page, route: string) {
  const response = await page.goto(route);
  expect(response?.status(), route).toBeLessThan(400);
  await expect(page.locator('main'), route).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('body')).not.toContainText('Application error');
  await expect(page.locator('body')).not.toContainText('This page could not be found');
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
}

test.describe.serial('A3 authenticated route smoke', () => {
  test.setTimeout(60_000);

  test.beforeAll(({}, testInfo) => {
    testInfo.setTimeout(120_000);
    seedDemoData();
  });

  test('public /a3 stays on the product homepage', async ({ page }) => {
    await page.route('**/api/auth/me/', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, user: null }),
      }),
    );
    const response = await page.goto('/a3');

    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/a3$/);
    await expect(page.getByTestId('a3-product-homepage')).toBeVisible();
    await expect(page.getByRole('heading', { name: '每一步学习， 都更懂你。' })).toBeVisible();
    await expect(page.getByTestId('a3-dashboard')).toHaveCount(0);
  });

  test('student can open all core learning routes', async ({ page }, testInfo) => {
    testInfo.setTimeout(600_000);
    await loginAs(page, STUDENT_PHONE);

    for (const route of STUDENT_ROUTES) {
      await expectUsableA3Page(page, route);
    }
  });

  test('student sees a permission boundary on teacher route', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await expectUsableA3Page(page, '/a3/teacher');

    await expect(page.getByText(/teacher|permission|权限|教师/).first()).toBeVisible();
    await expect(page.getByTestId('a3-teacher-workbench')).toHaveCount(0);
  });

  test('student sees readable classroom context and source panel', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await expectUsableA3Page(page, '/a3/classroom');

    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('AI 多智能体课堂').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前学习目标' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '知识库溯源' })).toBeVisible();
    await expect(page.getByTestId('a3-classroom-input')).toHaveAttribute(
      'placeholder',
      /输入你的问题，或使用上方快捷指令|请先生成学习路径后再开始课堂提问/,
    );
  });

  test('student sees readable face-to-face coaching controls', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await expectUsableA3Page(page, '/a3/coaching');

    const coaching = page.getByTestId('a3-coaching-view');
    await expect(coaching).toBeVisible({ timeout: 30_000 });
    await expect(coaching.getByRole('heading', { name: '实时面对面辅导' })).toBeVisible();
    await expect(coaching.getByText('实时字幕与事件')).toBeVisible();
    await expect(page.getByRole('button', { name: /开启摄像头|关闭摄像头/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /开启麦克风|关闭麦克风/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '看这里/截屏分析' })).toBeVisible();
  });

  test('student sees recommendation fast and deep metrics on capabilities page', async ({
    page,
  }) => {
    await loginAs(page, STUDENT_PHONE);
    await expectUsableA3Page(page, '/a3/capabilities');

    const modes = page.getByTestId('a3-capability-recommendation-modes');
    await expect(modes).toBeVisible({ timeout: 30_000 });
    await expect(modes).toContainText('Fast 推荐');
    await expect(modes).toContainText('Deep 推荐');
  });

  test('teacher can open teacher workbench directly', async ({ page }) => {
    await loginAs(page, TEACHER_PHONE);
    await expectUsableA3Page(page, '/a3/teacher');

    await expect(page.getByTestId('a3-teacher-workbench')).toBeVisible({ timeout: 30_000 });
  });
});
