import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { a3PostJson } from '@/lib/a3/api-client';
import {
  A3_LEARNING_EVENT_SCHEMA_VERSION,
  buildLearningEvent,
  trackLearningEvent,
  trackPageView,
  trackPracticeSubmit,
} from '@/lib/a3/learning-event-client';

vi.mock('@/lib/a3/api-client', () => ({
  a3PostJson: vi.fn(),
}));

const postJson = vi.mocked(a3PostJson);

describe('learning event client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T08:00:00.000Z'));
    postJson.mockReset();
    vi.stubGlobal('window', {
      location: { pathname: '/a3/today', search: '?day=1' },
      localStorage: createMemoryStorage(),
    });
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('builds a v2 payload with source page, client timestamp and normalized fields', () => {
    const event = buildLearningEvent({
      eventType: 'resource_completed',
      eventId: ' event-1 ',
      sourcePage: '/a3/resources/pack-1',
      targetType: 'resource_pack',
      targetId: 'pack-1',
      resourceType: 'practice_set',
      durationSec: -3,
      score: '92',
      quality: { completionRate: 1 },
      metadata: { action: 'completed' },
      traceId: 'trace-1',
    });

    expect(event).toEqual({
      schemaVersion: A3_LEARNING_EVENT_SCHEMA_VERSION,
      eventId: 'event-1',
      eventType: 'resource_completed',
      sourcePage: '/a3/resources/pack-1',
      clientTimestamp: '2026-07-08T08:00:00.000Z',
      targetType: 'resource_pack',
      targetId: 'pack-1',
      resourceType: 'practice_set',
      knowledgePointId: '',
      durationSec: 0,
      score: 92,
      quality: { completionRate: 1 },
      metadata: {
        action: 'completed',
        sessionId: '11111111222243338444555555555555',
      },
      traceId: 'trace-1',
    });
  });

  it('reuses localStorage sessionId and increments generated event ids', async () => {
    postJson.mockResolvedValue({ success: true, status: 'accepted' });

    await trackPageView('/a3/report');
    await trackPracticeSubmit({
      targetType: 'assessment_session',
      targetId: 'session-1',
      score: 80,
    });

    const firstPayload = postJson.mock.calls[0][1] as Record<string, unknown>;
    const secondPayload = postJson.mock.calls[1][1] as Record<string, unknown>;
    expect(postJson).toHaveBeenCalledWith('/api/learning/events/', expect.any(Object));
    expect(firstPayload.eventId).toBe('a3evt_11111111222243338444555555555555_1');
    expect(secondPayload.eventId).toBe('a3evt_11111111222243338444555555555555_2');
    expect((secondPayload.metadata as Record<string, unknown>).sessionId).toBe('11111111222243338444555555555555');
  });

  it('does not throw when tracking request fails', async () => {
    postJson.mockRejectedValue(new Error('network down'));

    await expect(trackLearningEvent({ eventType: 'page_viewed', sourcePage: '/a3/today' })).resolves.toEqual({
      success: false,
      error: '学习事件写入失败',
    });
  });
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}
