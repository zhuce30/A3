import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type {
  A3ResourceAgentPlanEntry,
  A3ResourceAgentProgressEntry,
  A3ResourceGenerateResponse,
  A3ResourcePackV2ResourceType,
} from '@/lib/a3/recommendation-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type PersistedResourceGenerationJob = {
  jobId: string;
  workflow: 'resource_generate' | string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  progress: number;
  stage: string;
  message: string;
  done?: boolean;
  resourcePack?: A3ResourceGenerateResponse['resourcePack'];
  traceId?: string;
  agentProgress?: A3ResourceAgentProgressEntry[];
  agentPlan?: A3ResourceAgentPlanEntry[];
  error?: string;
  updatedAt?: string;
};

type ResourceGenerationJobResponse = {
  success?: boolean;
  error?: string;
  job?: PersistedResourceGenerationJob;
  jobs?: PersistedResourceGenerationJob[];
};

const RESOURCE_JOB_STATUS_TIMEOUT_MS = 8_000;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后再生成学习资源');
    }

    const body = (await request.json().catch(() => ({}))) as {
      goal?: string;
      learningGoal?: string;
      topK?: number;
      resourceType?: A3ResourcePackV2ResourceType | '';
      resource_type?: A3ResourcePackV2ResourceType | '';
    };
    const goal = String(body.goal || body.learningGoal || '').trim();
    if (!goal) return apiError('MISSING_REQUIRED_FIELD', 400, '请先填写学习需求');
    const topK = normalizeTopK(body.topK);
    const resourceType = normalizeResourceType(body.resourceType || body.resource_type || '');
    const jobId = `a3_resource_${Date.now()}_${crypto.randomUUID()}`;
    const message = resourceType ? '已创建单项资源生成任务' : '已创建资源包生成任务';

    const persisted = await persistResourceGenerationJob(cookieHeader, {
      jobId,
      workflow: 'resource_generate',
      status: 'queued',
      progress: 0,
      stage: 'queued',
      message,
      goal,
      topK,
      resourceType,
      metadata: { createdBy: 'next-api', startedAt },
    });
    if (!persisted.success || !persisted.job) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || '资源生成任务创建失败');
    }
    if (persisted.job.status === 'failed') {
      return apiError('UPSTREAM_ERROR', 503, persisted.job.error || persisted.job.message || '资源生成任务队列不可用');
    }

    return apiSuccess({
      jobId,
      workflow: 'resource_generate',
      status: persisted.job.status,
      progress: persisted.job.progress,
      stage: persisted.job.stage,
      message: persisted.job.message || message,
      pollUrl: `/api/a3/resources/jobs?jobId=${encodeURIComponent(jobId)}`,
      pollIntervalMs: 1500,
      startedAt,
    }, 202);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '资源生成任务暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const signal = AbortSignal.timeout(RESOURCE_JOB_STATUS_TIMEOUT_MS);
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader, { signal });
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后再查看资源生成进度');
    }
    const jobId = request.nextUrl.searchParams.get('jobId') || '';
    if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
    const persisted = await fetchA3DjangoJson<ResourceGenerationJobResponse>(
      `/api/resources/jobs/${encodeURIComponent(jobId)}/`,
      cookieHeader,
      { signal },
    );
    if (!persisted.success || !persisted.job) {
      return apiError('INVALID_REQUEST', 404, persisted.error || '资源生成任务不存在或已过期');
    }
    const job = persisted.job;
    return apiSuccess({
      jobId: job.jobId,
      workflow: job.workflow,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      done: job.done ?? ['succeeded', 'failed'].includes(String(job.status)),
      pollIntervalMs: 1500,
      resourcePack: job.resourcePack,
      traceId: job.traceId,
      agentProgress: job.agentProgress ?? [],
      agentPlan: job.agentPlan ?? [],
      error: job.error,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '资源生成任务状态暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

async function persistResourceGenerationJob(cookieHeader: string | null, body: Record<string, unknown>) {
  return postA3DjangoJson<ResourceGenerationJobResponse>('/api/resources/jobs/', cookieHeader, body);
}

function normalizeTopK(value: unknown) {
  const next = Number(value || 5);
  if (!Number.isFinite(next)) return 5;
  return Math.max(1, Math.min(10, Math.round(next)));
}

function normalizeResourceType(value: unknown): A3ResourcePackV2ResourceType | '' {
  const text = String(value || '').trim();
  const allowed: A3ResourcePackV2ResourceType[] = [
    'lecture_doc',
    'knowledge_card',
    'mind_map',
    'practice_set',
    'case_study',
    'code_lab',
    'micro_video_script',
  ];
  return allowed.includes(text as A3ResourcePackV2ResourceType) ? text as A3ResourcePackV2ResourceType : '';
}
