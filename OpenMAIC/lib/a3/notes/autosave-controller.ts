import type {
  AccountActivation,
  NotesDraftStore,
  PendingNoteMutation,
  PersistableNoteDraft,
} from './draft-store';
import type { ApiResult, NoteConflict, SaveNoteInput, SaveNoteSuccess } from './types';

export type EditableNoteDraft = PersistableNoteDraft;

export interface AutosaveNotesClient {
  saveNote(
    noteId: string,
    input: SaveNoteInput,
    options?: { signal?: AbortSignal },
  ): Promise<ApiResult<SaveNoteSuccess>>;
}

export interface OnlineEventSource {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
}

export type AutosaveResult =
  | { kind: 'saved'; noteId: string; resultingVersion: number; idempotent: boolean }
  | { kind: 'queued'; noteId: string; reason: 'offline' | 'server' | 'conflict-blocked' | 'version-mismatch' | 'account-switch-required' }
  | { kind: 'conflict'; noteId: string; serverVersion: number; serverNote: NoteConflict['serverNote'] }
  | { kind: 'disposed'; noteId: string };

interface NotesAutosaveControllerOptions {
  store: NotesDraftStore;
  client: AutosaveNotesClient;
  userId: string;
  debounceMs?: number;
  onlineEvents?: OnlineEventSource;
}

interface ScheduledSave {
  handle: ReturnType<typeof setTimeout>;
  mutationId: string;
}

export class NotesAutosaveController {
  private readonly store: NotesDraftStore;
  private readonly client: AutosaveNotesClient;
  private readonly userId: string;
  private readonly debounceMs: number;
  private readonly onlineEvents?: OnlineEventSource;
  private readonly scheduled = new Map<string, ScheduledSave>();
  private readonly chains = new Map<string, Promise<AutosaveResult>>();
  private readonly persistenceChains = new Map<string, Promise<boolean>>();
  private readonly activeRequests = new Set<AbortController>();
  private readonly acknowledgedMutationIds = new Set<string>();
  private initialization?: Promise<AccountActivation>;
  private replay?: Promise<AutosaveResult[]>;
  private disposed = false;

  constructor(options: NotesAutosaveControllerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.userId = options.userId;
    this.debounceMs = options.debounceMs ?? 1500;
    this.onlineEvents = options.onlineEvents ?? browserOnlineEvents();
    this.onlineEvents?.addEventListener('online', this.handleOnline);
  }

  async initialize() {
    const account = await this.ensureInitialized();
    const replay = account.warningRequired ? [] : await this.resume();
    return { account, replay };
  }

  async confirmAccountSwitch() {
    const account = await this.store.confirmAccountSwitch();
    this.initialization = Promise.resolve(account);
    const replay = await this.resume();
    return { account, replay };
  }

  async schedule(draft: EditableNoteDraft) {
    if (this.disposed) return;
    if (this.acknowledgedMutationIds.has(draft.clientMutationId)) return;
    if (!await this.persistDraft(draft)) return;
    const previous = this.scheduled.get(draft.noteId);
    if (previous) {
      clearTimeout(previous.handle);
      if (previous.mutationId !== draft.clientMutationId) await this.store.discardMutation(previous.mutationId);
    }
    const handle = setTimeout(() => {
      this.scheduled.delete(draft.noteId);
      void this.enqueue(draft.noteId, draft.clientMutationId);
    }, this.debounceMs);
    this.scheduled.set(draft.noteId, { handle, mutationId: draft.clientMutationId });
  }

  flush(draft: EditableNoteDraft): Promise<AutosaveResult> {
    if (this.disposed) return Promise.resolve({ kind: 'disposed', noteId: draft.noteId });
    if (this.acknowledgedMutationIds.has(draft.clientMutationId)) {
      return Promise.resolve({ kind: 'saved', noteId: draft.noteId, resultingVersion: draft.baseVersion + 1, idempotent: true });
    }
    return this.persistDraft(draft).then((persisted) => persisted
      ? this.enqueue(draft.noteId, draft.clientMutationId)
      : { kind: 'queued', noteId: draft.noteId, reason: 'account-switch-required' });
  }

