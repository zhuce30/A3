import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';

const STUDENT_ROUTES = [
  '/a3',
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
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, 'seed_demo_data'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAs(page: import('@playwright/test').Page, phone: string) {
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').first().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function expectUsableA3Page(page: import('@playwright/test').Page, route: string) {
  const response = await page.goto(route);
  expect(response?.status(), route).toBeLessThan(400);
  await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText('Application error');
  await expect(page.locator('body')).not.toContainText('This page could not be found');
  await expect(page.locator('body')).not.toContainText('Internal Server Error');
}

test.describe.serial('A3 authenticated route smoke', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('student can open all core learning routes', async ({ page }) => {
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
    await expect(page.getByRole('heading', { name: 'AI 多智能体课堂' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前学习目标' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '知识库溯源' })).toBeVisible();
    await expect(page.getByTestId('a3-classroom-input')).toHaveAttribute('placeholder', '输入你的问题，或使用上方快捷指令');
  });

  test('student sees readable face-to-face coaching controls', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await expectUsableA3Page(page, '/a3/coaching');

    const coaching = page.getByTestId('a3-coaching-view');
    await expect(coaching).toBeVisible({ timeout: 30_000 });
    await expect(coaching.getByText('本地媒体连接已加密')).toBeVisible();
    await expect(coaching.getByText('实时字幕')).toBeVisible();
    await expect(page.getByRole('button', { name: /开启音视频|关闭摄像头/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '拍照提问' })).toBeVisible();
    await expect(page.getByRole('button', { name: /开始说话|结束并识别/ })).toBeVisible();
  });

  test('student sees recommendation fast and deep metrics on capabilities page', async ({ page }) => {
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
