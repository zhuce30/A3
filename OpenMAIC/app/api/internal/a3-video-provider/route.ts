import { timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { normalizeVideoOptions } from '@/lib/media/video-providers';
import { pollSeedanceTask, submitSeedanceTask } from '@/lib/media/adapters/seedance-adapter';
import { resolveVideoApiKey, resolveVideoBaseUrl } from '@/lib/server/provider-config';
import type { VideoGenerationConfig, VideoGenerationOptions } from '@/lib/media/types';

export const maxDuration = 60;

type ProviderBridgeBody = {
  action?: 'submit' | 'poll';
  provider?: string;
  providerTaskId?: string;
  prompt?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
};

export async function POST(request: NextRequest) {
  if (!validWorkerToken(request.headers.get('x-a3-video-worker-token'))) {
    return apiError('UNAUTHORIZED', 403, 'Forbidden');
  }
  try {
    const body = (await request.json()) as ProviderBridgeBody;
    if (body.provider !== 'seedance') return apiError('INVALID_REQUEST', 400, 'Unsupported video provider');
    const config = seedanceConfig();
    if (body.action === 'submit') {
      const prompt = String(body.prompt || '').trim();
      if (!prompt || prompt.length > 12_000) return apiError('INVALID_REQUEST', 400, 'Invalid video prompt');
      const options = normalizeVideoOptions('seedance', {
        prompt,
        duration: Number(body.duration || 10),
        aspectRatio: body.aspectRatio as VideoGenerationOptions['aspectRatio'],
        resolution: body.resolution as VideoGenerationOptions['resolution'],
      });
      const providerTaskId = await submitSeedanceTask(config, options);
      return apiSuccess({ providerTaskId, status: 'queued' });
    }
    if (body.action === 'poll') {
      const providerTaskId = String(body.providerTaskId || '').trim();
      if (!providerTaskId || providerTaskId.length > 160) return apiError('INVALID_REQUEST', 400, 'Invalid provider task ID');
      const result = await pollSeedanceTask(config, providerTaskId);
      if (!result) return apiSuccess({ status: 'running' });
      return apiSuccess({ status: 'succeeded', result });
    }
    return apiError('INVALID_REQUEST', 400, 'Invalid provider action');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Video provider request failed';
    if (message.includes('video generation failed')) {
      return apiSuccess({ status: 'failed', error: message });
    }
    return apiError('UPSTREAM_ERROR', 502, 'Video provider request failed', message);
  }
}

function seedanceConfig(): VideoGenerationConfig {
  const apiKey = resolveVideoApiKey('seedance');
  if (!apiKey) throw new Error('Seedance API key is not configured');
  return {
    providerId: 'seedance',
    apiKey,
    baseUrl: resolveVideoBaseUrl('seedance'),
  };
}

function validWorkerToken(supplied: string | null) {
  const configured = process.env.A3_VIDEO_WORKER_TOKEN?.trim() || '';
  if (!configured || !supplied) return false;
  const expectedBuffer = Buffer.from(configured);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
