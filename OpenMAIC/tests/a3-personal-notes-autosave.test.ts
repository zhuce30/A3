import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NotesDraftStore,
  type NoteDraft,
  type NotesDraftPersistence,
  type PendingNoteMutation,
} from '@/lib/a3/notes/draft-store';
import {
  NotesAutosaveController,
  type AutosaveNotesClient,
  type EditableNoteDraft,
  type OnlineEventSource,
} from '@/lib/a3/notes/autosave-controller';
import type { ApiResult, SaveNoteSuccess, SuccessfulApiResult } from '@/lib/a3/notes/types';

class MemoryPersistence implements NotesDraftPersistence {
  drafts = new Map<string, NoteDraft>();
  mutations = new Map<string, PendingNoteMutation>();

  async allDrafts() { return [...this.drafts.values()]; }
  async allMutations() { return [...this.mutations.values()]; }
  async getDraft(noteId: string) { return this.drafts.get(noteId); }
  async getMutation(clientMutationId: string) { return this.mutations.get(clientMutationId); }
  async putDraftAndMutation(draft: NoteDraft, mutation: PendingNoteMutation) {
    this.drafts.set(draft.noteId, structuredClone(draft));
    this.mutations.set(mutation.clientMutationId, structuredClone(mutation));
  }
  async deleteAccounts(userIds: string[]) {
    const ids = new Set(userIds);
    for (const [key, value] of this.drafts) if (ids.has(value.userId)) this.drafts.delete(key);
    for (const [key, value] of this.mutations) if (ids.has(value.userId)) this.mutations.delete(key);
  }
  async acknowledge(userId: string, mutation: PendingNoteMutation) {
    this.mutations.delete(mutation.clientMutationId);
    const draft = this.drafts.get(mutation.noteId);
    if (draft?.userId === userId && draft.clientMutationId === mutation.clientMutationId) {
      this.drafts.delete(mutation.noteId);
    }
  }
  async rebaseNewer(userId: string, mutation: PendingNoteMutation, resultingVersion: number) {
    for (const [key, value] of this.mutations) {
      if (value.userId === userId && value.noteId === mutation.noteId && value.createdAt > mutation.createdAt) {
        this.mutations.set(key, { ...value, baseVersion: resultingVersion });
      }
    }
    const draft = this.drafts.get(mutation.noteId);
    if (draft?.userId === userId && draft.clientMutationId !== mutation.clientMutationId) {
      this.drafts.set(draft.noteId, { ...draft, baseVersion: resultingVersion });
    }
  }
  async discardMutation(clientMutationId: string) { this.mutations.delete(clientMutationId); }
  async clear() { this.drafts.clear(); this.mutations.clear(); }
}

class FakeOnlineEvents implements OnlineEventSource {
  listeners = new Set<() => void>();
  addEventListener(_type: 'online', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'online', listener: () => void) { this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(); }
}

const now = () => new Date().toISOString();
const localDraft = (overrides: Partial<EditableNoteDraft> = {}): EditableNoteDraft => ({
  noteId: 'note-1',
  title: '进程调度',
  content: { type: 'doc', content: [] },
  contentText: '轮转调度',
  baseVersion: 7,
  clientMutationId: 'mutation-1',
  updatedAt: now(),
  ...overrides,
});

const saved = (version: number): SuccessfulApiResult<SaveNoteSuccess> => ({
  success: true,
  note: {
    id: 'note-1', title: '进程调度', content: {}, contentText: '轮转调度', version,
    notebook: null, tags: [], isPinned: false, lastEditedAt: now(), deletedAt: null,
    createdAt: now(), updatedAt: now(),
  },
  resultingVersion: version,
  idempotent: false,
});

const setup = (saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(8))) => {
  const persistence = new MemoryPersistence();
  const store = new NotesDraftStore(persistence);
  const events = new FakeOnlineEvents();
  const client: AutosaveNotesClient = { saveNote };
  const controller = new NotesAutosaveController({ store, client, userId: 'opaque-user-a', onlineEvents: events });
  return { persistence, store, events, client, saveNote, controller };
};

describe('personal notes draft account isolation', () => {
  it('does not expose one account draft to another account or logged-out state', async () => {
    const persistence = new MemoryPersistence();
    const store = new NotesDraftStore(persistence);
    await store.activateUser('opaque-user-a');
    await store.persist(localDraft());

    await store.activateUser(null);
    expect(await store.getDraft('note-1')).toBeUndefined();
    expect(await store.listMutations()).toEqual([]);

    const state = await store.activateUser('opaque-user-b');
    expect(state).toMatchObject({ kind: 'account-changed', warningRequired: true, clearedDraftCount: 1 });
    expect(await store.getDraft('note-1')).toBeUndefined();
    expect([...persistence.drafts.values()]).toEqual([]);
  });
});

