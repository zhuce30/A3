import type {
  ApiResult,
  NoteAttachment,
  NoteContent,
  NoteDetail,
  NoteExportJob,
  NoteNotebook,
  NoteRevision,
  NoteSummary,
  NoteTag,
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

  searchNotes(query: URLSearchParams | string) {
    return this.json<{ notes: NoteSummary[] }>('GET', this.withQuery('search/', query));
  }

  createNote(input: CreateNoteInput) {
    return this.json<{ note: NoteDetail }>('POST', 'notes/', input);
  }

  getNote(noteId: string) {
    return this.json<{ note: NoteDetail }>('GET', `notes/${encodeURIComponent(noteId)}/`);
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
