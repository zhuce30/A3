import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICPPTXExportArtifact, A3ResourcePackV2 } from '@/lib/a3/recommendation-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type PPTXExportRequest = {
  resourcePackId?: string;
  jobId?: string;
  status?: string;
  classroomId?: string;
  classroomUrl?: string;
  fileName?: string;
  slidesCount?: number;
  provider?: string;
  elapsedMs?: number;
  degradedReason?: string;
};

type DjangoPPTXExportResponse = {
  artifact?: A3OpenMAICPPTXExportArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后回写 PPTX 导出结果。');
    }

    const body = (await request.json().catch(() => ({}))) as PPTXExportRequest;
    const resourcePackId = String(body.resourcePackId || '').trim();
    if (!resourcePackId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 resourcePackId。');
    }
    const jobId = String(body.jobId || '').trim();
    if (!jobId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, '缺少 PPTX 导出 jobId。');
    }

    const payload = {
      jobId,
      status: String(body.status || 'succeeded'),
      classroomId: String(body.classroomId || ''),
      classroomUrl: String(body.classroomUrl || ''),
      fileName: String(body.fileName || ''),
      slidesCount: Number(body.slidesCount || 0),
      provider: String(body.provider || 'openmaic-pptx-export'),
      elapsedMs: Number(body.elapsedMs || 0),
      degradedReason: String(body.degradedReason || ''),
    };

    const persisted = await postA3DjangoJson<DjangoPPTXExportResponse>(
      `/api/resources/packs/${resourcePackId}/openmaic-pptx-export/`,
      cookieHeader,
      payload,
    );
    if (!persisted.success) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 PPTX 导出回写失败。');
    }

    return apiSuccess({
      artifact: persisted.artifact,
      resourcePack: persisted.resourcePack,
      traceId: persisted.traceId,
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'A3 PPTX 导出回写暂时不可用。',
      error instanceof Error ? error.message : undefined,
    );
  }
}
