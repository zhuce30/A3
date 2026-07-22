import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '@/app/api/a3/resources/video-playback/[playbackId]/route';


describe('A3 authenticated video playback proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
  });

  it('forwards session and byte range while streaming the backend response', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-length': '3',
        'content-range': 'bytes 4-6/100',
        'accept-ranges': 'bytes',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('http://localhost/api/a3/resources/video-playback/test', {
      headers: { cookie: 'a3_sessionid=session-value', range: 'bytes=4-6' },
    });

    const response = await GET(request, { params: Promise.resolve({ playbackId: '8d572da0-ec77-43c7-b6f4-578860b7cabc' }) });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 4-6/100');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend:8000/api/resources/video-playback/8d572da0-ec77-43c7-b6f4-578860b7cabc/',
      expect.objectContaining({
        headers: expect.objectContaining({ Cookie: 'a3_sessionid=session-value', Range: 'bytes=4-6' }),
      }),
    );
  });
});
