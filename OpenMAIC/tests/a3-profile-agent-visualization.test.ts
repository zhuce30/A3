import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GenerationAgentTrace } from '@/components/a3/features/generation-agent-trace';
import { ProfileDimensionRadar } from '@/components/a3/profile/profile-dimension-radar';
import type { A3ProfileSnapshot } from '@/lib/a3/auth-types';
import type { A3AgentTrace } from '@/lib/a3/recommendation-types';

describe('A3 profile and Agent process visualization', () => {
  it('renders only populated profile dimensions as covered', () => {
    const dimensions = {
      grade: {
        value: '大二',
        confidence: 0.9,
        basis: 'stable_field',
        missing: false,
      },
      weakPoints: {
        value: [],
        confidence: 0.8,
        basis: 'signals',
        missing: false,
      },
    } as unknown as A3ProfileSnapshot['dimensions'];

    const html = renderToStaticMarkup(React.createElement(ProfileDimensionRadar, { dimensions }));

    expect(html).toContain('画像维度置信度');
    expect(html).toContain('已覆盖 1/14 维');
    expect(html).toContain('待补充维度');
    expect(html).toContain('aria-label="画像维度置信度雷达图"');
  });

  it('renders real Agent names, metrics, status, and per-step latency', () => {
    const trace: A3AgentTrace = {
      traceId: 'trace-1234567890',
      workflow: 'resource_generate',
      status: 'completed',
      latencyMs: 340,
      steps: [
        {
          order: 1,
          name: 'RetrieverAgent',
          role: 'knowledge retrieval',
          status: 'completed',
          detail: 'Retrieve grounded sources.',
          latencyMs: 120,
          metadata: { outputSummary: { sourceCount: 6 } },
        },
        {
          order: 2,
          name: 'VerifierAgent',
          role: 'verification',
          status: 'degraded',
          detail: 'Verify citations.',
          latencyMs: 340,
          metadata: { outputSummary: { citationCount: 4 }, quality: { fallbackUsed: true } },
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(GenerationAgentTrace, { trace }));

    expect(html).toContain('知识检索');
    expect(html).toContain('引用与安全校验');
    expect(html).toContain('检索证据');
    expect(html).toContain('引用来源');
    expect(html).toContain('1 步降级');
    expect(html).toContain('220ms');
  });
});
