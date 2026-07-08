import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import type { CoachingSessionListItem } from '@/lib/a3/coaching-types';

type SessionsResponse = {
  sessions?: CoachingSessionListItem[];
};

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const limit = new URL(request.url).searchParams.get('limit') || '20';
    const result = await fetchA3DjangoJson<SessionsResponse>(`/api/learning/coaching/sessions/?limit=${encodeURIComponent(limit)}`, cookieHeader);
    if (!result.success || !Array.isArray(result.sessions)) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导历史加载失败');
    }
    return apiSuccess({ sessions: result.sessions });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导历史暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
