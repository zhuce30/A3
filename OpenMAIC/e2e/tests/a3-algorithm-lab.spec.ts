import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';
const BACKEND_BASE_URL = process.env.A3_E2E_BACKEND_URL
  ?? process.env.NEXT_PUBLIC_A3_API_BASE_URL
  ?? 'http://localhost:8000';

function seedDemoData() {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON
    ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  execFileSync(python, [path.join(projectRoot, 'backend', 'manage.py'), 'seed_demo_data'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DJANGO_DEBUG: '1',
      DJANGO_SETTINGS_MODULE: 'backend.config.test_sqlite_settings',
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: Page) {
  await page.context().clearCookies();
  await page.request.get(new URL('/api/auth/csrf/', BACKEND_BASE_URL).toString(), { timeout: 10_000 });
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>('body *')]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).split(/\s+/).slice(0, 3).join('.')}` : ''}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      })
      .filter(({ left, right, width }) => width > 0 && (left < -1 || right > window.innerWidth + 1))
      .slice(0, 12),
  }));
  expect(
    dimensions.scrollWidth,
    JSON.stringify(dimensions.offenders, null, 2),
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function answerVisibleCheckpoints(page: Page) {
  for (let guard = 0; guard < 4; guard += 1) {
    const submitButtons = page.getByRole('button', { name: '提交答案', exact: true });
    let answered = false;
    for (let index = 0; index < await submitButtons.count(); index += 1) {
      const submit = submitButtons.nth(index);
      if (!await submit.isVisible()) continue;
      const section = submit.locator('xpath=ancestor::section[1]');
      await section.getByRole('radio').first().check();
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(
        page.getByRole('status').filter({ hasText: '正在同步检查点记录' }),
      ).toHaveCount(0, { timeout: 30_000 });
      answered = true;
      break;
    }
    if (!answered) return;
  }
}

async function finishWithNextStep(page: Page, nextStep: Locator) {
  for (let guard = 0; guard < 240; guard += 1) {
    await answerVisibleCheckpoints(page);
    if (!await nextStep.isEnabled()) break;
    await nextStep.click();
  }
  await answerVisibleCheckpoints(page);
  await expect(nextStep).toBeDisabled();
}

async function openLabFromCatalog(page: Page, title: RegExp) {
  await page.goto('/a3/labs');
  const card = page.getByTestId('a3-algorithm-lab-item').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByTestId('a3-algorithm-lab-action').click();
}

test.describe.serial('A3 operating-system algorithm lab', () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    seedDemoData();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsStudent(page);
  });

  test('student completes a verified CPU scheduling lab and reloads backend progress', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLabFromCatalog(page, /CPU 调度算法/);

    await page.getByLabel('实验预设').selectOption('cpu-foundation');
    await page.getByRole('button', { name: '跳过预测', exact: true }).click();

    const play = page.getByRole('button', { name: '播放', exact: true });
    const pause = page.getByRole('button', { name: '暂停', exact: true });
    const nextStep = page.getByRole('button', { name: '下一步', exact: true });
    await play.click();
    await expect(pause).toBeEnabled({ timeout: 30_000 });
    await pause.click();
    await finishWithNextStep(page, nextStep);

    await expect(page.getByRole('status').filter({ hasText: '运行完成' })).toBeVisible();
    const submitCompletion = page.getByRole('button', { name: '提交学习记录', exact: true });
    await expect(submitCompletion).toBeEnabled();
    await submitCompletion.click();
    await expect(page.getByRole('region', { name: '学习证据写回结果' })).toContainText('已验证学习证据');

    await page.reload();
    await page.goto('/a3/labs');
    const cpuCard = page.getByTestId('a3-algorithm-lab-item').filter({ hasText: /CPU 调度算法/ });
    await expect(cpuCard).toContainText('已完成');
    await assertNoHorizontalOverflow(page);
  });

  test('page-replacement matrix remains usable at desktop, tablet, and mobile sizes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLabFromCatalog(page, /页面置换算法/);
    await page.getByRole('button', { name: '跳过预测', exact: true }).click();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: '暂停', exact: true }).click();

    const canvas = page.getByRole('region', { name: '算法运行画布' });
    const matrix = page.getByRole('region', { name: '页面置换页框矩阵' });
    await expect(matrix).toBeVisible();
    await expect(canvas).toHaveCSS('min-height', '430px');
    await assertNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole('button', { name: '输入设置', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '运行结果', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下一步', exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    const runTab = page.getByRole('tab', { name: '运行', exact: true });
    await expect(runTab).toHaveAttribute('aria-selected', 'true');
    await expect(matrix).toBeVisible();
    await expect(page.getByRole('button', { name: /移动端查看 FIFO/ })).toHaveCount(1);
    await assertNoHorizontalOverflow(page);
  });

  test('keyboard controls and reduced-motion mode preserve state changes', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLabFromCatalog(page, /页面置换算法/);

    const skipPrediction = page.getByRole('button', { name: '跳过预测', exact: true });
    await skipPrediction.focus();
    await page.keyboard.press('Enter');

    const play = page.getByRole('button', { name: '播放', exact: true });
    await play.focus();
    await page.keyboard.press('Space');
    const pause = page.getByRole('button', { name: '暂停', exact: true });
    await expect(pause).toBeEnabled({ timeout: 30_000 });
    await pause.focus();
    await page.keyboard.press('Space');

    const speed = page.getByLabel('播放速度');
    await expect(speed).toHaveAttribute('type', 'range');
    await expect(speed).toHaveAttribute('aria-valuetext', /1x/);
    await speed.press('ArrowRight');
    await expect(speed).toHaveAttribute('aria-valuetext', /1\.5x/);

    const nextStep = page.getByRole('button', { name: '下一步', exact: true });
    await nextStep.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/步骤 2 \/ /)).toBeVisible();
    await expect(nextStep).toHaveCSS('transition-duration', '0s');
  });
});
