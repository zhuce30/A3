import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const PROFILE_E2E_PHONE = '13800009991';
const DEMO_PASSWORD = 'Demo@123456';

const MOBILE_CORE_PAGES = [
  { route: '/a3/today', testId: 'a3-today-view' },
  { route: '/a3/wrong-notebook', testId: 'a3-wrong-notebook-view' },
  { route: '/a3/report', testId: 'a3-report-view' },
  { route: '/a3/notifications', testId: 'a3-notifications-view' },
] as const;

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

function seedDemoData() {
  runManage('seed_demo_data');
}

function resetProfileE2EUser() {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User

User.objects.filter(phone="${PROFILE_E2E_PHONE}").delete()
user = User.objects.create_user(
    phone="${PROFILE_E2E_PHONE}",
    password="${DEMO_PASSWORD}",
    display_name="E2E画像学生",
)
user.phone_bound = True
user.privacy_accepted = True
user.profile_completed = False
user.onboarding_step = "profile"
user.save(update_fields=["phone_bound", "privacy_accepted", "profile_completed", "onboarding_step", "updated_at"])
`,
  ]);
}

function createMobileLoopNotification(marker: string) {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.engagement.models import NotificationType, UserNotification

user = User.objects.get(phone="${STUDENT_PHONE}")
UserNotification.objects.filter(user=user, payload__generatedBy="e2e_mobile_loop", payload__marker="${marker}").delete()
UserNotification.objects.create(
    user=user,
    title="移动端闭环提醒 ${marker}",
    detail="完成一个今日任务后查看报告建议。",
    notification_type=NotificationType.LEARNING_TASK,
    unread=True,
    action_url="/a3/today",
    payload={
        "generatedBy": "e2e_mobile_loop",
        "marker": "${marker}",
        "actionKind": "today",
        "pendingTasks": 1,
        "remainingMinutes": 15,
    },
)
`,
  ]);
}

async function loginAsStudent(page: Page) {
  await loginAs(page, STUDENT_PHONE);
}

async function loginAsProfileE2EStudent(page: Page) {
  await loginAs(page, PROFILE_E2E_PHONE);
}

async function loginAsTeacher(page: Page) {
  await loginAs(page, TEACHER_PHONE);
}

async function loginAs(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(phone);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const scrollWidth = Math.max(root.scrollWidth, body.scrollWidth);
    return {
      clientWidth: root.clientWidth,
      scrollWidth,
      overflowPx: scrollWidth - root.clientWidth,
    };
  });

  expect(overflow.overflowPx, JSON.stringify(overflow)).toBeLessThanOrEqual(2);
}

test.describe.serial('A3 mobile learning loop', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
    resetProfileE2EUser();
  });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsStudent(page);
  });

  test('core learning pages render without horizontal overflow on mobile', async ({ page }) => {
    for (const { route, testId } of MOBILE_CORE_PAGES) {
      const response = await page.goto(route);
      expect(response?.status(), route).toBeLessThan(400);

      await expect(page.getByTestId(testId)).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('main')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Application error');
      await expect(page.locator('body')).not.toContainText('This page could not be found');
      await expectNoHorizontalOverflow(page);
    }
  });

  test('mobile notification, today feedback, and report loop stay continuous', async ({ page }) => {
    const marker = `${Date.now()}`;
    createMobileLoopNotification(marker);

    await page.goto('/a3/dashboard');
    await expect(page.getByRole('heading', { name: /早上好/ })).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-top-notifications-trigger').click();
    const panel = page.getByTestId('a3-top-notifications-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('a3-top-notification-item').filter({ hasText: marker })).toBeVisible();
    await expect(panel.getByTestId('a3-top-notification-learning-loop').first()).toContainText('为什么提醒');
    await expectNoHorizontalOverflow(page);

    await page.goto('/a3/today');
    const task = page.getByTestId('a3-today-task').first();
    await expect(task).toBeVisible({ timeout: 60_000 });
    const completeButton = task.getByTestId('a3-today-task-complete');
    await expect(completeButton).toBeEnabled({ timeout: 30_000 });
    await completeButton.click();
    await expect(page.getByTestId('a3-today-report-action-loop')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-today-report-primary-action')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto('/a3/report');
    await expect(page.getByTestId('a3-report-continuity-loop')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-report-loop-primary')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('onboarding and AI pages render primary controls without horizontal overflow on mobile', async ({ page }) => {
    await loginAsProfileE2EStudent(page);

    await page.goto('/a3/profile-setup');
    await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId('a3-profile-setup-submit')).toBeVisible();
    await page.getByTestId('a3-profile-setup-submit').click();
    const profileImpact = page.getByTestId('a3-profile-personalization-impact');
    await expect(profileImpact).toBeVisible({ timeout: 60_000 });
    await expect(profileImpact).toContainText('计划节奏');
    await expect(profileImpact).toContainText('调整理由');
    await expect(profileImpact).toContainText('薄弱点优先');
    await expect(profileImpact).toContainText('路径前置');

    await page.goto('/a3/recommendations');
    const recommendationInputs = page.getByTestId('a3-recommendation-profile-inputs');
    await expect(recommendationInputs).toBeVisible({ timeout: 60_000 });
    await expect(recommendationInputs).toContainText('每日 60 分钟');
    await expect(recommendationInputs).toContainText('根轨迹');

    await page.goto('/a3/admission-diagnostic');
    await expect(page.getByTestId('a3-admission-diagnostic-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-admission-diagnostic-submit')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-admission-question').first()).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalOverflow(page);

    await page.goto('/a3/coaching');
    await expect(page.getByTestId('a3-coaching-view')).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
  });

  test('student sees teacher permission boundary on mobile without overflow', async ({ page }) => {
    const response = await page.goto('/a3/teacher');
    expect(response?.status(), '/a3/teacher').toBeLessThan(400);

    await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-teacher-workbench')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test('teacher workbench opens on mobile without overflow', async ({ page }) => {
    await loginAsTeacher(page);

    const response = await page.goto('/a3/teacher');
    expect(response?.status(), '/a3/teacher').toBeLessThan(400);

    await expect(page.getByTestId('a3-teacher-workbench')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-student-intervention').first()).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalOverflow(page);
  });
});