describe('personal notes autosave', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists the draft and mutation before starting the network request', async () => {
    const { persistence, controller, saveNote } = setup();
    saveNote.mockImplementation(async () => {
      expect(persistence.drafts.get('note-1')?.title).toBe('进程调度');
      expect(persistence.mutations.has('mutation-1')).toBe(true);
      return saved(8);
    });

    await controller.flush(localDraft());

    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it('debounces scheduled saves for 1500ms', async () => {
    vi.useFakeTimers();
    const { controller, saveNote } = setup();

    await controller.schedule(localDraft({ clientMutationId: 'mutation-1' }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(saveNote).not.toHaveBeenCalled();
    await controller.schedule(localDraft({ title: '最新标题', clientMutationId: 'mutation-2' }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(saveNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote.mock.calls[0]?.[1]).toMatchObject({ title: '最新标题', clientMutationId: 'mutation-2' });
    controller.dispose();
  });

  it('keeps a conflicting draft instead of overwriting it', async () => {
    const { controller, store, saveNote } = setup();
    saveNote.mockResolvedValue({
      success: false,
      status: 409,
      code: 'note_version_conflict',
      error: '版本冲突',
      serverVersion: 8,
      serverNote: saved(8).note,
    });

    const result = await controller.flush(localDraft({ baseVersion: 7 }));

    expect(result).toMatchObject({ kind: 'conflict', noteId: 'note-1', serverVersion: 8 });
    expect(await store.getDraft(result.noteId)).toBeTruthy();
    expect(await store.listMutations()).toHaveLength(1);
  });

  it('deduplicates a retried mutation id after acknowledgement', async () => {
    const { controller, saveNote } = setup();

    await controller.flush(localDraft({ clientMutationId: 'same-id' }));
    await controller.flush(localDraft({ clientMutationId: 'same-id' }));

    expect(saveNote).toHaveBeenCalledTimes(1);
  });

  it('keeps network and 5xx failures queued and resumes deterministically on online', async () => {
    const { controller, events, store, saveNote } = setup();
    saveNote
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ success: false, status: 503, code: 'unavailable', error: '稍后重试' })
      .mockResolvedValueOnce(saved(8));

    expect(await controller.flush(localDraft())).toMatchObject({ kind: 'queued' });
    expect(await store.listMutations()).toHaveLength(1);
    events.emit();
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    expect(await store.listMutations()).toHaveLength(1);
    events.emit();
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(3));
    await vi.waitFor(async () => expect(await store.listMutations()).toHaveLength(0));
  });

  it('replays queued mutations on initialization in creation order', async () => {
    const persistence = new MemoryPersistence();
    const store = new NotesDraftStore(persistence);
    await store.activateUser('opaque-user-a');
    await store.persist(localDraft({ noteId: 'note-2', clientMutationId: 'later', updatedAt: '2026-08-02T02:00:00Z' }));
    await store.persist(localDraft({ noteId: 'note-1', clientMutationId: 'earlier', updatedAt: '2026-08-02T01:00:00Z' }));
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(8));
    const controller = new NotesAutosaveController({ store, client: { saveNote }, userId: 'opaque-user-a' });

    await controller.initialize();

    expect(saveNote.mock.calls.map((call) => call[1].clientMutationId)).toEqual(['earlier', 'later']);
  });

  it('serializes one request per note while allowing different notes concurrently', async () => {
    const releases = new Map<string, () => void>();
    let active = 0;
    let maximumActive = 0;
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockImplementation((noteId) => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      releases.set(noteId, () => { active -= 1; resolve(saved(8)); });
    }));
    const { controller } = setup(saveNote);

    const first = controller.flush(localDraft({ noteId: 'note-1', clientMutationId: 'one' }));
    const secondSameNote = controller.flush(localDraft({ noteId: 'note-1', clientMutationId: 'two' }));
    const otherNote = controller.flush(localDraft({ noteId: 'note-2', clientMutationId: 'three' }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(2);
    releases.get('note-1')?.();
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(3));
    releases.get('note-1')?.();
    releases.get('note-2')?.();
    await Promise.all([first, secondSameNote, otherNote]);
  });

  it('does not delete a newer edit when an older request is acknowledged', async () => {
    let release: ((result: ApiResult<SaveNoteSuccess>) => void) | undefined;
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(saved(9));
    const { controller, store } = setup(saveNote);

    const oldSave = controller.flush(localDraft({ clientMutationId: 'old', title: '旧内容' }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    const newSave = controller.flush(localDraft({ clientMutationId: 'new', title: '新内容' }));
    release?.(saved(8));
    await oldSave;
    expect(await store.getDraft('note-1')).toMatchObject({ title: '新内容', clientMutationId: 'new', baseVersion: 8 });
    await newSave;
    expect(saveNote.mock.calls[1]?.[1]).toMatchObject({ title: '新内容', baseVersion: 8 });
  });

  it('removes timers and online listeners when disposed', async () => {
    vi.useFakeTimers();
    const { controller, events, saveNote } = setup();
    await controller.schedule(localDraft());

    controller.dispose();
    events.emit();
    await vi.runAllTimersAsync();

    expect(events.listeners.size).toBe(0);
    expect(saveNote).not.toHaveBeenCalled();
  });
});
