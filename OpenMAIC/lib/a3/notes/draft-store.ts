import Dexie, { type DexieOptions, type Table } from 'dexie';

import type { NoteContent } from './types';

export interface NoteDraft {
  userId: string;
  noteId: string;
  content: NoteContent;
  baseVersion: number;
  clientMutationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingNoteMutation extends NoteDraft {
  state: 'pending' | 'conflict' | 'rejected';
  conflictAt?: string;
  serverVersion?: number;
  rejectedAt?: string;
  status?: number;
  errorCode?: string;
}

export interface PersistableNoteDraft {
  noteId: string;
  content: NoteContent;
  baseVersion: number;
  clientMutationId: string;
  updatedAt: string;
}

export type AccountActivation =
  | { kind: 'ready'; warningRequired: false }
  | { kind: 'logged-out'; warningRequired: false }
  | {
      kind: 'account-changed';
      warningRequired: true;
      foreignDraftCount: number;
      foreignMutationCount: number;
    };

export interface NotesDraftPersistence {
  allDrafts(): Promise<NoteDraft[]>;
  allMutations(): Promise<PendingNoteMutation[]>;
  getDraft(noteId: string): Promise<NoteDraft | undefined>;
  getMutation(clientMutationId: string): Promise<PendingNoteMutation | undefined>;
  putDraftAndMutation(draft: NoteDraft, mutation: PendingNoteMutation): Promise<void>;
  deleteAccounts(userIds: string[]): Promise<void>;
  acknowledgeAndRebase(userId: string, mutation: PendingNoteMutation, resultingVersion: number): Promise<boolean>;
  markNoteConflict(userId: string, noteId: string, conflictAt: string, serverVersion: number): Promise<void>;
  markRejected(
    userId: string,
    clientMutationId: string,
    rejectedAt: string,
    status: number,
    errorCode?: string,
  ): Promise<void>;
  resolveNoteConflict(
    userId: string,
    noteId: string,
    resolution: { kind: 'retry'; baseVersion: number } | { kind: 'discard' },
  ): Promise<boolean>;
  discardMutation(clientMutationId: string): Promise<void>;
  clear(): Promise<void>;
}

export class NotesDraftDatabase extends Dexie {
  drafts!: Table<NoteDraft, string>;
  mutations!: Table<PendingNoteMutation, string>;

  constructor(name = 'a3-personal-notes', options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      drafts: 'noteId,userId,updatedAt',
      mutations: 'clientMutationId,userId,noteId,createdAt',
    });
    this.version(2).stores({
      drafts: 'noteId,userId,updatedAt',
      mutations: 'clientMutationId,userId,noteId,createdAt',
    }).upgrade(async (transaction) => {
      const drafts = transaction.table('drafts');
      const mutations = transaction.table('mutations');
      const legacyDrafts = await drafts.toArray() as unknown[];
      const legacyMutations = await mutations.toArray() as unknown[];
      await drafts.clear();
      await mutations.clear();
      await drafts.bulkPut(legacyDrafts.map(sanitizeDraftRecord));
      await mutations.bulkPut(legacyMutations.map(sanitizeMutationRecord));
    });
  }
}

export class DexieNotesDraftPersistence implements NotesDraftPersistence {
  constructor(private readonly database = new NotesDraftDatabase()) {}

  allDrafts() { return this.database.drafts.toArray(); }
  allMutations() { return this.database.mutations.toArray(); }
  getDraft(noteId: string) { return this.database.drafts.get(noteId); }
  getMutation(clientMutationId: string) { return this.database.mutations.get(clientMutationId); }

