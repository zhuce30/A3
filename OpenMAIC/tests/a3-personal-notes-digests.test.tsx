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
    createManualDigest: vi.fn().mockResolvedValue({
      success: true,
      digest: { ...digests[0], id: 'digest-created', revision: 3 },
    }),
    retryDigest: vi.fn().mockResolvedValue({ success: true, digest: { ...digests[0], status: 'queued' } }),
    ...overrides,
  } as unknown as NotesClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function changeDate(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="date"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
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
    expect(client.retryDigest).toHaveBeenCalledWith('digest-2', { signal: expect.any(AbortSignal) });

    const refresh = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('生成新修订'))!;
    await act(async () => refresh.click());
    expect(client.createManualDigest).toHaveBeenCalledWith('2026-08-02', { signal: expect.any(AbortSignal) });
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

  it('ignores a stale refresh that resolves after a completed manual revision', async () => {
    const staleRefresh = deferred<{ success: true; digests: NoteDigest[] }>();
    const created = { ...digests[1], id: 'digest-3', revision: 3, generatedBy: 'manual' as const };
    const listDigests = vi.fn()
      .mockResolvedValueOnce({ success: true, digests })
      .mockReturnValueOnce(staleRefresh.promise);
    const client = clientStub({
      listDigests,
      createManualDigest: vi.fn().mockResolvedValue({ success: true, digest: created }),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.textContent).toContain('修订 2'));

    const refresh = host.querySelector<HTMLButtonElement>('button[title="刷新总结状态"]')!;
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('生成新修订'))!;
    act(() => refresh.click());
    await act(async () => create.click());
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('digest-3');

    await act(async () => staleRefresh.resolve({
      success: true,
      digests: [{ ...digests[0], id: 'mixed-old-create', digestDate: '2026-08-01' }, ...digests],
    }));

    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('digest-3');
    expect(host.textContent).toContain('修订 3');
    expect(create.disabled).toBe(false);
  });

  it('ignores a stale refresh that resolves after a completed retry', async () => {
    const staleRefresh = deferred<{ success: true; digests: NoteDigest[] }>();
    const retried = { ...digests[0], status: 'queued' as const };
    const client = clientStub({
      listDigests: vi.fn()
        .mockResolvedValueOnce({ success: true, digests })
        .mockReturnValueOnce(staleRefresh.promise),
      retryDigest: vi.fn().mockResolvedValue({ success: true, digest: retried }),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.textContent).toContain('摘要模型暂时不可用'));

    const refresh = host.querySelector<HTMLButtonElement>('button[title="刷新总结状态"]')!;
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('重试失败修订'))!;
    await act(async () => {
      refresh.click();
      retry.click();
    });
    expect(host.textContent).toContain('总结已排队');

    await act(async () => staleRefresh.resolve({
      success: true,
      digests: [{ ...digests[0], id: 'mixed-old-retry', digestDate: '2026-08-01' }, ...digests],
    }));

    expect(host.textContent).toContain('总结已排队');
    expect(host.textContent).not.toContain('摘要模型暂时不可用');
  });

  it('only applies the latest of two overlapping refreshes', async () => {
    const firstRefresh = deferred<{ success: true; digests: NoteDigest[] }>();
    const secondRefresh = deferred<{ success: true; digests: NoteDigest[] }>();
    const latest = [{ ...digests[1], id: 'latest-refresh', revision: 4 }];
    const client = clientStub({
      listDigests: vi.fn()
        .mockResolvedValueOnce({ success: true, digests })
        .mockReturnValueOnce(firstRefresh.promise)
        .mockReturnValueOnce(secondRefresh.promise),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.textContent).toContain('修订 2'));

    const refresh = host.querySelector<HTMLButtonElement>('button[title="刷新总结状态"]')!;
    act(() => {
      refresh.click();
      refresh.click();
    });
    await act(async () => secondRefresh.resolve({ success: true, digests: latest }));
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('latest-refresh');

    await act(async () => firstRefresh.resolve({ success: true, digests }));

    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('latest-refresh');
    expect(host.textContent).toContain('修订 4');
  });

  it('selects the latest date and excludes mixed-date revisions from the initial payload', async () => {
    const mixed = [
      { ...digests[0], id: 'older-failed', digestDate: '2026-08-01', revision: 9 },
      { ...digests[1], id: 'latest-one', digestDate: '2026-08-03', revision: 1 },
      { ...digests[0], id: 'latest-two', digestDate: '2026-08-03', revision: 2 },
      { ...digests[1], id: 'middle', digestDate: '2026-08-02', revision: 7 },
    ];
    const client = clientStub({
      listDigests: vi.fn().mockResolvedValue({ success: true, digests: mixed }),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect((host.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-08-03'));

    const options = [...host.querySelectorAll<HTMLOptionElement>('select option')];
    expect(options.map((option) => option.value)).toEqual(['latest-one', 'latest-two']);
  });

  it('filters an explicit old date and retries its failed digest', async () => {
    const oldFailed = { ...digests[0], id: 'old-failed', digestDate: '2026-08-01', revision: 5 };
    const newer = { ...digests[1], id: 'newer', digestDate: '2026-08-03', revision: 1 };
    const client = clientStub({
      listDigests: vi.fn().mockResolvedValue({ success: true, digests: [newer, oldFailed] }),
      retryDigest: vi.fn().mockResolvedValue({ success: true, digest: { ...oldFailed, status: 'queued' } }),
    });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect((host.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-08-03'));
    changeDate(host, '2026-08-01');
    await vi.waitFor(() => expect((host.querySelector('select') as HTMLSelectElement).value).toBe('old-failed'));
    expect(host.querySelectorAll('select option')).toHaveLength(1);

    const retry = host.querySelector<HTMLButtonElement>('article [role="alert"] button')!;
    await act(async () => retry.click());

    expect(client.retryDigest).toHaveBeenCalledWith('old-failed', { signal: expect.any(AbortSignal) });
    expect((host.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('2026-08-01');
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('old-failed');
    expect(host.querySelector('article [role="alert"]')).toBeNull();
  });

  it('blocks reads, date changes, navigation and duplicate create until create settles', async () => {
    const pending = deferred<{ success: true; digest: NoteDigest }>();
    const openNote = vi.fn();
    const client = clientStub({ createManualDigest: vi.fn().mockReturnValue(pending.promise) });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={openNote} />));
    await vi.waitFor(() => expect(host.querySelector('article')).not.toBeNull());
    const dateInput = host.querySelector<HTMLInputElement>('input[type="date"]')!;
    const select = host.querySelector<HTMLSelectElement>('select')!;
    const [refresh, create] = [...host.querySelectorAll<HTMLButtonElement>('header button')];
    const retry = host.querySelector<HTMLButtonElement>('article [role="alert"] button')!;
    const source = host.querySelector<HTMLButtonElement>('article section button')!;

    act(() => create.click());
    expect([dateInput.disabled, select.disabled, refresh.disabled, create.disabled, retry.disabled, source.disabled]).toEqual([
      true, true, true, true, true, true,
    ]);
    act(() => {
      create.click();
      retry.click();
      refresh.click();
      source.click();
    });
    changeDate(host, '2026-08-03');
    expect(client.createManualDigest).toHaveBeenCalledTimes(1);
    expect(client.retryDigest).not.toHaveBeenCalled();
    expect(client.listDigests).toHaveBeenCalledTimes(1);
    expect(openNote).not.toHaveBeenCalled();
    expect(dateInput.value).toBe('2026-08-02');
    expect(create.disabled).toBe(true);

    await act(async () => pending.resolve({
      success: true,
      digest: { ...digests[1], id: 'created-after-wait', revision: 3, generatedBy: 'manual' },
    }));
    expect(dateInput.disabled).toBe(false);
    expect(select.disabled).toBe(false);
    expect(refresh.disabled).toBe(false);
    expect(create.disabled).toBe(false);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('created-after-wait');
  });

  it('blocks reads, date changes and duplicate retry until retry settles', async () => {
    const pending = deferred<{ success: true; digest: NoteDigest }>();
    const client = clientStub({ retryDigest: vi.fn().mockReturnValue(pending.promise) });
    await act(async () => root.render(<NoteDigestView client={client} onOpenNote={vi.fn()} />));
    await vi.waitFor(() => expect(host.querySelector('article [role="alert"]')).not.toBeNull());
    const dateInput = host.querySelector<HTMLInputElement>('input[type="date"]')!;
    const [refresh, create] = [...host.querySelectorAll<HTMLButtonElement>('header button')];
    const retry = host.querySelector<HTMLButtonElement>('article [role="alert"] button')!;

    act(() => retry.click());
    expect(retry.disabled).toBe(true);
    expect(dateInput.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);
    expect(create.disabled).toBe(true);
    act(() => {
      retry.click();
      refresh.click();
      create.click();
    });
    changeDate(host, '2026-08-03');
    expect(client.retryDigest).toHaveBeenCalledTimes(1);
    expect(client.createManualDigest).not.toHaveBeenCalled();
    expect(client.listDigests).toHaveBeenCalledTimes(1);
    expect(dateInput.value).toBe('2026-08-02');

    await act(async () => pending.resolve({ success: true, digest: { ...digests[0], status: 'queued' } }));
    expect(dateInput.disabled).toBe(false);
    expect(refresh.disabled).toBe(false);
    expect(create.disabled).toBe(false);
    expect(host.querySelector('article [role="alert"]')).toBeNull();
  });
});
