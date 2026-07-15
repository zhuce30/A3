import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  return execFileSync(python, [path.join(projectRoot, 'backend', 'manage.py'), command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

const systemResource = {
  resourceCode: 'OS-LAB-001',
  title: 'Linux 进程调度观察实验',
  resourceType: 'code_lab',
  resourceTypeLabel: '实操案例',
  deliveryMode: 'internal_document',
  deliveryModeLabel: '站内文档',
  summary: '通过 Linux 命令观察进程状态与调度行为。',
  provider: '',
  course: { code: 'OS-001', title: '操作系统' },
  difficulty: 'foundation',
  difficultyLabel: '基础',
  estimatedMinutes: 25,
  keySegment: '进程调度',
  knowledgePoints: [{ id: 'kp-scheduling', code: 'OS-SCHEDULING', title: 'CPU 调度' }],
  prerequisites: [],
  learnerProfiles: ['需要巩固调度基础的学生'],
  learningObjectives: ['观察调度行为'],
  completionCriteria: ['完成实验记录'],
  isFree: true,
  personalization: {
    score: 96,
    reason: '匹配你的薄弱知识点：CPU 调度；近期错题尚未掌握',
    matchedKnowledgePoints: ['CPU 调度'],
    matchedTriggers: ['current_path', 'wrong_question'],
    rankingBasis: [{ label: '当前路径知识点', value: ['CPU 调度'] }],
  },
  action: { label: '站内阅读文档', href: '/api/kb/library/OS-LAB-001/content/', external: false },
  verification: {
    status: 'verified',
    catalogVerified: true,
    citationEligible: true,
    note: '站内文档已关联知识库，可作为检索与引用来源。',
    verifiedAt: '2026-07-15',
  },
  contentPreview: [{ modality: 'text', markdown: '## 实验步骤\n\n观察时间片轮转调度。', confidence: 0.95 }],
};

async function installLibraryRoutes(page: Page) {
  await page.route('**/api/kb/library/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/kb/library/') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          recommended: [systemResource],
          resources: [systemResource],
          summary: { total: 19, documents: 7, videos: 12 },
          filters: { type: '', difficulty: '', query: '' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, resource: systemResource }),
    });
  });
}

test.describe.serial('A3 platform system resource flow', () => {
  test.beforeAll(() => {
    runManage('seed_demo_data');
    runManage('import_os_curated_resources');
  });

  test('student opens a personalized platform resource and writes completion feedback', async ({ page }) => {
    await loginAsStudent(page);
    await installLibraryRoutes(page);
    await page.goto('/a3/library');

    await expect(page.getByTestId('a3-system-library-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('a3-system-library-recommended')).toBeVisible();
    await expect(page.getByText('19', { exact: true }).first()).toBeVisible();
    await page.getByTestId('a3-system-library-recommended').getByRole('link', { name: '查看详情' }).first().click();

    await expect(page.getByTestId('a3-system-resource-detail')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('为什么推荐给你')).toBeVisible();
    await expect(page.getByText('完成标准')).toBeVisible();
    const eventResponse = page.waitForResponse((response) => response.url().includes('/api/learning/events/') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '标记完成' }).click();
    expect([200, 201]).toContain((await eventResponse).status());
    await expect(page.getByText(/已标记完成/)).toBeVisible();
  });

  test('library remains readable on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAsStudent(page);
    await installLibraryRoutes(page);
    await page.goto('/a3/library');
    await expect(page.getByTestId('a3-system-library-view')).toBeVisible({ timeout: 30_000 });
    const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  });
});
