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
  | { kind: 'permanent-error'; noteId: string; status: number; code?: string; error: string }
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
  private readonly localOperationChains = new Map<string, Promise<void>>();
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

  schedule(draft: EditableNoteDraft) {
    return this.runLocalOperation(draft.noteId, async () => {
      if (this.disposed) return;
      const previous = this.cancelScheduled(draft.noteId);
      if (this.acknowledgedMutationIds.has(draft.clientMutationId)) {
        await this.discardSuperseded(previous, draft.clientMutationId);
        return;
      }
      if (!await this.persistDraft(draft)) return;
      await this.discardSuperseded(previous, draft.clientMutationId);
      if (this.disposed) return;
      const handle = setTimeout(() => {
        const scheduled = this.scheduled.get(draft.noteId);
        if (scheduled?.mutationId !== draft.clientMutationId) return;
        this.scheduled.delete(draft.noteId);
        void this.enqueue(draft.noteId, draft.clientMutationId);
      }, this.debounceMs);
      this.scheduled.set(draft.noteId, { handle, mutationId: draft.clientMutationId });
    });
  }

  flush(draft: EditableNoteDraft): Promise<AutosaveResult> {
    if (this.disposed) return Promise.resolve({ kind: 'disposed', noteId: draft.noteId });
    return this.runLocalOperation<AutosaveResult | undefined>(draft.noteId, async () => {
      if (this.disposed) return { kind: 'disposed', noteId: draft.noteId };
      const previous = this.cancelScheduled(draft.noteId);
      if (this.acknowledgedMutationIds.has(draft.clientMutationId)) {
        await this.discardSuperseded(previous, draft.clientMutationId);
        return {
          kind: 'saved',
          noteId: draft.noteId,
          resultingVersion: draft.baseVersion + 1,
          idempotent: true,
        };
      }
      if (!await this.persistDraft(draft)) {
        return { kind: 'queued', noteId: draft.noteId, reason: 'account-switch-required' };
      }
      await this.discardSuperseded(previous, draft.clientMutationId);
      return undefined;
    }).then((result) => result ?? this.enqueue(draft.noteId, draft.clientMutationId));
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
    if (mutation.state === 'rejected') {
      return {
        kind: 'permanent-error',
        noteId,
        status: mutation.status ?? 400,
        code: mutation.errorCode,
        error: '请求无法自动重试',
      };
    }
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
        await this.runLocalOperation(noteId, () => this.store.markNoteConflict(noteId, response.serverVersion));
        return {
          kind: 'conflict',
          noteId,
          serverVersion: response.serverVersion,
          serverNote: response.serverNote,
        };
      }
      if (isPermanentClientFailure(response.status)) {
        const status = response.status;
        await this.runLocalOperation(
          noteId,
          () => this.store.markRejected(mutation.clientMutationId, status, response.code),
        );
        return {
          kind: 'permanent-error',
          noteId,
          status,
          code: response.code,
          error: response.error,
        };
      }
      return {
        kind: 'queued',
        noteId,
        reason: response.status !== undefined ? 'server' : 'offline',
      };
    }
    if (response.resultingVersion !== mutation.baseVersion + 1) {
      return { kind: 'queued', noteId, reason: 'version-mismatch' };
    }
    const acknowledged = await this.runLocalOperation(
      noteId,
      () => this.store.acknowledge(mutation, response.resultingVersion),
    );
    if (!acknowledged) return { kind: 'queued', noteId, reason: 'version-mismatch' };
    this.acknowledgedMutationIds.add(mutation.clientMutationId);
    return {
      kind: 'saved',
      noteId,
      resultingVersion: response.resultingVersion,
      idempotent: response.idempotent,
    };
  }

  private async persistDraft(draft: EditableNoteDraft) {
    const account = await this.ensureInitialized();
    if (this.disposed || account.warningRequired) return false;
    await this.store.persist(draft);
    return true;
  }

  private runLocalOperation<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.localOperationChains.get(noteId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.localOperationChains.set(noteId, tail);
    void tail.finally(() => {
      if (this.localOperationChains.get(noteId) === tail) this.localOperationChains.delete(noteId);
    });
    return current;
  }

  private cancelScheduled(noteId: string) {
    const scheduled = this.scheduled.get(noteId);
    if (!scheduled) return undefined;
    clearTimeout(scheduled.handle);
    this.scheduled.delete(noteId);
    return scheduled;
  }

  private async discardSuperseded(scheduled: ScheduledSave | undefined, currentMutationId: string) {
    if (scheduled && scheduled.mutationId !== currentMutationId) {
      await this.store.discardMutation(scheduled.mutationId);
    }
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

function isPermanentClientFailure(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function browserOnlineEvents(): OnlineEventSource | undefined {
  return typeof window === 'undefined' ? undefined : window;
}
