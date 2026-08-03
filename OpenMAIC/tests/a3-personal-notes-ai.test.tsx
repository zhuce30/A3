// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { NoteAiDrawer } from '@/components/a3/notes/note-ai-drawer';
import { NotesWorkspace } from '@/components/a3/notes/notes-workspace';
import type { NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import type { NotesClient } from '@/lib/a3/notes/client';
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

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('personal note AI drawer', () => {
  it('is collapsed on first load and keeps the editor dominant', async () => {
    const container = mount(<NotesWorkspace client={clientStub()} userId="student-1" autosave={autosaveStub()} />);
    await vi.waitFor(() => expect(container.querySelector('[data-testid="notes-ai-drawer"]')).toBeTruthy());

    const drawer = container.querySelector('[data-testid="notes-ai-drawer"]')!;
    expect(drawer.getAttribute('data-state')).toBe('collapsed');
    expect(drawer.className).toContain('w-12');
    expect(container.querySelector('[data-testid="notes-workspace"]')?.className).toContain('minmax(560px,1fr)');
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
    }));
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
    })));
  });

  it('jumps from a citation to the cited note section', () => {
    const navigate = vi.fn();
    const message = assistantMessage({
      content: '死锁需要同时满足四个条件。',
      status: 'succeeded',
      verified: true,
      citations: [{ noteId: 'note-1', title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 11, snippet: '死锁与调度' }],
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

  it('maps document-wide citation offsets into the cited editor paragraph', async () => {
    let editorView: EditorView | undefined;
    const citation = { noteId: 'note-1', title: '操作系统复习', location: '第 2 段', paragraphIndex: 1, charStart: 6, charEnd: 8, snippet: '死锁' };
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

  it('continues a dropped stream by persisted messageId without a second chat submission', async () => {
    let update: ((message: NoteAiMessage) => void) | undefined;
    let dropped: (() => void) | undefined;
    const submitAiChat = vi.fn().mockResolvedValue({ success: true, message: assistantMessage(), idempotent: false });
    const watchAiMessage = vi.fn((_messageId, handlers) => {
      update = handlers.onMessage;
      dropped = handlers.onDisconnect;
      return vi.fn();
    });
    const client = clientStub({ submitAiChat, watchAiMessage });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);
    click('打开笔记 AI');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="向笔记 AI 提问"]')!, '解释进程状态');
    click('发送');

    await vi.waitFor(() => expect(watchAiMessage).toHaveBeenCalledWith('assistant-message-1', expect.anything()));
    act(() => dropped?.());
    expect(container.textContent).toContain('正在恢复回答');
    act(() => update?.(assistantMessage({ status: 'succeeded', content: '进程具有就绪、运行和阻塞状态。', verified: true })));

    await vi.waitFor(() => expect(container.textContent).toContain('进程具有就绪、运行和阻塞状态。'));
    expect(submitAiChat).toHaveBeenCalledTimes(1);
    expect(watchAiMessage).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('正在恢复回答');
  });
});
