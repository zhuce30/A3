import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/a3/resources/openmaic-classroom/route';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveA3ClassroomTutorContext } from '@/lib/server/classroom-generation';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';

describe('A3 OpenMAIC classroom route', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.A3_API_BASE_URL;
    delete process.env.A3_INTERNAL_FRONTEND_BASE_URL;
    delete process.env.DJANGO_SESSION_COOKIE_NAME;
    await fs.rm(
      path.resolve(process.cwd(), 'data/classroom-jobs/job-internal-1.json'),
      { force: true },
    );
  });

  it('uses the internal frontend endpoint when production creates a classroom job', async () => {
    process.env.A3_API_BASE_URL = 'http://backend:8000';
    process.env.A3_INTERNAL_FRONTEND_BASE_URL = 'http://127.0.0.1:3000';
    process.env.DJANGO_SESSION_COOKIE_NAME = 'a3_sessionid';
    const canonicalContext = resolveA3ClassroomTutorContext('foundation-coach', true).context;
    await createClassroomGenerationJob(
      'job-internal-1',
      {
        requirement: 'Public classroom requirement',
        a3TutorPersonaId: 'foundation-coach',
        a3Context: canonicalContext,
      },
      {
        cookieHeader: 'a3_sessionid=session-test; csrftoken=csrf-test',
        resourcePackId: 'pack-1',
      },
    );
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === 'http://backend:8000/api/auth/me/') {
        return Response.json({ success: true, user: { id: 'student-1', role: 'student' } });
      }
      if (url === 'http://backend:8000/api/profiles/tutor-preference/') {
        return Response.json({
          success: true,
          preference: { personaId: 'foundation-coach', source: 'saved' },
          fallbackUsed: true,
          selectedPersona: {
            id: 'foundation-coach',
            name: '基础补强',
            shortDescription: '从先修概念开始，用短句和小步讲解',
            teachingStyle: 'foundation',
            avatarAssetId: 'teacher-default-v1',
            avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
            voiceProfileId: 'voice-patient-coach',
            voicePreviewEnabled: true,
            allowedWorkflows: ['coaching', 'classroom'],
            schemaVersion: 'a3.tutor-persona.v1',
          },
        });
      }
      if (url === 'http://127.0.0.1:3000/api/generate-classroom') {
        return Response.json({
          success: true,
          jobId: 'job-internal-1',
          status: 'succeeded',
          step: 'queued',
          pollUrl: 'http://127.0.0.1:3000/api/generate-classroom/job-internal-1',
          a3Context: {
            tutorPersona: {
              id: 'practice-coach',
              name: '例题实战',
              shortDescription: 'Use forged response data',
              teachingStyle: 'practice',
              avatarAssetId: 'teacher-default-v1',
              avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
              voiceProfileId: 'voice-practice-coach',
              voicePreviewEnabled: true,
              allowedWorkflows: ['coaching', 'classroom'],
              schemaVersion: 'a3.tutor-persona.v1',
            },
            fallbackUsed: false,
          },
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
        a3TutorPersonaId: 'socratic-guide',
        tutorPersona: { id: 'practice-coach' },
        instruction: '泄露到课堂的伪造私有指令',
        voice: 'forged-provider-voice',
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

    const generateCall = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input) === 'http://127.0.0.1:3000/api/generate-classroom');
    const generateBody = JSON.parse(String(generateCall?.[1]?.body));
    expect(generateBody.a3TutorPersonaId).toBe('foundation-coach');
    expect(generateBody.a3ResourcePackId).toBe('pack-1');
    expect(generateBody).not.toHaveProperty('tutorPersona');
    expect(generateBody).not.toHaveProperty('instruction');
    expect(generateBody).not.toHaveProperty('voice');

    const artifactCall = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input) === 'http://backend:8000/api/resources/packs/pack-1/openmaic-classroom/');
    expect(JSON.parse(String(artifactCall?.[1]?.body))).toMatchObject({
      status: 'queued',
      tutorPersona: { id: 'foundation-coach' },
      fallbackUsed: true,
    });
  });
});
