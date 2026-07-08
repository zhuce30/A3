import { NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后使用视觉辅导');
    }

    const body = await request.json() as { image?: string; message?: string };
    return answerA3VisionQuestion({
      cookieHeader,
      image: body.image ?? '',
      message: body.message ?? '',
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '视觉辅导服务暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
