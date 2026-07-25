import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const ADMIN_PHONE = '13800000003';
const DEMO_PASSWORD = 'Demo@123456';
const BACKEND_BASE_URL = process.env.A3_E2E_BACKEND_URL
  ?? process.env.NEXT_PUBLIC_A3_API_BASE_URL
  ?? 'http://localhost:8000';

const adminRoutes = [
  ['/a3/admin/overview', '运行总览'],
  ['/a3/admin/users', '用户管理'],
  ['/a3/admin/conversations', '对话记录'],
  ['/a3/admin/catalog', '课程与知识库'],
  ['/a3/admin/tasks', '资源任务'],
  ['/a3/admin/agents', 'Agent 运行'],
  ['/a3/admin/safety', '内容安全'],
  ['/a3/admin/settings', '系统配置'],
  ['/a3/admin/audit', '审计日志'],
] as const;

function seedAdmin() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, 'seed_demo_data'], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
  const script = [
    'from backend.apps.accounts.models import User',
    `u,_=User.objects.get_or_create(phone='${ADMIN_PHONE}', defaults={'display_name':'验收管理员'})`,
    "u.role='admin'",
    'u.is_staff=True',
    'u.is_superuser=True',
    'u.is_active=True',
    'u.privacy_accepted=True',
    'u.profile_completed=True',
    "u.onboarding_step='completed'",
    `u.set_password('${DEMO_PASSWORD}')`,
    'u.save()',
  ].join(';');
  execFileSync(python, [manage, 'shell', '-c', script], { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
}

async function loginAsAdmin(page: Page) {
  await page.context().clearCookies();
  await page.request.get(new URL('/api/auth/csrf/', BACKEND_BASE_URL).toString(), { timeout: 10_000 });
  await page.goto('/a3/login?workspace=admin');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(ADMIN_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/a3\/admin\/overview$/, { timeout: 60_000 });
}

test.describe.serial('A3 admin operations console', () => {
  test.setTimeout(600_000);

  test.beforeAll(() => seedAdmin());

  test('exposes compact role entry links on the public homepage', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/a3/');
    await expect(page.getByRole('link', { name: '学生', exact: true }).first()).toHaveAttribute('href', '/a3/login?workspace=student');
    await expect(page.getByRole('link', { name: '教师', exact: true }).first()).toHaveAttribute('href', '/a3/login?workspace=teacher');
    await expect(page.getByRole('link', { name: '管理员', exact: true }).first()).toHaveAttribute('href', '/a3/login?workspace=admin');
  });

  test('navigates all nine real admin modules on desktop', async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAsAdmin(page);
    await expect(page.locator('[data-a3-admin-console]')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '管理后台导航' })).toBeVisible();

    for (const [href, title] of adminRoutes) {
      await page.getByRole('link', { name: title, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 60_000 });
      await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }

    await page.goto('/a3/admin/overview');
    await expect(page.getByTestId('a3-admin-overview')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('a3-admin-overview-1440x900.png'), fullPage: true });
  });

  test('uses the collapsible admin navigation on mobile', async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsAdmin(page);
    const navigation = page.getByRole('navigation', { name: '管理后台导航' });
    await page.getByRole('button', { name: '打开管理导航' }).click();
    await expect(navigation).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('a3-admin-mobile-nav-390x844.png'), fullPage: false });
    await page.getByRole('button', { name: '关闭管理导航' }).last().click();
    await expect(page.getByRole('button', { name: '打开管理导航' })).toBeVisible();
  });
});
