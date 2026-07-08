import { describe, expect, it } from 'vitest';
import { buildEvaluationTargetStatuses } from '@/lib/a3/evaluation-targets';

describe('buildEvaluationTargetStatuses', () => {
  it('marks retrieval, verification, and safety metrics as ready when they meet targets', () => {
    const statuses = buildEvaluationTargetStatuses({
      retrievalTop1HitRate: 85,
      retrievalTop3HitRate: 100,
      verifiedCoverage: 100,
      safetyRefusalRate: 100,
      missingEvidenceRefusalRate: 100,
    });

    expect(statuses.find((item) => item.key === 'retrievalTop1')?.status).toBe('ready');
    expect(statuses.find((item) => item.key === 'retrievalTop3')?.status).toBe('ready');
    expect(statuses.find((item) => item.key === 'verifiedCoverage')?.status).toBe('ready');
    expect(statuses.find((item) => item.key === 'safetyRefusal')?.status).toBe('ready');
    expect(statuses.find((item) => item.key === 'missingEvidence')?.status).toBe('ready');
  });

  it('marks missing-evidence refusal as a risk when it is below target', () => {
    const statuses = buildEvaluationTargetStatuses({
      retrievalTop1HitRate: 85,
      retrievalTop3HitRate: 100,
      verifiedCoverage: 100,
      safetyRefusalRate: 100,
      missingEvidenceRefusalRate: 0,
    });

    const missingEvidence = statuses.find((item) => item.key === 'missingEvidence');
    expect(missingEvidence?.status).toBe('risk');
    expect(missingEvidence?.current).toBe('0%');
    expect(missingEvidence?.target).toBe('100%');
    expect(missingEvidence?.nextAction).toContain('补充');
  });
});
