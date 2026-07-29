import type { Page } from '@playwright/test';
import type { A3ResourcePacksResponse } from '@/lib/a3/recommendation-types';
import { expect, test } from '../fixtures/base';

const longLessonContent = [
  '## 第 3 章 进程调度与死锁',
  '先理解处理机调度，再比较常见调度算法，最后掌握死锁的预防与避免。',
  '| 学习内容 | 重点 |\n| --- | --- |\n| 调度算法 | 周转时间与响应时间 |\n| 死锁 | 四个必要条件 |',
  ...Array.from({ length: 18 }, (_, index) => (
    `### 课件要点 ${index + 1}\n银行家算法会在资源分配前检查系统是否仍处于安全状态，避免进入死锁。`
  )),
].join('\n\n');

const classroomResourcePacksFixture = {
  success: true,
  resourcePacks: [{
    schemaVersion: 'a3.resource-pack.v2',
    resourcePackId: 'classroom-layout-pack',
    generationMode: 'full',
    requestedResourceType: '',
    goal: '掌握进程调度与死锁',
    learnerProfileSnapshot: {},
    resources: [],
    multimodalArtifacts: [{
      type: 'openmaic_classroom',
      jobId: 'job-classroom-layout-001',
      status: 'succeeded',
      classroomId: 'classroom-layout-001',
      classroomUrl: '/classroom/classroom-layout-001',
      scenesCount: 4,
      pptxExportable: true,
      provider: 'openmaic',
      elapsedMs: 1200,
      createdAt: '2026-07-29T08:00:00Z',
    }],
    nextActions: [],
    traceId: 'trace-classroom-layout-001',
    createdAt: '2026-07-29T08:00:00Z',
  }],
} satisfies A3ResourcePacksResponse;

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
  await page.route('**/api/profiles/tutor-preference/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      preference: {
        personaId: 'practice-coach',
        source: 'profile_recommendation',
        schemaVersion: 'a3.tutor-preference.v1',
        updatedAt: '2026-07-29T08:00:00Z',
      },
      selectedPersona: {
        id: 'practice-coach',
        name: '例题实战',
        shortDescription: '用例题、步骤和即时反馈巩固薄弱点',
        teachingStyle: 'practice',
        avatarAssetId: 'teacher-default-v1',
        avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
        voiceProfileId: 'voice-energetic-coach',
        voicePreviewEnabled: true,
        allowedWorkflows: ['coaching', 'classroom'],
        schemaVersion: 'a3.tutor-persona.v1',
        enabled: true,
      },
      fallbackUsed: false,
      personas: [{
        id: 'practice-coach',
        name: '例题实战',
        shortDescription: '用例题、步骤和即时反馈巩固薄弱点',
        teachingStyle: 'practice',
        avatarAssetId: 'teacher-default-v1',
        avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
        voiceProfileId: 'voice-energetic-coach',
        voicePreviewEnabled: true,
        allowedWorkflows: ['coaching', 'classroom'],
        schemaVersion: 'a3.tutor-persona.v1',
        enabled: true,
      }],
    }),
  }));
  await page.route('**/api/resources/packs/', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(classroomResourcePacksFixture),
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
      const composer = page.getByTestId('a3-classroom-composer-frame');
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

      const [classroomBox, workspaceBox, dialogueBox, composerBox] = await Promise.all([
        classroom.boundingBox(),
        workspace.boundingBox(),
        dialogue.boundingBox(),
        composer.boundingBox(),
      ]);
      expect(classroomBox).not.toBeNull();
      expect(workspaceBox).not.toBeNull();
      expect(dialogueBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(dialogueBox!.height).toBeGreaterThanOrEqual(viewport.minimumDialogueHeight);
      expect(Math.abs(
        dialogueBox!.y + dialogueBox!.height - (workspaceBox!.y + workspaceBox!.height),
      )).toBeLessThanOrEqual(1);
      expect(composerBox!.y).toBeGreaterThanOrEqual(workspaceBox!.y);
      expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
        workspaceBox!.y + workspaceBox!.height,
      );
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

  test('collapses context, reveals the sticky summary, and never covers the last message', async ({ page }) => {
    await mockClassroomLayoutDependencies(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });

    const context = page.getByTestId('a3-classroom-context-region');
    const composer = page.getByTestId('a3-classroom-composer-frame');
    const dialogue = page.getByTestId('a3-classroom-dialogue');

    await expect(context).toBeVisible();
    await expect(composer).toBeVisible();
    await expect(page.getByTestId('a3-classroom-sticky-context')).toBeHidden();
    await page.getByRole('button', { name: '收起课堂信息' }).click();
    await expect(page.getByTestId('a3-classroom-context-summary')).toBeVisible();

    const collapsedBox = await context.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(collapsedBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(collapsedBox!.height).toBeLessThanOrEqual(56);
    expect(composerBox!.height).toBeLessThanOrEqual(96);

    await dialogue.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByTestId('a3-classroom-sticky-context')).toBeVisible();

    const lastMessage = page.getByTestId('a3-classroom-message-assistant').last();
    await expect(lastMessage).toBeVisible();
    const [messageBox, floatingBox] = await Promise.all([
      lastMessage.boundingBox(),
      composer.boundingBox(),
    ]);
    expect(messageBox).not.toBeNull();
    expect(floatingBox).not.toBeNull();
    expect(messageBox!.y + messageBox!.height).toBeLessThanOrEqual(floatingBox!.y + 1);
  });

  test('preserves reading position for an appended reply and resumes following on demand', async ({ page }) => {
    await mockClassroomLayoutDependencies(page);
    const releaseReplies: Array<() => void> = [];
    const replyGates = Array.from({ length: 2 }, () => new Promise<void>((resolve) => {
      releaseReplies.push(resolve);
    }));
    let replyIndex = 0;
    await page.route('**/api/a3/coaching/respond', async (route) => {
      const currentReply = replyIndex;
      replyIndex += 1;
      await replyGates[currentReply];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          reply: `${longLessonContent}\n\nNew assistant explanation ${currentReply + 1}`,
          citations: [],
          claims: [],
        }),
      });
    });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/a3/classroom', { waitUntil: 'domcontentloaded' });

    const dialogue = page.getByTestId('a3-classroom-dialogue');
    const input = page.getByTestId('a3-classroom-input');
    await expect(page.getByTestId('a3-classroom-message-assistant')).toHaveCount(1);
    await input.fill('Explain why deadlock prevention works');
    await page.getByTestId('a3-classroom-submit').click();
    await expect.poll(() => dialogue.evaluate((element) => (
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)
    ))).toBeLessThanOrEqual(2);

    await dialogue.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 240);
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByTestId('a3-classroom-jump-latest')).toBeVisible();
    const readingPosition = await dialogue.evaluate((element) => element.scrollTop);

    releaseReplies[0]();
    await expect(page.getByTestId('a3-classroom-message-assistant')).toHaveCount(2);
    await expect.poll(() => dialogue.evaluate((element) => element.scrollTop)).toBe(readingPosition);
    await expect(page.getByTestId('a3-classroom-jump-latest')).toBeVisible();

    await page.getByTestId('a3-classroom-jump-latest').click();
    await expect.poll(() => dialogue.evaluate((element) => (
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)
    ))).toBeLessThanOrEqual(2);
    await expect(page.getByTestId('a3-classroom-jump-latest')).toBeHidden();

    await input.fill('Add a worked example');
    await page.getByTestId('a3-classroom-submit').click();
    await expect.poll(() => dialogue.evaluate((element) => (
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)
    ))).toBeLessThanOrEqual(2);
    await dialogue.evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollTop - 240);
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByTestId('a3-classroom-jump-latest')).toBeVisible();
    await page.getByTestId('a3-classroom-jump-latest').click();
    await expect(page.getByTestId('a3-classroom-jump-latest')).toBeHidden();

    releaseReplies[1]();
    await expect(page.getByTestId('a3-classroom-message-assistant')).toHaveCount(3);
    await expect.poll(() => dialogue.evaluate((element) => (
      Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)
    ))).toBeLessThanOrEqual(2);
  });
});
