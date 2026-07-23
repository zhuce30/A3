import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RealtimeDetectionOverlay } from '@/components/a3/features/coaching/realtime-detection-overlay';

describe('A3 realtime object detection overlay', () => {
  it('renders selectable local candidates with conservative labels', () => {
    const html = renderToStaticMarkup(createElement(RealtimeDetectionOverlay, {
      candidates: [{
        id: 'document-1',
        category: 'document',
        label: '可能的文档区域',
        confidence: 0.78,
        method: 'document_proposal',
        region: {
          x: 0.2,
          y: 0.25,
          width: 0.5,
          height: 0.4,
          label: '可能的文档区域',
          confidence: 0.78,
          method: 'document_proposal',
        },
      }],
      selectedId: null,
      onSelect: vi.fn(),
      viewport: { width: 800, height: 450 },
      sourceSize: { width: 1280, height: 720 },
      fit: 'contain',
    }));

    expect(html).toContain('data-testid="a3-realtime-detection-overlay"');
    expect(html).toContain('data-testid="a3-realtime-detection-document-1"');
    expect(html).toContain('可能的文档区域');
    expect(html).toContain('本地识别');
  });
});
