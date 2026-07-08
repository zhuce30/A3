import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';

type SummaryResponse = {
  summary?: Record<string, unknown>;
  session?: Record<string, unknown>;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json() as { sessionId?: string };
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少辅导会话 ID');

    const result = await postA3DjangoJson<SummaryResponse>(
      `/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/summary/`,
      cookieHeader,
      {},
    );
    if (!result.success || !result.summary) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导总结生成失败');
    }
    return apiSuccess({ summary: result.summary, session: result.session }, 201);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导总结暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
