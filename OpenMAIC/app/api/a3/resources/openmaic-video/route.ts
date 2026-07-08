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
  artifact?: A3OpenMAICVideoArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

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
    const prompt = String(body.prompt || '').trim();
    const provider = String(body.provider || 'seedance').trim();
    const resourceType = String(body.resourceType || 'micro_video_script').trim();
    if (!resourcePackId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId');
    if (!prompt) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少视频 prompt');

    const videoResponse = await fetch(new URL('/api/generate/video', request.nextUrl.origin), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-video-provider': provider,
      },
      body: JSON.stringify({
        prompt,
        duration: body.duration === 10 ? 10 : 5,
        aspectRatio: body.aspectRatio || '16:9',
        resolution: body.resolution || '1080p',
      }),
    });
    const video = (await videoResponse.json().catch(() => ({}))) as GenerateVideoResponse;
    const artifactPayload = buildA3OpenMAICVideoPayload({
      provider,
      status: videoResponse.ok && video.success && video.result?.url ? 'succeeded' : 'failed',
      resourceType,
      result: video.result,
      error: video.error || (videoResponse.ok ? '' : `视频生成接口失败：${videoResponse.status}`),
    }, Date.now() - startedAt);

    const persisted = await postA3DjangoJson<DjangoVideoArtifactResponse>(
      `/api/resources/packs/${resourcePackId}/openmaic-video/`,
      cookieHeader,
      artifactPayload,
    );
    if (!persisted.success) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 视频产物回写失败');
    }

    return apiSuccess({
      artifact: persisted.artifact,
      resourcePack: persisted.resourcePack,
      traceId: persisted.traceId,
      degraded: artifactPayload.status !== 'succeeded',
    }, artifactPayload.status === 'succeeded' ? 200 : 202);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, 'A3 视频生成桥接暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
