import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeMediaStage,
  reduceRealtimeMediaFocus,
} from '@/components/a3/features/coaching/realtime-media-stage';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('A3 realtime media stage', () => {
  it('keeps the avatar and both video nodes mounted', () => {
    const html = renderToStaticMarkup(createElement(RealtimeMediaStage, {
      cameraEnabled: true,
      screenEnabled: false,
      cameraVideoRef: { current: null },
      screenVideoRef: { current: null },
      onAnalyze: vi.fn(),
    }, createElement('div', { 'data-testid': 'stable-avatar' })));
    expect(html).toContain('data-testid="stable-avatar"');
    expect(html).toContain('data-testid="a3-realtime-camera-preview"');
    expect(html).toContain('data-testid="a3-realtime-screen-preview"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('does not focus disabled media and toggles enabled media', () => {
    expect(reduceRealtimeMediaFocus(null, 'camera', false)).toBeNull();
    expect(reduceRealtimeMediaFocus(null, 'camera', true)).toBe('camera');
    expect(reduceRealtimeMediaFocus('camera', 'camera', true)).toBeNull();
    expect(reduceRealtimeMediaFocus('camera', 'escape', true)).toBeNull();
  });

  it('keeps automatic detection opt-in and connected to the focused media only', () => {
    const source = readFileSync(join(process.cwd(), 'components/a3/features/coaching/realtime-media-stage.tsx'), 'utf8');

    expect(source).toContain('useRealtimeObjectDetection');
    expect(source).toContain('a3-realtime-detection-toggle');
    expect(source).toContain("useState(false)");
    expect(source).toContain('selectedDetectionId');
  });
});
