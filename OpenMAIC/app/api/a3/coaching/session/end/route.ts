import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';

type CoachingSessionResponse = {
  session?: {
    id?: string;
    schemaVersion: string;
    messages: Array<Record<string, unknown>>;
    summary: string;
    updatedAt: string;
    status?: string;
  };
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const result = await postA3DjangoJson<CoachingSessionResponse>(
      '/api/learning/coaching/session/end/',
      cookieHeader,
      {},
    );
    if (!result.success || !result.session) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '面对面辅导会话结束失败');
    }
    return apiSuccess({ session: result.session });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '面对面辅导会话结束失败', error instanceof Error ? error.message : undefined);
  }
}
