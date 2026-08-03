// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { NextRequest } from 'next/server';

import { GET as streamAssistantMessage } from '@/app/api/a3/notes/assistant/stream/[messageId]/route';
import { NoteAiDrawer } from '@/components/a3/notes/note-ai-drawer';
import { NotesWorkspace } from '@/components/a3/notes/notes-workspace';
import type { AutosaveEvent, NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import { mapNoteCitationToSelection } from '@/lib/a3/notes/citation-position';
import { NotesClient } from '@/lib/a3/notes/client';
import { parseNoteDocument } from '@/lib/a3/notes/editor-schema';
import type { NoteAiMessage, NoteDetail } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = '2026-08-03T08:00:00.000Z';
const note = (id = 'note-1', title = '操作系统复习'): NoteDetail => ({
  id,
  title,
  content: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '进程与线程' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '死锁与调度' }] },
    ],
  },
  contentText: '进程与线程\n死锁与调度',
  version: 3,
  notebook: null,
  tags: [],
  isPinned: false,
  lastEditedAt: now,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

const assistantMessage = (overrides: Partial<NoteAiMessage> = {}): NoteAiMessage => ({
  id: 'assistant-message-1',
  sessionId: 'session-1',
  role: 'assistant',
  content: '',
  status: 'queued',
  clientRequestId: 'request-1',
  citations: [],
  verified: false,
  claims: [],
  safety: {},
  degraded: false,
  errorCode: '',
  errorMessage: '',
  metadata: {},
  createdAt: now,
  ...overrides,
});

function clientStub(overrides: Partial<NotesClient> = {}) {
  return {
    listNotebooks: vi.fn().mockResolvedValue({ success: true, notebooks: [] }),
    listTags: vi.fn().mockResolvedValue({ success: true, tags: [] }),
    searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [note()] }),
    getNote: vi.fn().mockResolvedValue({ success: true, note: note() }),
    listAttachments: vi.fn().mockResolvedValue({ success: true, attachments: [] }),
    listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    createAiSession: vi.fn().mockResolvedValue({
      success: true,
      session: { id: 'session-1', title: '', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now },
    }),
    listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
    submitAiChat: vi.fn().mockResolvedValue({ success: true, message: assistantMessage(), idempotent: false }),
    watchAiMessage: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as NotesClient;
}

function autosaveStub() {
  return {
    schedule: vi.fn(),
    flush: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    initialize: vi.fn().mockResolvedValue({ account: { kind: 'ready', warningRequired: false }, replay: [] }),
    confirmAccountSwitch: vi.fn(),
    dispose: vi.fn(),
  } as unknown as NotesAutosaveController;
}

function controlledAutosave() {
  let listener: ((event: AutosaveEvent) => void) | undefined;
  const controller = {
    schedule: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn(),
    subscribe: vi.fn((_noteId: string, next: typeof listener) => {
      listener = next;
      return () => { listener = undefined; };
    }),
    initialize: vi.fn().mockResolvedValue({ account: { kind: 'ready', warningRequired: false }, replay: [] }),
    confirmAccountSwitch: vi.fn(),
    dispose: vi.fn(),
  } as unknown as NotesAutosaveController;
  return {
    controller,
    emit(event: AutosaveEvent) {
      act(() => listener?.(event));
    },
  };
}

let root: Root | null = null;

function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container;
}

function click(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name);
  expect(button, `button ${name}`).toBeTruthy();
  act(() => button!.click());
  return button!;
}

