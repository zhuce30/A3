import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

type ProfileCandidate = {
  source?: string;
  changedDimensions?: string[];
  evidence?: {
    eventType?: string;
  };
};

type DynamicProfileResponse = {
  success: boolean;
  confirmationQueue: ProfileCandidate[];
};

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  return execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function resetProfileCandidateState() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile

user = User.objects.get(phone="${STUDENT_PHONE}")
profile, _ = LearnerProfile.objects.get_or_create(user=user)
extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
extra["profileUpdateCandidates"] = []
extra["profileVersions"] = []
extra["cognitiveStyle"] = ""
extra["motivationRisk"] = ""
extra["mistakePatterns"] = []
profile.extra_profile = extra
profile.foundation_level = "未校准"
profile.weak_points = []
profile.expected_resources = []
profile.save(update_fields=["foundation_level", "weak_points", "expected_resources", "extra_profile", "updated_at"])
`,
  ]);
}

async function waitForBackend(page: Page) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await page.request.get('http://localhost:8000/api/auth/csrf/', { timeout: 5_000 });
      if (response.ok()) return;
    } catch (error) {
      lastError = error;
    }
    await page.waitForTimeout(1_000);
  }
  throw lastError instanceof Error ? lastError : new Error('A3 backend is not reachable on localhost:8000');
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await waitForBackend(page);
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function fetchDynamicProfile(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('http://localhost:8000/api/profiles/dynamic-profile/', {
      credentials: 'include',
      cache: 'no-store',
    });
    return response.json();
  }) as Promise<DynamicProfileResponse>;
}

async function expectProfileCandidateFromEvent(page: Page, eventType: string, dimensions: string[]) {
  await expect
    .poll(
      async () => {
        const feed = await fetchDynamicProfile(page);
        if (!feed.success) return [];
        return feed.confirmationQueue
          .filter((candidate) => candidate.evidence?.eventType === eventType || candidate.source === eventType)
          .flatMap((candidate) => candidate.changedDimensions ?? []);
      },
      { timeout: 60_000 },
    )
    .toEqual(expect.arrayContaining(dimensions));
}

test.describe.serial('A3 real learning flows generate profile update candidates', () => {
  test.setTimeout(240_000);

  test.beforeEach(() => {
    resetProfileCandidateState();
  });

  test('admission diagnostic submit creates foundation and weak point candidates', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/admission-diagnostic');
    await expect(page.getByTestId('a3-admission-diagnostic-view')).toBeVisible({ timeout: 60_000 });
    const questions = page.getByTestId('a3-admission-question');
    const count = await questions.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      await questions.nth(index).locator('button').last().click();
    }

    await expect(page.getByTestId('a3-admission-diagnostic-submit')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('a3-admission-diagnostic-submit').click();

    await expect(page.getByTestId('a3-admission-loop-evidence')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-update-candidate-panel')).toBeVisible({ timeout: 60_000 });
    await expectProfileCandidateFromEvent(page, 'admission_diagnostic', ['foundationLevel', 'weakPoints']);
  });

  test('wrong notebook retry creates weak point and mistake pattern candidates', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/wrong-notebook');
    const item = page.getByTestId('a3-wrong-question-item').first();
    await expect(item).toBeVisible({ timeout: 60_000 });
    await item.getByTestId('a3-wrong-question-expand').click();
    await item.getByTestId('a3-wrong-option').first().click();
    await item.getByTestId('a3-wrong-retry-submit').click();

    await expect(page.getByTestId('a3-wrong-retry-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-profile-update-candidate-panel')).toBeVisible({ timeout: 60_000 });
    await expectProfileCandidateFromEvent(page, 'wrong_question_reviewed', ['weakPoints', 'mistakePatterns']);
  });

  test('classroom question creates a cognitive style candidate', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-classroom-input').fill('请一步一步讲解根轨迹为什么能判断系统稳定性');
    await page.getByTestId('a3-classroom-submit').click();

    await expect(page.getByTestId('a3-classroom-verification')).toBeVisible({ timeout: 90_000 });
    await expectProfileCandidateFromEvent(page, 'classroom_qa', ['cognitiveStyle']);
  });

  test('resource feedback creates a resource preference candidate', async ({ page }) => {
    test.setTimeout(360_000);
    await loginAsStudent(page);

    await page.goto('/a3/recommendations');
    await expect(page.getByTestId('a3-recommendations-view')).toBeVisible({ timeout: 60_000 });
    await page.locator('main textarea, main input').first().fill('请生成根轨迹与稳定性判断的专项学习资源包，用于课堂学习和练习复盘');
    await expect(page.getByTestId('a3-resource-generation-primary')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('a3-resource-generation-primary').click();
    await expect(page.getByTestId('a3-resource-entry')).toHaveCount(7, { timeout: 120_000 });

    await page.getByTestId('a3-resource-entry').first().getByRole('link').click();
    const completeResource = page.getByRole('button').filter({ hasText: /完成|瀹屾垚/ }).first();
    await expect(completeResource).toBeEnabled({ timeout: 60_000 });
    await completeResource.click();
    await expect(page.getByTestId('a3-resource-feedback-message')).toBeVisible({ timeout: 60_000 });
    await expectProfileCandidateFromEvent(page, 'resource_feedback', ['resourcePreferences']);
  });
});
