import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import { buildA3OpenMAICVideoPayload } from '@/lib/a3/openmaic-classroom-bridge';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICVideoArtifact, A3ResourcePackV2 } from '@/lib/a3/recommendation-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type GenerateVideoResponse = {
  success?: boolean;
  error?: string;
  result?: {
    url?: string;
    duration?: number;
    width?: number;
    height?: number;
  };
};

type DjangoVideoArtifactResponse = {
  success?: boolean;
  error?: string;
  artifact?: A3OpenMAICVideoArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

type SegmentedVideoRequest = {
  prompt: string;
  duration: 10;
  aspectRatio: string;
  resolution: string;
  title: string;
};

type VideoJobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

type VideoJob = {
  jobId: string;
  userId: string;
  resourcePackId: string;
  status: VideoJobStatus;
  progress: number;
  stage: string;
  message: string;
  pollIntervalMs: number;
  createdAt: number;
  updatedAt: number;
  artifact?: A3OpenMAICVideoArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
  degraded?: boolean;
  error?: string;
};

const videoJobs = new Map<string, VideoJob>();
const VIDEO_JOB_TTL_MS = 2 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后生成视频任务');
    }

    const body = (await request.json()) as {
      resourcePackId?: string;
      prompt?: string;
      provider?: string;
      resourceType?: string;
      duration?: number;
      aspectRatio?: string;
      resolution?: string;
    };
    const resourcePackId = String(body.resourcePackId || '').trim();
    const prompt = hardenVideoPromptForProvider(String(body.prompt || '').trim());
    const provider = String(body.provider || 'seedance').trim();
    const resourceType = String(body.resourceType || 'micro_video_script').trim();
    if (!resourcePackId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId');
    if (!prompt) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少视频 prompt');

    const requestedDuration = Number(body.duration || 0);
    const segmentRequests = buildSegmentedVideoRequests({
      prompt: String(body.prompt || '').trim(),
      duration: requestedDuration,
      aspectRatio: body.aspectRatio || '16:9',
      resolution: body.resolution || '1080p',
    });

    cleanupExpiredVideoJobs();
    const jobId = `a3_video_${Date.now()}_${crypto.randomUUID()}`;
    const job: VideoJob = {
      jobId,
      userId: getA3UserId(auth.user),
      resourcePackId,
      status: 'queued',
      progress: 0,
      stage: 'queued',
      message: '视频任务已排队',
      pollIntervalMs: 2500,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    videoJobs.set(jobId, job);

    void runOpenMAICVideoJob({
      jobId,
      cookieHeader,
      origin: request.nextUrl.origin,
      provider,
      resourcePackId,
      resourceType,
      prompt,
      requestedDuration,
      aspectRatio: body.aspectRatio || '16:9',
      resolution: body.resolution || '1080p',
      segmentRequests,
      startedAt,
    });

    return apiSuccess({
      jobId,
      status: 'queued',
      progress: 0,
      stage: 'queued',
      message: '视频任务已创建，正在后台生成',
      pollUrl: `/api/a3/resources/openmaic-video?jobId=${encodeURIComponent(jobId)}`,
      pollIntervalMs: job.pollIntervalMs,
      startedAt,
    }, 202);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 视频生成桥接暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后查看视频任务状态');
    }
    cleanupExpiredVideoJobs();
    const jobId = request.nextUrl.searchParams.get('jobId') || '';
    const job = videoJobs.get(jobId);
    if (!job) return apiError('INVALID_REQUEST', 404, '视频任务不存在或已过期');
    if (job.userId && job.userId !== getA3UserId(auth.user)) {
      return apiError('UNAUTHORIZED', 403, '无权查看该视频任务');
    }
    return apiSuccess({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      done: ['succeeded', 'partial', 'failed'].includes(job.status),
      pollIntervalMs: job.pollIntervalMs,
      artifact: job.artifact,
      resourcePack: job.resourcePack,
      traceId: job.traceId,
      degraded: job.degraded,
      error: job.error,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 视频任务状态暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

async function runOpenMAICVideoJob(input: {
  jobId: string;
  cookieHeader: string | null;
  origin: string;
  provider: string;
  resourcePackId: string;
  resourceType: string;
  prompt: string;
  requestedDuration: number;
  aspectRatio: string;
  resolution: string;
  segmentRequests: SegmentedVideoRequest[];
  startedAt: number;
}) {
  updateVideoJob(input.jobId, {
    status: 'running',
    progress: 5,
    stage: 'generating',
    message: input.segmentRequests.length > 1 ? '正在生成分段视频' : '正在生成视频',
  });
  try {
    const artifactPayload = input.segmentRequests.length > 1
      ? await generateSegmentedVideoArtifact({
          origin: input.origin,
          provider: input.provider,
          resourceType: input.resourceType,
          requests: input.segmentRequests,
          startedAt: input.startedAt,
          onProgress: (segmentIndex, totalSegments) => updateVideoJob(input.jobId, {
            status: 'running',
            progress: Math.min(85, Math.round((segmentIndex / totalSegments) * 80) + 5),
            stage: 'generating',
            message: `正在生成第 ${segmentIndex}/${totalSegments} 段视频`,
          }),
        })
      : await generateSingleVideoArtifact({
          origin: input.origin,
          provider: input.provider,
          resourceType: input.resourceType,
          prompt: input.prompt,
          duration: input.requestedDuration === 10 ? 10 : 5,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          startedAt: input.startedAt,
        });

    updateVideoJob(input.jobId, {
      status: 'running',
      progress: 90,
      stage: 'writeback',
      message: '视频已生成，正在写回 A3 资源包',
    });
    const persisted = await postA3DjangoJson<DjangoVideoArtifactResponse>(
      `/api/resources/packs/${input.resourcePackId}/openmaic-video/`,
      input.cookieHeader,
      artifactPayload,
    );
    if (!persisted.success) {
      updateVideoJob(input.jobId, {
        status: 'failed',
        progress: 100,
        stage: 'failed',
        message: persisted.error || 'A3 视频产物回写失败',
        error: persisted.error || 'A3 视频产物回写失败',
      });
      return;
    }
    const finalStatus = artifactPayload.status === 'succeeded' ? 'succeeded' : artifactPayload.status === 'partial' ? 'partial' : 'failed';
    updateVideoJob(input.jobId, {
      status: finalStatus,
      progress: 100,
      stage: finalStatus === 'failed' ? 'failed' : 'completed',
      message: finalStatus === 'succeeded' ? '视频已生成并写回资源包' : finalStatus === 'partial' ? '视频部分片段成功，已写回资源包' : '视频生成失败，降级证据已写回资源包',
      artifact: persisted.artifact,
      resourcePack: persisted.resourcePack,
      traceId: persisted.traceId,
      degraded: artifactPayload.status !== 'succeeded',
      error: artifactPayload.status === 'succeeded' ? '' : artifactPayload.degradedReason,
    });
  } catch (error) {
    updateVideoJob(input.jobId, {
      status: 'failed',
      progress: 100,
      stage: 'failed',
      message: error instanceof Error ? error.message : '视频任务执行失败',
      error: error instanceof Error ? error.message : '视频任务执行失败',
    });
  }
}

async function generateSingleVideoArtifact(input: {
  origin: string;
  provider: string;
  resourceType: string;
  prompt: string;
  duration: 5 | 10;
  aspectRatio: string;
  resolution: string;
  startedAt: number;
}) {
  const videoResponse = await fetch(new URL('/api/generate/video', input.origin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-video-provider': input.provider,
    },
    body: JSON.stringify({
      prompt: input.prompt,
      duration: input.duration,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    }),
  });
  const video = (await videoResponse.json().catch(() => ({}))) as GenerateVideoResponse;
  return buildA3OpenMAICVideoPayload({
    provider: input.provider,
    status: videoResponse.ok && video.success && video.result?.url ? 'succeeded' : 'failed',
    resourceType: input.resourceType,
    result: video.result,
    error: video.error || (videoResponse.ok ? '' : `视频生成接口失败：${videoResponse.status}`),
  }, Date.now() - input.startedAt);
}

function updateVideoJob(jobId: string, patch: Partial<VideoJob>) {
  const job = videoJobs.get(jobId);
  if (!job) return;
  videoJobs.set(jobId, {
    ...job,
    ...patch,
    updatedAt: Date.now(),
  });
}

function cleanupExpiredVideoJobs() {
  const now = Date.now();
  for (const [jobId, job] of videoJobs.entries()) {
    if (now - job.updatedAt > VIDEO_JOB_TTL_MS) videoJobs.delete(jobId);
  }
}

function getA3UserId(user: A3PublicUser | null | undefined) {
  const record = (user ?? {}) as Record<string, unknown>;
  return String(record.id || record.userId || record.email || record.username || '');
}

async function generateSegmentedVideoArtifact(input: {
  origin: string;
  provider: string;
  resourceType: string;
  requests: SegmentedVideoRequest[];
  startedAt: number;
  onProgress?: (segmentIndex: number, totalSegments: number) => void;
}) {
  const segments = [];
  for (let index = 0; index < input.requests.length; index += 1) {
    const segmentRequest = input.requests[index];
    input.onProgress?.(index + 1, input.requests.length);
    try {
      const response = await fetch(new URL('/api/generate/video', input.origin), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-video-provider': input.provider,
        },
        body: JSON.stringify({
          prompt: segmentRequest.prompt,
          duration: segmentRequest.duration,
          aspectRatio: segmentRequest.aspectRatio,
          resolution: segmentRequest.resolution,
        }),
      });
      const video = (await response.json().catch(() => ({}))) as GenerateVideoResponse;
      const succeeded = response.ok && video.success && Boolean(video.result?.url);
      segments.push({
        index: index + 1,
        title: segmentRequest.title,
        status: succeeded ? 'succeeded' : 'failed',
        videoUrl: video.result?.url ?? '',
        duration: Number(video.result?.duration ?? segmentRequest.duration),
        width: Number(video.result?.width ?? 0),
        height: Number(video.result?.height ?? 0),
        degradedReason: succeeded ? '' : (video.error || (response.ok ? '视频片段未返回播放地址' : `视频生成接口失败：${response.status}`)),
      });
    } catch (error) {
      segments.push({
        index: index + 1,
        title: segmentRequest.title,
        status: 'failed',
        videoUrl: '',
        duration: segmentRequest.duration,
        width: 0,
        height: 0,
        degradedReason: error instanceof Error ? error.message : '视频片段生成失败',
      });
    }
  }

  const succeededSegments = segments.filter((segment) => segment.status === 'succeeded' && segment.videoUrl);
  const firstSucceeded = succeededSegments[0];
  const status = succeededSegments.length === segments.length ? 'succeeded' : succeededSegments.length ? 'partial' : 'failed';
  return buildA3OpenMAICVideoPayload({
    provider: input.provider,
    status,
    resourceType: input.resourceType,
    result: {
      url: firstSucceeded?.videoUrl ?? '',
      duration: succeededSegments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0),
      width: Number(firstSucceeded?.width ?? 0),
      height: Number(firstSucceeded?.height ?? 0),
    },
    segments,
    error: status === 'succeeded' ? '' : `1 分钟视频分段生成完成：${succeededSegments.length}/${segments.length} 段成功`,
  }, Date.now() - input.startedAt);
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
