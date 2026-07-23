import { afterEach, describe, expect, it, vi } from 'vitest';

import { a3GetJson } from '@/lib/a3/api-client';

describe('a3GetJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns a failure payload when GET cannot reach the backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await a3GetJson<{ success: boolean; error?: string }>('/api/v1/qa/interact/?q=test');

    expect(result.success).toBe(false);
    expect(result.error).toContain('后端服务');
    expect(result.error).not.toContain('connection refused');
  });

  it('keeps loopback API host aligned with the current browser host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
      ok: true,
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });

    await a3GetJson<{ success: boolean }>('/api/auth/me/');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/api/auth/me/',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('A3 CSRF token lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([
    '/api/auth/login/',
    '/api/auth/register/',
    '/api/auth/token/',
    '/api/auth/logout/',
  ])('refreshes the cached token after a successful session mutation at %s', async (authUrl) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-before-auth' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-after-auth' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { a3PostJson } = await import('@/lib/a3/api-client');

    await a3PostJson(authUrl, {});
    await a3PostJson('/api/auth/presence/heartbeat/', {});

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8000/api/auth/presence/heartbeat/',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-CSRFToken': 'csrf-after-auth' }),
      }),
    );
  });
});
