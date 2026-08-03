// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteDigestView } from '@/components/a3/notes/note-digest-view';
import { NotesWorkspace } from '@/components/a3/notes/notes-workspace';
import type { NotesAutosaveController } from '@/lib/a3/notes/autosave-controller';
import type { NotesClient } from '@/lib/a3/notes/client';
import type { NoteDigest } from '@/lib/a3/notes/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const digests: NoteDigest[] = [
  {
    id: 'digest-2', digestDate: '2026-08-02', revision: 2, status: 'failed', title: '', contentMd: '',
    sourceSnapshot: { notes: [{ id: 'note-1', version: 3, title: '离散数学', attachments: [] }] },
    generatedBy: 'manual', idempotencyKey: 'manual:2', errorCode: 'digest_model_unavailable',
    errorMessage: '摘要模型暂时不可用', createdAt: '2026-08-03T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z',
  },
  {
    id: 'digest-1', digestDate: '2026-08-02', revision: 1, status: 'succeeded', title: '8 月 2 日笔记总结',
    contentMd: '## 今日重点\n\n- **命题逻辑**',
    sourceSnapshot: { notes: [{ id: 'note-1', version: 3, title: '离散数学', attachments: [{ id: 'attachment-1', parseVersion: 4, displayName: '证明补充' }] }] },
    generatedBy: 'automatic', idempotencyKey: 'auto:user:2026-08-02', errorCode: '', errorMessage: '',
    createdAt: '2026-08-02T18:10:00Z', updatedAt: '2026-08-02T18:10:00Z',
  },
];

function clientStub(overrides: Partial<NotesClient> = {}) {
  return {
    listDigests: vi.fn().mockResolvedValue({ success: true, digests }),
    createManualDigest: vi.fn().mockResolvedValue({ success: true, digest: digests[0] }),
    retryDigest: vi.fn().mockResolvedValue({ success: true, digest: { ...digests[0], status: 'queued' } }),
    ...overrides,
  } as unknown as NotesClient;
}

describe('personal note daily digest view', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it('renders date and revision selectors, manual/automatic badges, Markdown and immutable sources', async () => {
    const openNote = vi.fn();
    await act(async () => root.render(<NoteDigestView client={clientStub()} onOpenNote={openNote} />));
    await vi.waitFor(() => expect(host.textContent).toContain('摘要模型暂时不可用'));

    expect(host.querySelector('input[type="date"]')).not.toBeNull();
    expect(host.textContent).toContain('手动生成');
    expect(host.textContent).toContain('修订 2');
    const revision = host.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      revision.value = 'digest-1';
      revision.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('自动生成');
    expect([...host.querySelectorAll('h1,h2,h3,h4')].some((heading) => heading.textContent === '今日重点')).toBe(true);
    expect(host.querySelector('strong')?.textContent).toBe('命题逻辑');
    expect(host.textContent).toContain('离散数学 · 版本 3');
    expect(host.textContent).toContain('证明补充 · 解析版本 4');
    expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();

    const sourceButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('离散数学'))!;
    await act(async () => sourceButton.click());
    expect(openNote).toHaveBeenCalledWith('note-1');
  });

  it('offers retry only for failed artifacts and manual refresh creates a new revision', async () => {
    const client = clientStub();
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.textContent).toContain('摘要模型暂时不可用'));

    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('重试'))!;
    await act(async () => retry.click());
    expect(client.retryDigest).toHaveBeenCalledWith('digest-2');

    const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('生成新修订'))!;
    await act(async () => refresh.click());
    expect(client.createManualDigest).toHaveBeenCalledWith('2026-08-02');
  });

  it('shows a readable manual generation failure without replacing the loaded artifact', async () => {
    const client = clientStub({
      createManualDigest: vi.fn().mockResolvedValue({ success: false, error: '每日总结创建繁忙，请重试' }),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.textContent).toContain('摘要模型暂时不可用'));

    const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('生成新修订'))!;
    await act(async () => refresh.click());

    expect(host.textContent).toContain('每日总结创建繁忙，请重试');
    expect(host.textContent).toContain('修订 2');
  });

  it('opens the daily summary smart view outside the editable note and AI surfaces', async () => {
    const client = clientStub({
      listNotebooks: vi.fn().mockResolvedValue({ success: true, notebooks: [] }),
      listTags: vi.fn().mockResolvedValue({ success: true, tags: [] }),
      searchNotes: vi.fn().mockResolvedValue({ success: true, notes: [] }),
    });
    const autosave = {
      initialize: vi.fn().mockResolvedValue({ account: { warningRequired: false }, replay: [] }),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(),
    } as unknown as NotesAutosaveController;
    await act(async () => root.render(<NotesWorkspace client={client} userId="student-1" autosave={autosave} />));
    const smartView = await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="每日总结"]');
      expect(button).not.toBeNull();
      return button!;
    });

    await act(async () => smartView.click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="每日总结只读视图"]')).not.toBeNull());

    await vi.waitFor(() => expect(client.listDigests).toHaveBeenCalled());
    expect(host.querySelector('[contenteditable="true"]')).toBeNull();
    expect(host.querySelector('[aria-label="打开笔记 AI"]')).toBeNull();
  });
});
