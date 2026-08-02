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
  async markConflict(userId: string, clientMutationId: string, conflictAt: string, serverVersion: number) {
    const mutation = this.mutations.get(clientMutationId);
    if (mutation?.userId === userId) {
      this.mutations.set(clientMutationId, { ...mutation, state: 'conflict', conflictAt, serverVersion });
    }
  }
  async resetConflict(userId: string, clientMutationId: string, baseVersion: number) {
    const mutation = this.mutations.get(clientMutationId);
    if (mutation?.userId === userId) {
      this.mutations.set(clientMutationId, {
        ...mutation,
        state: 'pending',
        baseVersion,
        conflictAt: undefined,
        serverVersion: undefined,
      });
      const draft = this.drafts.get(mutation.noteId);
      if (draft?.userId === userId && draft.clientMutationId === clientMutationId) {
        this.drafts.set(draft.noteId, { ...draft, baseVersion });
      }
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
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const localDraft = (overrides: Partial<EditableNoteDraft> = {}): EditableNoteDraft => ({
  noteId: 'note-1',
  content: doc('轮转调度'),
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
  it('warns without deleting foreign drafts until account switch is confirmed', async () => {
    const persistence = new MemoryPersistence();
    const store = new NotesDraftStore(persistence);
    await store.activateUser('opaque-user-a');
    await store.persist(localDraft());

    await store.activateUser(null);
    expect(await store.getDraft('note-1')).toBeUndefined();
    expect(await store.listMutations()).toEqual([]);

    const state = await store.activateUser('opaque-user-b');
    expect(state).toMatchObject({
      kind: 'account-changed',
      warningRequired: true,
      foreignDraftCount: 1,
      foreignMutationCount: 1,
    });
    expect(state).not.toHaveProperty('clearedDraftCount');
    expect(await store.getDraft('note-1')).toBeUndefined();
    expect([...persistence.drafts.values()]).toHaveLength(1);
    expect([...persistence.drafts.values()][0]?.userId).toBe('opaque-user-a');

    await store.confirmAccountSwitch();
    expect([...persistence.drafts.values()]).toEqual([]);
    expect([...persistence.mutations.values()]).toEqual([]);
    expect(await store.getDraft('note-1')).toBeUndefined();
  });

  it('blocks reads and replay while an account switch awaits confirmation', async () => {
    const persistence = new MemoryPersistence();
    const firstStore = new NotesDraftStore(persistence);
    await firstStore.activateUser('opaque-user-a');
    await firstStore.persist(localDraft());
    const reloadedStore = new NotesDraftStore(persistence);
    const state = await reloadedStore.activateUser('opaque-user-b');
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(8));
    const controller = new NotesAutosaveController({
      store: reloadedStore,
      client: { saveNote },
      userId: 'opaque-user-b',
    });

    expect(state.warningRequired).toBe(true);
    expect(await reloadedStore.getDraft('note-1')).toBeUndefined();
    await controller.initialize();
    expect(saveNote).not.toHaveBeenCalled();
    expect([...persistence.drafts.values()]).toHaveLength(1);

    await controller.confirmAccountSwitch();
    await controller.flush(localDraft({ clientMutationId: 'user-b-mutation' }));
    expect(saveNote).toHaveBeenCalledTimes(1);
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
      expect(persistence.drafts.get('note-1')?.content).toEqual(doc('轮转调度'));
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
    await controller.schedule(localDraft({ content: doc('最新正文'), clientMutationId: 'mutation-2' }));
    await vi.advanceTimersByTimeAsync(1499);
    expect(saveNote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote.mock.calls[0]?.[1]).toMatchObject({ content: doc('最新正文'), clientMutationId: 'mutation-2' });
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
    expect(await store.getMutation('mutation-1')).toMatchObject({
      state: 'conflict',
      serverVersion: 8,
    });
    expect(await store.listMutations()).toEqual([]);
  });

  it('persists conflict blocking across controller and store recreation', async () => {
    const persistence = new MemoryPersistence();
    const firstStore = new NotesDraftStore(persistence);
    const conflictClient = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue({
      success: false,
      status: 409,
      code: 'note_version_conflict',
      error: '版本冲突',
      serverVersion: 8,
      serverNote: saved(8).note,
    });
    const firstController = new NotesAutosaveController({
      store: firstStore,
      client: { saveNote: conflictClient },
      userId: 'opaque-user-a',
    });
    await firstController.flush(localDraft());
    firstController.dispose();

    const reloadedStore = new NotesDraftStore(persistence);
    const replayClient = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(9));
    const reloadedController = new NotesAutosaveController({
      store: reloadedStore,
      client: { saveNote: replayClient },
      userId: 'opaque-user-a',
    });
    await reloadedController.initialize();

    expect(replayClient).not.toHaveBeenCalled();
    expect(await reloadedStore.getDraft('note-1')).toBeTruthy();
    expect(await reloadedStore.getMutation('mutation-1')).toMatchObject({ state: 'conflict' });
  });

  it('replays a conflict only after explicit resolution resets its base version', async () => {
    const { persistence, store, controller, saveNote } = setup();
    persistence.drafts.set('note-1', {
      userId: 'opaque-user-a', noteId: 'note-1', content: doc('本地正文'), baseVersion: 7,
      clientMutationId: 'mutation-1', createdAt: now(), updatedAt: now(),
    });
    persistence.mutations.set('mutation-1', {
      ...persistence.drafts.get('note-1')!, state: 'conflict', conflictAt: now(), serverVersion: 8,
    });
    await store.activateUser('opaque-user-a');

    await controller.initialize();
    expect(saveNote).not.toHaveBeenCalled();
    await store.resolveConflict('mutation-1', { kind: 'retry', baseVersion: 8 });
    saveNote.mockResolvedValue(saved(9));
    await controller.resume();

    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote.mock.calls[0]?.[1]).toMatchObject({ baseVersion: 8 });
  });

  it('stores no title or derived plaintext and sends no client contentText', async () => {
    const { persistence, controller, saveNote } = setup();
    saveNote.mockRejectedValue(new TypeError('offline'));

    await controller.flush({
      ...localDraft(),
      title: '不得落盘的标题',
      contentText: '不得落盘的纯文本',
    } as EditableNoteDraft);

    const draft = persistence.drafts.get('note-1') as unknown as Record<string, unknown> | undefined;
    const mutation = persistence.mutations.get('mutation-1') as unknown as Record<string, unknown> | undefined;
    expect(draft).not.toHaveProperty('title');
    expect(draft).not.toHaveProperty('contentText');
    expect(mutation).not.toHaveProperty('title');
    expect(mutation).not.toHaveProperty('contentText');
    expect(saveNote.mock.calls[0]?.[1]).not.toHaveProperty('title');
    expect(saveNote.mock.calls[0]?.[1]).not.toHaveProperty('contentText');
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

    const oldSave = controller.flush(localDraft({ clientMutationId: 'old', content: doc('旧内容') }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    const newSave = controller.flush(localDraft({ clientMutationId: 'new', content: doc('新内容') }));
    release?.(saved(8));
    await oldSave;
    expect(await store.getDraft('note-1')).toMatchObject({ content: doc('新内容'), clientMutationId: 'new', baseVersion: 8 });
    await newSave;
    expect(saveNote.mock.calls[1]?.[1]).toMatchObject({ content: doc('新内容'), baseVersion: 8 });
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
