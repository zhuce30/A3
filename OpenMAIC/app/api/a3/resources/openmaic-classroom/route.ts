import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson, resolveA3InternalFrontendEndpoint } from '@/lib/server/a3-django-api';
import {
  InvalidDjangoSessionCookieError,
  isAuthorizedForClassroomJob,
  readClassroomGenerationJob,
  resolveDjangoSessionIdentity,
} from '@/lib/server/classroom-job-store';
import { getServerTTSProviders } from '@/lib/server/provider-config';
import {
  buildA3OpenMAICArtifactPayload,
  buildA3OpenMAICClassroomRequirement,
  type OpenMAICClassroomJobResult,
} from '@/lib/a3/openmaic-classroom-bridge';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICClassroomArtifact, A3ResourcePackV2, A3ResourcePackV2Citation } from '@/lib/a3/recommendation-types';
import {
  A3TutorConfigRequestError,
  fetchAuthenticatedA3ClassroomTutor,
} from '@/lib/server/a3-tutor-config-client';
import type { A3ClassroomTutorContext } from '@/lib/types/stage';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type StartPayload = {
  action?: 'start';
  resourcePackId?: string;
  goal?: string;
  learnerProfileSnapshot?: Record<string, unknown>;
  citations?: A3ResourcePackV2Citation[];
};

type SyncPayload = {
  action: 'sync';
  resourcePackId?: string;
  job?: OpenMAICClassroomJobResult;
  startedAt?: number;
};

type GenerateClassroomResponse = {
  success?: boolean;
  error?: string;
  jobId?: string;
  status?: string;
  step?: string;
  message?: string;
  pollUrl?: string;
  pollIntervalMs?: number;
  a3Context?: A3ClassroomTutorContext;
};

type DjangoArtifactResponse = {
  artifact?: A3OpenMAICClassroomArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    try {
      if (!resolveDjangoSessionIdentity(cookieHeader)) {
        return apiError('UNAUTHORIZED', 401, '请先登录后生成个性化课件');
      }
    } catch (error) {
      if (error instanceof InvalidDjangoSessionCookieError) {
        return apiError('UNAUTHORIZED', 401, '请先登录后生成个性化课件');
      }
      throw error;
    }
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后生成个性化课件');
    }

    const body = (await request.json()) as StartPayload | SyncPayload;
    const resourcePackId = String(body.resourcePackId || '').trim();
    if (!resourcePackId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId');

    if (body.action === 'sync') {
      return syncOpenMAICJob(request, cookieHeader, resourcePackId, body);
    }

    return startOpenMAICJob(request, cookieHeader, resourcePackId, body);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 多模态生成桥接暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

async function startOpenMAICJob(
  request: NextRequest,
  cookieHeader: string | null,
  resourcePackId: string,
  body: StartPayload,
) {
  const startedAt = Date.now();
  let selectedTutor;
  try {
    selectedTutor = await fetchAuthenticatedA3ClassroomTutor(cookieHeader);
  } catch (error) {
    if (error instanceof A3TutorConfigRequestError) {
      return apiError('UPSTREAM_ERROR', error.status, error.message);
    }
    throw error;
  }
  const requirement = buildA3OpenMAICClassroomRequirement({
    goal: body.goal || '当前学习目标',
    learnerProfileSnapshot: body.learnerProfileSnapshot,
    citations: body.citations,
  });
  const generateResponse = await fetch(resolveA3InternalFrontendEndpoint('/api/generate-classroom', request.nextUrl.origin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({
      requirement,
      enableWebSearch: false,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: hasServerTTSProvider(),
      agentMode: 'generate',
      a3TutorPersonaId: selectedTutor.tutorPersona.id,
      a3ResourcePackId: resourcePackId,
    }),
  });
  const job = (await generateResponse.json().catch(() => ({}))) as GenerateClassroomResponse;
  if (!generateResponse.ok || !job.success || !job.jobId) {
    return apiError('UPSTREAM_ERROR', 502, job.error || 'OpenMAIC 课堂生成任务创建失败');
  }
  const storedJob = await readClassroomGenerationJob(job.jobId);
  if (
    !storedJob?.a3Context
    || !isAuthorizedForClassroomJob(storedJob, cookieHeader, resourcePackId)
  ) {
    return apiError('UPSTREAM_ERROR', 502, 'OpenMAIC 课堂任务绑定校验失败');
  }

  const pollUrl = normalizePollUrl(job.pollUrl, request.nextUrl.origin);
  if (!pollUrl) {
    return apiError('UPSTREAM_ERROR', 502, 'OpenMAIC 课堂任务已创建，但没有返回可轮询的任务地址。');
  }

  const artifactPayload = buildA3OpenMAICArtifactPayload({
    jobId: storedJob.id,
    status: storedJob.status,
    a3Context: storedJob.a3Context,
  }, Date.now() - startedAt);
  const persisted = await postA3DjangoJson<DjangoArtifactResponse>(
    `/api/resources/packs/${resourcePackId}/openmaic-classroom/`,
    cookieHeader,
    artifactPayload,
  );
  if (!persisted.success) {
    return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 资源包回写失败');
  }

  return apiSuccess({
    jobId: storedJob.id,
    status: storedJob.status,
    step: storedJob.step,
    message: storedJob.message,
    pollUrl,
    pollIntervalMs: job.pollIntervalMs ?? 5000,
    startedAt,
    artifact: persisted.artifact,
    traceId: persisted.traceId,
  }, 202);
}

function normalizePollUrl(pollUrl: string | undefined, requestOrigin: string): string {
  const value = String(pollUrl || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value, requestOrigin);
    if (parsed.pathname.startsWith('/api/generate-classroom/')) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return '';
  }
  return '';
}

function hasServerTTSProvider(): boolean {
  return Object.keys(getServerTTSProviders()).some((providerId) => providerId !== 'browser-native-tts');
}

async function syncOpenMAICJob(
  _request: NextRequest,
  cookieHeader: string | null,
  resourcePackId: string,
  body: SyncPayload,
) {
  if (!body.job?.jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 job');
  const storedJob = await readClassroomGenerationJob(body.job.jobId);
  if (
    !storedJob?.a3Context
    || !isAuthorizedForClassroomJob(storedJob, cookieHeader, resourcePackId)
  ) {
    return apiError('INVALID_REQUEST', 404, 'OpenMAIC 课堂任务不存在');
  }
  const canonicalJob: OpenMAICClassroomJobResult = {
    jobId: storedJob.id,
    status: storedJob.status,
    a3Context: storedJob.a3Context,
    ...(storedJob.result ? { result: storedJob.result } : {}),
    ...(storedJob.error ? { error: storedJob.error } : {}),
  };
  const artifactPayload = buildA3OpenMAICArtifactPayload(
    canonicalJob,
    body.startedAt ? Math.max(Date.now() - body.startedAt, 0) : 0,
    { resourcePackId },
  );
  const persisted = await postA3DjangoJson<DjangoArtifactResponse>(
    `/api/resources/packs/${resourcePackId}/openmaic-classroom/`,
    cookieHeader,
    artifactPayload,
  );
  if (!persisted.success) {
    return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 资源包回写失败');
  }
  return apiSuccess({
    jobId: canonicalJob.jobId,
    status: canonicalJob.status,
    artifact: persisted.artifact,
    resourcePack: persisted.resourcePack,
    traceId: persisted.traceId,
  });
}
