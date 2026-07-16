import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const resourcePack = {
  schemaVersion: 'a3.resource-pack.v2',
  resourcePackId: 'workbench-pack',
  traceId: 'trace-workbench',
  goal: '掌握操作系统进程调度',
  learnerProfileSnapshot: {},
  resourceStrategy: { resourceTypes: ['practice_set', 'case_study', 'code_lab'] },
  sources: [],
  resources: [
    {
      type: 'practice_set', title: '进程调度专项练习', verified: true, personalizationReason: '针对调度算法薄弱点生成。', estimatedMinutes: 18,
      citations: [{ id: 'S1', title: '操作系统课程资料', location: '第 3 章', snippet: '时间片轮转按照固定时间片切换进程。' }],
      content: {
        questions: [
          { id: 'q1', type: 'choice', knowledgePoint: '时间片轮转', difficulty: '基础', stem: '使用时间片轮转算法前，最应该先确认什么？', options: ['A. 只看进程名称', 'B. 时间片和就绪队列状态', 'C. 忽略到达时间', 'D. 随机选择进程'], answer: 'B', explanation: 'RR 的行为由时间片和就绪队列共同决定。', distractorAnalysis: ['A 没有反映调度条件。', 'C 会导致周转时间判断错误。', 'D 不符合算法规则。'], commonMistake: '只记住轮转，不检查时间片。', evaluationRubric: ['识别时间片', '说明队列状态', '引用资料证据'], sourceIds: ['S1'] },
          ...Array.from({ length: 7 }, (_, index) => ({ id: `q${index + 2}`, type: 'analysis', knowledgePoint: '进程调度', difficulty: index < 3 ? '中等' : '提高', stem: `分析题 ${index + 2}：比较调度条件。`, answer: '应比较到达时间、服务时间和调度目标。', explanation: '先列条件，再比较算法结果。', distractorAnalysis: [], commonMistake: '只写最终结论。', evaluationRubric: ['条件完整', '推理清楚', '证据可靠'], sourceIds: ['S1'] })),
        ], sourceIds: ['S1'],
      },
    },
    {
      type: 'case_study', title: '高并发服务调度案例', verified: true, personalizationReason: '结合工程场景训练调度判断。', estimatedMinutes: 15,
      citations: [{ id: 'S1', title: '操作系统课程资料', location: '第 3 章', snippet: '响应时间和周转时间对应不同调度目标。' }],
      content: { scenario: '高并发服务出现长任务阻塞', role: '系统性能分析员', constraints: ['不能中断核心请求', '需要控制平均响应时间'], background: '服务同时处理短请求和长计算任务。', task: '选择调度策略并说明风险。', studentPrompt: '写出你的策略、两个依据和一个风险。', materials: [{ title: '请求统计', snippet: '短请求占 80%，长任务平均执行 8 秒。', sourceId: 'S1' }, { title: '服务目标', snippet: '要求多数请求快速响应。', sourceId: 'S2' }], decisionPoints: ['优先优化响应时间还是吞吐量', '长任务如何避免饥饿'], analysisSteps: ['识别请求类型', '提取性能目标', '比较候选算法', '检查饥饿风险'], expertAnalysis: '可采用多级反馈队列，并为长任务提供老化机制。', rubric: ['识别目标', '引用材料', '说明风险'], reflection: '还有哪些负载变化会影响方案？', sourceIds: ['S1', 'S2'] },
    },
    {
      type: 'code_lab', title: '时间片轮转代码实验', verified: true, personalizationReason: '通过运行代码观察调度顺序。', estimatedMinutes: 20,
      citations: [{ id: 'S1', title: '调度算法实验', location: '实验 2', snippet: '用队列模拟时间片轮转。' }],
      content: { language: 'Python', objective: '运行时间片轮转模拟并观察执行顺序。', environment: 'Python 3.10+，标准库', concepts: ['队列', '时间片', '剩余时间'], starterCode: "from collections import deque\nprint('RR ready')\n", steps: ['运行起始代码', '添加进程数据', '修改时间片', '比较输出', '记录结论'], expectedOutput: 'RR ready', testCases: [{ name: '默认输出', stdin: '', expectedStdout: 'RR ready\n' }], hints: ['先确认队列是否为空。'], commonFailures: ['忘记把未完成进程重新入队。'], checkpoints: ['代码可以运行', '输出顺序正确', '能修改时间片', '能解释结果'], extension: '加入不同到达时间。', sourceIds: ['S1'] },
    },
  ],
  verification: { verified: true, citations: [], claims: [], safety: {} },
  nextActions: [], multimodalArtifacts: [], createdAt: new Date().toISOString(), generationMode: 'single', requestedResourceType: 'practice_set',
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockDependencies(page: Page, feedbackBodies: Array<Record<string, unknown>> = []) {
  await page.route('**/api/access-code/status', (route) => fulfillJson(route, { enabled: false, authenticated: true }));
  await page.route('**/api/auth/me/', (route) => fulfillJson(route, { user: { id: 'workbench-student', phone: '13800000001', nickname: '张三', role: 'student', phoneBound: true, privacyAccepted: true, profileCompleted: true, onboardingStep: 'completed' } }));
  await page.route('**/api/resources/packs/workbench-pack/', (route) => route.request().method() === 'GET'
    ? fulfillJson(route, { success: true, resourcePack })
    : fulfillJson(route, { success: true }));
  await page.route('**/api/resources/packs/workbench-pack/feedback/', async (route) => {
    feedbackBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await fulfillJson(route, { success: true });
  });
  await page.route('**/api/resources/packs/workbench-pack/code-lab/run/', async (route) => {
    const request = route.request().postDataJSON() as { mode?: string };
    await fulfillJson(route, {
      success: true,
      result: request.mode === 'judge'
        ? { status: 'passed', mode: 'judge', provider: 'local_subprocess', passedCount: 1, totalCount: 1, testResults: [{ name: '默认输出', passed: true, status: 'passed', expectedStdout: 'RR ready\n', actualStdout: 'RR ready\n' }], durationMs: 12 }
        : { status: 'passed', mode: 'run', provider: 'local_subprocess', stdout: 'RR ready\n', stderr: '', durationMs: 12 },
    });
  });
  await page.route('**/api/engagement/notifications/**', (route) => fulfillJson(route, { success: true, notifications: [], unreadCount: 0 }));
  await page.route('**/api/resources/jobs/**', (route) => fulfillJson(route, { success: true, jobs: [] }));
  await page.route('**/api/kb/jobs/**', (route) => fulfillJson(route, { success: true, jobs: [] }));
  await page.route('**/api/a3/tasks**', (route) => fulfillJson(route, { success: true, tasks: [], summary: { active: 0, failed: 0 } }));
  await page.route('**/api/learning/events/**', (route) => fulfillJson(route, { success: true }));
}

test.describe('A3 professional resource workbenches', () => {
  test.beforeEach(async ({ page }) => mockDependencies(page));

  test('practice reveals only the submitted question feedback', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/a3/resources/workbench-pack/practice');
    await expect(page.getByTestId('a3-practice-set-workbench')).toBeVisible();
    await expect(page.getByRole('heading', { name: '解析' })).toHaveCount(0);
    await page.getByRole('button', { name: /B\. 时间片和就绪队列状态/ }).click();
    await page.getByRole('button', { name: '提交本题' }).click();
    await expect(page.getByRole('heading', { name: '解析' })).toBeVisible();
    await expect(page.getByText('其他选项为什么不对')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('practice-workbench-desktop.png'), fullPage: true });
  });

  test('interactive resources unlock completion only after real work and submit evidence-based scores', async ({ page }) => {
    const feedbackBodies: Array<Record<string, unknown>> = [];
    await mockDependencies(page, feedbackBodies);

    await page.goto('/a3/resources/workbench-pack/practice');
    const completePractice = page.getByTestId('a3-resource-feedback-completed');
    await expect(completePractice).toBeDisabled();
    await page.getByRole('button', { name: /B\. 时间片和就绪队列状态/ }).click();
    await page.getByRole('button', { name: '提交本题' }).click();
    for (let index = 2; index <= 8; index += 1) {
      await page.getByRole('button', { name: String(index), exact: true }).click();
      await page.getByPlaceholder(/写下你的判断/).fill(`第 ${index} 题的判断、条件与资料依据。`);
      await page.getByRole('button', { name: '提交本题' }).click();
    }
    await expect(completePractice).toBeEnabled();
    await completePractice.click();
    await expect.poll(() => feedbackBodies.find((item) => item.action === 'completed')?.score).toBe(100);

    feedbackBodies.length = 0;
    await page.goto('/a3/resources/workbench-pack/case-study');
    const completeCase = page.getByTestId('a3-resource-feedback-completed');
    await expect(completeCase).toBeDisabled();
    await page.getByPlaceholder(/你的结论/).fill('采用多级反馈队列，并说明依据和风险。');
    await page.getByRole('button', { name: '提交判断并查看专家拆解' }).click();
    await expect(completeCase).toBeEnabled();
    await completeCase.click();
    await expect.poll(() => feedbackBodies.find((item) => item.action === 'completed')?.score).toBeNull();

    feedbackBodies.length = 0;
    await page.goto('/a3/resources/workbench-pack/code-lab');
    const completeCode = page.getByTestId('a3-resource-feedback-completed');
    await expect(completeCode).toBeDisabled();
    for (const checkpoint of resourcePack.resources[2].content.checkpoints) {
      await page.getByRole('button', { name: checkpoint }).click();
    }
    await page.getByRole('button', { name: '提交判题' }).click();
    await expect(completeCode).toBeEnabled();
    await completeCode.click();
    await expect.poll(() => feedbackBodies.find((item) => item.action === 'completed')?.score).toBe(100);
  });

  test('case keeps expert analysis locked until judgment submission', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/a3/resources/workbench-pack/case-study');
    await expect(page.getByTestId('a3-case-study-workbench')).toBeVisible();
    await expect(page.getByRole('heading', { name: '专家拆解' })).toHaveCount(0);
    await page.getByPlaceholder(/你的结论/).fill('采用多级反馈队列，并通过老化机制控制长任务饥饿。');
    await page.getByRole('button', { name: '提交判断并查看专家拆解' }).click();
    await expect(page.getByRole('heading', { name: '专家拆解' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('case-workbench-desktop.png'), fullPage: true });
  });

  test('code editor and runner share the desktop workspace and stack safely on mobile', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/a3/resources/workbench-pack/code-lab');
    const editor = page.getByLabel('代码编辑器');
    const runner = page.getByText('运行与判题', { exact: true });
    await expect(editor).toBeVisible();
    await expect(runner).toBeVisible();
    const [editorBox, runnerBox] = await Promise.all([editor.boundingBox(), runner.boundingBox()]);
    expect(editorBox).not.toBeNull();
    expect(runnerBox).not.toBeNull();
    expect(editorBox!.x).toBeLessThan(runnerBox!.x);
    await page.getByRole('button', { name: '运行代码' }).click();
    await expect(page.getByText('RR ready', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('code-workbench-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(editor).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('code-workbench-mobile.png'), fullPage: true });
  });
});
