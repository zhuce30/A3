import type { A3OpenMAICVideoPayload } from './openmaic-classroom-bridge';

export type A3OpenMAICVideoSmokeReport = {
  schemaVersion: 'a3.openmaic-video-smoke-report.v1';
  status: string;
  success: boolean;
  provider: string;
  checkedAt: string;
  reason: string;
  videoUrl: string;
  duration: number;
  width: number;
  height: number;
  elapsedMs: number;
  reportPath: string;
};

export type OpenMAICVideoSmokePayloadResult =
  | { ok: true; payload: A3OpenMAICVideoPayload }
  | { ok: false; error: string };

export type SmokeWritebackResourcePackCandidate = {
  resourcePackId?: string;
  createdAt?: string;
};

export type SmokeWritebackResourcePackSelection =
  | { ok: true; resourcePackId: string; source: 'explicit' | 'latest' }
  | { ok: false; error: string };

export function normalizeOpenMAICVideoSmokeReport(input: Record<string, unknown>): A3OpenMAICVideoSmokeReport {
  return {
    schemaVersion: 'a3.openmaic-video-smoke-report.v1',
    status: stringValue(input.status, 'unknown'),
    success: Boolean(input.success),
    provider: stringValue(input.provider, 'unknown'),
    checkedAt: stringValue(input.checkedAt),
    reason: stringValue(input.reason),
    videoUrl: stringValue(input.videoUrl),
    duration: numberValue(input.duration),
    width: numberValue(input.width),
    height: numberValue(input.height),
    elapsedMs: numberValue(input.elapsedMs),
    reportPath: stringValue(input.reportPath, 'tmp/a3-openmaic-smoke-report.json'),
  };
}

export function buildOpenMAICVideoPayloadFromSmokeReport(
  report: A3OpenMAICVideoSmokeReport,
): OpenMAICVideoSmokePayloadResult {
  if (report.status !== 'succeeded' || !report.success) {
    return { ok: false, error: `最近视频 smoke 未成功：${report.reason || report.status || 'unknown'}` };
  }
  if (!report.videoUrl) {
    return { ok: false, error: '最近视频 smoke 未生成 videoUrl，不能写回资源包。' };
  }
  return {
    ok: true,
    payload: {
      type: 'openmaic_video',
      status: 'succeeded',
      provider: report.provider || 'unknown',
      resourceType: 'micro_video_script',
      videoUrl: report.videoUrl,
      duration: report.duration,
      width: report.width,
      height: report.height,
      elapsedMs: report.elapsedMs,
      degradedReason: '',
    },
  };
}

export function selectSmokeWritebackResourcePackId(
  packs: SmokeWritebackResourcePackCandidate[],
  preferredResourcePackId?: string,
): SmokeWritebackResourcePackSelection {
  const explicit = stringValue(preferredResourcePackId);
  if (explicit && explicit !== 'latest') {
    return { ok: true, resourcePackId: explicit, source: 'explicit' };
  }

  const candidates = packs
    .filter((pack) => stringValue(pack.resourcePackId))
    .sort((left, right) => timestampMs(right.createdAt) - timestampMs(left.createdAt));
  const latest = candidates[0]?.resourcePackId;
  if (!latest) {
    return { ok: false, error: '没有可写回的资源包，请先在推荐页生成一个 A3 资源包。' };
  }
  return { ok: true, resourcePackId: latest, source: 'latest' };
}

function stringValue(value: unknown, fallback = '') {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return text || fallback;
}

function numberValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function timestampMs(value: unknown) {
  const text = stringValue(value);
  if (!text) return 0;
  const time = new Date(text).getTime();
  return Number.isNaN(time) ? 0 : time;
}
