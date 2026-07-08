import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../fixtures/base';

const STUDENT_PHONE = '13800000001';
const DEMO_PASSWORD = 'Demo@123456';
const MOJIBAKE_PATTERN = /�|鈥|鈮|鉁|鉂|涓[\u4e00-\u9fff]?|鍙[\u4e00-\u9fff]?|鐢[\u4e00-\u9fff]?|璧[\u4e00-\u9fff]?|鏁[\u4e00-\u9fff]?|鎺[\u4e00-\u9fff]?|绋[\u4e00-\u9fff]?|瀛[\u4e00-\u9fff]?|楠[\u4e00-\u9fff]?/;
const LOCAL_WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^'"\s)]+/;

function runManage(command: string, args: string[] = []) {
  const projectRoot = path.resolve(process.cwd(), '..');
  const python = process.env.A3_BACKEND_PYTHON ?? path.join(projectRoot, 'backend', '.venv', 'Scripts', 'python.exe');
  const manage = path.join(projectRoot, 'backend', 'manage.py');
  execFileSync(python, [manage, command, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

async function loginAsStudent(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/a3/login');
  const inputs = page.locator('main input');
  await inputs.nth(0).fill(STUDENT_PHONE);
  await inputs.nth(1).fill(DEMO_PASSWORD);
  await page.locator('main button').first().click();
  await expect(page).not.toHaveURL(/\/a3\/login/, { timeout: 15_000 });
}

test.describe.serial('A3 capabilities evidence board', () => {
  test.setTimeout(180_000);

  test.beforeAll(() => {
    runManage('seed_demo_data');
    const projectRoot = path.resolve(process.cwd(), '..');
    const metricsPath = path.join(projectRoot, 'backend', 'tmp', 'demo_retrieval_metrics.json');
    if (!fs.existsSync(metricsPath)) {
      runManage('evaluate_demo_retrieval', ['--top-k', '3', '--json', '--output', 'backend/tmp/demo_retrieval_metrics.json']);
    }
  });

  test('student sees market-readiness evidence, risks, and verifiable metrics', async ({ page }) => {
    await loginAsStudent(page);

    const statusResponse = page.waitForResponse((response) => response.url().includes('/api/demo/status/') && response.status() === 200);
    await page.goto('/a3/capabilities');
    await statusResponse;

    await expect(page.getByTestId('a3-capabilities-view')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: '产品级学习闭环与 Agent 评测指标' })).toBeVisible();
    await expect(page.getByTestId('a3-capabilities-view').getByText('能力总览', { exact: true })).toBeVisible();
    await expect(page.getByText('学习闭环证据')).toBeVisible();
    await expect(page.getByText('最近视频 smoke 报告')).toBeVisible();
    await expect(page.getByText('验收命令')).toBeVisible();
    const visibleText = await page.getByTestId('a3-capabilities-view').textContent();
    expect(visibleText ?? '').not.toMatch(MOJIBAKE_PATTERN);
    expect(visibleText ?? '').not.toMatch(LOCAL_WINDOWS_PATH_PATTERN);
    await expect(page.getByText('已就绪能力')).toBeVisible();
    await expect(page.getByTestId('a3-market-readiness-radar')).toBeVisible();
    await expect(page.getByTestId('a3-learning-loop-readiness')).toBeVisible();
    await expect(page.getByTestId('a3-learning-loop-evidence').first()).toBeVisible();
    await expect(page.getByTestId('a3-capability-risk-list')).toBeVisible();
    await expect(page.getByTestId('a3-capability-evidence-board')).toBeVisible();
    await expect(page.getByTestId('a3-capability-evidence-board')).toContainText('validate_demo_flow');
    await expect(page.getByTestId('a3-capability-evidence-board')).toContainText('evaluate_demo_retrieval');
    await expect(page.getByTestId('a3-capability-evidence-board')).toContainText('evaluate_agent_workflows');
    await expect(page.getByTestId('a3-capability-evidence-board')).toContainText('backend/tmp/demo_retrieval_metrics.json');
    await expect(page.getByTestId('a3-capability-fix-flow')).toBeVisible();
    await expect(page.getByTestId('a3-capability-fix-validate')).toBeEnabled();
    await expect(page.getByTestId('a3-capability-fix-evaluate')).toBeEnabled();
    await expect(page.getByTestId('a3-evaluation-scale')).toBeVisible();
    await expect(page.getByTestId('a3-evaluation-scale')).toContainText('50');
    await expect(page.getByTestId('a3-evaluation-scale')).toContainText('missing evidence');
    await expect(page.getByTestId('a3-evaluation-metrics-file')).toBeVisible();
    await expect(page.getByTestId('a3-evaluation-metrics-file')).toContainText('backend/tmp/demo_retrieval_metrics.json');
    await expect(page.getByTestId('a3-agent-workflow-metrics')).toBeVisible();
    await expect(page.getByTestId('a3-agent-workflow-metrics')).toContainText('Agent Workflow Evaluation');
    await expect(page.getByTestId('a3-agent-workflow-metrics')).toContainText('backend/tmp/agent_workflow_metrics.json');
    await expect(page.getByTestId('a3-evaluation-target-status')).toBeVisible();
    await expect(page.getByTestId('a3-agent-runtime-governance')).toContainText('预算违约');
    await expect(page.getByTestId('a3-agent-runtime-slow-steps')).toBeVisible();
    await expect(page.getByTestId('a3-agent-trace-waterfall')).toBeVisible();
  });
});

