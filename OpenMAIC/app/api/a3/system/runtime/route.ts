import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type RuntimeCheckStatus = 'ok' | 'warning' | 'error';
type RuntimeCheckDetail = Record<string, string | boolean | number | Record<string, unknown>>;

type DjangoHealthResponse = {
  overallStatus?: RuntimeCheckStatus;
  checks?: Array<{
    name: string;
    status: RuntimeCheckStatus;
    message: string;
    detail?: RuntimeCheckDetail;
  }>;
};

function check(name: string, status: RuntimeCheckStatus, message: string, detail: RuntimeCheckDetail = {}) {
  return { name, status, message, detail };
}

function configured(...names: string[]) {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

function value(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function readOpenMAICSmokeReport() {
  const reportPath = path.join(process.cwd(), 'tmp', 'a3-openmaic-smoke-report.json');
  if (!fs.existsSync(reportPath)) {
    return {
      available: false,
      path: 'tmp/a3-openmaic-smoke-report.json',
      status: 'not_run',
      success: false,
    };
  }
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    return {
      available: true,
      path: 'tmp/a3-openmaic-smoke-report.json',
      schemaVersion: String(report.schemaVersion || 'a3.openmaic-video-smoke-report.v1'),
      status: String(report.status || 'unknown'),
      success: Boolean(report.success),
      provider: String(report.provider || ''),
      checkedAt: String(report.checkedAt || ''),
      command: String(report.command || 'A3_RUN_REAL_VIDEO_SMOKE=1 pnpm smoke:a3-video'),
      reason: String(report.reason || ''),
      hasProviderKey: Boolean(report.hasProviderKey),
      hasVideoUrl: Boolean(report.videoUrl),
      duration: Number(report.duration || 0),
      width: Number(report.width || 0),
      height: Number(report.height || 0),
      elapsedMs: Number(report.elapsedMs || 0),
    };
  } catch (error) {
    return {
      available: false,
      path: 'tmp/a3-openmaic-smoke-report.json',
      status: 'invalid',
      success: false,
      reason: error instanceof Error ? error.message : 'invalid smoke report',
    };
  }
}

export async function GET(request: NextRequest) {
  const cookieHeader = request.headers.get('cookie');
  const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
  if (!auth.success || !auth.user) {
    return apiError('UNAUTHORIZED', 401, 'Please login first');
  }

  const djangoHealth = await fetchA3DjangoJson<DjangoHealthResponse>('/api/system/health/', cookieHeader);
  const celeryBeatCheck = djangoHealth.success
    ? djangoHealth.checks?.find((item) => item.name === 'celeryBeat')
    : null;

  const checks = [
    check('djangoApi', configured('NEXT_PUBLIC_A3_API_BASE_URL') ? 'ok' : 'warning', 'Django API base URL is resolved', {
      baseUrl: value('NEXT_PUBLIC_A3_API_BASE_URL', 'http://localhost:8000'),
    }),
    check('textCoachingModel', configured('A3_COACHING_API_KEY', 'QWEN_API_KEY', 'ASR_QWEN_API_KEY') ? 'ok' : 'warning', 'Text coaching model configuration', {
      configured: configured('A3_COACHING_API_KEY', 'QWEN_API_KEY', 'ASR_QWEN_API_KEY'),
      baseUrl: value('A3_COACHING_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      model: value('A3_COACHING_MODEL', 'qwen-plus'),
    }),
    check('visionCoachingModel', configured('A3_VISION_COACHING_API_KEY', 'A3_COACHING_API_KEY', 'QWEN_API_KEY', 'ASR_QWEN_API_KEY') ? 'ok' : 'warning', 'Vision coaching model configuration', {
      configured: configured('A3_VISION_COACHING_API_KEY', 'A3_COACHING_API_KEY', 'QWEN_API_KEY', 'ASR_QWEN_API_KEY'),
      baseUrl: value('A3_VISION_COACHING_BASE_URL', value('A3_COACHING_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1')),
      model: value('A3_VISION_COACHING_MODEL', 'qwen-vl-plus'),
    }),
    check('speechRecognition', configured('ASR_QWEN_API_KEY', 'ASR_OPENAI_API_KEY', 'ASR_LEMONADE_BASE_URL') ? 'ok' : 'warning', 'Speech recognition provider configuration', {
      configured: configured('ASR_QWEN_API_KEY', 'ASR_OPENAI_API_KEY', 'ASR_LEMONADE_BASE_URL'),
      qwen: configured('ASR_QWEN_API_KEY'),
      openaiCompatible: configured('ASR_OPENAI_API_KEY'),
      localLemonade: configured('ASR_LEMONADE_BASE_URL'),
    }),
    check('textToSpeech', configured('TTS_QWEN_API_KEY', 'TTS_OPENAI_API_KEY', 'TTS_AZURE_API_KEY', 'TTS_GLM_API_KEY') ? 'ok' : 'warning', 'Text-to-speech provider configuration', {
      configured: configured('TTS_QWEN_API_KEY', 'TTS_OPENAI_API_KEY', 'TTS_AZURE_API_KEY', 'TTS_GLM_API_KEY'),
    }),
    check('openmaicVideoProvider', configured('VIDEO_SEEDANCE_API_KEY', 'VIDEO_KLING_API_KEY', 'VIDEO_VEO_API_KEY', 'VIDEO_SORA_API_KEY', 'VIDEO_MINIMAX_API_KEY', 'VIDEO_GROK_API_KEY', 'VIDEO_HAPPYHORSE_API_KEY', 'A3_VIDEO_SMOKE_API_KEY') ? 'ok' : 'warning', 'OpenMAIC video provider configuration', {
      configured: configured('VIDEO_SEEDANCE_API_KEY', 'VIDEO_KLING_API_KEY', 'VIDEO_VEO_API_KEY', 'VIDEO_SORA_API_KEY', 'VIDEO_MINIMAX_API_KEY', 'VIDEO_GROK_API_KEY', 'VIDEO_HAPPYHORSE_API_KEY', 'A3_VIDEO_SMOKE_API_KEY'),
      seedance: configured('VIDEO_SEEDANCE_API_KEY'),
      smokeOverride: configured('A3_VIDEO_SMOKE_API_KEY'),
      smokeCommand: 'pnpm smoke:a3-video',
    }),
    celeryBeatCheck
      ? check('celeryBeat', celeryBeatCheck.status, celeryBeatCheck.message, celeryBeatCheck.detail ?? {})
      : check('celeryBeat', 'warning', 'Django system health did not return Celery beat status', { source: '/api/system/health/' }),
  ];
  const statuses = new Set(checks.map((item) => item.status));
  const overallStatus: RuntimeCheckStatus = statuses.has('error') ? 'error' : statuses.has('warning') ? 'warning' : 'ok';
  return apiSuccess({ overallStatus, checks, openmaicSmokeReport: readOpenMAICSmokeReport() });
}