function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('personal note citation position mapping', () => {
  it.each(['bullet_list', 'ordered_list'])('maps a nested paragraph inside a %s', (listType) => {
    const nestedType = listType === 'bullet_list' ? 'ordered_list' : 'bullet_list';
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '前言' }] },
        {
          type: listType,
          content: [{
            type: 'list_item',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '父项' }] },
              {
                type: nestedType,
                content: [{
                  type: 'list_item',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: '嵌套目标' }] }],
                }],
              },
            ],
          }],
        },
      ],
    });

    const selection = mapNoteCitationToSelection(documentNode, { paragraphIndex: 2, charStart: 6, charEnd: 10 });

    expect(selection).not.toBeNull();
    expect(documentNode.textBetween(selection!.from, selection!.to)).toBe('嵌套目标');
  });

  it('maps a paragraph nested in a blockquote', () => {
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '开头' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: '引用目标' }] }] },
      ],
    });

    const selection = mapNoteCitationToSelection(documentNode, { paragraphIndex: 1, charStart: 3, charEnd: 7 });

    expect(selection).not.toBeNull();
    expect(documentNode.textBetween(selection!.from, selection!.to)).toBe('引用目标');
  });

  it('maps text after a hard break using the flattened global offset', () => {
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '甲' },
          { type: 'hard_break' },
          { type: 'text', text: '乙' },
        ],
      }],
    });

    const selection = mapNoteCitationToSelection(documentNode, { paragraphIndex: 1, charStart: 2, charEnd: 3 });

    expect(selection).not.toBeNull();
    expect(documentNode.textBetween(selection!.from, selection!.to)).toBe('乙');
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
    ['VT', '\v'],
    ['FF', '\f'],
    ['FS', '\u001c'],
    ['GS', '\u001d'],
    ['RS', '\u001e'],
    ['NEL', '\u0085'],
    ['LINE SEPARATOR', '\u2028'],
    ['PARAGRAPH SEPARATOR', '\u2029'],
  ])('matches Python splitlines for %s', (_label, separator) => {
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [{ type: 'code_block', content: [{ type: 'text', text: `甲${separator}乙` }] }],
    });

    const selection = mapNoteCitationToSelection(documentNode, { paragraphIndex: 1, charStart: 2, charEnd: 3 });

    expect(selection).toEqual({ from: 2 + separator.length, to: 3 + separator.length });
    expect(documentNode.textBetween(selection!.from, selection!.to)).toBe('乙');
  });

  it('maps a citation into the correct table cell across backend tab separators', () => {
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'table_row',
          content: [
            { type: 'table_cell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }] }] },
            { type: 'table_cell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '目标单元' }] }] },
          ],
        }],
      }],
    });

    const selection = mapNoteCitationToSelection(documentNode, { paragraphIndex: 0, charStart: 2, charEnd: 6 });

    expect(selection).not.toBeNull();
    expect(documentNode.textBetween(selection!.from, selection!.to)).toBe('目标单元');
  });

  it.each([
    ['attachment_reference', { attachmentId: 'attachment-1', label: '附件' }],
    ['image', { src: 'https://example.com/image.png', alt: '图片' }],
    ['math_inline', { latex: 'x+y' }],
  ])('fails safely when a citation covers only a non-editor %s label', (type, attrs) => {
    const leafText = type === 'math_inline' ? 'x+y' : type === 'image' ? '图片' : '附件';
    const documentNode = parseNoteDocument({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type, attrs },
          { type: 'text', text: '正文' },
        ],
      }],
    });

    expect(mapNoteCitationToSelection(documentNode, {
      paragraphIndex: 0,
      charStart: 0,
      charEnd: Array.from(leafText).length,
    })).toBeNull();
  });
});

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  FakeEventSource.instances = [];
  FakeEventSource.reconnectUrls = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('personal note AI drawer', () => {
  it('is collapsed on first load and keeps the editor dominant', async () => {
    const container = mount(<NotesWorkspace client={clientStub()} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="notes-ai-drawer"]')).toBeTruthy());

    const drawer = container.querySelector('[data-testid="notes-ai-drawer"]')!;
    expect(drawer.getAttribute('data-state')).toBe('collapsed');
    expect(drawer.className).toContain('w-12');
    expect(container.querySelector('[data-testid="notes-workspace"]')?.className).toContain('minmax(560px,1fr)');
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="打开笔记 AI"]')!;
    expect(trigger.title).toBe('打开笔记 AI');
  });

  it('uses the clamped desktop width and a full-screen mobile expanded view', () => {
    const desktop = mount(<NoteAiDrawer client={clientStub()} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    expect(desktop.querySelector('[data-testid="notes-ai-drawer"]')?.className).toContain('w-[clamp(320px,28vw,420px)]');

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    const mobile = mount(<NoteAiDrawer client={clientStub()} currentNote={note()} notes={[note()]} isMobile onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    const drawer = mobile.querySelector('[data-testid="notes-ai-drawer"]')!;
    expect(drawer.className).toContain('fixed inset-0');
    expect(drawer.className).toContain('h-dvh');
    expect(drawer.className).toContain('w-screen');
  });

  it('opens without changing editor scroll or selection', async () => {
    let editorView: EditorView | undefined;
    const container = mount(
      <NotesWorkspace
        client={clientStub()}
        userId="student-1"
        autosave={autosaveStub()}
        onEditorReady={(view) => { editorView = view; }}
      />,
    );
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    const canvas = container.querySelector<HTMLElement>('[data-testid="note-editor-canvas"]')!;
    canvas.scrollTop = 137;
    act(() => editorView!.dispatch(editorView!.state.tr.setSelection(TextSelection.create(editorView!.state.doc, 4))));
    const selectionBefore = editorView!.state.selection.from;

    click('打开笔记 AI');

    expect(canvas.scrollTop).toBe(137);
    expect(editorView!.state.selection.from).toBe(selectionBefore);
    expect(container.querySelector('[data-testid="notes-ai-drawer"]')?.getAttribute('data-state')).toBe('expanded');
  });

  it('defaults new conversations to the current note scope', async () => {
    const client = clientStub();
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    expect(container.querySelector<HTMLSelectElement>('[aria-label="AI 作用范围"]')?.value).toBe('note');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '解释死锁条件');
    click('发送');

    await vi.waitFor(() => expect(client.createAiSession).toHaveBeenCalledWith({
      title: '解释死锁条件',
      scope: { type: 'note', noteIds: ['note-1'] },
    }, { signal: expect.any(AbortSignal) }));
  });

  it('requires an explicit selected-notes scope and sends only checked notes', async () => {
    const second = note('note-2', '计算机网络');
    const client = clientStub();
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note(), second]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    change(container.querySelector<HTMLSelectElement>('[aria-label="AI 作用范围"]')!, 'selection');
    expect(container.textContent).toContain('明确选择笔记');
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择计算机网络"]')!;
    act(() => checkbox.click());
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '比较两篇笔记');
    click('发送');

    await vi.waitFor(() => expect(client.createAiSession).toHaveBeenCalledWith(expect.objectContaining({
      scope: { type: 'selection', noteIds: ['note-2'] },
    }), { signal: expect.any(AbortSignal) }));
  });

  it('jumps from a citation to the cited note section', () => {
    const navigate = vi.fn();
    const message = assistantMessage({
      content: '死锁需要同时满足四个条件。',
      status: 'succeeded',
      verified: true,
      citations: [{ noteId: 'note-1', noteVersion: 3, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 11, snippet: '死锁与调度' }],
    });
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '死锁', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [message] }),
    });
    mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={navigate} />);
    click('打开笔记 AI');

    return vi.waitFor(() => {
      click('跳转到操作系统复习第 2 段');
      expect(navigate).toHaveBeenCalledWith(message.citations[0]);
    });
  });

  it('shows verified and degraded states and offers Retry only for failed assistant messages', async () => {
    const failedUser = assistantMessage({ id: 'failed-user', role: 'user', status: 'failed', content: '失败的问题', errorMessage: '用户消息失败' });
    const failedAssistant = assistantMessage({ id: 'failed-assistant', status: 'failed', errorMessage: '回答失败' });
    const verified = assistantMessage({ id: 'verified', status: 'succeeded', content: '已核验回答', verified: true });
    const degraded = assistantMessage({ id: 'degraded', status: 'succeeded', content: '证据较少', degraded: true });
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '状态', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [failedUser, failedAssistant, verified, degraded] }),
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');

    await vi.waitFor(() => expect(container.textContent).toContain('已核验回答'));
    expect(container.textContent).toContain('已验证');
    expect(container.textContent).toContain('证据不足');
    expect([...container.querySelectorAll('button')].filter((item) => item.textContent?.includes('重试'))).toHaveLength(1);
    expect(container.querySelector('article')?.textContent).not.toContain('重试');
  });

  it('requests a writeback suggestion without directly saving the note', async () => {
    const saveNote = vi.fn();
    const submitAiChat = vi.fn().mockResolvedValue({ success: true, message: assistantMessage({ status: 'succeeded', content: '建议补充例题。' }), idempotent: false });
    const client = clientStub({ saveNote, submitAiChat });
    mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    click('生成写回建议');

    await vi.waitFor(() => expect(submitAiChat).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('只提供建议，不要直接修改笔记'),
    }), { signal: expect.any(AbortSignal) }));
    expect(saveNote).not.toHaveBeenCalled();
  });

  it('resumes only the latest persisted pending assistant message after reload', async () => {
    const watchAiMessage = vi.fn(() => vi.fn());
    const pending = assistantMessage({ id: 'pending-1', status: 'queued' });
    const latestPending = assistantMessage({ id: 'pending-2', status: 'streaming' });
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '待恢复', scopeType: 'note', scopeSnapshot: { type: 'note', notes: [{ id: 'note-1' }] }, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [pending, latestPending] }),
      watchAiMessage,
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');

    await vi.waitFor(() => expect(container.textContent).toContain('正在生成回答'));
    expect(watchAiMessage).toHaveBeenCalledTimes(1);
    expect(watchAiMessage).toHaveBeenCalledWith('pending-2', expect.anything());
  });

  it('replaces the pending watcher after collapse and reopen, then accepts the final update', async () => {
    const handlers: Array<{ onMessage: (message: NoteAiMessage) => void }> = [];
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    const watchAiMessage = vi.fn((_messageId, nextHandlers) => {
      handlers.push(nextHandlers);
      const cleanup = vi.fn();
      cleanups.push(cleanup);
      return cleanup;
    });
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '待恢复', scopeType: 'note', scopeSnapshot: { type: 'note', notes: [{ id: 'note-1' }] }, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ id: 'pending-reopen', status: 'streaming' })] }),
      watchAiMessage,
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    await vi.waitFor(() => expect(watchAiMessage).toHaveBeenCalledTimes(1));
    click('收起笔记 AI');
    expect(cleanups[0]).toHaveBeenCalledTimes(1);

    click('打开笔记 AI');
    await vi.waitFor(() => expect(watchAiMessage).toHaveBeenCalledTimes(2));
    act(() => handlers[1]!.onMessage(assistantMessage({ id: 'pending-reopen', status: 'succeeded', content: '重开后完成' })));

    expect(container.textContent).toContain('重开后完成');
    expect(watchAiMessage).toHaveBeenNthCalledWith(2, 'pending-reopen', expect.anything());
  });

  it('fences a delayed session creation after selected-note scope changes', async () => {
    const created = deferred<ReturnType<typeof sessionSuccess>>();
    const createAiSession = vi.fn((_input: unknown, _options: { signal: AbortSignal }) => created.promise);
    const submitAiChat = vi.fn();
    const watchAiMessage = vi.fn();
    const second = note('note-2', '计算机网络');
    const client = clientStub({ createAiSession, submitAiChat, watchAiMessage });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note(), second]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '旧范围问题');
    click('发送');
    await vi.waitFor(() => expect(createAiSession).toHaveBeenCalledTimes(1));
    change(container.querySelector<HTMLSelectElement>('[aria-label="AI 作用范围"]')!, 'selection');
    act(() => container.querySelector<HTMLInputElement>('input[aria-label="选择计算机网络"]')!.click());
    await act(async () => created.resolve(sessionSuccess('old-session')));

    expect(createAiSession.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(submitAiChat).not.toHaveBeenCalled();
    expect(watchAiMessage).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('旧范围问题');
  });

  it('fences a delayed chat response after unmount without creating an EventSource', async () => {
    const submitted = deferred<{ success: true; message: NoteAiMessage; idempotent: false }>();
    const submitAiChat = vi.fn((_input: unknown, _options: { signal: AbortSignal }) => submitted.promise);
    const watchAiMessage = vi.fn();
    const client = clientStub({ submitAiChat, watchAiMessage });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '卸载前问题');
    click('发送');
    await vi.waitFor(() => expect(submitAiChat).toHaveBeenCalledTimes(1));
    act(() => root!.unmount());
    root = null;
    await act(async () => submitted.resolve({ success: true, message: assistantMessage(), idempotent: false }));

    expect(submitAiChat.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    expect(watchAiMessage).not.toHaveBeenCalled();
  });

  it('invalidates old-scope messages and stream when the current note changes', async () => {
    const stopWatching = vi.fn();
    const secondMessages = deferred<{ success: true; messages: NoteAiMessage[] }>();
    const client = clientStub({
      listAiSessions: vi.fn()
        .mockResolvedValueOnce({ success: true, sessions: [{ id: 'session-1', title: '第一篇', scopeType: 'note', scopeSnapshot: { type: 'note', notes: [{ id: 'note-1' }] }, status: 'active', createdAt: now, updatedAt: now }] })
        .mockResolvedValueOnce({ success: true, sessions: [{ id: 'session-2', title: '第二篇', scopeType: 'note', scopeSnapshot: { type: 'note', notes: [{ id: 'note-2' }] }, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn()
        .mockResolvedValueOnce({ success: true, messages: [assistantMessage({ id: 'pending', status: 'streaming', content: '' }), assistantMessage({ id: 'old-answer', status: 'succeeded', content: '第一篇旧回答' })] })
        .mockImplementationOnce(() => secondMessages.promise),
      watchAiMessage: vi.fn(() => stopWatching),
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note(), note('note-2', '第二篇')]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.textContent).toContain('第一篇旧回答'));

    act(() => root!.render(<NoteAiDrawer client={client} currentNote={note('note-2', '第二篇')} notes={[note(), note('note-2', '第二篇')]} isMobile={false} onCitationNavigate={vi.fn()} />));
    await vi.waitFor(() => expect(client.listAiMessages).toHaveBeenCalledWith('session-2'));

    expect(container.textContent).not.toContain('第一篇旧回答');
    expect(stopWatching).toHaveBeenCalledTimes(1);
    await act(async () => secondMessages.resolve({ success: true, messages: [] }));
  });

  it('renders attachment citations without a note-body jump action', async () => {
    const navigate = vi.fn();
    const citation = { noteId: 'note-1', attachmentId: 'attachment-1', title: '讲义.pdf', location: '附件第 2 段', paragraphIndex: 1, charStart: 4, charEnd: 8, snippet: '附件内容' };
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '附件', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ status: 'succeeded', content: '来自附件', citations: [citation] })] }),
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={navigate} />);
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.textContent).toContain('讲义.pdf'));

    expect(container.querySelector('button[aria-label="跳转到讲义.pdf附件第 2 段"]')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('makes New conversation clear history without creating until the next send', async () => {
    const createAiSession = vi.fn().mockResolvedValue(sessionSuccess('session-2'));
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '旧会话', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ status: 'succeeded', content: '旧会话回答' })] }),
      createAiSession,
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.textContent).toContain('旧会话回答'));
    change(container.querySelector<HTMLSelectElement>('[aria-label="AI 会话"]')!, '');

    expect(container.textContent).not.toContain('旧会话回答');
    expect(createAiSession).not.toHaveBeenCalled();
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '新会话问题');
    click('发送');
    await vi.waitFor(() => expect(createAiSession).toHaveBeenCalledTimes(1));
  });

  it('maps document-wide citation offsets into the cited editor paragraph', async () => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', noteVersion: 3, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
    const message = assistantMessage({ content: '请查看原文。', status: 'succeeded', citations: [citation] });
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '定位原文', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [message] }),
    });
    mount(
      <NotesWorkspace
        client={client}
        userId="student-1"
        autosave={autosaveStub()}
        onEditorReady={(view) => { editorView = view; }}
      />,
    );
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    click('打开笔记 AI');
    await vi.waitFor(() => expect(document.querySelector('button[aria-label="跳转到操作系统复习第 2 段"]')).toBeTruthy());
    click('跳转到操作系统复习第 2 段');

    expect(editorView!.state.doc.textBetween(editorView!.state.selection.from, editorView!.state.selection.to)).toBe('死锁');
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s personal note citation version without changing selection', async (_label, noteVersion) => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', noteVersion, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '无效版本引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看引用', status: 'succeeded', citations: [citation] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => { editorView = view; }} />);
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到操作系统复习第 2 段"]')).toBeTruthy());
    const selectionBeforeCitation = { from: editorView!.state.selection.from, to: editorView!.state.selection.to };
    click('跳转到操作系统复习第 2 段');

    expect({ from: editorView!.state.selection.from, to: editorView!.state.selection.to }).toEqual(selectionBeforeCitation);
    expect(container.querySelector('[data-testid="stale-citation-notice"]')?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it('rejects a same-version citation immediately after the displayed document is edited', async () => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', noteVersion: 3, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '编辑前引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看编辑前引用', status: 'succeeded', citations: [citation] })] }),
    });
    const autosave = controlledAutosave();
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosave.controller} onEditorReady={(view) => { editorView = view; }} />);
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到操作系统复习第 2 段"]')).toBeTruthy());
    act(() => editorView!.dispatch(editorView!.state.tr.insertText('已编辑')));
    const selectionBeforeCitation = { from: editorView!.state.selection.from, to: editorView!.state.selection.to };
    click('跳转到操作系统复习第 2 段');

    expect({ from: editorView!.state.selection.from, to: editorView!.state.selection.to }).toEqual(selectionBeforeCitation);
    expect(container.querySelector('[data-testid="stale-citation-notice"]')?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it('rejects an old citation after autosave advances the displayed document version', async () => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', noteVersion: 3, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '保存前引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看保存前引用', status: 'succeeded', citations: [citation] })] }),
    });
    const autosave = controlledAutosave();
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosave.controller} onEditorReady={(view) => { editorView = view; }} />);
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到操作系统复习第 2 段"]')).toBeTruthy());
    act(() => editorView!.dispatch(editorView!.state.tr.insertText('已保存')));
    autosave.emit({ type: 'saved', noteId: 'note-1', resultingVersion: 4, idempotent: false });
    const selectionBeforeCitation = { from: editorView!.state.selection.from, to: editorView!.state.selection.to };
    click('跳转到操作系统复习第 2 段');

    expect({ from: editorView!.state.selection.from, to: editorView!.state.selection.to }).toEqual(selectionBeforeCitation);
    expect(container.querySelector('[data-testid="stale-citation-notice"]')?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it('does not apply a stale citation to a newer current note and shows visible feedback', async () => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', noteVersion: 2, title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
    const client = clientStub({
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '旧引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看旧引用', status: 'succeeded', citations: [citation] })] }),
    });
    const container = mount(
      <NotesWorkspace
        client={client}
        userId="student-1"
        autosave={autosaveStub()}
        onEditorReady={(view) => { editorView = view; }}
      />,
    );
    await vi.waitFor(() => expect(editorView).toBeTruthy());
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到操作系统复习第 2 段"]')).toBeTruthy());
    click('跳转到操作系统复习第 2 段');

    expect(editorView!.state.selection.empty).toBe(true);
    const notice = container.querySelector('[data-testid="stale-citation-notice"]');
    expect(notice).toBeTruthy();
    expect(notice?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['non-positive', 0],
    ['fractional', 1.5],
  ])('rejects an unloaded target with a %s version before any note lookup', async (_label, noteVersion) => {
    const current = note('note-1', '当前笔记');
    const target = { ...note('note-2', '目标笔记'), version: 4 };
    const citation = { noteId: 'note-2', noteVersion, title: '目标笔记', location: '第 1 段', paragraphIndex: 0, charStart: 0, charEnd: 2, snippet: '进程' };
    const views: EditorView[] = [];
    const getNote = vi.fn(async (noteId: string) => ({ success: true as const, note: noteId === 'note-2' ? target : current }));
    const client = clientStub({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [current] }),
      getNote,
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '无效目标引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看目标引用', status: 'succeeded', citations: [citation] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => views.push(view)} />);
    await vi.waitFor(() => expect(views).toHaveLength(1));
    getNote.mockClear();
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到目标笔记第 1 段"]')).toBeTruthy());
    click('跳转到目标笔记第 1 段');

    expect(getNote).not.toHaveBeenCalled();
    expect(views).toHaveLength(1);
    expect(views[0]!.isDestroyed).toBe(false);
    expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('当前笔记');
    expect(container.querySelector('[data-testid="stale-citation-notice"]')?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it('loads and selects a valid-version citation whose target is not in the current note list', async () => {
    const current = note('note-1', '当前笔记');
    const target = { ...note('note-2', '目标笔记'), version: 4 };
    const citation = { noteId: 'note-2', noteVersion: 4, title: '目标笔记', location: '第 1 段', paragraphIndex: 0, charStart: 0, charEnd: 2, snippet: '进程' };
    const views: EditorView[] = [];
    const getNote = vi.fn(async (noteId: string) => ({ success: true as const, note: noteId === 'note-2' ? target : current }));
    const client = clientStub({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [current] }),
      getNote,
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '有效目标引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看目标引用', status: 'succeeded', citations: [citation] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => views.push(view)} />);
    await vi.waitFor(() => expect(views).toHaveLength(1));
    getNote.mockClear();
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到目标笔记第 1 段"]')).toBeTruthy());
    click('跳转到目标笔记第 1 段');
    await vi.waitFor(() => expect(views).toHaveLength(2));
    await vi.waitFor(() => {
      const targetView = views[1]!;
      expect(targetView.state.doc.textBetween(targetView.state.selection.from, targetView.state.selection.to)).toBe('进程');
    });

    expect(getNote).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('目标笔记');
  });

  it('rechecks citation version after an asynchronous target-note load', async () => {
    const current = note('note-1', '当前笔记');
    const listedTarget = { ...note('note-2', '目标笔记'), version: 4 };
    const loadedTarget = { ...listedTarget, version: 5 };
    const citation = { noteId: 'note-2', noteVersion: 4, title: '目标笔记', location: '第 1 段', paragraphIndex: 0, charStart: 0, charEnd: 2, snippet: '进程' };
    const views: EditorView[] = [];
    const client = clientStub({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [current, listedTarget] }),
      getNote: vi.fn(async (noteId: string) => ({ success: true as const, note: noteId === 'note-2' ? loadedTarget : current })),
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '异步旧引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ content: '查看目标引用', status: 'succeeded', citations: [citation] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => views.push(view)} />);
    await vi.waitFor(() => expect(views).toHaveLength(1));
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到目标笔记第 1 段"]')).toBeTruthy());
    click('跳转到目标笔记第 1 段');
    await vi.waitFor(() => expect(views).toHaveLength(2));

    expect(views[1]!.state.selection.empty).toBe(true);
    expect(container.querySelector('[data-testid="stale-citation-notice"]')?.textContent).toContain('笔记内容已更新，该引用对应旧版本，请在历史版本中查看');
  });

  it('clears a pending citation when its note load fails', async () => {
    const first = note('note-1', '当前笔记');
    const third = { ...note('note-3', '后续笔记'), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '后续正文' }] }] }, contentText: '后续正文' };
    const citation = { noteId: 'note-2', noteVersion: 3, title: '缺失笔记', location: '第 1 段', paragraphIndex: 0, charStart: 1, charEnd: 3, snippet: '缺失' };
    const views: EditorView[] = [];
    const client = clientStub({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first, third] }),
      getNote: vi.fn(async (noteId: string) => noteId === 'note-2' ? { success: false as const, error: '引用笔记加载失败' } : { success: true as const, note: noteId === 'note-3' ? third : first }),
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ status: 'succeeded', content: '查看引用', citations: [citation] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => views.push(view)} />);
    await vi.waitFor(() => expect(views).toHaveLength(1));
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到缺失笔记第 1 段"]')).toBeTruthy());
    click('跳转到缺失笔记第 1 段');
    await vi.waitFor(() => expect(container.textContent).toContain('引用笔记加载失败'));
    click('后续笔记');
    await vi.waitFor(() => expect(views).toHaveLength(2));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(views[1]!.state.selection.from).toBe(1);
    expect(views[1]!.state.selection.empty).toBe(true);
  });

  it('lets a newer current-note citation supersede an older in-flight citation load', async () => {
    const first = { ...note('note-1', '当前笔记'), content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '当前正文' }] }] }, contentText: '当前正文' };
    const slowNote = deferred<{ success: true; note: NoteDetail }>();
    const older = { noteId: 'note-2', noteVersion: 3, title: '较慢笔记', location: '第 1 段', paragraphIndex: 0, charStart: 0, charEnd: 2, snippet: '较慢' };
    const newer = { noteId: 'note-1', noteVersion: 3, title: '当前笔记', location: '第 1 段', paragraphIndex: 0, charStart: 2, charEnd: 4, snippet: '正文' };
    const views: EditorView[] = [];
    const client = clientStub({
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [first] }),
      getNote: vi.fn((noteId: string) => noteId === 'note-2' ? slowNote.promise : Promise.resolve({ success: true as const, note: first })),
      listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [{ id: 'session-1', title: '引用', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }] }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ status: 'succeeded', content: '两个引用', citations: [older, newer] })] }),
    });
    const container = mount(<NotesWorkspace client={client} userId="student-1" autosave={autosaveStub()} onEditorReady={(view) => views.push(view)} />);
    await vi.waitFor(() => expect(views).toHaveLength(1));
    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.querySelector('button[aria-label="跳转到较慢笔记第 1 段"]')).toBeTruthy());
    click('跳转到较慢笔记第 1 段');
    await vi.waitFor(() => expect(client.getNote).toHaveBeenCalledWith('note-2', expect.anything()));
    click('跳转到当前笔记第 1 段');
    await act(async () => slowNote.resolve({ success: true, note: note('note-2', '较慢笔记') }));
    await vi.waitFor(() => expect(views.at(-1)?.state.doc.textContent).toBe('当前正文'));
    await vi.waitFor(() => {
      const currentView = views.at(-1)!;
      expect(currentView.state.doc.textBetween(currentView.state.selection.from, currentView.state.selection.to)).toBe('正文');
    });

    const activeView = views.at(-1)!;
    expect(activeView.state.doc.textBetween(activeView.state.selection.from, activeView.state.selection.to)).toBe('正文');
    expect(container.querySelector('[aria-label="笔记编辑器"]')?.textContent).toContain('当前笔记');
  });

  it('reconnects the actual EventSource with the persisted messageId without a second create or chat POST', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const requests: Array<{ url: string; method: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.endsWith('/assistant/sessions/') && method === 'GET') return jsonResponse({ success: true, sessions: [] });
      if (url.endsWith('/assistant/sessions/') && method === 'POST') {
        return jsonResponse({ success: true, session: { id: 'session-1', title: '解释进程状态', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now } }, 201);
      }
      if (url.endsWith('/assistant/chat/') && method === 'POST') return jsonResponse({ success: true, message: assistantMessage(), idempotent: false }, 202);
      throw new Error(`unexpected request ${method} ${url}`);
    });
    const client = new NotesClient({ fetch: fetcher });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '解释进程状态');
    click('发送');

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toContain('/assistant/stream/assistant-message-1/');
    act(() => FakeEventSource.instances[0]!.disconnect());
    expect(container.textContent).toContain('正在恢复回答');
    expect(FakeEventSource.reconnectUrls).toEqual([FakeEventSource.instances[0]!.url]);
    act(() => FakeEventSource.instances[0]!.emit('final', { success: true, message: assistantMessage({ status: 'succeeded', content: '进程具有就绪、运行和阻塞状态。', verified: true }) }));

    await vi.waitFor(() => expect(container.textContent).toContain('进程具有就绪、运行和阻塞状态。'));
    expect(requests.filter((item) => item.method === 'POST' && item.url.endsWith('/assistant/sessions/'))).toHaveLength(1);
    expect(requests.filter((item) => item.method === 'POST' && item.url.endsWith('/assistant/chat/'))).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(container.textContent).not.toContain('正在恢复回答');
  });

  it('closes the actual EventSource on server stream-error without entering reconnect state', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onDisconnect = vi.fn();
    const onError = vi.fn();
    const client = new NotesClient({ fetch: vi.fn() });
    client.watchAiMessage('persisted-message', { onMessage: vi.fn(), onDisconnect, onError });
    const source = FakeEventSource.instances[0]!;

    source.emit('stream-error', { success: false, error: '消息不存在' });
    source.disconnect();

    expect(source.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith('消息不存在');
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(FakeEventSource.reconnectUrls).toEqual([]);
  });
});

