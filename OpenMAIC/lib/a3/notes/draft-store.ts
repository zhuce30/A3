import Dexie, { type Table } from 'dexie';

import type { NoteContent } from './types';

export interface NoteDraft {
  userId: string;
  noteId: string;
  title: string;
  content: NoteContent;
  contentText: string;
  baseVersion: number;
  clientMutationId: string;
  createdAt: string;
  updatedAt: string;
}

export type PendingNoteMutation = NoteDraft;

export interface PersistableNoteDraft {
  noteId: string;
  title: string;
  content: NoteContent;
  contentText: string;
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
      clearedDraftCount: number;
      clearedMutationCount: number;
    };

export interface NotesDraftPersistence {
  allDrafts(): Promise<NoteDraft[]>;
  allMutations(): Promise<PendingNoteMutation[]>;
  getDraft(noteId: string): Promise<NoteDraft | undefined>;
  getMutation(clientMutationId: string): Promise<PendingNoteMutation | undefined>;
  putDraftAndMutation(draft: NoteDraft, mutation: PendingNoteMutation): Promise<void>;
  deleteAccounts(userIds: string[]): Promise<void>;
  acknowledge(userId: string, mutation: PendingNoteMutation): Promise<void>;
  rebaseNewer(userId: string, mutation: PendingNoteMutation, resultingVersion: number): Promise<void>;
  discardMutation(clientMutationId: string): Promise<void>;
  clear(): Promise<void>;
}

export class NotesDraftDatabase extends Dexie {
  drafts!: Table<NoteDraft, string>;
  mutations!: Table<PendingNoteMutation, string>;

  constructor(name = 'a3-personal-notes') {
    super(name);
    this.version(1).stores({
      drafts: 'noteId,userId,updatedAt',
      mutations: 'clientMutationId,userId,noteId,createdAt',
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
      await this.database.mutations.put(mutation);
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

  async acknowledge(userId: string, mutation: PendingNoteMutation) {
    await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      await this.database.mutations.delete(mutation.clientMutationId);
      const draft = await this.database.drafts.get(mutation.noteId);
      if (draft?.userId === userId && draft.clientMutationId === mutation.clientMutationId) {
        await this.database.drafts.delete(mutation.noteId);
      }
    });
  }

  async rebaseNewer(userId: string, mutation: PendingNoteMutation, resultingVersion: number) {
    await this.database.transaction('rw', this.database.drafts, this.database.mutations, async () => {
      const pending = await this.database.mutations.where('noteId').equals(mutation.noteId).toArray();
      const newer = pending.filter((item) => item.userId === userId && mutationOrder(item, mutation) > 0);
      await Promise.all(newer.map((item) => this.database.mutations.put({ ...item, baseVersion: resultingVersion })));
      const draft = await this.database.drafts.get(mutation.noteId);
      if (draft?.userId === userId && draft.clientMutationId !== mutation.clientMutationId) {
        await this.database.drafts.put({ ...draft, baseVersion: resultingVersion });
      }
    });
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

  constructor(private readonly persistence: NotesDraftPersistence = new DexieNotesDraftPersistence()) {}

  async activateUser(userId: string | null): Promise<AccountActivation> {
    if (!userId) {
      this.userId = null;
      return { kind: 'logged-out', warningRequired: false };
    }
    const [drafts, mutations] = await Promise.all([
      this.persistence.allDrafts(),
      this.persistence.allMutations(),
    ]);
    const foreignUserIds = new Set<string>();
    for (const item of [...drafts, ...mutations]) if (item.userId !== userId) foreignUserIds.add(item.userId);
    const accountChanged = this.userId !== null && this.userId !== userId;
    const clearedDraftCount = drafts.filter((item) => foreignUserIds.has(item.userId)).length;
    const clearedMutationCount = mutations.filter((item) => foreignUserIds.has(item.userId)).length;
    if (foreignUserIds.size > 0) await this.persistence.deleteAccounts([...foreignUserIds]);
    this.userId = userId;
    if (accountChanged || foreignUserIds.size > 0) {
      return { kind: 'account-changed', warningRequired: true, clearedDraftCount, clearedMutationCount };
    }
    return { kind: 'ready', warningRequired: false };
  }

  async persist(input: PersistableNoteDraft) {
    const userId = this.requireUser();
    const existing = await this.persistence.getMutation(input.clientMutationId);
    const createdAt = existing?.userId === userId
      ? existing.createdAt
      : await this.uniqueCreatedAt(input.updatedAt);
    const record: NoteDraft = { ...input, userId, createdAt };
    await this.persistence.putDraftAndMutation(record, { ...record });
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
    return mutations.filter((item) => item.userId === this.userId).sort(mutationOrder);
  }

  async acknowledge(mutation: PendingNoteMutation, resultingVersion: number) {
    const userId = this.requireUser();
    await this.persistence.rebaseNewer(userId, mutation, resultingVersion);
    await this.persistence.acknowledge(userId, mutation);
  }

  async discardMutation(clientMutationId: string) {
    const mutation = await this.getMutation(clientMutationId);
    if (mutation) await this.persistence.discardMutation(clientMutationId);
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
