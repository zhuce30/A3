import { describe, expect, it } from 'vitest';
import { buildOpenMAICAcceptanceSummary } from '@/lib/a3/openmaic-acceptance';
import { A3_OPENMAIC_PAGE_OWNERSHIP } from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICVerificationSummary } from '@/lib/a3/openmaic-verification-status';

describe('A3 OpenMAIC acceptance checklist', () => {
  it('covers page boundary, artifact writeback, history, classroom, teacher, video smoke, and smoke writeback', () => {
    const summary = buildOpenMAICAcceptanceSummary(
      A3_OPENMAIC_PAGE_OWNERSHIP,
      buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, false),
    );

    expect(summary.items.map((item) => item.key)).toEqual([
      'page-boundary',
      'resource-artifact-writeback',
      'artifact-history',
      'classroom-pptx-boundary',
      'teacher-effect',
      'video-smoke',
      'video-smoke-writeback',
    ]);
    expect(summary.total).toBe(7);
    expect(summary.ready).toBe(5);
    expect(summary.warnings).toBe(2);
  });

  it('becomes fully ready when real video provider smoke is available', () => {
    const summary = buildOpenMAICAcceptanceSummary(
      A3_OPENMAIC_PAGE_OWNERSHIP,
      buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, true),
    );

    expect(summary.ready).toBe(summary.total);
    expect(summary.items.find((item) => item.key === 'video-smoke')?.status).toBe('ready');
    expect(summary.items.find((item) => item.key === 'video-smoke-writeback')?.standard).toContain('videoUrl');
    expect(summary.items.find((item) => item.key === 'teacher-effect')?.command).toContain('a3-openmaic-bridge.spec.ts');
  });
});
