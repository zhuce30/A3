import { NextRequest } from 'next/server';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { GET, PATCH, POST } from '@/app/api/a3/notes/[...path]/route';
import { NotesClient } from '@/lib/a3/notes/client';
import type {
  ApiResult,
  NoteAttachment,
  NoteConflict,
  NoteDetail,
  NoteDigest,
  NoteRevision,
  NoteSummary,
} from '@/lib/a3/notes/types';

const note: NoteDetail = {
  id: 'note-1',
  title: '进程调度',
  contentText: '轮转调度',
  content: { type: 'doc', content: [] },
  version: 3,
  notebook: null,
  tags: [],
  isPinned: false,
  lastEditedAt: '2026-08-02T12:00:00+08:00',
  deletedAt: null,
  createdAt: '2026-08-02T11:00:00+08:00',
  updatedAt: '2026-08-02T12:00:00+08:00',
};

describe('personal notes frontend contracts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
  });

  it('models current backend camelCase note payloads without any', () => {
    const summary: NoteSummary = note;
    const revision: NoteRevision = {
      id: 'revision-1',
      noteId: note.id,
      version: 2,
      source: 'manual',
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      createdAt: note.createdAt,
    };
    const attachment: NoteAttachment = {
      id: 'attachment-1',
      noteId: note.id,
      kind: 'file',
      displayName: 'schedule.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      parseStatus: 'succeeded',
      parseGeneration: 1,
      parseStartedAt: null,
      errorCode: '',
      errorMessage: '',
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
    const conflict: ApiResult<{ note: NoteDetail }> = {
      success: false,
      status: 409,
      code: 'note_version_conflict',
      error: '版本冲突',
      serverVersion: 4,
      serverNote: note,
    };

    expect(summary.version).toBe(3);
    expect(revision.noteId).toBe(note.id);
    expect(attachment.parseStatus).toBe('succeeded');
    expectTypeOf(conflict).toMatchTypeOf<NoteConflict>();
  });

  it('uses implemented lifecycle endpoints and preserves JSON failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, note }))
      .mockResolvedValueOnce(Response.json({
        success: false,
        code: 'note_version_conflict',
        error: '版本冲突',
        serverVersion: 4,
        serverNote: note,
      }, { status: 409 }));
    const client = new NotesClient({ fetch: fetchMock });

    const detail = await client.getNote(note.id);
    const conflict = await client.saveNote(note.id, {
      title: '新标题',
      content: note.content,
      baseVersion: 3,
      clientMutationId: 'mutation-1',
    });

    expect(detail).toEqual({ success: true, note });
    expect(fetchMock).toHaveBeenNthCalledWith(1, `/api/a3/notes/notes/${note.id}/`, expect.objectContaining({
      method: 'GET',
      credentials: 'include',
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/a3/notes/notes/${note.id}/`, expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        title: '新标题',
        content: note.content,
        baseVersion: 3,
        clientMutationId: 'mutation-1',
      }),
    }));
    expect(conflict).toMatchObject({ success: false, status: 409, serverVersion: 4 });
  });

  it('sends multipart uploads unchanged and exposes downloads as responses', async () => {
    const attachment: NoteAttachment = {
      id: 'attachment-1', noteId: note.id, kind: 'file', displayName: 'a.txt', mimeType: 'text/plain',
      sizeBytes: 1, parseStatus: 'pending', parseGeneration: 1, parseStartedAt: null,
      errorCode: '', errorMessage: '', createdAt: note.createdAt, updatedAt: note.updatedAt,
    };
    const download = new Response(new Uint8Array([1, 2]), {
      headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="a.txt"' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, attachment }, { status: 201 }))
      .mockResolvedValueOnce(download);
    const client = new NotesClient({ fetch: fetchMock });
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });

    const uploaded = await client.uploadAttachment(note.id, file);
    const response = await client.downloadAttachment(attachment.id);

    const uploadInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(uploaded).toEqual({ success: true, attachment });
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(new Headers(uploadInit.headers).has('content-type')).toBe(false);
    expect(response).toBe(download);
  });

  it('loads persisted note attachments through the typed note-scoped endpoint', async () => {
    const attachment: NoteAttachment = {
      id: 'attachment-1', noteId: note.id, kind: 'file', displayName: 'persisted.txt', mimeType: 'text/plain',
      sizeBytes: 9, parseStatus: 'succeeded', parseGeneration: 1, parseStartedAt: null,
      errorCode: '', errorMessage: '', createdAt: note.createdAt, updatedAt: note.updatedAt,
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true, attachments: [attachment] }));
    const client = new NotesClient({ fetch: fetchMock });

    const result = await client.listAttachments(note.id);

    expect(result).toEqual({ success: true, attachments: [attachment] });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/a3/notes/notes/${note.id}/attachments/`,
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );
  });

  it('uses the owned digest list, manual revision, and retry endpoints', async () => {
    const digest: NoteDigest = {
      id: 'digest-1', digestDate: '2026-08-02', revision: 1, status: 'failed', title: '', contentMd: '',
      sourceSnapshot: { notes: [{ id: note.id, version: 3, title: note.title, attachments: [] }] },
      generatedBy: 'manual', idempotencyKey: 'manual:1', errorCode: 'digest_model_unavailable',
      errorMessage: '摘要模型暂时不可用', createdAt: note.createdAt, updatedAt: note.updatedAt,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, digests: [digest] }))
      .mockResolvedValueOnce(Response.json({ success: true, digest }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ success: true, digest: { ...digest, status: 'queued' } }, { status: 202 }));
    const client = new NotesClient({ fetch: fetchMock });

    await client.listDigests('2026-08-02');
    await client.createManualDigest('2026-08-02');
    await client.retryDigest(digest.id);

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/a3/notes/digests/?date=2026-08-02', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/a3/notes/digests/manual/', expect.objectContaining({ method: 'POST', body: JSON.stringify({ date: '2026-08-02' }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/a3/notes/digests/digest-1/retry/', expect.objectContaining({ method: 'POST' }));
  });
});