  async putDraftAndMutation(draft: NoteDraft, mutation: PendingNoteMutation) {
    await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      await this.database.drafts.put(draft);
      const noteMutations = await this.database.mutations.where('noteId').equals(mutation.noteId).toArray();
      const block = noteMutations.find(
        (item) => item.userId === mutation.userId && item.state === 'conflict',
      );
      await this.database.mutations.put(block && mutation.state === 'pending'
        ? {
            ...mutation,
            state: 'conflict',
            conflictAt: block.conflictAt,
            serverVersion: block.serverVersion,
          }
        : mutation);
    });
  }

  async deleteAccounts(userIds: string[]) {
    if (userIds.length === 0) return;
    const ids = new Set(userIds);
    await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      const drafts = await this.database.drafts.toArray();
      const mutations = await this.database.mutations.toArray();
      await this.database.drafts.bulkDelete(drafts.filter((item) => ids.has(item.userId)).map((item) => item.noteId));
      await this.database.mutations.bulkDelete(
        mutations.filter((item) => ids.has(item.userId)).map((item) => item.clientMutationId),
      );
    });
  }

  async acknowledgeAndRebase(userId: string, mutation: PendingNoteMutation, resultingVersion: number) {
    const result = await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      const stored = await this.database.mutations.get(mutation.clientMutationId);
      if (
        stored?.userId !== userId
        || stored.noteId !== mutation.noteId
        || stored.createdAt !== mutation.createdAt
        || stored.baseVersion !== mutation.baseVersion
        || stored.state !== 'pending'
      ) return false;
      const noteMutations = await this.database.mutations.where('noteId').equals(stored.noteId).toArray();
      const newer = noteMutations.filter(
        (item) => item.userId === userId && mutationOrder(item, stored) > 0,
      );
      await this.database.mutations.delete(stored.clientMutationId);
      await Promise.all(newer.map((item) => this.database.mutations.put({ ...item, baseVersion: resultingVersion })));
      const draft = await this.database.drafts.get(mutation.noteId);
      if (draft?.userId === userId && draft.clientMutationId === mutation.clientMutationId) {
        await this.database.drafts.delete(mutation.noteId);
      } else if (draft?.userId === userId) {
        await this.database.drafts.put({ ...draft, baseVersion: resultingVersion });
      }
      return true;
    });
    return result;
  }

  async markNoteConflict(userId: string, noteId: string, conflictAt: string, serverVersion: number) {
    await this.database.transaction('rw', this.database.mutations, async () => {
      const noteMutations = await this.database.mutations.where('noteId').equals(noteId).toArray();
      const pending = noteMutations.filter((item) => item.userId === userId && item.state === 'pending');
      await Promise.all(pending.map((mutation) => this.database.mutations.put({
        ...mutation,
        state: 'conflict',
        conflictAt,
        serverVersion,
      })));
    });
  }

  async markRejected(
    userId: string,
    clientMutationId: string,
    rejectedAt: string,
    status: number,
    errorCode?: string,
  ) {
    await this.database.transaction('rw', this.database.mutations, async () => {
      const mutation = await this.database.mutations.get(clientMutationId);
      if (mutation?.userId !== userId || mutation.state !== 'pending') return;
      await this.database.mutations.put({
        ...mutation,
        state: 'rejected',
        rejectedAt,
        status,
        errorCode,
      });
    });
  }

  async resolveNoteConflict(
    userId: string,
    noteId: string,
    resolution: { kind: 'retry'; baseVersion: number } | { kind: 'discard' },
  ) {
    const result = await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      const noteMutations = await this.database.mutations.where('noteId').equals(noteId).toArray();
      const conflicts = noteMutations.filter((item) => item.userId === userId && item.state === 'conflict');
      if (conflicts.length === 0) return false;
      const draft = await this.database.drafts.get(noteId);
      if (resolution.kind === 'discard') {
        await this.database.mutations.bulkDelete(conflicts.map((item) => item.clientMutationId));
        if (draft?.userId === userId) await this.database.drafts.delete(noteId);
        return true;
      }
      await Promise.all(conflicts.map((mutation) => this.database.mutations.put({
        ...mutation,
        state: 'pending',
        baseVersion: resolution.baseVersion,
        conflictAt: undefined,
        serverVersion: undefined,
      })));
      if (draft?.userId === userId) {
        await this.database.drafts.put({ ...draft, baseVersion: resolution.baseVersion });
      }
      return true;
    });
    return result;
  }

  async discardMutation(clientMutationId: string) {
    await this.database.mutations.delete(clientMutationId);
  }

  async clear() {
    await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      await this.database.drafts.clear();
      await this.database.mutations.clear();
    });
  }
}

