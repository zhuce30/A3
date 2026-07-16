import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

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

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 120_000 });
}

test.describe.serial('A3 conversational profile interview loop', () => {
  test.setTimeout(300_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
  });

  test.beforeEach(() => {
    resetProfileInterview();
  });

  test('interview asks a follow-up, commits the profile, and defers planning until admission diagnosis', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/profile-setup');
    await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('a3-profile-interview-input').fill('我是自动化大二，想考研。');
    await page.getByTestId('a3-profile-interview-generate').click();
    await expect(page.getByTestId('a3-profile-interview-missing-dimensions')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-interview-confirm')).toBeDisabled();

    await page
      .getByTestId('a3-profile-interview-input')
      .fill('我每天 40 分钟，控制理论基础一般，根轨迹和频率响应薄弱，学过高等数学和自动控制原理，喜欢动画、例题和工程案例，考研目标明确，但坚持学习时容易被临时任务打断。');
    await page.getByTestId('a3-profile-interview-generate').click();
    await expect(page.getByTestId('a3-profile-interview-confirm')).toBeEnabled({ timeout: 60_000 });

    const confirmResponsePromise = page.waitForResponse((response) => (
      response.url().includes('/api/profile/interview/')
      && response.request().method() === 'POST'
    ));
    await page.getByTestId('a3-profile-interview-confirm').click();
    const confirmResponse = await confirmResponsePromise;
    expect(confirmResponse.ok()).toBeTruthy();
    const confirmPayload = await confirmResponse.json() as {
      success?: boolean;
      profileCommitted?: boolean;
      planningDeferred?: boolean;
      generated?: { path?: boolean; studyPlan?: boolean };
    };
    expect(confirmPayload.success).toBeTruthy();
    expect(confirmPayload.profileCommitted).toBeTruthy();
    expect(confirmPayload.planningDeferred).toBeTruthy();
    expect(confirmPayload.generated).toEqual({ path: false, studyPlan: false });
    await expect(page.getByTestId('a3-profile-setup-save-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-setup-save-result')).toContainText(/入学诊断后生成|入学诊断/);

    await page.getByTestId('a3-profile-setup-save-result').getByRole('button', { name: '开始入学诊断', exact: true }).click();
    await expect(page).toHaveURL(/\/a3\/admission-diagnostic/, { timeout: 60_000 });
    await expect(page.getByTestId('a3-admission-diagnostic-view')).toBeVisible({ timeout: 60_000 });

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;
    const profileEvidence = page.getByTestId('a3-profile-interview-evidence');
    await expect(profileEvidence).toBeVisible({ timeout: 60_000 });
    await expect(profileEvidence).toContainText('complete', { timeout: 60_000 });
    await expect(profileEvidence).toContainText(/trace|turns|messages/);
    await expect(profileEvidence).toContainText('committed');
    await expect(profileEvidence).toContainText('yes');
  });
});
