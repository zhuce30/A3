import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const TEACHER_PHONE = '13800000002';
const DEMO_PASSWORD = 'Demo@123456';
const PPT_FIXTURE_NAME = 'a3-e2e-real-ppt-evidence.pptx';

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  return execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasIndexedPptEvidence(originalName: string) {
  const output = runManage('shell', [
    '-c',
    [
      'from backend.apps.knowledge_base.models import KnowledgeResource',
      `ready = KnowledgeResource.objects.filter(original_name=${JSON.stringify(originalName)}, file_type__iexact='.pptx', status__in=['indexed', 'indexed_with_warnings'], assets__kind='rendered_slide').distinct().exists()`,
      "print('A3_REAL_PPT_READY=1' if ready else 'A3_REAL_PPT_READY=0')",
    ].join('; '),
  ]);
  return output.includes('A3_REAL_PPT_READY=1');
}

function hasPptResource(originalName: string) {
  const output = runManage('shell', [
    '-c',
    [
      'from backend.apps.knowledge_base.models import KnowledgeResource',
      `exists = KnowledgeResource.objects.filter(original_name=${JSON.stringify(originalName)}).exists()`,
      "print('A3_REAL_PPT_EXISTS=1' if exists else 'A3_REAL_PPT_EXISTS=0')",
    ].join('; '),
  ]);
  return output.includes('A3_REAL_PPT_EXISTS=1');
}

async function loginAsStudent(page: Page) {
  await loginAs(page, STUDENT_PHONE);
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
  await page.locator('main button').last().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe.serial('A3 classroom real PPT evidence', () => {
  test('renders real indexed PPT slides in the redesigned claim-citation gallery', async ({ page }, testInfo) => {
    test.skip(process.env.A3_RUN_REAL_PPT_E2E !== '1', 'Set A3_RUN_REAL_PPT_E2E=1 to verify real indexed PPT evidence.');
    test.setTimeout(300_000);

    runManage('seed_demo_data');
    if (!hasPptResource(PPT_FIXTURE_NAME)) {
      const fixturePath = path.resolve(process.cwd(), '..', 'outputs', 'A3-多模态知识库与知识图谱构建-可编辑.pptx');
      expect(fs.existsSync(fixturePath), `Missing repository PPTX fixture: ${fixturePath}`).toBe(true);
      await loginAsTeacher(page);
      await page.goto('/a3/knowledge-base');
      await expect(page.getByTestId('a3-knowledge-base-view')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('a3-kb-file-input').setInputFiles({
        name: PPT_FIXTURE_NAME,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        buffer: fs.readFileSync(fixturePath),
      });
      await page.getByTestId('a3-kb-upload-submit').click();
    }
    await expect.poll(() => hasIndexedPptEvidence(PPT_FIXTURE_NAME), {
      timeout: 120_000,
      intervals: [2_000, 5_000, 10_000],
      message: 'The real PPTX fixture was not indexed with a rendered_slide asset.',
    }).toBe(true);

    const previewResponses: Array<{ url: string; status: number; contentType: string }> = [];
    page.on('response', (response) => {
      const contentType = response.headers()['content-type'] ?? '';
      if (contentType.startsWith('image/')) {
        previewResponses.push({ url: response.url(), status: response.status(), contentType });
      }
    });

    await loginAsStudent(page);
    await page.goto('/a3/classroom');
    await expect(page.getByTestId('a3-classroom-view')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('a3-classroom-new-dialogue').click();
    const retrievalControls = page.getByTestId('a3-classroom-retrieval-controls');
    await retrievalControls.getByRole('button').nth(1).click();
    await retrievalControls.locator('select').selectOption('teacher');
    await page.getByTestId('a3-classroom-input').fill('请根据多模态知识库与知识图谱构建课件，解释知识图谱、AI 辅导引用和 Verifier 证据验证流程，并引用具体课件页面。');
    await page.getByTestId('a3-classroom-submit').click();

    const gallery = page.getByTestId('a3-classroom-claim-citation-map').last();
    await expect(gallery).toBeVisible({ timeout: 120_000 });
    const preview = gallery.getByTestId('a3-classroom-citation-preview').first();
    await expect(preview).toBeVisible();
    await expect.poll(async () => preview.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), {
      timeout: 30_000,
    }).toBe(true);
    expect(previewResponses.some(({ status, contentType }) => status === 200 && contentType.startsWith('image/'))).toBe(true);

    const thumbnails = gallery.getByTestId('a3-classroom-evidence-thumbnail');
    if (await thumbnails.count() > 1) {
      await thumbnails.nth(1).click();
      await expect(thumbnails.nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/\/a3\/classroom/);
    }

    await page.screenshot({ path: testInfo.outputPath('a3-classroom-ppt-evidence-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(gallery).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('a3-classroom-ppt-evidence-mobile.png'), fullPage: true });
  });
});
