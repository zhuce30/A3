import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import {
  buildOpenMAICVideoPayloadFromSmokeReport,
  normalizeOpenMAICVideoSmokeReport,
  selectSmokeWritebackResourcePackId,
} from '@/lib/a3/openmaic-video-smoke-report';
import type { A3PublicUser } from '@/lib/a3/auth-types';
import type { A3OpenMAICVideoArtifact, A3ResourcePackV2, A3ResourcePacksResponse } from '@/lib/a3/recommendation-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

type DjangoVideoArtifactResponse = {
  artifact?: A3OpenMAICVideoArtifact;
  resourcePack?: A3ResourcePackV2;
  traceId?: string;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后写回视频 smoke 结果。');
    }

    const body = (await request.json().catch(() => ({}))) as { resourcePackId?: string };
    const preferredResourcePackId = String(body.resourcePackId || '').trim();
    const resourcePackSelection = preferredResourcePackId && preferredResourcePackId !== 'latest'
      ? selectSmokeWritebackResourcePackId([], preferredResourcePackId)
      : await selectLatestResourcePackId(cookieHeader, preferredResourcePackId);
    if (!resourcePackSelection.ok) {
      return apiError('MISSING_REQUIRED_FIELD', 400, resourcePackSelection.error);
    }
    const resourcePackId = resourcePackSelection.resourcePackId;

    const reportPath = path.join(process.cwd(), 'tmp', 'a3-openmaic-smoke-report.json');
    if (!fs.existsSync(reportPath)) {
      return apiError('INVALID_REQUEST', 400, '尚未找到视频 smoke 报告，请先运行 pnpm smoke:a3-video。');
    }

    const rawReport = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    const report = normalizeOpenMAICVideoSmokeReport(rawReport);
    const payloadResult = buildOpenMAICVideoPayloadFromSmokeReport(report);
    if (!payloadResult.ok) {
      return apiError('INVALID_REQUEST', 400, payloadResult.error);
    }

    const persisted = await postA3DjangoJson<DjangoVideoArtifactResponse>(
      `/api/resources/packs/${resourcePackId}/openmaic-video/`,
      cookieHeader,
      payloadResult.payload,
    );
    if (!persisted.success) {
      return apiError('UPSTREAM_ERROR', 502, persisted.error || 'A3 视频 smoke 写回失败。');
    }

    return apiSuccess({
      artifact: persisted.artifact,
      resourcePack: persisted.resourcePack,
      traceId: persisted.traceId,
      report: {
        status: report.status,
        provider: report.provider,
        checkedAt: report.checkedAt,
        reportPath: report.reportPath,
        writebackTargetSource: resourcePackSelection.source,
      },
    });
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      500,
      'A3 视频 smoke 写回暂时不可用。',
      error instanceof Error ? error.message : undefined,
    );
  }
}

async function selectLatestResourcePackId(cookieHeader: string | null, preferredResourcePackId: string) {
  const packsResult = await fetchA3DjangoJson<A3ResourcePacksResponse>('/api/resources/packs/', cookieHeader);
  if (!packsResult.success) {
    return {
      ok: false as const,
      error: packsResult.error || '资源包列表加载失败，不能自动选择 smoke 写回目标。',
    };
  }
  return selectSmokeWritebackResourcePackId(packsResult.resourcePacks ?? [], preferredResourcePackId);
}
