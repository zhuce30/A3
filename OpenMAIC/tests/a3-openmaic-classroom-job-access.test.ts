import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/generate-classroom/[jobId]/route';
import { POST as createClassroomJobRoute } from '@/app/api/generate-classroom/route';
import {
  assertNoPrivateTutorDirectiveLeak,
  resolveA3ClassroomTutorContext,
} from '@/lib/server/classroom-generation';
import {
  createClassroomGenerationJob,
  readClassroomGenerationJob,
  updateClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';

const createdJobIds: string[] = [];

async function removeCreatedJobs() {
  await Promise.all(createdJobIds.splice(0).map((jobId) =>
    fs.rm(path.resolve(process.cwd(), 'data/classroom-jobs', `${jobId}.json`), { force: true }),
  ));
}

async function createA3Job(
  jobId: string,
  cookieHeader = 'sessionid=owner-session',
  resourcePackId = 'pack-owner',
) {
  createdJobIds.push(jobId);
  const context = resolveA3ClassroomTutorContext('structured-teacher').context;
  await createClassroomGenerationJob(
    jobId,
    { requirement: 'Public topic', a3TutorPersonaId: 'structured-teacher', a3Context: context },
    { cookieHeader, resourcePackId },
  );
  return context;
}

async function poll(jobId: string, cookieHeader?: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/generate-classroom/${jobId}`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
    }),
    { params: Promise.resolve({ jobId }) },
  );
}

describe('A3 classroom job access binding', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await removeCreatedJobs();
  });

  it('persists only a fingerprint and pack binding and keeps them out of polling responses', async () => {
    const jobId = 'a3-access-owner-binding';
    const context = await createA3Job(jobId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: true,
      user: { id: 'student-owner', role: 'student' },
    })));

    const fileText = await fs.readFile(
      path.resolve(process.cwd(), 'data/classroom-jobs', `${jobId}.json`),
      'utf8',
    );
    expect(fileText).not.toContain('owner-session');
    expect(fileText).not.toContain(context.tutorPersona.id === 'structured-teacher'
      ? resolveA3ClassroomTutorContext('structured-teacher').privateTeachingDirective
      : 'unreachable');
    const stored = JSON.parse(fileText) as Record<string, unknown>;
    expect(stored).toMatchObject({
      a3Binding: {
        ownerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        resourcePackId: 'pack-owner',
      },
    });

    const response = await poll(jobId, 'sessionid=owner-session');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('ownerFingerprint');
    expect(JSON.stringify(body)).not.toContain('resourcePackId');
  });

  it.each([
    ['missing cookie', undefined],
    ['another user session', 'sessionid=other-session'],
  ])('hides A3 jobs from %s', async (_case, cookieHeader) => {
    const jobId = `a3-access-denied-${createdJobIds.length}`;
    await createA3Job(jobId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: true,
      user: { id: 'student-other', role: 'student' },
    })));

    const response = await poll(jobId, cookieHeader);

    expect(response.status).toBe(404);
  });

  it.each([
    'sessionid=attacker; sessionid=owner-session',
    'sessionid=owner-session; sessionid=attacker',
    'sessionid=owner-session; sessionid=owner-session',
  ])('rejects A3 generation with duplicate configured session cookies: %s', async (cookieHeader) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await createClassroomJobRoute(new NextRequest(
      'http://localhost:3000/api/generate-classroom',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader },
        body: JSON.stringify({
          requirement: 'Public topic',
          a3TutorPersonaId: 'structured-teacher',
          a3ResourcePackId: 'pack-owner',
        }),
      },
    ));

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'sessionid=attacker; sessionid=owner-session',
    'sessionid=owner-session; sessionid=attacker',
    'sessionid=owner-session; sessionid=owner-session',
  ])('rejects polling with duplicate configured session cookies: %s', async (cookieHeader) => {
    const jobId = `a3-access-duplicate-${createdJobIds.length}`;
    await createA3Job(jobId);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: true,
      user: { id: 'student-owner', role: 'student' },
    })));

    const response = await poll(jobId, cookieHeader);

    expect(response.status).toBe(404);
  });

  it('still allows polling legacy jobs without A3 context or cookies', async () => {
    const jobId = 'legacy-classroom-job-access';
    createdJobIds.push(jobId);
    await createClassroomGenerationJob(jobId, { requirement: 'Legacy topic' });

    const response = await poll(jobId);

    expect(response.status).toBe(200);
  });

  it('does not allow status updates to rebind an A3 job', async () => {
    const jobId = 'a3-access-immutable-binding';
    await createA3Job(jobId);

    await updateClassroomGenerationJob(jobId, {
      status: 'running',
      a3Binding: {
        ownerFingerprint: '0'.repeat(64),
        resourcePackId: 'pack-attacker',
      },
    });

    await expect(readClassroomGenerationJob(jobId)).resolves.toMatchObject({
      status: 'running',
      a3Binding: { resourcePackId: 'pack-owner' },
    });
  });

  it('marks a contaminated generation as failed while preserving the public tutor context', async () => {
    const jobId = 'a3-directive-controlled-failure';
    const context = await createA3Job(jobId);
    const directive = resolveA3ClassroomTutorContext('structured-teacher').privateTeachingDirective;
    const contaminated = directive.split('').join(' · ');

    try {
      assertNoPrivateTutorDirectiveLeak({ scenes: [{ content: contaminated }] }, directive);
    } catch {
      const { markClassroomGenerationJobFailed } = await import('@/lib/server/classroom-job-store');
      await markClassroomGenerationJobFailed(jobId, 'Generated classroom output was rejected');
    }

    const stored = await readClassroomGenerationJob(jobId);
    expect(stored).toMatchObject({ status: 'failed', a3Context: context });
    expect(JSON.stringify(stored)).not.toContain(directive);
    expect(JSON.stringify(stored)).not.toContain(contaminated);
  });
});
