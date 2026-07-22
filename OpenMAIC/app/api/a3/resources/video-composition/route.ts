import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, patchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';

type CompositionResponse = { success?: boolean; error?: string; composition?: Record<string, unknown> };

function jobIdFrom(request: NextRequest, body?: Record<string, unknown>) {
  return String(body?.jobId || request.nextUrl.searchParams.get('jobId') || '').trim();
}

export async function GET(request: NextRequest) {
  const jobId = jobIdFrom(request);
  if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
  const result = await fetchA3DjangoJson<CompositionResponse>(
    `/api/resources/video-jobs/${encodeURIComponent(jobId)}/composition/`,
    request.headers.get('cookie'),
  );
  if (!result.success || !result.composition) return apiError('UPSTREAM_ERROR', 502, result.error || '视频制作状态加载失败');
  return apiSuccess({ composition: result.composition });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>;
  const jobId = jobIdFrom(request, body);
  if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
  const { jobId: _jobId, ...changes } = body;
  const result = await patchA3DjangoJson<CompositionResponse>(
    `/api/resources/video-jobs/${encodeURIComponent(jobId)}/composition/`,
    request.headers.get('cookie'),
    changes,
  );
  if (!result.success || !result.composition) return apiError('UPSTREAM_ERROR', 502, result.error || '视频制作设置保存失败');
  return apiSuccess({ composition: result.composition });
}

export async function POST(request: NextRequest) {
  const body = await request.json() as Record<string, unknown>;
  const jobId = jobIdFrom(request, body);
  const action = String(body.action || '').trim();
  if (!jobId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 jobId');
  if (!['generate-narration', 'compose'].includes(action)) {
    return apiError('INVALID_REQUEST', 400, '不支持的视频制作操作');
  }
  const endpoint = action === 'generate-narration'
    ? `/api/resources/video-jobs/${encodeURIComponent(jobId)}/composition/generate-narration/`
    : `/api/resources/video-jobs/${encodeURIComponent(jobId)}/composition/compose/`;
  const payload = action === 'generate-narration' ? { segmentIndexes: body.segmentIndexes || [] } : {};
  const result = await postA3DjangoJson<CompositionResponse>(
    endpoint,
    request.headers.get('cookie'),
    payload,
  );
  if (!result.success || !result.composition) return apiError('UPSTREAM_ERROR', 502, result.error || '视频制作任务启动失败');
  return apiSuccess({ composition: result.composition }, 202);
}
