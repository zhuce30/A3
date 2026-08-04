// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoteAiDrawer } from '@/components/a3/notes/note-ai-drawer';
import { NoteMemoryManager } from '@/components/a3/notes/note-memory-manager';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteAiMessage, NoteDetail, NoteMemory } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = '2026-08-03T08:00:00.000Z';

const note = (id = 'note-1', title = '进程复习笔记'): NoteDetail => ({
  id,
  title,
  content: { type: 'doc', content: [] },
  contentText: '',
  version: 3,
  notebook: null,
  tags: [],
  isPinned: false,
  lastEditedAt: now,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

const memory = (overrides: Partial<NoteMemory> = {}): NoteMemory => ({
  id: 'memory-1',
  memoryType: 'core',
  content: '讲解时先给流程图，再解释细节',
  status: 'candidate',
  importance: 4,
  confidence: 0.92,
  sourceSessionId: 'session-1',
  sourceMessageIds: ['message-1'],
  sourceNoteRefs: [{ id: 'note-1', version: 3, title: '进程复习笔记' }],
  reason: '用户明确表达了长期讲解偏好',
  validFrom: now,
  validUntil: null,
  supersededById: null,
  confirmedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const assistantMessage = (metadata: Record<string, unknown>): NoteAiMessage => ({
  id: 'assistant-1',
  sessionId: 'session-1',
  role: 'assistant',
  content: '我会先用流程图解释。',
  status: 'succeeded',
  clientRequestId: 'request-1',
  citations: [],
  verified: true,
  claims: [],
  safety: {},
  degraded: false,
  errorCode: '',
  errorMessage: '',
  metadata,
  createdAt: now,
});

function clientStub(overrides: Partial<NotesClient> = {}) {
  return {
    listMemories: vi.fn().mockResolvedValue({ success: true, memories: [] }),
    confirmMemory: vi.fn(),
    pauseMemory: vi.fn(),
    resumeMemory: vi.fn(),
    supersedeMemory: vi.fn(),
    deleteMemory: vi.fn(),
    listAiSessions: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
    listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
    watchAiMessage: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as NotesClient;
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

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('personal note memory controls', () => {
  it('separates candidates, opens an editable confirmation preview, and links sources', async () => {
    const candidate = memory();
    const confirmed = memory({ id: 'memory-2', content: '每晚复习二十分钟', status: 'confirmed', confirmedAt: now });
    const confirmMemory = vi.fn().mockResolvedValue({
      success: true,
      memory: { ...candidate, content: '先给流程图，再解释关键细节', status: 'confirmed', confirmedAt: now },
    });
    const onSourceOpen = vi.fn();
    const client = clientStub({
      listMemories: vi.fn().mockResolvedValue({ success: true, memories: [candidate, confirmed] }),
      confirmMemory,
    });
    const container = mount(<NoteMemoryManager client={client} notes={[note()]} onSourceOpen={onSourceOpen} />);

    await vi.waitFor(() => expect(container.textContent).toContain(candidate.content));
    expect(container.textContent).not.toContain(confirmed.content);
    click('打开来源笔记：进程复习笔记');
    expect(onSourceOpen).toHaveBeenCalledWith('note-1');

    click('审核并确认');
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="记忆内容"]')!;
    expect(editor.value).toBe(candidate.content);
    change(editor, '先给流程图，再解释关键细节');
    change(container.querySelector<HTMLSelectElement>('[aria-label="记忆类型"]')!, 'episodic');
    click('确认使用');

    await vi.waitFor(() => expect(confirmMemory).toHaveBeenCalledWith(candidate.id, expect.objectContaining({
      content: '先给流程图，再解释关键细节',
      memoryType: 'episodic',
    })));
    click('已启用');
    await vi.waitFor(() => expect(container.textContent).toContain('先给流程图，再解释关键细节'));
    expect(container.textContent).toContain('已启用');
  });

  it('pauses active memory, records replacement relationships, and confirms destructive deletion', async () => {
    const active = memory({ status: 'confirmed', confirmedAt: now });
    const pauseMemory = vi.fn().mockResolvedValue({ success: true, memory: { ...active, status: 'paused' } });
    const replacement = memory({ id: 'memory-2', content: '先看代码，再看流程图', status: 'confirmed', confirmedAt: now });
    const supersedeMemory = vi.fn().mockResolvedValue({
      success: true,
      memory: { ...active, status: 'superseded', supersededById: replacement.id },
      replacement,
    });
    const deleteMemory = vi.fn().mockResolvedValue({ success: true, memory: { ...replacement, status: 'deleted', deletedAt: now } });
    const client = clientStub({
      listMemories: vi.fn().mockResolvedValue({ success: true, memories: [active] }),
      pauseMemory,
      supersedeMemory,
      deleteMemory,
    });
    const container = mount(<NoteMemoryManager client={client} notes={[note()]} onSourceOpen={vi.fn()} />);

    click('已启用');
    await vi.waitFor(() => expect(container.textContent).toContain(active.content));
    click('暂停');
    await vi.waitFor(() => expect(pauseMemory).toHaveBeenCalledWith(active.id));
    await vi.waitFor(() => expect(container.textContent).not.toContain('当前会用于回答'));

    click('已暂停');
    click('更正');
    change(container.querySelector<HTMLTextAreaElement>('[aria-label="更正后的记忆内容"]')!, replacement.content);
    click('保存更正');
    await vi.waitFor(() => expect(supersedeMemory).toHaveBeenCalledWith(active.id, expect.objectContaining({ content: replacement.content })));

    click('历史');
    expect(container.textContent).toContain('已由新记忆替换');
    expect(container.textContent).toContain(replacement.content);
    click('已启用');
    click('删除记忆');
    expect(container.textContent).toContain('删除后，今后的个人笔记 AI 对话将不再使用这条记忆');
    click('确认删除');
    await vi.waitFor(() => expect(deleteMemory).toHaveBeenCalled());
  });
});

describe('personal note assistant memory disclosure', () => {
  it('shows only used confirmed memories and expands their source and current state', async () => {
    const used = memory({ status: 'confirmed', confirmedAt: now });
    const candidate = memory({ id: 'candidate-2', content: '未经确认的候选', status: 'candidate' });
    const client = clientStub({
      listMemories: vi.fn().mockResolvedValue({ success: true, memories: [used, candidate] }),
      listAiSessions: vi.fn().mockResolvedValue({
        success: true,
        sessions: [{ id: 'session-1', title: '复习', scopeType: 'note', scopeSnapshot: {}, status: 'active', createdAt: now, updatedAt: now }],
      }),
      listAiMessages: vi.fn().mockResolvedValue({ success: true, messages: [assistantMessage({ memoryIds: [used.id, candidate.id] })] }),
    });
    const container = mount(<NoteAiDrawer client={client} currentNote={note()} notes={[note()]} isMobile={false} onCitationNavigate={vi.fn()} />);

    click('打开笔记 AI');
    await vi.waitFor(() => expect(container.textContent).toContain('使用了 1 条已确认记忆'));
    expect(container.textContent).not.toContain(candidate.content);
    click('使用了 1 条已确认记忆');
    expect(container.textContent).toContain(used.content);
    expect(container.textContent).toContain('来源：进程复习笔记');
    expect(container.textContent).toContain('状态：已启用');
  });
});
