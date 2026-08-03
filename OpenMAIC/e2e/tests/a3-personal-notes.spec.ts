import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page, Route } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { resolveA3PlaywrightRuntime } from '../playwright-runtime';

const now = '2026-08-03T08:00:00.000Z';
const studentPhone = '13800000001';
const demoPassword = 'Demo@123456';
const runtime = resolveA3PlaywrightRuntime();
const browserChannel = process.env.A3_PLAYWRIGHT_BROWSER_CHANNEL;

if (browserChannel) {
  test.use({ channel: browserChannel });
}

type ProviderMode = 'available' | 'slow-assistant' | 'unavailable';

interface ProviderStub {
  requests: Array<{ system: string; user: string }>;
  server: Server;
  setMode: (mode: ProviderMode) => void;
}

interface Phase2Seed {
  digestDate: string;
  noteId: string;
  noteTitle: string;
}

interface Phase2DatabaseState {
  assistantMessages: Array<{
    citations: Array<{ noteId?: string; noteVersion?: number }>;
    content: string;
    id: string;
    status: string;
  }>;
  auditCount: number;
  digestSources: Array<{ noteIds: string[]; revision: number; versions: number[] }>;
  noteContent: string;
  noteVersion: number;
  previewStatus: string;
  revisionSources: string[];
  scopeVersions: number[];
  sessionId: string;
  userMessageCount: number;
}

function manageEnvironment() {
  return {
    ...process.env,
    DJANGO_DEBUG: '1',
    DJANGO_SETTINGS_MODULE: 'backend.config.test_sqlite_settings',
  };
}

