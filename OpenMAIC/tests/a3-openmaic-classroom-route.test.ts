import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/a3/resources/openmaic-classroom/route';

describe('A3 OpenMAIC classroom route', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
    delete process.env.A3_INTERNAL_FRONTEND_BASE_URL;
  });

  it('uses the internal frontend endpoint when production creates a classroom job', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    process.env.A3_INTERNAL_FRONTEND_BASE_URL = 'http://127.0.0.1:3000';
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === 'http://backend:8000/api/auth/me/') {
        return Response.json({ success: true, user: { id: 'student-1', role: 'student' } });
      }
      if (url === 'http://127.0.0.1:3000/api/generate-classroom') {
        return Response.json({
          success: true,
          jobId: 'job-internal-1',
          status: 'queued',
          step: 'queued',
          pollUrl: 'http://127.0.0.1:3000/api/generate-classroom/job-internal-1',
        }, { status: 202 });
      }
      if (url === 'http://backend:8000/api/resources/packs/pack-1/openmaic-classroom/') {
        return Response.json({
          success: true,
          artifact: { type: 'openmaic_classroom', jobId: 'job-internal-1', status: 'queued' },
          traceId: 'trace-internal-1',
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const response = await POST(new NextRequest('https://a3.zhuce.work/api/a3/resources/openmaic-classroom', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'a3_sessionid=session-test; csrftoken=csrf-test',
      },
      body: JSON.stringify({
        action: 'start',
        resourcePackId: 'pack-1',
        goal: '进程调度与死锁',
      }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      jobId: 'job-internal-1',
      pollUrl: '/api/generate-classroom/job-internal-1',
    });
    expect(requestedUrls).toContain('http://127.0.0.1:3000/api/generate-classroom');
    expect(requestedUrls).not.toContain('https://a3.zhuce.work/api/generate-classroom');
  });
});