const persistedMessageId = '123e4567-e89b-42d3-a456-426614174000';

describe('personal note assistant SSE polling route', () => {
  it('requires an authenticated session before opening a stream', async () => {
    const { request } = routeRequest();
    const response = await streamAssistantMessage(request, { params: Promise.resolve({ messageId: persistedMessageId }) });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ success: false, code: 'authentication_required' });
  });

  it('forwards the session, polls at 700ms, emits changed snapshots only, and finishes on success', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(messageStatus('queued', ''))
      .mockResolvedValueOnce(messageStatus('queued', ''))
      .mockResolvedValueOnce(messageStatus('streaming', '草稿'))
      .mockResolvedValueOnce(messageStatus('succeeded', '最终回答'));
    vi.stubGlobal('fetch', fetcher);
    const { request } = routeRequest('sessionid=session-1; csrftoken=csrf-1');
    const response = await streamAssistantMessage(request, { params: Promise.resolve({ messageId: persistedMessageId }) });
    const reader = response.body!.getReader();
    const chunks = [await readChunk(reader)];

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(fetcher.mock.calls[0]?.[0]).toContain(`/api/notes/assistant/messages/${persistedMessageId}/`);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('cookie')).toBe('sessionid=session-1; csrftoken=csrf-1');
    await vi.advanceTimersByTimeAsync(699);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(700);
    chunks.push(await readChunk(reader));
    await vi.advanceTimersByTimeAsync(700);
    chunks.push(await readChunk(reader));

    const output = chunks.join('');
    expect(output.match(/event: status/g)).toHaveLength(2);
    expect(output).toContain('event: final');
    expect(output).toContain('最终回答');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['succeeded', 'failed'] as const)('emits a final event for %s', async (status) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(messageStatus(status, status === 'succeeded' ? '完成' : '')));
    const { request } = routeRequest('sessionid=session-1');
    const response = await streamAssistantMessage(request, { params: Promise.resolve({ messageId: persistedMessageId }) });
    const output = await readChunk(response.body!.getReader());
    expect(output).toContain('event: final');
    expect(output).toContain(`\"status\":\"${status}\"`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends keepalives, closes at the maximum duration, and aborts the in-flight poll', async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }));
    const { request } = routeRequest('sessionid=session-1');
    const response = await streamAssistantMessage(request, { params: Promise.resolve({ messageId: persistedMessageId }) });
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await readChunk(reader)).toContain(': keepalive');
    await vi.advanceTimersByTimeAsync(285_000);
    const remainder = await readToEnd(reader);
    expect(remainder).toContain('stream_timeout');
    expect(upstreamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up polling, keepalive, and upstream fetch when the browser aborts', async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }));
    const { request, controller } = routeRequest('sessionid=session-1');
    const response = await streamAssistantMessage(request, { params: Promise.resolve({ messageId: persistedMessageId }) });
    const reader = response.body!.getReader();
    controller.abort();
    expect((await reader.read()).done).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reconnectUrls: string[] = [];
  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === 'function' ? listener : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  disconnect() {
    if (this.closed) return;
    this.onerror?.(new Event('error'));
    FakeEventSource.reconnectUrls.push(this.url);
  }

  emit(type: string, payload: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() {
    this.closed = true;
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}

function routeRequest(cookie = '') {
  const controller = new AbortController();
  const request = { headers: new Headers(cookie ? { cookie } : {}), signal: controller.signal } as NextRequest;
  return { request, controller };
}

function messageStatus(status: NoteAiMessage['status'], content: string) {
  return jsonResponse({ success: true, message: assistantMessage({ id: persistedMessageId, status, content }) });
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await reader.read();
  return result.value ? new TextDecoder().decode(result.value) : '';
}

async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let output = '';
  for (;;) {
    const result = await reader.read();
    if (result.done) return output;
    output += new TextDecoder().decode(result.value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function sessionSuccess(id = 'session-1') {
  return { success: true as const, session: { id, title: '会话', scopeType: 'note' as const, scopeSnapshot: {}, status: 'active' as const, createdAt: now, updatedAt: now } };
}
