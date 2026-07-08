import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';

type SummaryResponse = {
  summary?: unknown;
  session?: unknown;
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json().catch(() => ({})) as { coachingSessionId?: string };
    const coachingSessionId = String(body.coachingSessionId || '').trim();
    if (!coachingSessionId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少实时辅导会话 ID');
    const result = await postA3DjangoJson<SummaryResponse>(
      `/api/learning/coaching/sessions/${encodeURIComponent(coachingSessionId)}/summary/`,
      cookieHeader,
      {},
    );
    if (!result.success) return apiError('UPSTREAM_ERROR', 502, result.error || '实时辅导总结生成失败');
    return apiSuccess({ summary: result.summary ?? null, session: result.session ?? null });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时辅导总结生成失败', error instanceof Error ? error.message : undefined);
  }
}
