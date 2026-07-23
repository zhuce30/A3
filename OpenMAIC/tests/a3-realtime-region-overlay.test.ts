import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeRegionOverlay } from '@/components/a3/features/coaching/realtime-region-overlay';

describe('A3 realtime region overlay', () => {
  it('exposes an accessible selection surface without page-level chrome', () => {
    const html = renderToStaticMarkup(createElement(RealtimeRegionOverlay, {
      enabled: true,
      videoRef: { current: null },
      region: null,
      onChange: vi.fn(),
      fit: 'contain',
    }));
    expect(html).toContain('data-testid="a3-realtime-region-overlay"');
    expect(html).toContain('aria-label="在画面中拖动框选分析区域"');
  });

  it('renders browser-local detection candidates without enabling manual drawing', () => {
    const html = renderToStaticMarkup(createElement(RealtimeRegionOverlay, {
      enabled: false,
      videoRef: { current: null },
      region: null,
      onChange: vi.fn(),
      fit: 'contain',
      detectionCandidates: [{
        id: 'person-0',
        category: 'person',
        label: '人物',
        confidence: 0.9,
        method: 'object_detection',
        region: {
          x: 0.1,
          y: 0.1,
          width: 0.3,
          height: 0.7,
          label: '人物',
          confidence: 0.9,
          method: 'object_detection',
        },
      }],
      selectedDetectionId: null,
      onDetectionSelect: vi.fn(),
    }));

    expect(html).toContain('data-testid="a3-realtime-detection-overlay"');
    expect(html).toContain('人物');
  });
});
