import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';
const BACKEND_BASE_URL = process.env.A3_E2E_BACKEND_URL
  ?? process.env.NEXT_PUBLIC_A3_API_BASE_URL
  ?? 'http://localhost:8000';
const PROFILE_MESSAGE = '我是自动化专业大二学生，控制理论基础一般，目标是考研；每天能学习 40 分钟，薄弱点是根轨迹和频率响应，学过高等数学和自动控制原理，喜欢动画、例题推导和工程案例，期望视频讲解和练习题库。';

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1100, height: 900 },
  { width: 1440, height: 1000 },
] as const;

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function resetProfileInterview() {
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile

user = User.objects.get(phone="${STUDENT_PHONE}")
profile, _ = LearnerProfile.objects.get_or_create(user=user)
extra = dict(profile.extra_profile or {})
extra.pop("profileInterviewSession", None)
profile.extra_profile = extra
profile.save(update_fields=["extra_profile", "updated_at"])
user.profile_completed = False
user.onboarding_step = "profile"
user.save(update_fields=["profile_completed", "onboarding_step", "updated_at"])
`,
  ]);
}

async function waitForBackend(page: Page) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await page.request.get(new URL('/api/auth/csrf/', BACKEND_BASE_URL).toString(), { timeout: 5_000 });
      if (response.ok()) return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error(`A3 backend is not reachable at ${BACKEND_BASE_URL}`);
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await waitForBackend(page);
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

async function openProfileSetup(page: Page) {
  await page.goto('/a3/profile-setup');
  await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('a3-profile-interview-input')).toBeVisible({ timeout: 60_000 });
}

async function expectSectionWithControls(page: Page, title: string) {
  const heading = page.getByRole('heading', { name: title, exact: true });
  await expect(heading).toBeVisible();
  await expect(heading.locator('..').getByRole('button').first()).toBeVisible();
}

async function expectControlsFitViewport(page: Page) {
  const input = page.getByTestId('a3-profile-interview-input');
  const primaryButton = page.getByTestId('a3-profile-interview-generate');
  await input.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(input).toBeInViewport();
  await expect(primaryButton).toBeInViewport();

  const layout = await page.evaluate(() => {
    const inputElement = document.querySelector<HTMLElement>('[data-testid="a3-profile-interview-input"]');
    const buttonElement = document.querySelector<HTMLElement>('[data-testid="a3-profile-interview-generate"]');
    if (!inputElement || !buttonElement) return null;
    const inputBox = inputElement.getBoundingClientRect();
    const buttonBox = buttonElement.getBoundingClientRect();
    const overlaps = inputBox.left < buttonBox.right
      && inputBox.right > buttonBox.left
      && inputBox.top < buttonBox.bottom
      && inputBox.bottom > buttonBox.top;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      input: { left: inputBox.left, right: inputBox.right, top: inputBox.top, bottom: inputBox.bottom },
      button: { left: buttonBox.left, right: buttonBox.right, top: buttonBox.top, bottom: buttonBox.bottom },
      overlaps,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.overlaps, JSON.stringify(layout)).toBeFalsy();
  for (const box of [layout?.input, layout?.button]) {
    expect(box?.left, JSON.stringify(layout)).toBeGreaterThanOrEqual(0);
    expect(box?.right, JSON.stringify(layout)).toBeLessThanOrEqual(layout?.viewport.width ?? 0);
    expect(box?.top, JSON.stringify(layout)).toBeGreaterThanOrEqual(0);
    expect(box?.bottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout?.viewport.height ?? 0);
  }
}

test.describe.serial('A3 profile setup guidance and responsive behavior', () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test.beforeEach(() => {
    resetProfileInterview();
  });

  test('first visit presents conversational guidance and the complete manual profile controls', async ({ page }) => {
    await loginAsStudent(page);
    await openProfileSetup(page);

    await expect(page.getByRole('heading', { name: '告诉我们你的学习情况', exact: true })).toBeVisible();
    await expect(page.getByTestId('a3-profile-interview-input')).toBeVisible();
    await expect(page.getByRole('button', { name: '发送并整理', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看示例', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '确认并开始入学诊断', exact: true })).toBeVisible();
    const manualDisclosure = page.getByRole('button', { name: /想自己修改？展开手动填写/ });
    await expect(manualDisclosure).toBeVisible();
    await expect(page.getByText('Agent 决策证据', { exact: true })).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('逐项确认');
    await expect(page.locator('body')).not.toContainText('画像信号证据');
    await expect(page.locator('body')).not.toContainText('抽取 dashscope/qwen-plus');

    await manualDisclosure.click();
    for (const title of [
      '专业方向',
      '年级',
      '当前基础水平',
      '学习目标',
      '学习偏好',
      '薄弱知识点',
      '期望资源类型',
      '每日可投入时间',
      '学习节奏',
    ]) {
      await expectSectionWithControls(page, title);
    }
  });

  test('a real interview turn remains visible after refresh', async ({ page }) => {
    await loginAsStudent(page);
    await openProfileSetup(page);

    await page.getByTestId('a3-profile-interview-input').fill(PROFILE_MESSAGE);
    const interviewResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/profile/interview/')
      && response.request().method() === 'POST'
    ));
    await page.getByTestId('a3-profile-interview-generate').click();
    const interviewResponse = await interviewResponsePromise;
    expect(interviewResponse.ok()).toBeTruthy();
    const interviewPayload = await interviewResponse.json() as {
      success?: boolean;
      traceId?: string;
      nextQuestion?: string;
      interviewSession?: { turnCount?: number; nextQuestion?: string };
    };
    expect(interviewPayload.success).toBeTruthy();
    expect(interviewPayload.traceId).toBeTruthy();
    expect(interviewPayload.interviewSession?.turnCount).toBeGreaterThan(0);
    const nextQuestion = interviewPayload.nextQuestion || interviewPayload.interviewSession?.nextQuestion;
    expect(nextQuestion).toBeTruthy();
    await expect(page.getByTestId('a3-profile-interview-thread')).toContainText(PROFILE_MESSAGE, { timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-interview-thread')).toContainText(nextQuestion!, { timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });
    const restoredThread = page.getByTestId('a3-profile-interview-thread');
    await expect(restoredThread).toContainText(PROFILE_MESSAGE, { timeout: 60_000 });
    await expect(restoredThread).toContainText(nextQuestion!);
  });

  test('profile setup keeps its primary conversation controls usable across supported viewports', async ({ page }, testInfo: TestInfo) => {
    await loginAsStudent(page);

    for (const viewport of VIEWPORTS) {
      await test.step(`${viewport.width}x${viewport.height}`, async () => {
        await page.setViewportSize(viewport);
        await openProfileSetup(page);
        await expect(page.getByText(/正在加载课程信息/)).toHaveCount(0, { timeout: 60_000 });

        const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(horizontalOverflow).toBeLessThanOrEqual(1);
        await expectControlsFitViewport(page);

        const threadClassName = await page.getByTestId('a3-profile-interview-thread').getAttribute('class');
        expect(threadClassName).toMatch(/overflow-y-auto|max-h-\[/);

        if (viewport.width === 390 || viewport.width === 1440) {
          await page.screenshot({
            path: testInfo.outputPath(`a3-profile-setup-guidance-${viewport.width}x${viewport.height}.png`),
            fullPage: true,
          });
        }
      });
    }
  });
});