  async resume(): Promise<AutosaveResult[]> {
    if (this.disposed) return [];
    const account = await this.ensureInitialized();
    if (account.warningRequired) return [];
    if (this.replay) return this.replay;
    this.replay = (async () => {
      const results: AutosaveResult[] = [];
      for (const mutation of await this.store.listMutations()) {
        if (this.disposed) break;
        results.push(await this.enqueue(mutation.noteId, mutation.clientMutationId));
      }
      return results;
    })().finally(() => {
      this.replay = undefined;
    });
    return this.replay;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.scheduled.values()) clearTimeout(item.handle);
    this.scheduled.clear();
    for (const request of this.activeRequests) request.abort();
    this.activeRequests.clear();
    this.onlineEvents?.removeEventListener('online', this.handleOnline);
  }

  private readonly handleOnline = () => {
    if (!this.disposed) void this.resume();
  };

  private async ensureInitialized() {
    if (!this.initialization) {
      this.initialization = this.store.activateUser(this.userId);
    }
    return this.initialization;
  }

  private enqueue(noteId: string, mutationId: string) {
    const previous = this.chains.get(noteId);
    const current = (previous ? previous.catch(() => ({ kind: 'queued', noteId, reason: 'offline' } as const)) : Promise.resolve())
      .then(() => this.send(noteId, mutationId));
    this.chains.set(noteId, current);
    void current.finally(() => {
      if (this.chains.get(noteId) === current) this.chains.delete(noteId);
    });
    return current;
  }

  private async send(noteId: string, mutationId: string): Promise<AutosaveResult> {
    if (this.disposed) return { kind: 'disposed', noteId };
    if (this.acknowledgedMutationIds.has(mutationId)) {
      const mutation = await this.store.getMutation(mutationId);
      return {
        kind: 'saved',
        noteId,
        resultingVersion: (mutation?.baseVersion ?? 0) + 1,
        idempotent: true,
      };
    }
    const mutation = await this.store.getMutation(mutationId);
    if (!mutation) return { kind: 'saved', noteId, resultingVersion: 0, idempotent: true };
    if (mutation.state === 'conflict') return { kind: 'queued', noteId, reason: 'conflict-blocked' };
    const abortController = new AbortController();
    this.activeRequests.add(abortController);
    let response: ApiResult<SaveNoteSuccess>;
    try {
      response = await this.client.saveNote(noteId, requestFromMutation(mutation), { signal: abortController.signal });
    } catch (error) {
      if (this.disposed || isAbortError(error)) return { kind: 'disposed', noteId };
      return { kind: 'queued', noteId, reason: 'offline' };
    } finally {
      this.activeRequests.delete(abortController);
    }
    if (!response.success) {
      if (isConflict(response)) {
        await this.store.markConflict(mutation.clientMutationId, response.serverVersion);
        return {
          kind: 'conflict',
          noteId,
          serverVersion: response.serverVersion,
          serverNote: response.serverNote,
        };
      }
      return { kind: 'queued', noteId, reason: response.status && response.status >= 500 ? 'server' : 'offline' };
    }
    if (response.resultingVersion !== mutation.baseVersion + 1) {
      return { kind: 'queued', noteId, reason: 'version-mismatch' };
    }
    await this.persistenceChains.get(noteId);
    await this.store.acknowledge(mutation, response.resultingVersion);
    this.acknowledgedMutationIds.add(mutation.clientMutationId);
    return {
      kind: 'saved',
      noteId,
      resultingVersion: response.resultingVersion,
      idempotent: response.idempotent,
    };
  }

  private persistDraft(draft: EditableNoteDraft) {
    const previous = this.persistenceChains.get(draft.noteId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const account = await this.ensureInitialized();
        if (!this.disposed && !account.warningRequired) {
          await this.store.persist(draft);
          return true;
        }
        return false;
      });
    this.persistenceChains.set(draft.noteId, current);
    void current.finally(() => {
      if (this.persistenceChains.get(draft.noteId) === current) this.persistenceChains.delete(draft.noteId);
    });
    return current;
  }
}

function requestFromMutation(mutation: PendingNoteMutation): SaveNoteInput {
  return {
    content: mutation.content,
    baseVersion: mutation.baseVersion,
    clientMutationId: mutation.clientMutationId,
  };
}

function isConflict(result: Exclude<ApiResult<SaveNoteSuccess>, { success: true }>): result is NoteConflict {
  return result.status === 409
    && result.code === 'note_version_conflict'
    && typeof (result as Partial<NoteConflict>).serverVersion === 'number'
    && typeof (result as Partial<NoteConflict>).serverNote === 'object';
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function browserOnlineEvents(): OnlineEventSource | undefined {
  return typeof window === 'undefined' ? undefined : window;
}
