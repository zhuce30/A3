import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  resolveA3ClassroomTutorContext,
  resolveA3ClassroomTutorSnapshot,
  type GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import {
  createClassroomGenerationJob,
  InvalidDjangoSessionCookieError,
  resolveDjangoSessionIdentity,
} from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import {
  A3TutorConfigRequestError,
  fetchAuthenticatedA3ClassroomTutor,
} from '@/lib/server/a3-tutor-config-client';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  try {
    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    let tutor;
    if (rawBody.a3TutorPersonaId) {
      if (!resolveDjangoSessionIdentity(req.headers.get('cookie'))) {
        throw new A3TutorConfigRequestError(401, '请先登录');
      }
      tutor = resolveA3ClassroomTutorContext(rawBody.a3TutorPersonaId);
      const authenticatedTutor = await fetchAuthenticatedA3ClassroomTutor(req.headers.get('cookie'));
      tutor = resolveA3ClassroomTutorSnapshot({
        tutorPersona: authenticatedTutor.tutorPersona,
        fallbackUsed: authenticatedTutor.fallbackUsed
          || authenticatedTutor.tutorPersona.id !== rawBody.a3TutorPersonaId,
      });
    }
    requirementSnippet = rawBody.requirement?.substring(0, 60);
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),

      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.webSearchProviderId ? { webSearchProviderId: rawBody.webSearchProviderId } : {}),
      ...(rawBody.webSearchApiKey ? { webSearchApiKey: rawBody.webSearchApiKey } : {}),
      ...(rawBody.baiduSubSources ? { baiduSubSources: rawBody.baiduSubSources } : {}),
      ...(rawBody.enableImageGeneration != null
        ? { enableImageGeneration: rawBody.enableImageGeneration }
        : {}),
      ...(rawBody.enableVideoGeneration != null
        ? { enableVideoGeneration: rawBody.enableVideoGeneration }
        : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
      ...(tutor
        ? {
            a3TutorPersonaId: tutor.context.tutorPersona.id,
            a3ResourcePackId: String(rawBody.a3ResourcePackId || '').trim(),
            a3Context: tutor.context,
          }
        : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }
    if (tutor && !body.a3ResourcePackId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: a3ResourcePackId');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(
      jobId,
      body,
      tutor
        ? {
            cookieHeader: req.headers.get('cookie'),
            resourcePackId: body.a3ResourcePackId || '',
          }
        : undefined,
    );
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
        a3Context: job.a3Context,
      },
      202,
    );
  } catch (error) {
    if (error instanceof InvalidDjangoSessionCookieError) {
      return apiError('UNAUTHORIZED', 401, '请先登录');
    }
    if (error instanceof A3TutorConfigRequestError) {
      return apiError('UPSTREAM_ERROR', error.status, error.message);
    }
    if (error instanceof Error && error.message === '不支持该辅导风格') {
      return apiError('INVALID_REQUEST', 400, error.message);
    }
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
