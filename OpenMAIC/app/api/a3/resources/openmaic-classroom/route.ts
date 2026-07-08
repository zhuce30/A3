import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import { getServerTTSProviders } from '@/lib/server/provider-config';
import {
  buildA3OpenMAICArtifactPayload,
  buildA3OpenMAICClassroomRequirement,
  type OpenMAICClassroomJobResult,
} from '@/lib/a3/openmaic-classroom-bridge';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICClassroomArtifact, A3ResourcePackV2, A3ResourcePackV2Citation } from '@/lib/a3/recommendation-types';

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
};

type DjangoArtifactResponse = {
  artifact?: A3OpenMAICClassroomArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后生成个性化课件');
    }

    const body = (await request.json()) as StartPayload | SyncPayload;
    const resourcePackId = String(body.resourcePackId || '').trim();
    if (!resourcePackId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId');

    if (body.action === 'sync') {
      return syncOpenMAICJob(cookieHeader, resourcePackId, body);
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
  const requirement = buildA3OpenMAICClassroomRequirement({
    goal: body.goal || '当前学习目标',
    learnerProfileSnapshot: body.learnerProfileSnapshot,
    citations: body.citations,
  });
  const generateResponse = await fetch(new URL('/api/generate-classroom', request.nextUrl.origin), {
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
    }),
  });
  const job = (await generateResponse.json().catch(() => ({}))) as GenerateClassroomResponse;
  if (!generateResponse.ok || !job.success || !job.jobId) {
    return apiError('UPSTREAM_ERROR', 502, job.error || 'OpenMAIC 课堂生成任务创建失败');
  }

  const artifactPayload = buildA3OpenMAICArtifactPayload({
    jobId: job.jobId,
    status: job.status || 'queued',
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
    jobId: job.jobId,
    status: job.status || 'queued',
    step: job.step || 'queued',
    message: job.message || 'OpenMAIC 课堂生成任务已创建',
    pollUrl: job.pollUrl,
    pollIntervalMs: job.pollIntervalMs ?? 5000,
    startedAt,
    artifact: persisted.artifact,
    traceId: persisted.traceId,
  }, 202);
}

function hasServerTTSProvider(): boolean {
  return Object.keys(getServerTTSProviders()).some((providerId) => providerId !== 'browser-native-tts');
}

async function syncOpenMAICJob(
  cookieHeader: string | null,
  resourcePackId: string,
  body: SyncPayload,
) {
  if (!body.job?.jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 job');
  const artifactPayload = buildA3OpenMAICArtifactPayload(
    body.job,
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
    jobId: body.job.jobId,
    status: body.job.status,
    artifact: persisted.artifact,
    resourcePack: persisted.resourcePack,
    traceId: persisted.traceId,
  });
}
