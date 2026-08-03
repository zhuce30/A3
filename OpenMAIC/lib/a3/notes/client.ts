import type {
  ApiResult,
  NoteAttachment,
  NoteAiMessage,
  NoteAiScopeInput,
  NoteAiSession,
  NoteContent,
  NoteDetail,
  NoteDigest,
  NoteExportJob,
  NoteNotebook,
  NoteRevision,
  NoteSummary,
  NoteTag,
  NoteWritebackPreview,
  SaveNoteInput,
  SaveNoteSuccess,
} from './types';

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface NotesClientOptions {
  fetch?: Fetch;
}

export interface CreateNoteInput {
  title?: string;
  content?: NoteContent;
  notebookId?: string | null;
  tagIds?: string[];
  isPinned?: boolean;
}

export interface AiMessageWatchHandlers {
  onMessage: (message: NoteAiMessage) => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
}

export class NotesClient {
  private readonly fetcher: Fetch;

  constructor(options: NotesClientOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  listNotebooks() {
    return this.json<{ notebooks: NoteNotebook[] }>('GET', 'notebooks/');
  }

  createNotebook(input: { name: string; sortOrder?: number }) {
    return this.json<{ notebook: NoteNotebook }>('POST', 'notebooks/', input);
  }

  updateNotebook(notebookId: string, input: { name?: string; sortOrder?: number; isArchived?: boolean }) {
    return this.json<{ notebook: NoteNotebook }>('PATCH', `notebooks/${encodeURIComponent(notebookId)}/`, input);
  }

  listTags() {
    return this.json<{ tags: NoteTag[] }>('GET', 'tags/');
  }

  createTag(input: { name: string; color?: string }) {
    return this.json<{ tag: NoteTag }>('POST', 'tags/', input);
  }

  deleteTag(tagId: string) {
    return this.json<{ deleted: true }>('DELETE', `tags/${encodeURIComponent(tagId)}/`);
  }

  listNotes(query: URLSearchParams | string = '') {
    return this.json<{ notes: NoteSummary[] }>('GET', this.withQuery('notes/', query));
  }

  searchNotes(query: URLSearchParams | string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ notes: NoteSummary[] }>('GET', this.withQuery('search/', query), undefined, options);
  }

  createNote(input: CreateNoteInput) {
    return this.json<{ note: NoteDetail }>('POST', 'notes/', input);
  }

