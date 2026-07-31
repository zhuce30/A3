import { beforeEach, describe, expect, it, vi } from 'vitest';

import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import {
  fetchAlgorithmLabCatalog,
  submitAlgorithmLabCompletion,
  type AlgorithmLabCompletionRequest,
} from '@/lib/a3/algorithm-lab/client';
import {
  clearLabSession,
  loadLabSession,
  saveLabSession,
  type AlgorithmLabSession,
} from '@/lib/a3/algorithm-lab/session';

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: vi.fn(),
  a3PostJson: vi.fn(),
}));

const getJson = vi.mocked(a3GetJson);
const postJson = vi.mocked(a3PostJson);

describe('algorithm lab API client', () => {
  beforeEach(() => {
    getJson.mockReset();
    postJson.mockReset();
  });

  it('uses only the registered catalog endpoint', async () => {
    getJson.mockResolvedValue({ success: true, schemaVersion: 'a3.algorithm-labs.catalog.v1', labs: [], recentSession: null });

    await expect(fetchAlgorithmLabCatalog()).resolves.toMatchObject({ success: true, labs: [] });
    expect(getJson).toHaveBeenCalledWith('/api/learning/algorithm-labs/');
  });

  it('submits completion through the verified completion endpoint', async () => {
    const request = createCompletionRequest();
    postJson.mockResolvedValue({
      success: true,
      status: 'accepted',
      completion: {
        labId: 'cpu-scheduling',
        verified: true,
        score: 100,
        masteryEvidenceAccepted: true,
        nextAction: { type: 'assessment', label: '完成专项练习', href: '/a3/assessment', reason: '继续验证调度算法判断' },
      },
    });

    await expect(submitAlgorithmLabCompletion(request)).resolves.toMatchObject({ status: 'accepted' });
    expect(postJson).toHaveBeenCalledWith('/api/learning/algorithm-labs/complete/', request);
  });
});

describe('algorithm lab session recovery', () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('sessionStorage', storage);
  });

  it('round-trips only the active unsubmitted session without simulation steps', () => {
    const session = {
      ...createSession(),
      steps: [{ index: 0, state: { running: true } }],
    } as AlgorithmLabSession & { steps: unknown[] };

    expect(saveLabSession('cpu-scheduling', session)).toBe(true);
    expect(loadLabSession('cpu-scheduling')?.currentStepIndex).toBe(3);
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).not.toContain('steps');

    clearLabSession('cpu-scheduling');
    expect(loadLabSession('cpu-scheduling')).toBeNull();
  });

  it.each([
    '{bad',
    JSON.stringify({ ...createSession(), phase: 'submitted' }),
    JSON.stringify({ ...createSession(), labId: 'page-replacement' }),
    JSON.stringify({ ...createSession(), currentStepIndex: Number.NaN }),
    JSON.stringify({ ...createSession(), replayCount: -1 }),
    JSON.stringify({ ...createSession(), input: { processes: 'invalid', timeQuantum: 2 } }),
  ])('drops malformed, submitted, or invalid sessions', (raw) => {
    storage.setItem('a3.algorithmLab.cpu-scheduling', raw);

    expect(loadLabSession('cpu-scheduling')).toBeNull();
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).toBeNull();
  });

  it('rejects sessions whose UTF-8 serialization is not below 32 KB', () => {
    const oversized = {
      ...createSession(),
      checkpointAnswers: { oversized: '学'.repeat(11_000) },
    };

    expect(saveLabSession('cpu-scheduling', oversized)).toBe(false);
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).toBeNull();
  });

  it('rejects nested simulation steps and non-serializable session records', () => {
    expect(saveLabSession('cpu-scheduling', {
      ...createSession(),
      checkpointAnswers: { steps: [{ index: 0, state: {} }] },
    })).toBe(false);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(saveLabSession('cpu-scheduling', {
      ...createSession(),
      prediction: circular,
    })).toBe(false);
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).toBeNull();
  });

  it('does not throw when browser storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });

    expect(() => saveLabSession('cpu-scheduling', createSession())).not.toThrow();
    expect(loadLabSession('cpu-scheduling')).toBeNull();
    expect(() => clearLabSession('cpu-scheduling')).not.toThrow();
  });
});

function createSession(): AlgorithmLabSession<'cpu-scheduling'> {
  return {
    schemaVersion: 'a3.algorithm-lab.session.v1',
    labId: 'cpu-scheduling',
    phase: 'paused',
    presetId: 'cpu-foundation',
    presetVersion: '1',
    selectedAlgorithms: ['fcfs', 'sjf'],
    input: { processes: [], timeQuantum: 2 },
    prediction: null,
    checkpointAnswers: {},
    currentStepIndex: 3,
    replayCount: 0,
    reviewedStepIndexes: [1, 3],
    startedAt: '2026-07-31T00:00:00.000Z',
  };
}

function createCompletionRequest(): AlgorithmLabCompletionRequest {
  return {
    schemaVersion: 'a3.algorithm-lab.completion.v1',
    eventId: 'a3lab-event-1',
    labId: 'cpu-scheduling',
    labVersion: '1.0.0',
    presetId: 'cpu-foundation',
    presetVersion: '1',
    customInput: false,
    selectedAlgorithms: ['fcfs', 'sjf', 'priority', 'rr'],
    prediction: { answer: 'sjf', skipped: false, correct: true },
    checkpoints: { answered: 1, correct: 1, items: [{ id: 'cpu-order', correct: true }] },
    metrics: { score: 100, durationSec: 10, replayCount: 0, reviewedStepIndexes: [1] },
    resultFingerprint: 'cpu:fingerprint',
  };
}

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}
