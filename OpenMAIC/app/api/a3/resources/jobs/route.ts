import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3ResourceGenerateResponse, A3ResourcePackV2ResourceType } from '@/lib/a3/recommendation-types';

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
  error?: string;
  updatedAt?: string;
};

type ResourceGenerationJobResponse = {
  success?: boolean;
  error?: string;
  job?: PersistedResourceGenerationJob;
  jobs?: PersistedResourceGenerationJob[];
};

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

    void runResourceGenerationJob({
      jobId,
      cookieHeader,
      goal,
      topK,
      resourceType,
    });

    return apiSuccess({
      jobId,
      workflow: 'resource_generate',
      status: 'queued',
      progress: 0,
      stage: 'queued',
      message,
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
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后再查看资源生成进度');
    }
    const jobId = request.nextUrl.searchParams.get('jobId') || '';
    if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
    const persisted = await fetchA3DjangoJson<ResourceGenerationJobResponse>(
      `/api/resources/jobs/${encodeURIComponent(jobId)}/`,
      cookieHeader,
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
      error: job.error,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '资源生成任务状态暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

async function runResourceGenerationJob(input: {
  jobId: string;
  cookieHeader: string | null;
  goal: string;
  topK: number;
  resourceType: A3ResourcePackV2ResourceType | '';
}) {
  await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
    status: 'running',
    stage: 'retrieval',
    progress: 15,
    message: '正在检索本地知识库和课程资料',
  });
  await sleep(120);
  await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
    status: 'running',
    stage: 'synthesis',
    progress: 45,
    message: '正在结合画像、薄弱点和学习目标组织内容',
  });

  try {
    const result = await postA3DjangoJson<A3ResourceGenerateResponse>(
      '/api/resources/generate/',
      input.cookieHeader,
      {
        goal: input.goal,
        topK: input.topK,
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      },
    );
    await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
      status: 'running',
      stage: 'writeback',
      progress: 85,
      message: '正在保存资源包和 Agent 证据',
      traceId: result.traceId,
    });
    if (!result.success || !result.resourcePack) {
      await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
        status: 'failed',
        stage: 'failed',
        progress: 100,
        message: result.error || '资源生成失败',
        error: result.error || '资源生成失败',
        traceId: result.traceId,
      });
      return;
    }
    await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
      status: 'succeeded',
      stage: 'completed',
      progress: 100,
      message: input.resourceType ? '单项资源已生成，可以打开查看' : '资源包已生成，可以选择资源查看',
      resourcePack: result.resourcePack,
      traceId: result.traceId || result.resourcePack.traceId,
    });
  } catch (error) {
    await patchResourceGenerationJob(input.cookieHeader, input.jobId, {
      status: 'failed',
      stage: 'failed',
      progress: 100,
      message: error instanceof Error ? error.message : '资源生成任务执行失败',
      error: error instanceof Error ? error.message : '资源生成任务执行失败',
    });
  }
}

async function persistResourceGenerationJob(cookieHeader: string | null, body: Record<string, unknown>) {
  return postA3DjangoJson<ResourceGenerationJobResponse>('/api/resources/jobs/', cookieHeader, body);
}

async function patchResourceGenerationJob(cookieHeader: string | null, jobId: string, patch: Record<string, unknown>) {
  return postA3DjangoJson<ResourceGenerationJobResponse>(
    `/api/resources/jobs/${encodeURIComponent(jobId)}/`,
    cookieHeader,
    patch,
  );
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
