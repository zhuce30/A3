import { execFileSync } from 'node:child_process';
import { expect, test } from '../fixtures/base';
import { resolveA3PlaywrightRuntime } from '../playwright-runtime';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';

test.beforeAll(({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const runtime = resolveA3PlaywrightRuntime(process.env, process.cwd());
  if (!runtime.useExistingServers) {
    execFileSync(runtime.backendPython, [runtime.backendManagePy, 'seed_demo_data'], {
      cwd: runtime.backendProjectRoot,
      stdio: 'pipe',
    });
  }
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 60_000 });
}

test('keeps evidence detail inside the graph workspace and can restore full canvas width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto('/a3/knowledge-graph');

  const workspace = page.getByTestId('a3-knowledge-graph-workspace');
  const graph = page.getByTestId('a3-real-knowledge-graph');
  const detail = page.getByTestId('a3-material-detail-panel');
  await expect(workspace).toBeVisible({ timeout: 60_000 });
  await expect(graph).toBeVisible();
  await expect(detail).toBeVisible();
  const selectedMaterialTitle = (await detail.locator('h3').first().textContent())?.trim();
  expect(selectedMaterialTitle).toBeTruthy();

  await page.getByRole('tab', { name: '课程路径' }).click();
  await expect(page.getByText('正在读取课程路径图')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('正在读取课程路径图')).not.toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: '资料图谱' }).click();
  await expect(detail.locator('h3').first()).toHaveText(selectedMaterialTitle ?? '');
  await page.screenshot({ path: 'test-results/a3-knowledge-graph-1440.png', fullPage: true });

  const workspaceBox = await workspace.boundingBox();
  const graphBoxWithDetail = await graph.boundingBox();
  expect(workspaceBox).not.toBeNull();
  expect(graphBoxWithDetail).not.toBeNull();
  expect(Math.abs((workspaceBox?.height ?? 0) - (graphBoxWithDetail?.height ?? 0))).toBeLessThan(4);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(detail).toBeVisible();
  await page.screenshot({ path: 'test-results/a3-knowledge-graph-1024.png', fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  const graphBoxWithDetailAfterResize = await graph.boundingBox();
  expect(graphBoxWithDetailAfterResize).not.toBeNull();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(detail).not.toBeVisible();

  const graphBoxWithoutDetail = await graph.boundingBox();
  expect(graphBoxWithoutDetail).not.toBeNull();
  expect(graphBoxWithoutDetail?.width ?? 0).toBeGreaterThan(graphBoxWithDetailAfterResize?.width ?? 0);
});

test('labels local search honestly and exposes data health on demand', async ({ page }) => {
  await login(page);
  await page.goto('/a3/knowledge-graph');

  await expect(page.getByPlaceholder('搜索当前视图中的实体')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '数据状态' }).click();
  await expect(page.getByTestId('a3-material-graph-data-status')).toBeVisible();
});
