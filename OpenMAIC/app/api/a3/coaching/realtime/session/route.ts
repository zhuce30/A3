import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import { createA3RealtimeSession } from '@/lib/server/a3-realtime-provider';
import type { A3RealtimeProvider } from '@/lib/a3/realtime-coaching-types';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { ClassroomContext } from '@/lib/a3/classroom-types';

type AuthMeResponse = { user?: A3PublicUser | null };
type ClassroomResponse = { classroom?: ClassroomContext; error?: string };
type CoachingSessionResponse = {
  session?: {
    id?: string;
    messages?: Array<{ role?: string; content?: string }>;
  };
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) return apiError('UNAUTHORIZED', 401, '请先登录后使用实时面对面辅导');

    const body = await request.json().catch(() => ({})) as {
      preferredProvider?: A3RealtimeProvider;
      mode?: string;
    };
    const classroom = await fetchA3DjangoJson<ClassroomResponse>('/api/learning/classroom/', cookieHeader);
    const targetTitle = classroom.classroom?.target?.title || '面对面辅导';
    const bootstrapMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `实时面对面辅导会话已创建。当前主题：${targetTitle}`,
      createdAt: new Date().toISOString(),
      metadata: { realtime: { event: 'session_created', mode: body.mode || 'voice_video' } },
    };
    const session = await postA3DjangoJson<CoachingSessionResponse>(
      '/api/learning/coaching/session/',
      cookieHeader,
      { messages: [bootstrapMessage], summary: `${targetTitle}：实时面对面辅导已创建` },
    );
    if (!session.success || !session.session?.id) {
      return apiError('UPSTREAM_ERROR', 502, session.error || '创建面对面辅导会话失败');
    }

    const realtime = await createA3RealtimeSession({
      userId: String(auth.user.id || auth.user.phone || 'a3-user'),
      coachingSessionId: session.session.id,
      targetTitle,
      preferredProvider: body.preferredProvider,
    });
    return apiSuccess(realtime);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时面对面辅导会话创建失败', error instanceof Error ? error.message : undefined);
  }
}
