import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type InteractionRequest = {
  resourcePackId?: string;
  eventType?: string;
  classroomId?: string;
  classroomJobId?: string;
  classroomUrl?: string;
  sceneId?: string;
  sceneTitle?: string;
  actionType?: string;
  actionId?: string;
  progress?: number;
  elapsedMs?: number;
};

type DjangoInteractionResponse = {
  interaction?: Record<string, unknown>;
  traceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后写回 OpenMAIC 课堂互动。');
    }

    const body = (await request.json().catch(() => ({}))) as InteractionRequest;
    const resourcePackId = String(body.resourcePackId || '').trim();
    if (!resourcePackId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId。');
    }
    const classroomId = String(body.classroomId || '').trim();
    if (!classroomId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 classroomId。');
    }
    const classroomJobId = String(body.classroomJobId || '').trim();
    if (!classroomJobId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 classroomJobId。');
    }
    const actionType = String(body.actionType || '').trim();
    if (!actionType) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 actionType。');
    }

    const payload = {
      eventType: String(body.eventType || 'interaction'),
      classroomId,
      classroomJobId,
      classroomUrl: String(body.classroomUrl || ''),
      sceneId: String(body.sceneId || ''),
      sceneTitle: String(body.sceneTitle || ''),
      actionType,
      actionId: String(body.actionId || ''),
      progress: Number(body.progress || 0),
      elapsedMs: Number(body.elapsedMs || 0),
    };

    const persisted = await postA3DjangoJson<DjangoInteractionResponse>(
      `/api/resources/packs/${resourcePackId}/openmaic-interaction/`,
      cookieHeader,
      payload,
    );
    if (!persisted.success) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 OpenMAIC 互动写回失败。');
    }

    return apiSuccess({
      interaction: persisted.interaction,
      traceId: persisted.traceId,
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'A3 OpenMAIC 互动写回暂时不可用。',
      error instanceof Error ? error.message : undefined,
    );
  }
}
