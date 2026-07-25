import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import { exchangeRealtimeSdp } from '@/lib/server/a3-realtime-sdp';
import type { A3RealtimeProvider } from '@/lib/a3/realtime-coaching-types';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3TutorPersona } from '@/lib/a3/tutor-persona-types';
import { resolveA3TutorPersonaRuntime } from '@/lib/server/a3-tutor-persona-runtime';

type AuthMeResponse = { user?: A3PublicUser | null };
type CoachingSessionResponse = {
  session?: {
    id?: string;
    topicTitle?: string;
    tutorPersona?: A3TutorPersona | null;
  };
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) return apiError('UNAUTHORIZED', 401, '请先登录后连接实时辅导');

    const body = await request.json().catch(() => ({})) as {
      provider?: A3RealtimeProvider;
      model?: string;
      offerSdp?: string;
      coachingSessionId?: string;
    };
    const provider = body.provider;
    const offerSdp = String(body.offerSdp || '').trim();
    const coachingSessionId = String(body.coachingSessionId || '').trim();
    if (provider !== 'openai_realtime_webrtc' && provider !== 'dashscope_qwen_omni_realtime') {
      return apiError('INVALID_REQUEST', 400, '不支持的实时 provider');
    }
    if (!offerSdp.startsWith('v=0')) return apiError('INVALID_REQUEST', 400, '请提供有效的 WebRTC Offer SDP');
    if (!coachingSessionId) return apiError('INVALID_REQUEST', 400, '缺少面对面辅导会话 ID');
    const session = await fetchA3DjangoJson<CoachingSessionResponse>(
      `/api/learning/coaching/sessions/${encodeURIComponent(coachingSessionId)}/`,
      cookieHeader,
    );
    if (!session.success || !session.session?.id) {
      return apiError('INVALID_REQUEST', 400, session.error || '面对面辅导会话不存在或无权访问');
    }
    const runtime = resolveA3TutorPersonaRuntime(session.session.tutorPersona?.id);
    const result = await exchangeRealtimeSdp({
      provider,
      model: String(body.model || ''),
      offerSdp,
      runtime,
      targetTitle: session.session.topicTitle || '面对面辅导',
      safetyIdentifier: `a3_user_${auth.user.id || auth.user.phone || 'unknown'}`,
    });
    if (!result.success) return apiError('UPSTREAM_ERROR', 502, result.error || '实时 SDP 交换失败');
    return apiSuccess({ answerSdp: result.answerSdp || '' });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '实时 SDP 交换失败', error instanceof Error ? error.message : undefined);
  }
}