export class NotesDraftStore {
  private userId: string | null = null;
  private pendingUserId: string | null = null;
  private pendingActivation: AccountActivation | null = null;

  constructor(private readonly persistence: NotesDraftPersistence = new DexieNotesDraftPersistence()) {}

  async activateUser(userId: string | null): Promise<AccountActivation> {
    if (!userId) {
      this.userId = null;
      this.pendingUserId = null;
      this.pendingActivation = null;
      return { kind: 'logged-out', warningRequired: false };
    }
    if (this.pendingUserId === userId && this.pendingActivation) return this.pendingActivation;
    const [drafts, mutations] = await Promise.all([
      this.persistence.allDrafts(),
      this.persistence.allMutations(),
    ]);
    const foreignUserIds = new Set<string>();
    for (const item of [...drafts, ...mutations]) if (item.userId !== userId) foreignUserIds.add(item.userId);
    const accountChanged = this.userId !== null && this.userId !== userId;
    const foreignDraftCount = drafts.filter((item) => foreignUserIds.has(item.userId)).length;
    const foreignMutationCount = mutations.filter((item) => foreignUserIds.has(item.userId)).length;
    if (accountChanged || foreignUserIds.size > 0) {
      this.userId = null;
      this.pendingUserId = userId;
      this.pendingActivation = {
        kind: 'account-changed',
        warningRequired: true,
        foreignDraftCount,
        foreignMutationCount,
      };
      return this.pendingActivation;
    }
    this.userId = userId;
    this.pendingUserId = null;
    this.pendingActivation = null;
    return { kind: 'ready', warningRequired: false };
  }

  async confirmAccountSwitch(): Promise<AccountActivation> {
    if (!this.pendingUserId) throw new Error('No pending notes account switch');
    const targetUserId = this.pendingUserId;
    const [drafts, mutations] = await Promise.all([
      this.persistence.allDrafts(),
      this.persistence.allMutations(),
    ]);
    const foreignUserIds = new Set<string>();
    for (const item of [...drafts, ...mutations]) {
      if (item.userId !== targetUserId) foreignUserIds.add(item.userId);
    }
    await this.persistence.deleteAccounts([...foreignUserIds]);
    this.userId = targetUserId;
    this.pendingUserId = null;
    this.pendingActivation = null;
    return { kind: 'ready', warningRequired: false };
  }

  async persist(input: PersistableNoteDraft) {
    const userId = this.requireUser();
    const existing = await this.persistence.getMutation(input.clientMutationId);
    const createdAt = existing?.userId === userId
      ? existing.createdAt
      : await this.uniqueCreatedAt(input.updatedAt);
    const record: NoteDraft = {
      userId,
      noteId: input.noteId,
      content: input.content,
      baseVersion: input.baseVersion,
      clientMutationId: input.clientMutationId,
      createdAt,
      updatedAt: input.updatedAt,
    };
    const retryState = existing?.userId === userId && existing.state !== 'pending'
      ? mutationRetryState(existing)
      : { state: 'pending' as const };
    await this.persistence.putDraftAndMutation(record, { ...record, ...retryState });
  }

  async getDraft(noteId: string) {
    if (!this.userId) return undefined;
    const draft = await this.persistence.getDraft(noteId);
    return draft?.userId === this.userId ? draft : undefined;
  }

  async getMutation(clientMutationId: string) {
    if (!this.userId) return undefined;
    const mutation = await this.persistence.getMutation(clientMutationId);
    return mutation?.userId === this.userId ? mutation : undefined;
  }

  async listMutations() {
    if (!this.userId) return [];
    const mutations = await this.persistence.allMutations();
    return mutations
      .filter((item) => item.userId === this.userId && item.state === 'pending')
      .sort(mutationOrder);
  }

