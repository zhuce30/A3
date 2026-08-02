import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import {
  NotesDraftDatabase,
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
  acknowledgeAndRebaseCalls = 0;

  async allDrafts() { return [...this.drafts.values()]; }
  async allMutations() { return [...this.mutations.values()]; }
  async getDraft(noteId: string) { return this.drafts.get(noteId); }
  async getMutation(clientMutationId: string) { return this.mutations.get(clientMutationId); }
  async putDraftAndMutation(draft: NoteDraft, mutation: PendingNoteMutation) {
    const block = [...this.mutations.values()].find(
      (item) => item.userId === mutation.userId && item.noteId === mutation.noteId && item.state === 'conflict',
    );
    this.drafts.set(draft.noteId, structuredClone(draft));
    this.mutations.set(mutation.clientMutationId, structuredClone(
      block && mutation.state === 'pending'
        ? { ...mutation, state: 'conflict', conflictAt: block.conflictAt, serverVersion: block.serverVersion }
        : mutation,
    ));
  }
  async deleteAccounts(userIds: string[]) {
    const ids = new Set(userIds);
    for (const [key, value] of this.drafts) if (ids.has(value.userId)) this.drafts.delete(key);
    for (const [key, value] of this.mutations) if (ids.has(value.userId)) this.mutations.delete(key);
  }
  async acknowledgeAndRebase(userId: string, mutation: PendingNoteMutation, resultingVersion: number) {
    this.acknowledgeAndRebaseCalls += 1;
    const stored = this.mutations.get(mutation.clientMutationId);
    if (
      stored?.userId !== userId
      || stored.noteId !== mutation.noteId
      || stored.createdAt !== mutation.createdAt
      || stored.baseVersion !== mutation.baseVersion
      || stored.state !== 'pending'
    ) return false;
    this.mutations.delete(mutation.clientMutationId);
    for (const [key, value] of this.mutations) {
      if (value.userId === userId && value.noteId === mutation.noteId && value.createdAt > mutation.createdAt) {
        this.mutations.set(key, { ...value, baseVersion: resultingVersion });
      }
    }
    const draft = this.drafts.get(mutation.noteId);
    if (draft?.userId === userId && draft.clientMutationId === mutation.clientMutationId) {
      this.drafts.delete(mutation.noteId);
    } else if (draft?.userId === userId) {
      this.drafts.set(draft.noteId, { ...draft, baseVersion: resultingVersion });
    }
    return true;
  }
  async markNoteConflict(userId: string, noteId: string, conflictAt: string, serverVersion: number) {
    for (const [key, mutation] of this.mutations) {
      if (mutation.userId === userId && mutation.noteId === noteId) {
        this.mutations.set(key, { ...mutation, state: 'conflict', conflictAt, serverVersion });
      }
    }
  }
  async markRejected(
    userId: string,
    clientMutationId: string,
    rejectedAt: string,
    status: number,
    errorCode?: string,
  ) {
    const mutation = this.mutations.get(clientMutationId);
    if (mutation?.userId === userId) {
      this.mutations.set(clientMutationId, {
        ...mutation,
        state: 'rejected',
        rejectedAt,
        status,
        errorCode,
      });
    }
  }
  async resolveNoteConflict(
    userId: string,
    noteId: string,
    resolution: { kind: 'retry'; baseVersion: number } | { kind: 'discard' },
  ) {
    const noteMutations = [...this.mutations.values()].filter(
      (mutation) => mutation.userId === userId && mutation.noteId === noteId && mutation.state === 'conflict',
    );
    if (resolution.kind === 'discard') {
      for (const mutation of noteMutations) this.mutations.delete(mutation.clientMutationId);
      const draft = this.drafts.get(noteId);
      if (draft?.userId === userId) this.drafts.delete(noteId);
      return noteMutations.length > 0;
    }
    for (const mutation of noteMutations) {
      this.mutations.set(mutation.clientMutationId, {
        ...mutation,
        state: 'pending',
        baseVersion: resolution.baseVersion,
        conflictAt: undefined,
        serverVersion: undefined,
      });
    }
    const draft = this.drafts.get(noteId);
    if (draft?.userId === userId) this.drafts.set(noteId, { ...draft, baseVersion: resolution.baseVersion });
    return noteMutations.length > 0;
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

  it('retries a failed store activation while deduplicating concurrent initialization', async () => {
    const persistence = new MemoryPersistence();
    const initializationFailure = new Error('IndexedDB unavailable');
    const allDrafts = vi.spyOn(persistence, 'allDrafts')
      .mockRejectedValueOnce(initializationFailure)
      .mockResolvedValue([]);
    const allMutations = vi.spyOn(persistence, 'allMutations').mockResolvedValue([]);
    const store = new NotesDraftStore(persistence);
    const controller = new NotesAutosaveController({
      store,
      client: { saveNote: vi.fn<AutosaveNotesClient['saveNote']>() },
      userId: 'opaque-user-a',
    });

    const failedAttempts = await Promise.allSettled([
      controller.initialize(),
      controller.initialize(),
    ]);

    expect(failedAttempts).toEqual([
      { status: 'rejected', reason: initializationFailure },
      { status: 'rejected', reason: initializationFailure },
    ]);
    expect(allDrafts).toHaveBeenCalledTimes(1);
    expect(allMutations).toHaveBeenCalledTimes(1);

    const retriedAttempts = await Promise.all([
      controller.initialize(),
      controller.initialize(),
    ]);

    expect(retriedAttempts).toEqual([
      { account: { kind: 'ready', warningRequired: false }, replay: [] },
      { account: { kind: 'ready', warningRequired: false }, replay: [] },
    ]);
    expect(allDrafts).toHaveBeenCalledTimes(2);
    expect(allMutations).toHaveBeenCalledTimes(3);

    await controller.initialize();
    expect(allDrafts).toHaveBeenCalledTimes(2);
    expect(allMutations).toHaveBeenCalledTimes(4);
    controller.dispose();
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

  it('publishes isolated scheduled, saving, and acknowledged lifecycle events per note', async () => {
    vi.useFakeTimers();
    const { controller, saveNote } = setup();
    const noteOneEvents: Array<{ type: string; noteId: string }> = [];
    const noteTwoEvents: Array<{ type: string; noteId: string }> = [];
    const unsubscribe = controller.subscribe('note-1', (event) => noteOneEvents.push(event));
    controller.subscribe('note-2', (event) => noteTwoEvents.push(event));

    await controller.schedule(localDraft());
    await controller.schedule(localDraft({ noteId: 'note-2', clientMutationId: 'mutation-2' }));
    expect(noteOneEvents.map((event) => event.type)).toEqual(['scheduled']);
    expect(noteTwoEvents.map((event) => event.type)).toEqual(['scheduled']);

    await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(noteOneEvents.map((event) => event.type)).toEqual(['scheduled', 'saving', 'saved']));
    expect(noteOneEvents.every((event) => event.noteId === 'note-1')).toBe(true);
    expect(noteTwoEvents.every((event) => event.noteId === 'note-2')).toBe(true);

    unsubscribe();
    await controller.schedule(localDraft({ clientMutationId: 'mutation-3' }));
    expect(noteOneEvents.map((event) => event.type)).toEqual(['scheduled', 'saving', 'saved']);
  });

  it('publishes the server note on 409 and removes every subscriber on dispose', async () => {
    const serverNote = saved(8).note;
    const conflictingDraft = localDraft({ content: doc('触发冲突的本地正文') });
    const conflictClient = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue({
      success: false,
      status: 409,
      code: 'note_version_conflict',
      error: '版本冲突',
      serverVersion: 8,
      serverNote,
    });
    const { controller } = setup(conflictClient);
    const events: unknown[] = [];
    controller.subscribe('note-1', (event) => events.push(event));

    await controller.flush(conflictingDraft);
    expect(events).toContainEqual({ type: 'saving', noteId: 'note-1', clientMutationId: 'mutation-1' });
    expect(events).toContainEqual({
      type: 'conflict',
      noteId: 'note-1',
      serverVersion: 8,
      serverNote,
      draft: conflictingDraft,
    });

    controller.dispose();
    await controller.schedule(localDraft({ clientMutationId: 'after-dispose' }));
    expect(events).toHaveLength(2);
  });

  it('publishes retryable failures as offline and permanent failures as rejected', async () => {
    const retryable = setup(vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue({
      success: false, status: 503, code: 'unavailable', error: '稍后重试',
    }));
    const retryableEvents: unknown[] = [];
    retryable.controller.subscribe('note-1', (event) => retryableEvents.push(event));
    await retryable.controller.flush(localDraft());
    expect(retryableEvents.at(-1)).toEqual({ type: 'offline', noteId: 'note-1', reason: 'server' });

    const rejected = setup(vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue({
      success: false, status: 422, code: 'invalid_note', error: '内容不可保存',
    }));
    const rejectedEvents: unknown[] = [];
    rejected.controller.subscribe('note-1', (event) => rejectedEvents.push(event));
    await rejected.controller.flush(localDraft());
    expect(rejectedEvents.at(-1)).toEqual({
      type: 'rejected', noteId: 'note-1', status: 422, code: 'invalid_note', error: '内容不可保存',
    });
  });

  it('serializes concurrent schedules and leaves only the newest mutation replayable', async () => {
    vi.useFakeTimers();
    const persistence = new MemoryPersistence();
    const originalPut = persistence.putDraftAndMutation.bind(persistence);
    let releaseFirstPut: (() => void) | undefined;
    const firstPutBlocked = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
    const put = vi.spyOn(persistence, 'putDraftAndMutation').mockImplementation(async (draft, mutation) => {
      if (mutation.clientMutationId === 'concurrent-old') await firstPutBlocked;
      await originalPut(draft, mutation);
    });
    const store = new NotesDraftStore(persistence);
    const firstSave = vi.fn<AutosaveNotesClient['saveNote']>().mockRejectedValue(new TypeError('offline'));
    const controller = new NotesAutosaveController({
      store,
      client: { saveNote: firstSave },
      userId: 'opaque-user-a',
    });

    const oldSchedule = controller.schedule(localDraft({
      clientMutationId: 'concurrent-old',
      content: doc('old concurrent content'),
    }));
    const newSchedule = controller.schedule(localDraft({
      clientMutationId: 'concurrent-new',
      content: doc('new concurrent content'),
    }));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    releaseFirstPut?.();
    await Promise.all([oldSchedule, newSchedule]);
    await vi.advanceTimersByTimeAsync(1500);

    expect(firstSave).toHaveBeenCalledTimes(1);
    expect([...persistence.mutations.keys()]).toEqual(['concurrent-new']);
    controller.dispose();

    const replaySave = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(8));
    const reloaded = new NotesAutosaveController({
      store: new NotesDraftStore(persistence),
      client: { saveNote: replaySave },
      userId: 'opaque-user-a',
    });
    await reloaded.initialize();

    expect(replaySave).toHaveBeenCalledTimes(1);
    expect(replaySave.mock.calls[0]?.[1]).toMatchObject({ clientMutationId: 'concurrent-new' });
    reloaded.dispose();
  });

  it('persists a scheduled edit while the previous network request is in flight', async () => {
    let releaseRequest: ((result: ApiResult<SaveNoteSuccess>) => void) | undefined;
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockImplementation(
      () => new Promise((resolve) => { releaseRequest = resolve; }),
    );
    const { controller, persistence } = setup(saveNote);
    const inFlight = controller.flush(localDraft({ clientMutationId: 'in-flight' }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));

    const scheduling = controller.schedule(localDraft({
      clientMutationId: 'edit-during-flight',
      content: doc('content persisted during request'),
    }));
    await vi.waitFor(() => expect(persistence.mutations.has('edit-during-flight')).toBe(true));
    await scheduling;

    expect(persistence.drafts.get('note-1')?.clientMutationId).toBe('edit-during-flight');
    releaseRequest?.(saved(8));
    await inFlight;
    controller.dispose();
  });

  it('cancels a scheduled ghost save when a newer explicit flush supersedes it', async () => {
    vi.useFakeTimers();
    const { controller, persistence, saveNote } = setup();
    await controller.schedule(localDraft({ clientMutationId: 'scheduled-old', content: doc('旧定时内容') }));

    await controller.flush(localDraft({ clientMutationId: 'explicit-new', content: doc('显式新内容') }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(saveNote.mock.calls[0]?.[1]).toMatchObject({ clientMutationId: 'explicit-new' });
    expect(persistence.mutations.has('scheduled-old')).toBe(false);
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

  it('blocks later same-note edits durably after a 409 and across controller recreation', async () => {
    const persistence = new MemoryPersistence();
    const store = new NotesDraftStore(persistence);
    let releaseConflict: ((result: ApiResult<SaveNoteSuccess>) => void) | undefined;
    const firstClient = vi.fn<AutosaveNotesClient['saveNote']>().mockImplementation(
      () => new Promise((resolve) => { releaseConflict = resolve; }),
    );
    const controller = new NotesAutosaveController({ store, client: { saveNote: firstClient }, userId: 'opaque-user-a' });
    const conflicting = controller.flush(localDraft({ clientMutationId: 'conflicting-old' }));
    await vi.waitFor(() => expect(firstClient).toHaveBeenCalledTimes(1));
    const currentLater = controller.flush(localDraft({ clientMutationId: 'current-later', content: doc('请求中的编辑') }));
    releaseConflict?.({
      success: false,
      status: 409,
      code: 'note_version_conflict',
      error: '版本冲突',
      serverVersion: 8,
      serverNote: saved(8).note,
    });
    await conflicting;
    expect(await currentLater).toMatchObject({ kind: 'queued', reason: 'conflict-blocked' });
    expect(await store.getMutation('current-later')).toMatchObject({ state: 'conflict', serverVersion: 8 });

    const later = await controller.flush(localDraft({ clientMutationId: 'later-edit', content: doc('冲突后的编辑') }));
    expect(later).toMatchObject({ kind: 'queued', reason: 'conflict-blocked' });
    expect(firstClient).toHaveBeenCalledTimes(1);
    expect(await store.getMutation('later-edit')).toMatchObject({ state: 'conflict', serverVersion: 8 });
    controller.dispose();

    const reloadedStore = new NotesDraftStore(persistence);
    const replayClient = vi.fn<AutosaveNotesClient['saveNote']>()
      .mockResolvedValueOnce(saved(9))
      .mockResolvedValueOnce(saved(10))
      .mockResolvedValueOnce(saved(11));
    const reloaded = new NotesAutosaveController({
      store: reloadedStore,
      client: { saveNote: replayClient },
      userId: 'opaque-user-a',
    });
    await reloaded.initialize();
    expect(replayClient).not.toHaveBeenCalled();

    await reloadedStore.resolveNoteConflict('note-1', { kind: 'retry', baseVersion: 8 });
    await reloaded.resume();
    expect(replayClient).toHaveBeenCalled();
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
    await store.resolveNoteConflict('note-1', { kind: 'retry', baseVersion: 8 });
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

  it.each([400, 401, 403, 404, 422])('persists HTTP %s as rejected and never replays it online or after reload', async (status) => {
    const persistence = new MemoryPersistence();
    const store = new NotesDraftStore(persistence);
    const events = new FakeOnlineEvents();
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue({
      success: false,
      status,
      code: 'request_rejected',
      error: '请求不可重试',
    });
    const controller = new NotesAutosaveController({
      store,
      client: { saveNote },
      userId: 'opaque-user-a',
      onlineEvents: events,
    });

    const result = await controller.flush(localDraft());
    expect(result).toMatchObject({ kind: 'permanent-error', status, code: 'request_rejected' });
    expect(await store.getMutation('mutation-1')).toMatchObject({ state: 'rejected', status });
    expect(await store.getDraft('note-1')).toBeTruthy();
    events.emit();
    await controller.resume();
    expect(saveNote).toHaveBeenCalledTimes(1);
    controller.dispose();

    const reloadedStore = new NotesDraftStore(persistence);
    const replayClient = vi.fn<AutosaveNotesClient['saveNote']>().mockResolvedValue(saved(8));
    const reloaded = new NotesAutosaveController({
      store: reloadedStore,
      client: { saveNote: replayClient },
      userId: 'opaque-user-a',
    });
    await reloaded.initialize();
    expect(replayClient).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500, 503])('keeps retryable HTTP %s pending', async (status) => {
    const { controller, store, saveNote } = setup();
    saveNote.mockResolvedValue({ success: false, status, code: 'retry_later', error: '稍后重试' });

    const result = await controller.flush(localDraft());

    expect(result).toMatchObject({ kind: 'queued' });
    expect(await store.getMutation('mutation-1')).toMatchObject({ state: 'pending' });
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
    const { controller, store, persistence } = setup(saveNote);

    const oldSave = controller.flush(localDraft({ clientMutationId: 'old', content: doc('旧内容') }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    const newSave = controller.flush(localDraft({ clientMutationId: 'new', content: doc('新内容') }));
    release?.(saved(8));
    await oldSave;
    expect(await store.getDraft('note-1')).toMatchObject({ content: doc('新内容'), clientMutationId: 'new', baseVersion: 8 });
    await newSave;
    expect(saveNote.mock.calls[1]?.[1]).toMatchObject({ content: doc('新内容'), baseVersion: 8 });
    expect(persistence.acknowledgeAndRebaseCalls).toBe(2);
  });

  it('keeps a rebased queued mutation version when retry receives a stale draft snapshot', async () => {
    let releaseOld: ((result: ApiResult<SaveNoteSuccess>) => void) | undefined;
    const saveNote = vi.fn<AutosaveNotesClient['saveNote']>()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }))
      .mockResolvedValueOnce(saved(9));
    const { controller, store } = setup(saveNote);
    const events: Array<{ type: string; pendingMutationId?: string }> = [];
    controller.subscribe('note-1', (event) => events.push(event));
    const oldSave = controller.flush(localDraft({ clientMutationId: 'old', content: doc('old') }));
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1));
    const staleNewDraft = localDraft({ clientMutationId: 'new', content: doc('new'), baseVersion: 7 });
    await controller.schedule(staleNewDraft);

    releaseOld?.(saved(8));
    await oldSave;

    expect(await store.getDraft('note-1')).toMatchObject({ clientMutationId: 'new', baseVersion: 8 });
    expect(events.filter((event) => event.type === 'saved')).toContainEqual(expect.objectContaining({
      type: 'saved',
      pendingMutationId: 'new',
    }));

    await controller.flush(staleNewDraft);
    expect(saveNote.mock.calls[1]?.[1]).toMatchObject({ clientMutationId: 'new', baseVersion: 8 });
    controller.dispose();
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

describe('personal notes Dexie migration', () => {
  it('upgrades v1 records to version 2 and strips every non-allowlisted field', async () => {
    const indexedDB = new IDBFactory();
    const databaseName = `a3-notes-migration-${crypto.randomUUID()}`;
    const options = { indexedDB, IDBKeyRange };
    const legacy = new Dexie(databaseName, options);
    legacy.version(1).stores({
      drafts: 'noteId,userId,updatedAt',
      mutations: 'clientMutationId,userId,noteId,createdAt',
    });
    await legacy.open();
    const content = doc('迁移后保留');
    const base = {
      userId: 'opaque-user-a', noteId: 'note-1', content, baseVersion: 3,
      clientMutationId: 'legacy-mutation', createdAt: now(), updatedAt: now(),
      title: '必须移除', contentText: '必须移除', unknownSecret: '必须移除',
    };
    await legacy.table('drafts').put(base);
    await legacy.table('mutations').put({ ...base, state: 'pending', extraMetadata: { secret: true } });
    legacy.close();

    const upgraded = new NotesDraftDatabase(databaseName, options);
    await upgraded.open();
    const draft = await upgraded.drafts.get('note-1');
    const mutation = await upgraded.mutations.get('legacy-mutation');

    expect(upgraded.verno).toBe(2);
    expect(draft?.content).toEqual(content);
    expect(Object.keys(draft ?? {}).sort()).toEqual([
      'baseVersion', 'clientMutationId', 'content', 'createdAt', 'noteId', 'updatedAt', 'userId',
    ]);
    expect(Object.keys(mutation ?? {}).sort()).toEqual([
      'baseVersion', 'clientMutationId', 'content', 'createdAt', 'noteId', 'state', 'updatedAt', 'userId',
    ]);
    upgraded.close();

    const reopened = new NotesDraftDatabase(databaseName, options);
    await reopened.open();
    expect(await reopened.drafts.get('note-1')).toEqual(draft);
    expect(await reopened.mutations.get('legacy-mutation')).toEqual(mutation);
    await reopened.delete();
  });
});
