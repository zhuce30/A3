import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';
const PROFILE_REFRESH_MARKER = 'E2E_PROFILE_CONFIRM_REFRESH_MARKER';

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

function seedProfileCandidate() {
  runManage('seed_demo_data');
  runManage('shell', [
    '-c',
    `
from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_updates import create_profile_update_candidate

user = User.objects.get(phone="${STUDENT_PHONE}")
profile, _ = LearnerProfile.objects.get_or_create(user=user)
extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
extra["profileUpdateCandidates"] = []
extra["profileVersions"] = []
profile.extra_profile = extra
profile.save(update_fields=["extra_profile", "updated_at"])
create_profile_update_candidate(
    profile,
    dimension="motivationRisk",
    previous_value="baseline",
    next_value="${PROFILE_REFRESH_MARKER}",
    source="learning_event_stream",
    evidence={"eventTypes": ["task_skip", "practice_low_accuracy"], "windowDays": 7},
    confidence=0.83,
    conflict_explanation="E2E profile confirmation should refresh today, study plan, and recommendations rationale.",
)
`,
  ]);
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

async function fetchDynamicProfileFromBrowser(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('http://localhost:8000/api/profiles/dynamic-profile/', {
      credentials: 'include',
      cache: 'no-store',
    });
    return response.json();
  }) as Promise<{ success: boolean; confirmationQueue: unknown[]; timeline: Array<{ status: string }> }>;
}

async function expectConfirmedProfileRationale(page: Page, route: string, viewTestId: string, rationaleTestId: string) {
  await page.goto(route);
  await expect(page.getByTestId(viewTestId)).toBeVisible({ timeout: 60_000 });
  const rationale = page.getByTestId(rationaleTestId).first();
  await expect(rationale).toBeVisible({ timeout: 60_000 });
  await expect(rationale).toContainText(PROFILE_REFRESH_MARKER, { timeout: 60_000 });
  await expect(rationale).toContainText('83%', { timeout: 60_000 });
}

test.describe.serial('A3 profile confirmation refreshes learning flows', () => {
  test.setTimeout(180_000);

  test.beforeEach(() => {
    seedProfileCandidate();
  });

  test('confirming a profile candidate refreshes today, study plan, and recommendations rationale', async ({ page }) => {
    await loginAsStudent(page);

    await page.goto('/a3/profile-setup');
    await expect(page.getByTestId('a3-profile-setup-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-update-timeline')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-update-confirm').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-profile-update-timeline')).toContainText(PROFILE_REFRESH_MARKER);
    await expect(page.getByTestId('a3-profile-update-timeline')).toContainText('83%');

    await page.getByTestId('a3-profile-update-confirm').first().click();
    await expect(page.getByTestId('a3-profile-update-confirm')).toHaveCount(0, { timeout: 60_000 });

    const feed = await fetchDynamicProfileFromBrowser(page);
    expect(feed.success).toBeTruthy();
    expect(feed.confirmationQueue).toHaveLength(0);
    expect(feed.timeline[0]?.status).toBe('confirmed');

    await expectConfirmedProfileRationale(page, '/a3/today', 'a3-today-view', 'a3-task-profile-rationale');
    await expectConfirmedProfileRationale(page, '/a3/study-plan', 'a3-study-plan-view', 'a3-task-profile-rationale');
    await expectConfirmedProfileRationale(page, '/a3/recommendations', 'a3-recommendations-view', 'a3-recommendation-profile-rationale');
  });
});