  async acknowledge(mutation: PendingNoteMutation, resultingVersion: number) {
    const userId = this.requireUser();
    return this.persistence.acknowledgeAndRebase(userId, mutation, resultingVersion);
  }

  async discardMutation(clientMutationId: string) {
    const mutation = await this.getMutation(clientMutationId);
    if (mutation) await this.persistence.discardMutation(clientMutationId);
  }

  async markNoteConflict(noteId: string, serverVersion: number) {
    const userId = this.requireUser();
    await this.persistence.markNoteConflict(userId, noteId, new Date().toISOString(), serverVersion);
  }

  async markRejected(clientMutationId: string, status: number, errorCode?: string) {
    const userId = this.requireUser();
    await this.persistence.markRejected(userId, clientMutationId, new Date().toISOString(), status, errorCode);
  }

  async resolveNoteConflict(
    noteId: string,
    resolution: { kind: 'retry'; baseVersion: number } | { kind: 'discard' },
  ) {
    const userId = this.requireUser();
    const resolved = await this.persistence.resolveNoteConflict(userId, noteId, resolution);
    if (!resolved) throw new Error('Conflict note not found');
  }

  private requireUser() {
    if (!this.userId) throw new Error('Notes draft storage requires an authenticated user');
    return this.userId;
  }

  private async uniqueCreatedAt(candidate: string) {
    const occupied = new Set((await this.persistence.allMutations()).map((item) => item.createdAt));
    let timestamp = candidate;
    let milliseconds = Date.parse(candidate);
    while (occupied.has(timestamp)) {
      milliseconds = Number.isFinite(milliseconds) ? milliseconds + 1 : Date.now();
      timestamp = new Date(milliseconds).toISOString();
    }
    return timestamp;
  }
}

function mutationOrder(left: PendingNoteMutation, right: PendingNoteMutation) {
  return left.createdAt.localeCompare(right.createdAt) || left.clientMutationId.localeCompare(right.clientMutationId);
}

function mutationRetryState(mutation: PendingNoteMutation): Pick<
  PendingNoteMutation,
  'state' | 'conflictAt' | 'serverVersion' | 'rejectedAt' | 'status' | 'errorCode'
> {
  return {
    state: mutation.state,
    ...(mutation.conflictAt ? { conflictAt: mutation.conflictAt } : {}),
    ...(mutation.serverVersion !== undefined ? { serverVersion: mutation.serverVersion } : {}),
    ...(mutation.rejectedAt ? { rejectedAt: mutation.rejectedAt } : {}),
    ...(mutation.status !== undefined ? { status: mutation.status } : {}),
    ...(mutation.errorCode ? { errorCode: mutation.errorCode } : {}),
  };
}

function sanitizeDraftRecord(value: unknown): NoteDraft {
  const record = asRecord(value);
  return {
    userId: stringValue(record.userId),
    noteId: stringValue(record.noteId),
    content: asRecord(record.content),
    baseVersion: numberValue(record.baseVersion),
    clientMutationId: stringValue(record.clientMutationId),
    createdAt: stringValue(record.createdAt),
    updatedAt: stringValue(record.updatedAt),
  };
}

function sanitizeMutationRecord(value: unknown): PendingNoteMutation {
  const record = asRecord(value);
  const draft = sanitizeDraftRecord(record);
  const state = record.state === 'conflict' || record.state === 'rejected' ? record.state : 'pending';
  return {
    ...draft,
    state,
    ...(state === 'conflict' && typeof record.conflictAt === 'string' ? { conflictAt: record.conflictAt } : {}),
    ...(state === 'conflict' && typeof record.serverVersion === 'number' ? { serverVersion: record.serverVersion } : {}),
    ...(state === 'rejected' && typeof record.rejectedAt === 'string' ? { rejectedAt: record.rejectedAt } : {}),
    ...(state === 'rejected' && typeof record.status === 'number' ? { status: record.status } : {}),
    ...(state === 'rejected' && typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
