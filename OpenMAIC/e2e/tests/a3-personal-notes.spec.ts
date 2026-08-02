import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures/base';

const now = '2026-08-03T08:00:00.000Z';

function note(id: string, title: string, text = '', deletedAt: string | null = null) {
  return {
    id,
    title,
    content: { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] },
    contentText: text,
    version: 1,
    notebook: null,
    tags: [],
    isPinned: false,
    lastEditedAt: now,
    deletedAt,
    createdAt: now,
    updatedAt: now,
  };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installNotesContracts(page: Page, initialNotes = [note('note-1', '操作系统复习', '进程调度')]) {
  const state = {
    notes: [...initialNotes],
    offline: false,
    conflict: false,
    attachments: [] as Array<Record<string, unknown>>,
  };
  await page.context().addCookies([{ name: 'sessionid', value: 'notes-e2e', domain: 'localhost', path: '/' }]);
  await page.route('**/api/auth/me/', (route) => json(route, {
    user: {
      id: 'student-notes', role: 'student', displayName: '笔记学生', phoneBound: true,
      privacyAccepted: true, profileCompleted: true, onboardingStep: 'complete', createdAt: now, updatedAt: now,
    },
  }));
  await page.route('**/api/a3/notes/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/a3/notes/', '');
    if (path === 'notebooks/') return json(route, { success: true, notebooks: [] });
    if (path === 'tags/') return json(route, { success: true, tags: [] });
    if (path === 'search/') {
      const trash = url.searchParams.get('view') === 'trash';
      return json(route, { success: true, notes: state.notes.filter((item) => Boolean(item.deletedAt) === trash) });
    }
    if (path === 'notes/' && request.method() === 'POST') {
      const created = note(`note-${state.notes.length + 1}`, '无标题笔记');
      state.notes.push(created);
      return json(route, { success: true, note: created }, 201);
    }
    const detail = path.match(/^notes\/([^/]+)\/$/);
    if (detail && request.method() === 'GET') {
      return json(route, { success: true, note: state.notes.find((item) => item.id === detail[1]) });
    }
    if (detail && request.method() === 'PATCH') {
      if (state.offline) return route.abort('internetdisconnected');
      const current = state.notes.find((item) => item.id === detail[1])!;
      if (state.conflict) {
        state.conflict = false;
        return json(route, {
          success: false, status: 409, code: 'note_version_conflict', error: '笔记版本冲突',
          serverVersion: current.version + 1,
          serverNote: { ...current, version: current.version + 1, contentText: '服务器版本' },
        }, 409);
      }
      const payload = request.postDataJSON();
      Object.assign(current, { content: payload.content, version: current.version + 1 });
      return json(route, { success: true, note: current, resultingVersion: current.version, idempotent: false });
    }
    const attachmentList = path.match(/^notes\/([^/]+)\/attachments\/$/);
    if (attachmentList && request.method() === 'GET') {
      return json(route, {
        success: true,
        attachments: state.attachments.filter((item) => item.noteId === attachmentList[1]),
      });
    }
    const restore = path.match(/^notes\/([^/]+)\/restore\/$/);
    if (restore) {
      const current = state.notes.find((item) => item.id === restore[1])!;
      current.deletedAt = null;
      return json(route, { success: true, note: current });
    }
    const upload = path.match(/^notes\/([^/]+)\/attachments\/upload\/$/);
    if (upload) {
      const attachment = {
        id: 'attachment-1', noteId: upload[1], kind: 'file', displayName: '复习提纲.txt',
        mimeType: 'text/plain', sizeBytes: 12, parseStatus: 'pending', parseGeneration: 1,
        parseStartedAt: null, errorCode: '', errorMessage: '', createdAt: now, updatedAt: now,
      };
      state.attachments.push(attachment);
      return json(route, { success: true, attachment }, 201);
    }
    return json(route, { success: false, error: `未覆盖的笔记契约：${request.method()} ${path}` }, 501);
  });
  return state;
}

test.describe.serial('A3 personal notes Phase 1', () => {
  test('creates, edits, restores an offline draft, and surfaces conflicts without an AI rail', async ({ page }) => {
    const state = await installNotesContracts(page, []);
    await page.goto('/a3/notes');
    await expect(page.getByText('还没有笔记')).toBeVisible();
    await page.getByRole('button', { name: '新建笔记' }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await expect(page.getByTestId('notes-ai-rail')).toHaveCount(0);

    await page.locator('.ProseMirror').fill('在线保存内容');
    await expect(page.getByTestId('note-save-status')).toContainText('已保存');
    state.offline = true;
    await page.locator('.ProseMirror').fill('离线恢复内容');
    await expect(page.getByTestId('note-save-status')).toContainText('离线待同步');
    await page.reload();
    await expect(page.getByText('发现本地草稿')).toBeVisible();
    await page.getByRole('button', { name: '恢复草稿' }).click();
    await expect(page.locator('.ProseMirror')).toContainText('离线恢复内容');

    state.offline = false;
    state.conflict = true;
    await page.locator('.ProseMirror').pressSequentially(' 冲突编辑');
    await expect(page.getByText('笔记版本冲突')).toBeVisible();
  });

  test('uploads an attachment and restores a trashed note through API contracts', async ({ page }) => {
    await installNotesContracts(page, [note('active-1', '附件笔记'), note('trash-1', '待恢复笔记', '', now)]);
    await page.goto('/a3/notes');
    await page.getByRole('button', { name: '附件笔记' }).click();
    await page.getByRole('button', { name: '附件' }).click();
    await page.getByLabel('上传附件').setInputFiles({ name: '复习提纲.txt', mimeType: 'text/plain', buffer: Buffer.from('review notes') });
    await expect(page.getByTestId('note-attachment-row')).toContainText('复习提纲.txt');

    await page.getByRole('button', { name: '回收站' }).click();
    await expect(page.getByRole('button', { name: '待恢复笔记' })).toBeVisible();
    await page.getByRole('button', { name: '恢复笔记' }).click();
    await expect(page.getByText('回收站为空')).toBeVisible();
  });

  test('keeps a dominant desktop editor and one mobile view with browser back behavior', async ({ page }) => {
    await installNotesContracts(page);
    await page.setViewportSize({ width: 1360, height: 850 });
    await page.goto('/a3/notes');
    await expect(page.getByTestId('notes-workspace')).toHaveCSS('grid-template-columns', /220px .+/);
    const editorWidth = await page.getByTestId('notes-editor-pane').evaluate((element) => element.getBoundingClientRect().width);
    expect(editorWidth).toBeGreaterThan(560);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('[data-notes-mobile-view="list"]')).toBeVisible();
    await expect(page.locator('[data-notes-mobile-view="editor"]')).toHaveCount(0);
    await page.getByRole('button', { name: '操作系统复习' }).click();
    await expect(page.locator('[data-notes-mobile-view="editor"]')).toBeVisible();
    await expect(page.locator('[data-notes-mobile-view="list"]')).toHaveCount(0);
    await page.goBack();
    await expect(page.locator('[data-notes-mobile-view="list"]')).toBeVisible();
    await expect(page.getByRole('button', { name: '操作系统复习' })).toBeFocused();
  });
});
