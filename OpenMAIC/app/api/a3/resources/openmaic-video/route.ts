import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICVideoArtifact, A3ResourcePackV2 } from '@/lib/a3/recommendation-types';

type AuthMeResponse = { user?: A3PublicUser | null };

type SegmentedVideoRequest = {
  prompt: string;
  duration: 10;
  aspectRatio: string;
  resolution: string;
  title: string;
};

type DjangoVideoJob = {
  jobId: string;
  status: string;
  progress: number;
  stage: string;
  message: string;
  done: boolean;
  resourcePackId: string;
  traceId?: string;
  artifact?: A3OpenMAICVideoArtifact & { resourcePack?: A3ResourcePackV2 };
  segments?: A3OpenMAICVideoArtifact['segments'];
  error?: string;
  createdAt?: number;
  updatedAt?: number;
  actionUrl?: string;
};

type DjangoVideoJobResponse = {
  success?: boolean;
  error?: string;
  created?: boolean;
  retried?: number;
  job?: DjangoVideoJob;
  jobs?: DjangoVideoJob[];
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const unauthorized = await rejectUnauthenticated(cookieHeader);
    if (unauthorized) return unauthorized;
    const body = (await request.json()) as {
      jobId?: string;
      resourcePackId?: string;
      prompt?: string;
      provider?: string;
      resourceType?: string;
      duration?: number;
      aspectRatio?: string;
      resolution?: string;
    };
    const resourcePackId = String(body.resourcePackId || '').trim();
    const rawPrompt = String(body.prompt || '').trim();
    if (!resourcePackId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId');
    if (!rawPrompt) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少视频 prompt');

    const duration = Math.max(1, Math.min(Number(body.duration || 60), 60));
    const aspectRatio = String(body.aspectRatio || '16:9');
    const resolution = String(body.resolution || '1080p');
    const segmented = buildSegmentedVideoRequests({
      prompt: rawPrompt,
      duration,
      aspectRatio,
      resolution,
    });
    const segmentRequests = segmented.length
      ? segmented
      : [{
          prompt: hardenVideoPromptForProvider(rawPrompt),
          duration: Math.min(duration, 10) as 10,
          aspectRatio,
          resolution,
          title: '教学视频',
        }];

    const persisted = await postA3DjangoJson<DjangoVideoJobResponse>(
      `/api/resources/packs/${resourcePackId}/video-jobs/`,
      cookieHeader,
      {
        jobId: String(body.jobId || '').trim(),
        provider: String(body.provider || 'seedance').trim(),
        resourceType: String(body.resourceType || 'micro_video_script').trim(),
        duration,
        aspectRatio,
        resolution,
        segments: segmentRequests.map((segment, index) => ({
          index: index + 1,
          title: segment.title,
          prompt: segment.prompt,
          duration: segment.duration,
        })),
      },
    );
    if (!persisted.success || !persisted.job) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || '视频任务创建失败');
    }
    return apiSuccess(toPublicVideoJob(persisted.job), 202);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 视频任务创建暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const unauthorized = await rejectUnauthenticated(cookieHeader);
    if (unauthorized) return unauthorized;
    const jobId = String(request.nextUrl.searchParams.get('jobId') || '').trim();
    if (!jobId) {
      const persisted = await fetchA3DjangoJson<DjangoVideoJobResponse>('/api/resources/video-jobs/', cookieHeader);
      if (!persisted.success) return apiError('UPSTREAM_ERROR', 502, persisted.error || '视频任务列表加载失败');
      return apiSuccess({ jobs: (persisted.jobs ?? []).map(toPublicVideoJob) });
    }
    const persisted = await fetchA3DjangoJson<DjangoVideoJobResponse>(
      `/api/resources/video-jobs/${encodeURIComponent(jobId)}/`,
      cookieHeader,
    );
    if (!persisted.success || !persisted.job) {
      return apiError('INVALID_REQUEST', 404, persisted.error || '视频任务不存在');
    }
    return apiSuccess(toPublicVideoJob(persisted.job));
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 视频任务状态暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const unauthorized = await rejectUnauthenticated(cookieHeader);
    if (unauthorized) return unauthorized;
    const body = (await request.json()) as { action?: string; jobId?: string };
    const action = String(body.action || '').trim();
    const jobId = String(body.jobId || '').trim();
    if (action !== 'retry-failed') return apiError('INVALID_REQUEST', 400, '不支持的视频任务操作');
    if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');

    const persisted = await postA3DjangoJson<DjangoVideoJobResponse>(
      `/api/resources/video-jobs/${encodeURIComponent(jobId)}/retry-failed/`,
      cookieHeader,
      {},
    );
    if (!persisted.success || !persisted.job) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || '失败片段重试失败');
    }
    return apiSuccess({ ...toPublicVideoJob(persisted.job), retried: persisted.retried ?? 0 }, 202);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '失败片段重试暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

function toPublicVideoJob(job: DjangoVideoJob) {
  const artifact = job.artifact && Object.keys(job.artifact).length ? job.artifact : undefined;
  return {
    ...job,
    artifact,
    resourcePack: artifact?.resourcePack,
    pollUrl: `/api/a3/resources/openmaic-video?jobId=${encodeURIComponent(job.jobId)}`,
    pollIntervalMs: 5000,
    degraded: Boolean(artifact && artifact.status !== 'succeeded'),
  };
}

async function rejectUnauthenticated(cookieHeader: string | null) {
  const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
  return auth.success && auth.user ? null : apiError('UNAUTHORIZED', 401, '请先登录后操作视频任务');
}

export function buildSegmentedVideoRequests(input: {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
}): SegmentedVideoRequest[] {
  const requestedDuration = Number(input.duration || 0);
  if (requestedDuration < 60) return [];
  const stages = [
    '导入：用一个学习困惑或真实场景引出主题',
    '概念：解释核心定义和判断条件',
    '机制：展示关键过程、结构或因果关系',
    '例子：用一个小案例演示推理步骤',
    '误区：突出常见错误和纠正方式',
    '收束：总结要点并提示下一步练习',
  ];
  return stages.map((stage, index) => ({
    prompt: hardenVideoPromptForProvider([
      `第 ${index + 1}/${stages.length} 段，10 秒。`,
      `教学阶段：${stage}。`,
      '这是 1 分钟课程视频的一个连续片段，保持同一画风、角色、色彩和节奏。',
      input.prompt,
    ].join('\n')),
    duration: 10,
    aspectRatio: input.aspectRatio || '16:9',
    resolution: input.resolution || '1080p',
    title: stage.split('：')[0],
  }));
}

export function hardenVideoPromptForProvider(prompt: string) {
  const normalized = String(prompt || '').trim();
  if (!normalized) return '';
  return [
    'IMPORTANT VISUAL CONSTRAINT: Do not render any readable text in the video frames. No Chinese characters, English words, formulas, subtitles, captions, whiteboard writing, blackboard writing, labels, UI text, logos, or watermarks inside the generated image. Use only people, icons, arrows, colors, shapes, objects, and motion to explain concepts. Spoken narration or the webpage subtitle layer will carry all text content.',
    normalized,
    'Negative prompt: garbled text, fake letters, pseudo words, unreadable writing, misspelled text, whiteboard text, blackboard text, subtitles, captions, title cards, labels, formulas, watermarks, logos.',
  ].join('\n\n');
}
