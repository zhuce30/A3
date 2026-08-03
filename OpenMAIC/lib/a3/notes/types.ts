export type NoteContent = Record<string, unknown>;
export type NoteMetadata = Record<string, unknown>;

export interface NoteNotebook {
  id: string;
  name: string;
  sortOrder: number;
  isArchived: boolean;
  noteCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  contentText: string;
  version: number;
  notebook: NoteNotebook | null;
  tags: NoteTag[];
  isPinned: boolean;
  lastEditedAt: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDetail extends NoteSummary {
  content: NoteContent;
}

export interface NoteRevision {
  id: string;
  noteId: string;
  version: number;
  source: 'checkpoint' | 'manual' | 'ai_writeback' | 'restore';
  title: string;
  content: NoteContent;
  contentText: string;
  createdAt: string;
}

export interface NoteAttachment {
  id: string;
  noteId: string;
  kind: 'file' | 'image' | 'link';
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  parseStatus: 'pending' | 'processing' | 'succeeded' | 'failed';
  parseGeneration: number;
  parseStartedAt: string | null;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
  sourceUrl?: string;
}

export interface NoteAiSession {
  id: string;
  title: string;
  scopeType: 'note' | 'notebook' | 'selection';
  scopeSnapshot: NoteMetadata;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface NoteAiCitation {
  sourceKind?: 'personal_note' | 'course_knowledge' | string;
  sourceId?: string;
  noteId?: string;
  noteVersion?: number;
  attachmentId?: string;
  title: string;
  location: string;
  paragraphIndex?: number;
  charStart?: number;
  charEnd?: number;
  snippet: string;
  score?: number;
}

export interface NoteAiMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'queued' | 'streaming' | 'succeeded' | 'failed';
  clientRequestId: string;
  citations: NoteAiCitation[];
  verified: boolean;
  claims: unknown[];
  safety: NoteMetadata;
  degraded: boolean;
  errorCode: string;
  errorMessage: string;
  metadata: NoteMetadata;
  createdAt: string;
}

export type NoteAiScopeInput =
  | { type: 'note'; noteIds: [string] }
  | { type: 'selection'; noteIds: string[] }
  | { type: 'notebook'; notebookId: string };

export interface NoteDigest {
  id: string;
  digestDate: string;
  revision: number;
  status: 'queued' | 'processing' | 'succeeded' | 'failed';
  title: string;
  contentMd: string;
  sourceSnapshot: NoteMetadata;
  generatedBy: 'automatic' | 'manual';
  idempotencyKey: string;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteMemory {
  id: string;
  memoryType: 'core' | 'episodic';
  content: string;
  status: 'candidate' | 'confirmed' | 'paused' | 'superseded' | 'deleted';
  importance: number;
  confidence: number;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  sourceNoteRefs: unknown[];
  validFrom: string;
  validUntil: string | null;
  supersededById: string | null;
  confirmedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteExportJob {
  id: string;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'expired';
  format: 'markdown_zip' | 'json_zip';
  selection: { noteCount: number };
  deferred: boolean;
  enqueueAttempts: number;
  sizeBytes: number;
  sha256: string;
  errorCode: string;
  errorMessage: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotePhysicalCleanup {
  id: string;
  kind: 'attachment_dir';
  status: 'pending' | 'failed';
  ownerRef: string;
  referenceId: string;
  noteRef: string;
  attempts: number;
  lastAttemptAt: string | null;
  errorCode: string;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiSuccess {
  success: true;
}

export type SuccessfulApiResult<T> = ApiSuccess & T;

export interface ApiFailure {
  success: false;
  error: string;
  code?: string;
  status?: number;
}

export interface NoteConflict extends ApiFailure {
  status: 409;
  code: 'note_version_conflict';
  serverVersion: number;
  serverNote: NoteDetail;
}

export type ApiResult<T> = SuccessfulApiResult<T> | ApiFailure | NoteConflict;

export interface SaveNoteInput {
  title?: string;
  content: NoteContent;
  baseVersion: number;
  clientMutationId: string;
  notebookId?: string | null;
  tagIds?: string[];
  isPinned?: boolean;
}

export interface SaveNoteSuccess {
  note: NoteDetail;
  resultingVersion: number;
  idempotent: boolean;
}
