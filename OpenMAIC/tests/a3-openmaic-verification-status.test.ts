import { describe, expect, it } from 'vitest';
import { A3_OPENMAIC_PAGE_OWNERSHIP } from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICVerificationSummary } from '@/lib/a3/openmaic-verification-status';

describe('A3 OpenMAIC verification status', () => {
  it('marks bridge/unit/e2e evidence ready and video smoke warning when provider key is missing', () => {
    const summary = buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, false);

    expect(summary.total).toBe(4);
    expect(summary.ready).toBe(3);
    expect(summary.warnings).toBe(1);
    expect(summary.items.find((item) => item.key === 'e2e-bridge')?.command).toContain('a3-openmaic-bridge.spec.ts');
    expect(summary.items.find((item) => item.key === 'video-smoke')?.status).toBe('warning');
  });

  it('marks real video smoke ready when runtime detects a provider key', () => {
    const summary = buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, true);

    expect(summary.ready).toBe(summary.total);
    expect(summary.warnings).toBe(0);
    expect(summary.coverage).toBe(100);
    expect(summary.items.find((item) => item.key === 'video-smoke')?.evidence).toContain('/api/generate/video');
  });
});
