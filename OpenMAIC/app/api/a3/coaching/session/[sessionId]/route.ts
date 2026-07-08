import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type SessionDetailResponse = {
  session?: Record<string, unknown>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const cookieHeader = request.headers.get('cookie');
    const result = await fetchA3DjangoJson<SessionDetailResponse>(`/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/`, cookieHeader);
    if (!result.success || !result.session) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导记录加载失败');
    }
    return apiSuccess({ session: result.session });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导记录暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
