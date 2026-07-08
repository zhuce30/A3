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
    expect(result.error).toContain('connection refused');
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
