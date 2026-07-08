import { describe, expect, it } from 'vitest';
import { buildOpenMAICDemoFlowSteps } from '@/lib/a3/openmaic-demo-flow';
import { A3_OPENMAIC_PAGE_OWNERSHIP } from '@/lib/a3/openmaic-page-ownership';

describe('A3 OpenMAIC demo flow', () => {
  it('turns page ownership into a fixed presentation path', () => {
    const steps = buildOpenMAICDemoFlowSteps(A3_OPENMAIC_PAGE_OWNERSHIP);

    expect(steps.map((step) => step.href)).toEqual([
      '/a3/recommendations',
      '/a3/resources/latest',
      '/a3/classroom',
      '/a3/teacher',
      '/a3/capabilities',
      '/a3/knowledge-base',
    ]);
  });

  it('explains bridge responsibility, evidence, and handoff rule for every step', () => {
    const steps = buildOpenMAICDemoFlowSteps(A3_OPENMAIC_PAGE_OWNERSHIP);

    for (const step of steps) {
      expect(step.title).toContain('OpenMAIC');
      expect(step.evidence.length).toBeGreaterThan(0);
      expect(step.handoffRule.length).toBeGreaterThan(0);
      expect(step.scriptLine).toMatch(/A3|OpenMAIC|bridge|资源包/);
    }
  });
});