describe('secure personal notes proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
  });

  it('forwards auth, CSRF, query and conditional headers while streaming bodies', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const upstream = new Response(new Uint8Array([7, 8, 9]), {
      status: 206,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="notes.zip"',
        etag: '"export-v1"',
        'last-modified': 'Sun, 02 Aug 2026 04:00:00 GMT',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('http://frontend/api/a3/notes/exports/export-1/download/?token=raw%2Bvalue', {
      method: 'GET',
      headers: {
        cookie: 'sessionid=secret; csrftoken=csrf-cookie',
        'x-csrftoken': 'csrf-header',
        'if-none-match': '"export-v1"',
      },
    });

    const response = await GET(request, { params: Promise.resolve({ path: ['exports', 'export-1', 'download'] }) });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8000/api/notes/exports/export-1/download/?token=raw%2Bvalue',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Cookie: 'sessionid=secret; csrftoken=csrf-cookie',
          'X-CSRFToken': 'csrf-header',
          'If-None-Match': '"export-v1"',
        }),
      }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="notes.zip"');
    expect(response.headers.get('etag')).toBe('"export-v1"');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([7, 8, 9]);
  });

  it('forwards the persisted note assistant API through the notes-only allowlist', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('http://frontend/api/a3/notes/assistant/chat/', {
      method: 'POST',
      headers: {
        cookie: 'sessionid=secret; csrftoken=csrf-token',
        'content-type': 'application/json',
        'x-csrftoken': 'csrf-token',
      },
      body: JSON.stringify({ sessionId: 'session-1', message: 'hello' }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ path: ['assistant', 'chat'] }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8000/api/notes/assistant/chat/',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(JSON.stringify({
      sessionId: 'session-1',
      message: 'hello',
    }));
    expect(response.status).toBe(202);
  });

  it('obtains Django CSRF server-side when the browser only sends the shared session cookie', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'fresh-csrf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(Response.json({ success: true }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('http://frontend/api/a3/notes/notes/', {
      method: 'POST',
      headers: { cookie: 'a3_sessionid=secret', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new note' }),
    });

    const response = await POST(request, { params: Promise.resolve({ path: ['notes'] }) });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://backend:8000/api/auth/csrf/',
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'a3_sessionid=secret' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://backend:8000/api/notes/notes/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Cookie: 'a3_sessionid=secret; csrftoken=fresh-csrf',
          'X-CSRFToken': 'fresh-csrf',
        }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it('streams multipart request bodies without parsing them', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ success: true }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const boundary = '----a3-test-boundary';
    const request = new NextRequest('http://frontend/api/a3/notes/notes/note-1/attachments/upload/', {
      method: 'POST',
      headers: {
        cookie: 'sessionid=secret; csrftoken=csrf-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'upload-1',
        'x-csrftoken': 'csrf-token',
      },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nx\r\n--${boundary}--`,
    });

    const response = await POST(request, { params: Promise.resolve({ path: ['notes', 'note-1', 'attachments', 'upload'] }) });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { duplex?: string };
    expect(response.status).toBe(201);
    expect(init.body).toBe(request.body);
    expect(init.duplex).toBe('half');
    expect(new Headers(init.headers).get('content-type')).toContain(boundary);
    expect(new Headers(init.headers).get('idempotency-key')).toBe('upload-1');
  });

  it.each([
    { url: 'http://frontend/api/a3/notes/notes//secret/', path: ['notes', '', 'secret'] },
    { url: 'http://frontend/api/a3/notes/notes/../secret/', path: ['notes', '..', 'secret'] },
    { url: 'http://frontend/api/a3/notes/notes/%2e%2e/secret/', path: ['notes', '%2e%2e', 'secret'] },
    { url: 'http://frontend/api/a3/notes/notes/%252e%252e/secret/', path: ['notes', '%252e%252e', 'secret'] },
    { url: 'http://frontend/api/a3/notes/notes/a%2Fb/', path: ['notes', 'a%2Fb'] },
    { url: 'http://frontend/api/a3/notes/notes/a%255Cb/', path: ['notes', 'a%255Cb'] },
    { url: 'http://frontend/api/a3/notes/https:%2F%2Fevil.test/', path: ['https:%2F%2Fevil.test'] },
    { url: 'http://frontend/api/a3/notes/auth/users/', path: ['auth', 'users'] },
    { url: 'http://frontend/api/a3/notes/notes/%2500/', path: ['notes', '%2500'] },
  ])('rejects unsafe proxy path $url', async ({ url, path }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await PATCH(new NextRequest(url, {
      method: 'PATCH',
      headers: { cookie: 'sessionid=secret', 'content-type': 'application/json' },
      body: '{}',
    }), { params: Promise.resolve({ path }) });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an authenticated session cookie', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new NextRequest('http://frontend/api/a3/notes/notes/'),
      { params: Promise.resolve({ path: ['notes'] }) },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
