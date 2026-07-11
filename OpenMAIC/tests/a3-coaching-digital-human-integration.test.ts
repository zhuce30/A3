import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { A3RealtimeStatus } from '@/lib/a3/realtime-coaching-types';

const mockRealtime = vi.hoisted(() => ({
  status: 'idle' as A3RealtimeStatus,
  assistantSpeaking: false,
}));

vi.mock('@/components/a3/features/coaching/use-realtime-coaching', () => ({
  useRealtimeCoaching: () => ({
    audioLevel: 0,
    assistantSpeaking: mockRealtime.assistantSpeaking,
    cameraEnabled: false,
    cameraVideoRef: undefined,
    captureFrame: vi.fn(),
    end: vi.fn(),
    endWithoutSummary: vi.fn(),
    error: '',
    evidence: [],
    interruptAssistant: vi.fn(),
    microphoneEnabled: false,
    retrieveEvidence: vi.fn(),
    retrievalProgress: { status: 'idle', message: '' },
    screenEnabled: false,
    screenVideoRef: undefined,
    session: undefined,
    shareScreen: vi.fn(),
    setToolQuery: vi.fn(),
    start: vi.fn(),
    status: mockRealtime.status,
    summary: undefined,
    toggleCamera: vi.fn(),
    toggleMic: vi.fn(),
    toolQuery: '',
    transcript: [],
  }),
}));

import {
  RealtimeCoachingCall,
  resolveRealtimeAvatarState,
} from '@/components/a3/features/coaching/realtime-coaching-call';

describe('A3 realtime coaching digital teacher integration', () => {
  beforeEach(() => {
    mockRealtime.status = 'idle';
    mockRealtime.assistantSpeaking = false;
  });

  it.each([
    ['idle', false, 'idle'],
    ['requesting_permission', false, 'connecting'],
    ['connecting', false, 'connecting'],
    ['live', false, 'listening'],
    ['live', true, 'speaking'],
    ['visual_focus', false, 'visual_focus'],
    ['degraded', false, 'degraded'],
    ['ending', false, 'thinking'],
    ['ended', false, 'ended'],
    ['error', false, 'error'],
  ] satisfies Array<[A3RealtimeStatus, boolean, string]>)(
    'maps %s (assistantSpeaking=%s) to %s',
    (status, assistantSpeaking, expectedState) => {
      expect(resolveRealtimeAvatarState(status, assistantSpeaking)).toBe(expectedState);
    },
  );

  it('renders the digital teacher while a silent realtime session listens', () => {
    mockRealtime.status = 'live';

    const html = renderToStaticMarkup(createElement(RealtimeCoachingCall));

    expect(html).toContain('data-testid="a3-digital-human-avatar"');
    expect(html).toContain('data-state="listening"');
    expect(html).not.toContain('>AI<');
  });
});
