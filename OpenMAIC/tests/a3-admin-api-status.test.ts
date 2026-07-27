import { afterEach, describe, expect, it, vi } from 'vitest';

describe('admin API HTTP status evidence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('adds the HTTP status to a JSON PATCH failure without replacing backend copy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: '并发版本不一致',
        errorCode: 'stale_update',
      }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { a3PatchJson } = await import('../lib/a3/api-client');

    const result = await a3PatchJson<{ success: boolean; error?: string; status?: number }>(
      '/api/admin/tutors/personas/structured-teacher/',
      { reason: '并发测试' },
    );

    expect(result).toEqual({
      success: false,
      error: '并发版本不一致',
      errorCode: 'stale_update',
      status: 409,
    });
  });
});