  getNote(noteId: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ note: NoteDetail }>('GET', `notes/${encodeURIComponent(noteId)}/`, undefined, options);
  }

  saveNote(noteId: string, input: SaveNoteInput, options: { signal?: AbortSignal } = {}) {
    return this.json<SaveNoteSuccess>('PATCH', `notes/${encodeURIComponent(noteId)}/`, input, options);
  }

  deleteNote(noteId: string) {
    return this.json<{ note: NoteDetail }>('DELETE', `notes/${encodeURIComponent(noteId)}/`);
  }

  restoreNote(noteId: string) {
    return this.json<{ note: NoteDetail }>('POST', `notes/${encodeURIComponent(noteId)}/restore/`, {});
  }

  purgeNote(noteId: string) {
    return this.json<{ purged: true }>('DELETE', `notes/${encodeURIComponent(noteId)}/purge/`, { confirm: true });
  }

  listRevisions(noteId: string) {
    return this.json<{ revisions: NoteRevision[] }>('GET', `notes/${encodeURIComponent(noteId)}/revisions/`);
  }

  restoreRevision(noteId: string, revisionId: string, input: { baseVersion: number; clientMutationId: string }) {
    return this.json<SaveNoteSuccess>(
      'POST',
      `notes/${encodeURIComponent(noteId)}/revisions/${encodeURIComponent(revisionId)}/restore/`,
      input,
    );
  }

  listAttachments(noteId: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ attachments: NoteAttachment[] }>(
      'GET',
      `notes/${encodeURIComponent(noteId)}/attachments/`,
      undefined,
      options,
    );
  }

  listDigests(date?: string, options: { signal?: AbortSignal } = {}) {
    const query = date ? new URLSearchParams({ date }) : '';
    return this.json<{ digests: NoteDigest[] }>('GET', this.withQuery('digests/', query), undefined, options);
  }

  getDigest(digestId: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ digest: NoteDigest }>('GET', `digests/${encodeURIComponent(digestId)}/`, undefined, options);
  }

  createManualDigest(date: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ digest: NoteDigest }>('POST', 'digests/manual/', { date }, options);
  }

  retryDigest(digestId: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ digest: NoteDigest }>('POST', `digests/${encodeURIComponent(digestId)}/retry/`, {}, options);
  }

  uploadAttachment(noteId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.json<{ attachment: NoteAttachment }>(
      'POST',
      `notes/${encodeURIComponent(noteId)}/attachments/upload/`,
      form,
    );
  }

  createLinkAttachment(noteId: string, input: { url: string; displayName?: string }) {
    return this.json<{ attachment: NoteAttachment }>(
      'POST',
      `notes/${encodeURIComponent(noteId)}/attachments/link/`,
      input,
    );
  }

  reparseAttachment(attachmentId: string) {
    return this.json<{ attachment: NoteAttachment }>('POST', `attachments/${encodeURIComponent(attachmentId)}/reparse/`, {});
  }

  deleteAttachment(attachmentId: string) {
    return this.json<{ deleted: true }>('DELETE', `attachments/${encodeURIComponent(attachmentId)}/`);
  }

  downloadAttachment(attachmentId: string, options: { signal?: AbortSignal } = {}) {
    return this.download(`attachments/${encodeURIComponent(attachmentId)}/download/`, options);
  }

  createExport(input: { noteIds: string[]; format: NoteExportJob['format'] }) {
    return this.json<{ export: NoteExportJob }>('POST', 'exports/', input);
  }

  getExport(exportId: string) {
    return this.json<{ export: NoteExportJob }>('GET', `exports/${encodeURIComponent(exportId)}/`);
  }

  downloadExport(exportId: string, options: { signal?: AbortSignal } = {}) {
    return this.download(`exports/${encodeURIComponent(exportId)}/download/`, options);
  }

  listAiSessions() {
    return this.json<{ sessions: NoteAiSession[] }>('GET', 'assistant/sessions/');
  }

  createAiSession(input: { title: string; scope: NoteAiScopeInput }, options: { signal?: AbortSignal } = {}) {
    return this.json<{ session: NoteAiSession }>('POST', 'assistant/sessions/', input, options);
  }

  listAiMessages(sessionId: string, options: { signal?: AbortSignal } = {}) {
    return this.json<{ messages: NoteAiMessage[] }>(
      'GET',
      `assistant/sessions/${encodeURIComponent(sessionId)}/messages/`,
      undefined,
      options,
    );
  }

  submitAiChat(
    input: { sessionId: string; clientRequestId: string; message: string; includeCourseEvidence?: boolean },
    options: { signal?: AbortSignal } = {},
  ) {
    return this.json<{ message: NoteAiMessage; idempotent: boolean }>('POST', 'assistant/chat/', input, options);
  }

  createWritebackPreview(input: { targetNoteId: string; messageId: string }) {
    return this.json<{ preview: NoteWritebackPreview }>('POST', 'assistant/writeback-previews/', input);
  }

  confirmWritebackPreview(previewId: string) {
    return this.json<{ preview: NoteWritebackPreview; note: NoteDetail; idempotent: boolean }>(
      'POST',
      `assistant/writeback-previews/${encodeURIComponent(previewId)}/confirm/`,
      {},
    );
  }

  abandonWritebackPreview(previewId: string) {
    return this.json<{ preview: NoteWritebackPreview; idempotent: boolean }>(
      'POST',
      `assistant/writeback-previews/${encodeURIComponent(previewId)}/abandon/`,
      {},
    );
  }

  watchAiMessage(messageId: string, handlers: AiMessageWatchHandlers) {
    const source = new EventSource(`${this.endpoint(`assistant/stream/${encodeURIComponent(messageId)}`)}/`, {
      withCredentials: true,
    });
    let settled = false;
    const receive = (event: Event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { message?: NoteAiMessage; error?: string };
        if (payload.message) handlers.onMessage(payload.message);
        if (event.type === 'final') {
          settled = true;
          source.close();
        }
        if (event.type === 'stream-error') {
          settled = true;
          source.close();
        }
        if (payload.error) handlers.onError?.(payload.error);
      } catch {
        handlers.onError?.('AI 回答状态无法解析');
      }
    };
    source.addEventListener('status', receive);
    source.addEventListener('final', receive);
    source.addEventListener('stream-error', receive);
    source.onerror = () => {
      if (!settled) handlers.onDisconnect?.();
    };
    return () => {
      settled = true;
      source.close();
    };
  }

  private async json<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<T>> {
    const isForm = body instanceof FormData;
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined && !isForm) headers.set('Content-Type', 'application/json');
    const csrfToken = readCsrfCookie();
    if (method !== 'GET' && csrfToken) headers.set('X-CSRFToken', csrfToken);
    try {
      const response = await this.fetcher(this.endpoint(path), {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: options.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return { success: false, status: response.status, error: `笔记服务返回了无法识别的数据（${response.status}）` };
      }
      const payload = await response.json() as ApiResult<T>;
      if (!response.ok && !payload.success && payload.status === undefined) {
        return { ...payload, status: response.status };
      }
      return payload;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { success: false, error: '暂时无法连接笔记服务，请检查网络后重试' };
    }
  }

  private download(path: string, options: { signal?: AbortSignal }) {
    return this.fetcher(this.endpoint(path), {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: options.signal,
    });
  }

  private endpoint(path: string) {
    return `/api/a3/notes/${path}`;
  }

  private withQuery(path: string, query: URLSearchParams | string) {
    const value = typeof query === 'string' ? query.replace(/^\?/, '') : query.toString();
    return value ? `${path}?${value}` : path;
  }
}

function readCsrfCookie() {
  if (typeof document === 'undefined') return '';
  const item = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('csrftoken='));
  if (!item) return '';
  try {
    return decodeURIComponent(item.slice('csrftoken='.length));
  } catch {
    return '';
  }
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}
