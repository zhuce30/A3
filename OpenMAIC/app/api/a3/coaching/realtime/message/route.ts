import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';

type CoachingSessionResponse = {
  session?: unknown;
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json().catch(() => ({})) as {
      messages?: unknown[];
      summary?: string;
    };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return apiError('MISSING_REQUIRED_FIELD', 400, '请提供需要保存的实时辅导消息');
    const result = await postA3DjangoJson<CoachingSessionResponse>(
      '/api/learning/coaching/session/',
      cookieHeader,
      { messages, summary: String(body.summary || '') },
    );
    if (!result.success) return apiError('UPSTREAM_ERROR', 502, result.error || '实时辅导消息保存失败');
    return apiSuccess({ session: result.session ?? null });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时辅导消息保存失败', error instanceof Error ? error.message : undefined);
  }
}
