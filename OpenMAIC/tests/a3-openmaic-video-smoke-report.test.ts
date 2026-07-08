import { describe, expect, it } from 'vitest';
import {
  buildOpenMAICVideoPayloadFromSmokeReport,
  normalizeOpenMAICVideoSmokeReport,
  selectSmokeWritebackResourcePackId,
} from '@/lib/a3/openmaic-video-smoke-report';

describe('A3 OpenMAIC video smoke report writeback', () => {
  it('rejects skipped smoke reports instead of creating successful video artifacts', () => {
    const report = normalizeOpenMAICVideoSmokeReport({
      schemaVersion: 'a3.openmaic-video-smoke-report.v1',
      status: 'skipped',
      success: false,
      provider: 'seedance',
      checkedAt: '2026-07-03T00:00:00.000Z',
      reason: 'missing provider key',
    });

    const result = buildOpenMAICVideoPayloadFromSmokeReport(report);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('skipped report should not build payload');
    expect(result.error).toContain('未成功');
  });

  it('builds a Django video artifact payload from a successful real provider report', () => {
    const report = normalizeOpenMAICVideoSmokeReport({
      schemaVersion: 'a3.openmaic-video-smoke-report.v1',
      status: 'succeeded',
      success: true,
      provider: 'seedance',
      checkedAt: '2026-07-03T00:00:00.000Z',
      videoUrl: 'https://cdn.example.com/a3-smoke.mp4',
      duration: 5,
      width: 1280,
      height: 720,
      elapsedMs: 1234,
    });

    const result = buildOpenMAICVideoPayloadFromSmokeReport(report);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.payload).toMatchObject({
      type: 'openmaic_video',
      status: 'succeeded',
      provider: 'seedance',
      resourceType: 'micro_video_script',
      videoUrl: 'https://cdn.example.com/a3-smoke.mp4',
      duration: 5,
      width: 1280,
      height: 720,
      elapsedMs: 1234,
      degradedReason: '',
    });
  });

  it('selects an explicit resource pack id before falling back to the newest pack', () => {
    const packs = [
      { resourcePackId: 'older-pack', createdAt: '2026-07-01T00:00:00.000Z' },
      { resourcePackId: 'newer-pack', createdAt: '2026-07-03T00:00:00.000Z' },
    ];

    expect(selectSmokeWritebackResourcePackId(packs, 'manual-pack')).toEqual({
      ok: true,
      resourcePackId: 'manual-pack',
      source: 'explicit',
    });
    expect(selectSmokeWritebackResourcePackId(packs, '')).toEqual({
      ok: true,
      resourcePackId: 'newer-pack',
      source: 'latest',
    });
    expect(selectSmokeWritebackResourcePackId([], 'latest')).toEqual({
      ok: false,
      error: '没有可写回的资源包，请先在推荐页生成一个 A3 资源包。',
    });
  });
});
