import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';

type CoachingSessionResponse = {
  session?: {
    id?: string;
    schemaVersion: string;
    messages: Array<Record<string, unknown>>;
    summary: string;
    updatedAt: string;
  };
};

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const result = await fetchA3DjangoJson<CoachingSessionResponse>('/api/learning/coaching/session/', cookieHeader);
    if (!result.success || !result.session) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '面对面辅导记录加载失败');
    }
    return apiSuccess({ session: result.session });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '面对面辅导记录暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json() as { messages?: unknown[]; summary?: string };
    const result = await postA3DjangoJson<CoachingSessionResponse>(
      '/api/learning/coaching/session/',
      cookieHeader,
      {
        messages: Array.isArray(body.messages) ? body.messages : [],
        ...(body.summary ? { summary: body.summary } : {}),
      },
    );
    if (!result.success || !result.session) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '面对面辅导记录保存失败');
    }
    return apiSuccess({ session: result.session }, 201);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '面对面辅导记录保存失败', error instanceof Error ? error.message : undefined);
  }
}
