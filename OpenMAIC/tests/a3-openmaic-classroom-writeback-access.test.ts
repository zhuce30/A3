import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/a3/resources/openmaic-classroom/route';
import { resolveA3ClassroomTutorContext } from '@/lib/server/classroom-generation';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';

const jobs: string[] = [];

async function createBoundJob(jobId: string) {
  jobs.push(jobId);
  const a3Context = resolveA3ClassroomTutorContext('structured-teacher').context;
  await createClassroomGenerationJob(
    jobId,
    { requirement: 'Public topic', a3TutorPersonaId: 'structured-teacher', a3Context },
    { cookieHeader: 'sessionid=owner-session', resourcePackId: 'pack-owner' },
  );
  return a3Context;
}

function syncRequest(jobId: string, cookieHeader: string, resourcePackId: string) {
  return new NextRequest('http://localhost:3000/api/a3/resources/openmaic-classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${cookieHeader}; csrftoken=csrf-test` },
    body: JSON.stringify({
      action: 'sync',
      resourcePackId,
      job: { jobId, status: 'succeeded' },
    }),
  });
}

describe('A3 classroom writeback access binding', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
    await Promise.all(jobs.splice(0).map((jobId) =>
      fs.rm(path.resolve(process.cwd(), 'data/classroom-jobs', `${jobId}.json`), { force: true }),
    ));
  });

  it.each([
    ['another user', 'sessionid=other-session', 'pack-owner'],
    ['another pack', 'sessionid=owner-session', 'pack-other'],
  ])('rejects replay from %s without writing an artifact', async (_case, cookie, packId) => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const jobId = `writeback-denied-${jobs.length}`;
    const a3Context = await createBoundJob(jobId);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://backend:8000/api/auth/me/') {
        return Response.json({ success: true, user: { id: 'authenticated-user' } });
      }
      if (url.includes(`/api/generate-classroom/${jobId}`)) {
        return Response.json({ success: true, jobId, status: 'queued', a3Context });
      }
      if (url.includes('/openmaic-classroom/')) {
        return Response.json({ success: true, artifact: { jobId, status: 'queued' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const response = await POST(syncRequest(jobId, cookie, packId));

    expect([403, 404]).toContain(response.status);
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input).includes('/api/resources/packs/') && String(input).includes('/openmaic-classroom/'),
    )).toBe(false);
  });

  it('allows idempotent sync for the bound owner and pack', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const jobId = 'writeback-owner-pack';
    await createBoundJob(jobId);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://backend:8000/api/auth/me/') {
        return Response.json({ success: true, user: { id: 'owner' } });
      }
      if (url === 'http://backend:8000/api/resources/packs/pack-owner/openmaic-classroom/') {
        return Response.json({ success: true, artifact: { jobId, status: 'queued' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const first = await POST(syncRequest(jobId, 'sessionid=owner-session', 'pack-owner'));
    const second = await POST(syncRequest(jobId, 'sessionid=owner-session', 'pack-owner'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it.each([
    'sessionid=attacker; sessionid=owner-session',
    'sessionid=owner-session; sessionid=attacker',
    'sessionid=owner-session; sessionid=owner-session',
  ])('rejects writeback with duplicate configured session cookies: %s', async (cookieHeader) => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    const jobId = `writeback-duplicate-${jobs.length}`;
    await createBoundJob(jobId);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://backend:8000/api/auth/me/') {
        return Response.json({ success: true, user: { id: 'owner' } });
      }
      if (url.includes('/openmaic-classroom/')) {
        return Response.json({ success: true, artifact: { jobId, status: 'queued' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }));

    const response = await POST(syncRequest(jobId, cookieHeader, 'pack-owner'));

    expect([401, 403, 404]).toContain(response.status);
    expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input).includes('/api/resources/packs/') && String(input).includes('/openmaic-classroom/'),
    )).toBe(false);
  });
});
