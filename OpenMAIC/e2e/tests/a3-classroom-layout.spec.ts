import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const longLessonContent = [
  '## 第 3 章 进程调度与死锁',
  '先理解处理机调度，再比较常见调度算法，最后掌握死锁的预防与避免。',
  '| 学习内容 | 重点 |\n| --- | --- |\n| 调度算法 | 周转时间与响应时间 |\n| 死锁 | 四个必要条件 |',
  ...Array.from({ length: 18 }, (_, index) => (
    `### 课件要点 ${index + 1}\n银行家算法会在资源分配前检查系统是否仍处于安全状态，避免进入死锁。`
  )),
].join('\n\n');

async function mockClassroomLayoutDependencies(page: Page) {
  await page.route('**/api/access-code/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ enabled: false, authenticated: true }),
  }));
  await page.route('**/api/auth/me/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      user: {
        id: 'classroom-layout-student',
        phone: '13800000001',
        nickname: '张三',
        role: 'student',
        phoneBound: true,
        privacyAccepted: true,
        profileCompleted: true,
        onboardingStep: 'completed',
      },
    }),
  }));
  await page.route('**/api/learning/classroom/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      classroom: {
        target: { id: 'process-scheduling', title: '进程调度与死锁' },
        sources: [{ id: 'source-1', title: '操作系统课程课件', location: '第 3 章' }],
        recommended: [],
        graphSummary: { nodes: 1, edges: 0, weak: 0 },
      },
    }),
  }));
  await page.route('**/api/resources/packs/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, resourcePacks: [] }),
  }));
  await page.route('**/api/learning/classroom/history/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      messages: [{
        id: 'layout-answer',
        role: 'assistant',
        content: longLessonContent,
        verified: true,
        citations: [{ id: 'source-1', title: '操作系统课程课件', location: '第 3 章' }],
        claims: [],
      }],
      sessions: [],
    }),
  }));
  await page.route('**/api/learning/study-plan/?auto=1', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: 'layout fixture omits study plan' }),
  }));
  await page.route('**/api/profiles/dynamic-profile/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error: 'layout fixture omits profile feed' }),
  }));
  await page.route('**/api/engagement/notifications/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, notifications: [], unreadCount: 0 }),
  }));
  await page.route('**/api/resources/jobs/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, jobs: [] }),
  }));
  await page.route('**/api/kb/jobs/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, jobs: [] }),
  }));
  await page.route('**/api/a3/tasks**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, tasks: [], summary: { active: 0, failed: 0 } }),
  }));
}

test.describe('A3 classroom viewport layout', () => {
  test('gives courseware the remaining viewport height without covering the composer', async ({ page }, testInfo) => {
    await mockClassroomLayoutDependencies(page);

    for (const viewport of [
      { width: 1440, height: 900, minimumDialogueHeight: 360 },
      { width: 1920, height: 1080, minimumDialogueHeight: 540 },
      { width: 1366, height: 768, minimumDialogueHeight: 230 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });

      const classroom = page.getByTestId('a3-classroom-view');
      const workspace = page.getByTestId('a3-classroom-workspace');
      const dialogue = page.getByTestId('a3-classroom-dialogue');
      const input = page.getByTestId('a3-classroom-input');
      await expect(classroom).toBeVisible();
      await expect(workspace).toBeVisible();
      await expect(dialogue).toBeVisible();
      await expect(input).toBeVisible();
      await expect(page.getByTestId('a3-classroom-message-assistant')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect.poll(() => page.evaluate(() => ({
        html: document.documentElement.style.overflowY,
        body: document.body.style.overflowY,
      }))).toEqual({ html: 'hidden', body: 'hidden' });

      await page.getByRole('button', { name: '收起历史侧栏' }).click();
      await workspace.getByRole('button', { name: '侧面板', exact: true }).click();
      await expect(page.getByTestId('a3-classroom-history-panel')).toBeHidden();
      await expect(page.getByTestId('a3-classroom-drawer-tab-practice')).toBeHidden();

      const [classroomBox, workspaceBox, dialogueBox, inputBox] = await Promise.all([
        classroom.boundingBox(),
        workspace.boundingBox(),
        dialogue.boundingBox(),
        input.boundingBox(),
      ]);
      expect(classroomBox).not.toBeNull();
      expect(workspaceBox).not.toBeNull();
      expect(dialogueBox).not.toBeNull();
      expect(inputBox).not.toBeNull();
      expect(dialogueBox!.height).toBeGreaterThanOrEqual(viewport.minimumDialogueHeight);
      expect(dialogueBox!.y + dialogueBox!.height).toBeLessThanOrEqual(inputBox!.y);
      expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(workspaceBox!.y + workspaceBox!.height);
      expect(Math.abs(classroomBox!.height - workspaceBox!.height)).toBeLessThanOrEqual(1);

      await page.screenshot({
        path: testInfo.outputPath(`a3-classroom-layout-${viewport.width}x${viewport.height}.png`),
        fullPage: true,
      });
    }

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(() => page.evaluate(() => ({
      html: document.documentElement.style.overflowY,
      body: document.body.style.overflowY,
    }))).toEqual({ html: '', body: '' });
  });
});
