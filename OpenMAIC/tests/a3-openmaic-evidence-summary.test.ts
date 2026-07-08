import { describe, expect, it } from 'vitest';
import { buildOpenMAICEvidenceSummary } from '@/lib/a3/openmaic-evidence-summary';
import { A3_OPENMAIC_PAGE_OWNERSHIP, buildOpenMAICPageOwnershipMetrics } from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICVerificationSummary } from '@/lib/a3/openmaic-verification-status';

describe('A3 OpenMAIC evidence summary', () => {
  it('builds a one-screen defense summary from page ownership, artifacts, smoke, trace, and verification commands', () => {
    const summary = buildOpenMAICEvidenceSummary({
      pageMetrics: buildOpenMAICPageOwnershipMetrics(A3_OPENMAIC_PAGE_OWNERSHIP),
      verification: buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, true),
      artifactAudit: {
        schemaVersion: 'a3.openmaic-artifact-audit.v1',
        total: 3,
        classroom: 1,
        classroomSucceeded: 1,
        video: 2,
        videoSucceeded: 1,
        videoDegraded: 1,
        latestArtifacts: [
          { type: 'openmaic_video', status: 'succeeded', provider: 'happyhorse', resourcePackId: 'pack-1' },
        ],
      },
      smokeReport: {
        status: 'succeeded',
        success: true,
        provider: 'happyhorse',
        hasVideoUrl: true,
        path: 'tmp/a3-openmaic-smoke-report.json',
      },
      latestTraceId: 'trace-openmaic-001',
      latestRagMode: 'vector',
    });

    expect(summary.schemaVersion).toBe('a3.openmaic-evidence-summary.v1');
    expect(summary.status).toBe('ready');
    expect(summary.cards.map((card) => card.key)).toEqual([
      'page-ownership',
      'artifact-audit',
      'video-smoke',
      'agent-trace',
    ]);
    expect(summary.cards.find((card) => card.key === 'page-ownership')?.value).toBe('6/6');
    expect(summary.cards.find((card) => card.key === 'artifact-audit')?.value).toBe('3');
    expect(summary.cards.find((card) => card.key === 'video-smoke')?.value).toBe('happyhorse');
    expect(summary.cards.find((card) => card.key === 'agent-trace')?.detail).toContain('vector');
    expect(summary.proofCommands).toContain('npx playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium');
    expect(summary.nextActions).toEqual([]);
  });

  it('surfaces concrete next actions when provider smoke or artifact writeback is missing', () => {
    const summary = buildOpenMAICEvidenceSummary({
      pageMetrics: buildOpenMAICPageOwnershipMetrics(A3_OPENMAIC_PAGE_OWNERSHIP),
      verification: buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, false),
      artifactAudit: {
        schemaVersion: 'a3.openmaic-artifact-audit.v1',
        total: 0,
        classroom: 0,
        classroomSucceeded: 0,
        video: 0,
        videoSucceeded: 0,
        videoDegraded: 0,
        latestArtifacts: [],
      },
      smokeReport: {
        status: 'skipped',
        success: false,
        provider: 'seedance',
        hasVideoUrl: false,
        reason: 'missing provider key',
        path: 'tmp/a3-openmaic-smoke-report.json',
      },
      latestTraceId: '',
      latestRagMode: 'unknown',
    });

    expect(summary.status).toBe('warning');
    expect(summary.nextActions).toContain('在推荐页生成资源包并触发课堂、PPTX 或视频 artifact 写回。');
    expect(summary.nextActions).toContain('配置真实视频 provider key 后运行 pnpm smoke:a3-video。');
    expect(summary.nextActions).toContain('运行 Agent workflow 评测生成最新 trace。');
  });
});