function runManage(args: string[]) {
  return execFileSync(runtime.backendPython, [runtime.backendManagePy, ...args], {
    cwd: runtime.backendProjectRoot,
    encoding: 'utf8',
    env: manageEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runManageJson<T>(code: string): T {
  const marker = '__A3_PHASE2_JSON__';
  const output = runManage(['shell', '-c', `${code}\nprint('${marker}' + json.dumps(result, ensure_ascii=True))`]);
  const line = output.split(/\r?\n/).find((item) => item.startsWith(marker));
  if (!line) throw new Error(`Django shell did not emit Phase 2 state: ${output}`);
  return JSON.parse(line.slice(marker.length)) as T;
}

function seedPhase2Database(): Phase2Seed {
  return runManageJson<Phase2Seed>(String.raw`
import json
from datetime import timedelta
from django.contrib.auth import get_user_model
from django.utils import timezone
from backend.apps.notes.models import Note, NoteAiSession, NoteAuditEvent, NoteDailyDigest, NoteDailyState, NoteRevision, NoteWritebackPreview
User = get_user_model()
user, _ = User.objects.update_or_create(
    phone='${studentPhone}',
    defaults={
        'display_name': 'Phase 2 学生',
        'role': 'student',
        'phone_bound': True,
        'privacy_accepted': True,
        'profile_completed': True,
        'onboarding_step': 'complete',
        'is_active': True,
    },
)
user.set_password('${demoPassword}')
user.save(update_fields=['password', 'updated_at'])
other, _ = User.objects.update_or_create(
    phone='13800009999',
    defaults={'display_name': 'Phase 2 隔离用户', 'role': 'student', 'is_active': True},
)
NoteDailyDigest.objects.filter(user=user).delete()
NoteWritebackPreview.objects.filter(user=user).delete()
NoteAiSession.objects.filter(user=user).delete()
NoteAuditEvent.objects.filter(user=user).delete()
Note.objects.filter(user=user).delete()
doc = {'type': 'doc', 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': '时间片轮转使用固定时间片，过短会增加切换开销。'}]}]}
note = Note.objects.create(user=user, title='Phase 2 调度笔记', content_json=doc, content_text='时间片轮转使用固定时间片，过短会增加切换开销。', version=3)
NoteRevision.objects.create(note=note, version=3, source='manual', title_snapshot=note.title, content_json_snapshot=doc, content_text_snapshot=note.content_text)
target_date = timezone.localdate()
instant = timezone.now()
NoteDailyState.objects.create(note=note, local_date=target_date, title_snapshot=note.title, content_json_snapshot=doc, content_text_snapshot=note.content_text, version=3, last_edited_at_snapshot=instant, was_edited=True, deleted_at_day_end=False, last_event_at=instant)
outside = Note.objects.create(user=user, title='隔离日期笔记', content_json=doc, content_text='OUTSIDE_DATE_MARKER', version=1)
NoteDailyState.objects.create(note=outside, local_date=target_date - timedelta(days=1), title_snapshot=outside.title, content_json_snapshot=doc, content_text_snapshot='OUTSIDE_DATE_MARKER', version=1, last_edited_at_snapshot=instant - timedelta(days=1), was_edited=True, deleted_at_day_end=False, last_event_at=instant - timedelta(days=1))
foreign = Note.objects.create(user=other, title='他人隔离笔记', content_json=doc, content_text='FOREIGN_NOTE_MARKER', version=8)
NoteDailyState.objects.create(note=foreign, local_date=target_date, title_snapshot=foreign.title, content_json_snapshot=doc, content_text_snapshot='FOREIGN_NOTE_MARKER', version=8, last_edited_at_snapshot=instant, was_edited=True, deleted_at_day_end=False, last_event_at=instant)
result = {'digestDate': target_date.isoformat(), 'noteId': str(note.id), 'noteTitle': note.title}
`);
}

function readPhase2DatabaseState(noteId: string): Phase2DatabaseState {
  return runManageJson<Phase2DatabaseState>(String.raw`
import json
from backend.apps.notes.models import Note, NoteAiMessage, NoteAiSession, NoteAuditEvent, NoteDailyDigest, NoteRevision, NoteWritebackPreview
note = Note.objects.get(pk='${noteId}')
session = NoteAiSession.objects.filter(user=note.user).order_by('created_at').first()
assistants = NoteAiMessage.objects.filter(session__user=note.user, role='assistant').order_by('created_at')
digests = NoteDailyDigest.objects.filter(user=note.user).order_by('revision')
preview = NoteWritebackPreview.objects.filter(user=note.user).order_by('-created_at').first()
result = {
  'assistantMessages': [{'id': str(item.id), 'status': item.status, 'content': item.content, 'citations': item.citations} for item in assistants],
  'auditCount': NoteAuditEvent.objects.filter(user=note.user, action='note.ai_writeback_applied', object_id=note.id).count(),
  'digestSources': [{'revision': item.revision, 'noteIds': [source.get('id') for source in item.source_snapshot.get('notes', [])], 'versions': [source.get('version') for source in item.source_snapshot.get('notes', [])]} for item in digests],
  'noteContent': note.content_text,
  'noteVersion': note.version,
  'previewStatus': preview.status if preview else '',
  'revisionSources': list(NoteRevision.objects.filter(note=note).order_by('version').values_list('source', flat=True)),
  'scopeVersions': [item.get('version') for item in (session.scope_snapshot.get('notes', []) if session else [])],
  'sessionId': str(session.id) if session else '',
  'userMessageCount': NoteAiMessage.objects.filter(session__user=note.user, role='user').count(),
}
`);
}

async function loginAsPhase2Student(page: Page) {
  await page.context().clearCookies();
  const csrfResponse = await page.request.get(`${runtime.backendURL}/api/auth/csrf/`);
  expect(csrfResponse.ok()).toBeTruthy();
  const csrf = await csrfResponse.json() as { csrfToken?: string };
  const loginResponse = await page.request.post(`${runtime.backendURL}/api/auth/login/`, {
    headers: csrf.csrfToken ? { 'X-CSRFToken': csrf.csrfToken } : undefined,
    data: { identifier: studentPhone, password: demoPassword },
  });
  expect(loginResponse.ok()).toBeTruthy();
  await expect(loginResponse.json()).resolves.toMatchObject({ success: true });
}

async function openPhase2Notes(page: Page, noteTitle: string) {
  await page.goto('/a3/notes', { waitUntil: 'commit', timeout: 60_000 });
  await expect(page.getByRole('button', { name: noteTitle, exact: true })).toBeVisible({ timeout: 120_000 });
}

async function notesApi<T>(page: Page, path: string, init?: Parameters<Page['request']['fetch']>[1]) {
  const method = String(init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  if (method !== 'GET') {
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === 'csrftoken')?.value;
    if (csrf) headers.set('X-CSRFToken', csrf);
  }
  const response = await page.request.fetch(`/api/a3/notes/${path}`, {
    ...init,
    headers: Object.fromEntries(headers.entries()),
  });
  if (!response.ok()) throw new Error(`${response.status()} ${path}: ${await response.text()}`);
  return await response.json() as T;
}

async function startProviderStub(): Promise<ProviderStub> {
  if (!process.env.A3_TEST_SQLITE_PATH || process.env.A3_TEST_SQLITE_PATH === ':memory:') {
    throw new Error('A3_TEST_SQLITE_PATH must be a shared file-backed database for the Phase 2 real-backend gate');
  }
  if (!process.env.A3_LLM_API_KEY) {
    throw new Error('A3_LLM_API_KEY must contain a local test value for the Phase 2 provider stub');
  }
  const configured = process.env.A3_LLM_BASE_URL;
  if (!configured) throw new Error('A3_LLM_BASE_URL must point to the Phase 2 local provider stub');
  const url = new URL(configured);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`Phase 2 refuses a non-local model provider: ${url.hostname}`);
  }
  let mode: ProviderMode = 'available';
  const requests: ProviderStub['requests'] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role?: string; content?: string }> };
      const system = payload.messages?.find((item) => item.role === 'system')?.content ?? '';
      const user = [...(payload.messages ?? [])].reverse().find((item) => item.role === 'user')?.content ?? '';
      requests.push({ system, user });
      const reply = () => {
        if (mode === 'unavailable') {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'phase2 provider unavailable' } }));
          return;
        }
        const content = system.includes('每日总结助手')
          ? '## 今日重点\n\n- 时间片轮转使用固定时间片。\n- 下一步复习上下文切换开销。'
          : '时间片轮转使用固定时间片；时间片过短会增加上下文切换开销。';
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }));
      };
      if (mode === 'slow-assistant' && !system.includes('每日总结助手')) setTimeout(reply, 3_000);
      else reply();
    });
  });
  const port = Number(url.port || 80);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, url.hostname, () => resolve());
  });
  expect((server.address() as AddressInfo).port).toBe(port);
  return { requests, server, setMode: (value) => { mode = value; } };
}

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
  test.setTimeout(120_000);

  test('creates, edits, restores an offline draft, and surfaces conflicts without an AI rail', async ({ page }) => {
    const state = await installNotesContracts(page, []);
    await page.goto('/a3/notes', { waitUntil: 'commit' });
    await expect(page.getByText('还没有笔记')).toBeVisible();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible();
    await expect(page.getByTestId('notes-ai-rail')).toHaveCount(0);

    await page.locator('.ProseMirror').fill('在线保存内容');
    await expect(page.getByTestId('note-save-status')).toHaveText(/已保存|未修改/);
    state.offline = true;
    await page.locator('.ProseMirror').fill('离线恢复内容');
    await expect(page.getByTestId('note-save-status')).toContainText('离线待同步');
    await page.reload({ waitUntil: 'domcontentloaded' });
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
    await page.goto('/a3/notes', { waitUntil: 'commit' });
    await page.getByRole('button', { name: '附件笔记' }).click();
    await page.getByRole('button', { name: '附件', exact: true }).click();
    await page.getByLabel('上传附件').setInputFiles({ name: '复习提纲.txt', mimeType: 'text/plain', buffer: Buffer.from('review notes') });
    await expect(page.getByTestId('note-attachment-row')).toContainText('复习提纲.txt');

    await page.getByRole('button', { name: '回收站', exact: true }).click();
    await expect(page.getByRole('button', { name: '待恢复笔记' })).toBeVisible();
    await page.getByRole('button', { name: '恢复笔记', exact: true }).click();
    await expect(page.getByText('回收站为空')).toBeVisible();
  });

  test('keeps a dominant desktop editor and one mobile view with browser back behavior', async ({ page }) => {
    await installNotesContracts(page);
    await page.setViewportSize({ width: 1360, height: 850 });
    await page.goto('/a3/notes', { waitUntil: 'commit' });
    await expect(page.getByTestId('notes-workspace')).toHaveCSS('grid-template-columns', /220px .+/);
    const editorWidth = await page.getByTestId('notes-editor-pane').evaluate((element) => element.getBoundingClientRect().width);
    expect(editorWidth).toBeGreaterThan(560);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
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

test.describe.serial('A3 personal notes Phase 2 real service gate', () => {
  test.setTimeout(300_000);

  let provider: ProviderStub;
  let seed: Phase2Seed;

  test.beforeAll(async () => {
    provider = await startProviderStub();
  });

  test.beforeEach(() => {
    seed = seedPhase2Database();
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => provider.server.close((error) => error ? reject(error) : resolve()));
  });

  test('uses immutable scoped notes, reconnects the persisted message, and confirms writeback explicitly', async ({ page }) => {
    provider.setMode('slow-assistant');
    await loginAsPhase2Student(page);
    await openPhase2Notes(page, seed.noteTitle);
    await page.getByRole('button', { name: seed.noteTitle, exact: true }).click();

    const initial = await notesApi<{ success: true; note: { id: string; version: number; contentText: string } }>(page, `notes/${seed.noteId}/`);
    expect(initial.note).toMatchObject({ id: seed.noteId, version: 3 });
    expect(readPhase2DatabaseState(seed.noteId).noteVersion).toBe(3);

    let chatSubmissions = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/a3/notes/assistant/chat/')) chatSubmissions += 1;
    });
    await page.getByRole('button', { name: '打开笔记 AI' }).click();
    await page.getByLabel('向笔记 AI 提问').fill('时间片太短会有什么影响？');
    await page.getByRole('button', { name: '发送', exact: true }).click();

    await expect.poll(() => readPhase2DatabaseState(seed.noteId).assistantMessages.length, { timeout: 30_000 }).toBe(1);
    const disconnected = readPhase2DatabaseState(seed.noteId);
    const messageId = disconnected.assistantMessages[0].id;
    expect(disconnected.scopeVersions).toEqual([3]);
    expect(disconnected.userMessageCount).toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: seed.noteTitle, exact: true }).click();
    await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: '打开笔记 AI' }).click();
    await expect(page.getByText('正在加载会话...')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText('时间片轮转使用固定时间片；时间片过短会增加上下文切换开销。')).toBeVisible({ timeout: 60_000 });

    const persisted = readPhase2DatabaseState(seed.noteId);
    expect(persisted.assistantMessages).toHaveLength(1);
    expect(persisted.assistantMessages[0]).toMatchObject({ id: messageId, status: 'succeeded' });
    expect(persisted.assistantMessages[0].citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ noteId: seed.noteId, noteVersion: 3 }),
    ]));
    expect(persisted.userMessageCount).toBe(1);
    expect(chatSubmissions).toBe(1);
    const messageApi = await notesApi<{ success: true; messages: Array<{ id: string; citations: Array<{ noteVersion: number }> }> }>(page, `assistant/sessions/${persisted.sessionId}/messages/`);
    expect(messageApi.messages.filter((item) => item.id === messageId)).toEqual([
      expect.objectContaining({ id: messageId, citations: expect.arrayContaining([expect.objectContaining({ noteVersion: 3 })]) }),
    ]);

    provider.setMode('available');
    await page.getByRole('button', { name: '生成写回建议' }).click();
    await expect(page.getByRole('region', { name: 'AI 写回预览' })).toBeVisible();
    const afterPreviewApi = await notesApi<{ success: true; note: { version: number; contentText: string } }>(page, `notes/${seed.noteId}/`);
    expect(afterPreviewApi.note).toMatchObject({ version: 3, contentText: initial.note.contentText });
    const afterPreview = readPhase2DatabaseState(seed.noteId);
    expect(afterPreview).toMatchObject({ noteVersion: 3, previewStatus: 'pending', auditCount: 0 });
    expect(afterPreview.revisionSources).toEqual(['manual']);

    await page.getByRole('button', { name: '确认写入笔记正文' }).click();
    await expect(page.locator('.ProseMirror')).toContainText('时间片过短会增加上下文切换开销');
    const afterConfirmApi = await notesApi<{ success: true; note: { version: number; contentText: string } }>(page, `notes/${seed.noteId}/`);
    expect(afterConfirmApi.note.version).toBe(4);
    expect(afterConfirmApi.note.contentText).toContain('时间片过短会增加上下文切换开销');
    const revisionsApi = await notesApi<{ success: true; revisions: Array<{ source: string; version: number }> }>(page, `notes/${seed.noteId}/revisions/`);
    expect(revisionsApi.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'ai_writeback', version: 4 })]));
    const afterConfirm = readPhase2DatabaseState(seed.noteId);
    expect(afterConfirm).toMatchObject({ noteVersion: 4, previewStatus: 'applied', auditCount: 1 });
    expect(afterConfirm.revisionSources).toEqual(['manual', 'ai_writeback']);
  });

  test('creates versioned manual digests from isolated immutable daily sources in a read-only view', async ({ page }) => {
    provider.setMode('available');
    await loginAsPhase2Student(page);
    await openPhase2Notes(page, seed.noteTitle);
    await page.getByRole('button', { name: '每日总结', exact: true }).click();
    const dateInput = page.locator('input[type="date"]');
    await dateInput.fill(seed.digestDate);
    await page.getByRole('button', { name: '生成第一版' }).click();
    const digestArticle = page.locator('article[data-readonly="true"]');
    await expect(digestArticle.getByText('修订 1', { exact: true })).toBeVisible({ timeout: 30_000 });

    const firstApi = await notesApi<{ success: true; digests: Array<{ digestDate: string; revision: number; sourceSnapshot: { notes: Array<{ id: string; version: number }> } }> }>(page, `digests/?date=${seed.digestDate}`);
    expect(firstApi.digests).toHaveLength(1);
    expect(firstApi.digests[0]).toMatchObject({ digestDate: seed.digestDate, revision: 1 });
    expect(firstApi.digests[0].sourceSnapshot.notes).toEqual([expect.objectContaining({ id: seed.noteId, version: 3 })]);
    const firstDatabase = readPhase2DatabaseState(seed.noteId);
    expect(firstDatabase.digestSources).toEqual([{ revision: 1, noteIds: [seed.noteId], versions: [3] }]);
    await expect(page.locator('article[data-readonly="true"]')).toBeVisible();
    await expect(page.locator('.ProseMirror')).toHaveCount(0);

    const saved = await notesApi<{ success: true; note: { version: number } }>(page, `notes/${seed.noteId}/`, {
      method: 'PATCH',
      data: {
        baseVersion: 3,
        clientMutationId: 'b5bc77f7-4d56-4c81-b5cf-10346d4b7872',
        title: seed.noteTitle,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '修订后的时间片复习内容。' }] }] },
        source: 'autosave',
      },
    });
    expect(saved.note.version).toBe(4);
    expect(readPhase2DatabaseState(seed.noteId).noteVersion).toBe(4);

    await page.getByRole('button', { name: '生成新修订' }).click();
    await expect(digestArticle.getByText('修订 2', { exact: true })).toBeVisible({ timeout: 30_000 });
    const secondApi = await notesApi<{ success: true; digests: Array<{ revision: number; sourceSnapshot: { notes: Array<{ id: string; version: number }> } }> }>(page, `digests/?date=${seed.digestDate}`);
    expect(secondApi.digests.map((item) => item.revision)).toEqual([2, 1]);
    expect(secondApi.digests.find((item) => item.revision === 1)?.sourceSnapshot.notes).toEqual([
      expect.objectContaining({ id: seed.noteId, version: 3 }),
    ]);
    expect(secondApi.digests.find((item) => item.revision === 2)?.sourceSnapshot.notes).toEqual([
      expect.objectContaining({ id: seed.noteId, version: 4 }),
    ]);
    expect(readPhase2DatabaseState(seed.noteId).digestSources).toEqual([
      { revision: 1, noteIds: [seed.noteId], versions: [3] },
      { revision: 2, noteIds: [seed.noteId], versions: [4] },
    ]);
    const digestPrompts = provider.requests.filter((item) => item.system.includes('每日总结助手')).map((item) => item.user).join('\n');
    expect(digestPrompts).not.toContain('OUTSIDE_DATE_MARKER');
    expect(digestPrompts).not.toContain('FOREIGN_NOTE_MARKER');
  });

  test('keeps basic note creation and persistence available when the model provider is unavailable', async ({ page }) => {
    provider.setMode('unavailable');
    const providerCallsBefore = provider.requests.length;
    await loginAsPhase2Student(page);
    await openPhase2Notes(page, seed.noteTitle);
    await page.getByRole('button', { name: seed.noteTitle, exact: true }).click();
    await page.getByRole('button', { name: '打开笔记 AI' }).click();
    await page.getByLabel('向笔记 AI 提问').fill('模型不可用时给出复习步骤');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('暂时使用规则降级回答')).toBeVisible({ timeout: 30_000 });
    expect(provider.requests.length).toBeGreaterThan(providerCallsBefore);

    await page.getByRole('button', { name: '收起笔记 AI' }).click();
    await page.getByRole('button', { name: '快速新建笔记', exact: true }).click();
    await page.locator('.ProseMirror').fill('模型不可用时仍可保存的基础笔记');
    await expect.poll(async () => {
      const search = await notesApi<{ success: true; notes: Array<{ id: string; contentText: string; version: number }> }>(
        page,
        'search/?q=%E6%A8%A1%E5%9E%8B%E4%B8%8D%E5%8F%AF%E7%94%A8',
      );
      return search.notes.find((item) => item.contentText === '模型不可用时仍可保存的基础笔记')?.version ?? 0;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('note-save-status')).toHaveText(/已保存|未修改/);
    const persistedCount = runManageJson<number>(String.raw`
import json
from backend.apps.notes.models import Note
result = Note.objects.filter(user__phone='${studentPhone}', content_text='模型不可用时仍可保存的基础笔记').count()
`);
    expect(persistedCount).toBe(1);
  });
});
