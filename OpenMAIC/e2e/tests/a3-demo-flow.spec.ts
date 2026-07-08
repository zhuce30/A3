import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';
const REAL_SMOKE_VIDEO_WRITEBACK = '\u771f\u5b9e \u0073\u006d\u006f\u006b\u0065 \u89c6\u9891\u5b89\u5168\u5199\u56de';

function seedDemoData() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, 'seed_demo_data'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAs(page: Page, phone: string) {
  await page.goto('/a3/login');
  await page.getByPlaceholder(/手机号|邮箱|学号/).fill(phone);
  await page.getByPlaceholder('密码').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

async function postDjangoJson(page: Page, apiPath: string, data: unknown) {
  const cookies = await page.context().cookies('http://localhost:8000');
  const csrfToken = cookies.find((cookie) => cookie.name === 'csrftoken')?.value ?? '';
  return page.request.post(`http://localhost:8000${apiPath}`, {
    headers: csrfToken ? { 'X-CSRFToken': csrfToken } : undefined,
    data,
  });
}

async function generateResourcePackWithOpenMAICArtifact(page: Page) {
  const generated = await postDjangoJson(page, '/api/resources/generate/', {
    goal: 'demo-flow OpenMAIC latest artifact history',
    topK: 3,
  });
  expect(generated.ok()).toBeTruthy();
  const payload = await generated.json() as { resourcePack?: { resourcePackId?: string } };
  const resourcePackId = payload.resourcePack?.resourcePackId;
  expect(resourcePackId).toBeTruthy();

  const writeback = await postDjangoJson(page, `/api/resources/packs/${resourcePackId}/openmaic-classroom/`, {
    jobId: 'job-demo-flow-latest',
    status: 'succeeded',
    classroomId: 'classroom-demo-flow-latest',
    classroomUrl: '/classroom/classroom-demo-flow-latest',
    scenesCount: 4,
    pptxExportable: true,
    provider: 'openmaic-generate-classroom',
    elapsedMs: 1000,
    degradedReason: '',
  });
  expect(writeback.ok()).toBeTruthy();
}

test.describe.serial('A3 contest demo smoke flow', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test('student can generate a validation report from demo flow', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await page.goto('/a3/demo-flow');

    await expect(page.getByTestId('a3-demo-flow')).toBeVisible();
    await expect(page.getByTestId('a3-defense-script-entry')).toBeVisible();
    await expect(page.getByTestId('a3-defense-script-entry')).toContainText('6 分钟答辩脚本');
    await expect(page.getByTestId('a3-defense-script-entry')).toContainText('docs/A3_6分钟答辩脚本.md');
    await expect(page.getByTestId('a3-openmaic-acceptance-checklist')).toBeVisible();
    await expect(page.getByTestId('a3-openmaic-acceptance-checklist')).toContainText('OpenMAIC 接入验收清单');
    await expect(page.getByTestId('a3-openmaic-acceptance-item')).toHaveCount(7);
    await expect(page.getByTestId('a3-openmaic-acceptance-checklist')).toContainText('资源包 artifact 写回');
    await expect(page.getByTestId('a3-openmaic-acceptance-checklist')).toContainText('真实视频 provider 可验收');
    await expect(page.getByTestId('a3-openmaic-acceptance-checklist')).toContainText(REAL_SMOKE_VIDEO_WRITEBACK);
    await expect(page.getByTestId('a3-demo-evaluation-evidence')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-demo-evaluation-evidence')).toContainText('50');
    await expect(page.getByTestId('a3-demo-evaluation-evidence')).toContainText('Top3');
    await expect(page.getByTestId('a3-demo-evaluation-evidence')).toContainText('/a3/capabilities');
    await expect(page.getByTestId('a3-run-validation')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('a3-run-validation').click();

    const report = page.getByTestId('a3-validation-report');
    await expect(report).toContainText('A3 演示验收报告', { timeout: 60_000 });
    await expect(report).toContainText('teacherIntervention');
  });

  test('teacher intervention appears in student notifications', async ({ page, context }) => {
    await loginAs(page, TEACHER_PHONE);
    await page.goto('/a3/teacher');

    await expect(page.getByTestId('a3-teacher-workbench')).toBeVisible();
    await page.getByTestId('a3-student-intervention').first().click();
    await expect(page.getByTestId('a3-teacher-message')).toBeVisible({ timeout: 30_000 });

    await context.clearCookies();
    await loginAs(page, STUDENT_PHONE);
    await page.goto('/a3/notifications');

    await expect(page.getByTestId('a3-notifications-view')).toBeVisible();
    await expect(page.getByTestId('a3-notification-item').first()).toBeVisible({ timeout: 30_000 });
  });

  test('OpenMAIC demo flow opens latest resource pack artifact history', async ({ page }) => {
    await loginAs(page, STUDENT_PHONE);
    await generateResourcePackWithOpenMAICArtifact(page);
    await page.goto('/a3/demo-flow');

    await expect(page.getByTestId('a3-openmaic-demo-flow')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('a[href="/a3/resources/latest"]').first()).toBeVisible();
    await page.locator('a[href="/a3/resources/latest"]').first().click();

    await expect(page).toHaveURL(/\/a3\/resources\/latest/);
    await expect(page.getByTestId('a3-resource-pack-detail')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('a3-resource-pack-artifact-history')).toContainText('job-demo-flow-latest');
    await expect(page.getByTestId('a3-resource-pack-artifact-summary')).toContainText('1/1');
  });
});
