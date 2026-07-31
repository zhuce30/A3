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
    getJson.mockResolvedValue({
      success: true,
      schemaVersion: 'a3.algorithm-labs.catalog.v1',
      labs: [{
        id: 'cpu-scheduling',
        version: '1.0.0',
        title: 'CPU 调度算法对比',
        description: '比较不同调度策略。',
        knowledgePointCodes: ['os-process-scheduling'],
        estimatedMinutes: 18,
        algorithms: ['fcfs', 'sjf', 'priority', 'rr'],
        presets: [{ id: 'cpu-foundation', version: '1', title: '基础到达队列', difficulty: 'foundation' }],
        progress: { completed: true, bestScore: 100, lastCompletedAt: '2026-07-31T08:10:00.000Z', verifiedRuns: 1 },
        recentSession: {
          schemaVersion: 'a3.algorithm-lab.completion.v1',
          eventId: 'a3lab-event-1',
          labId: 'cpu-scheduling',
          labVersion: '1.0.0',
          presetId: 'cpu-foundation',
          presetVersion: '1',
          customInput: false,
          selectedAlgorithms: ['fcfs', 'sjf', 'priority', 'rr'],
          prediction: { answer: 'sjf', skipped: false, correct: true },
          checkpoints: { answered: 1, correct: 1 },
          metrics: { score: 100, durationSec: 10, replayCount: 0, reviewedStepIndexes: [1], reviewedCount: 1 },
          verified: true,
          score: 100,
          masteryEvidenceAccepted: true,
          nextAction: { type: 'assessment', label: '完成专项练习', href: '/a3/assessment', reason: '继续验证调度算法判断' },
          completedAt: '2026-07-31T08:10:00.000Z',
        },
      }],
    });

    const result = await fetchAlgorithmLabCatalog();
    if (!result.success) throw new Error('expected algorithm lab catalog');
    expect(result).not.toHaveProperty('recentSession');
    expect(result.labs[0].recentSession).toMatchObject({
      eventId: 'a3lab-event-1',
      score: 100,
      nextAction: { type: 'assessment', href: '/a3/assessment' },
    });
    expect(getJson).toHaveBeenCalledWith('/api/learning/algorithm-labs/');
  });

  it('narrows a catalog 401 response without requiring labs', async () => {
    getJson.mockResolvedValue({ success: false, error: '请先登录', status: 401 });

    const result = await fetchAlgorithmLabCatalog();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(401);
      expect(result.error).toBe('请先登录');
      expect(result).not.toHaveProperty('labs');
    }
  });

  it('narrows a catalog network failure without requiring an HTTP status', async () => {
    getJson.mockResolvedValue({ success: false, error: '网络连接失败' });

    const result = await fetchAlgorithmLabCatalog();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBeUndefined();
      expect(result.error).toBe('网络连接失败');
      expect(result).not.toHaveProperty('labs');
    }
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

    const result = await submitAlgorithmLabCompletion(request);
    expect(result).toMatchObject({ status: 'accepted' });
    if (!result.success) throw new Error('expected accepted completion');
    const acceptedStatus: 'accepted' | 'duplicate' = result.status;
    const score: number = result.completion.score;
    const nextActionType: string = result.completion.nextAction.type;
    expect({ acceptedStatus, score, nextActionType }).toEqual({
      acceptedStatus: 'accepted',
      score: 100,
      nextActionType: 'assessment',
    });
    expect(postJson).toHaveBeenCalledWith('/api/learning/algorithm-labs/complete/', request);
  });

  it('keeps completion algorithms correlated with the selected lab', () => {
    const cpuRequest: AlgorithmLabCompletionRequest<'cpu-scheduling'> = createCompletionRequest();
    const pageRequest: AlgorithmLabCompletionRequest<'page-replacement'> = {
      ...createCompletionRequest(),
      labId: 'page-replacement',
      selectedAlgorithms: ['fifo', 'lru', 'opt'],
    };
    expect(cpuRequest.selectedAlgorithms).toEqual(['fcfs', 'sjf', 'priority', 'rr']);
    expect(pageRequest.selectedAlgorithms).toEqual(['fifo', 'lru', 'opt']);

    if (false) {
      void submitAlgorithmLabCompletion(cpuRequest);
      void submitAlgorithmLabCompletion(pageRequest);
      // @ts-expect-error FIFO is not a CPU scheduling algorithm.
      void submitAlgorithmLabCompletion({ ...cpuRequest, selectedAlgorithms: ['fifo'] });
    }
  });

  it.each([400, 409])('preserves numeric HTTP status %s on completion failures', async (httpStatus) => {
    postJson.mockResolvedValue({ success: false, error: '提交失败', status: httpStatus });

    const result = await submitAlgorithmLabCompletion(createCompletionRequest());

    expect(result.success).toBe(false);
    if (!result.success) {
      const numericStatus: number | undefined = result.status;
      expect(result.status).toBe(httpStatus);
      expect(numericStatus).toBe(httpStatus);
      expect(result.error).toBe('提交失败');
    }
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
    JSON.stringify({ ...createSession(), input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 0, priority: 1 }], timeQuantum: 2 } }),
    JSON.stringify({ ...createSession(), input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 100 }], timeQuantum: 2 } }),
    JSON.stringify({ ...createSession(), input: { processes: Array.from({ length: 13 }, (_, index) => ({ processId: `P${index}`, arrivalTime: 0, burstTime: 1, priority: 1 })), timeQuantum: 2 } }),
    JSON.stringify({ ...createSession(), input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 1 }], timeQuantum: 21 } }),
  ])('drops malformed, submitted, or invalid sessions', (raw) => {
    storage.setItem('a3.algorithmLab.cpu-scheduling', raw);

    expect(loadLabSession('cpu-scheduling')).toBeNull();
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).toBeNull();
  });

  it.each([
    { referenceString: [], frameCount: 3 },
    { referenceString: [1, 1000], frameCount: 3 },
    { referenceString: [1, 2], frameCount: 9 },
  ])('drops page replacement sessions rejected by the official validator', (input) => {
    storage.setItem('a3.algorithmLab.page-replacement', JSON.stringify({
      ...createPageSession(),
      input,
    }));

    expect(loadLabSession('page-replacement')).toBeNull();
    expect(storage.getItem('a3.algorithmLab.page-replacement')).toBeNull();
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

  it('removes a stale session when setItem fails', () => {
    storage.setItem('a3.algorithmLab.cpu-scheduling', JSON.stringify({ ...createSession(), currentStepIndex: 1 }));
    vi.stubGlobal('sessionStorage', {
      getItem: storage.getItem,
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: storage.removeItem,
    });

    expect(saveLabSession('cpu-scheduling', { ...createSession(), currentStepIndex: 4 })).toBe(false);
    expect(storage.getItem('a3.algorithmLab.cpu-scheduling')).toBeNull();
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
    input: {
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 4, priority: 1 }],
      timeQuantum: 2,
    },
    prediction: null,
    checkpointAnswers: {},
    currentStepIndex: 3,
    replayCount: 0,
    reviewedStepIndexes: [1, 3],
    startedAt: '2026-07-31T00:00:00.000Z',
  };
}

function createPageSession(): AlgorithmLabSession<'page-replacement'> {
  return {
    schemaVersion: 'a3.algorithm-lab.session.v1',
    labId: 'page-replacement',
    phase: 'paused',
    presetId: 'page-foundation',
    presetVersion: '1',
    selectedAlgorithms: ['fifo', 'lru'],
    input: { referenceString: [1, 2, 3, 1], frameCount: 3 },
    prediction: null,
    checkpointAnswers: {},
    currentStepIndex: 2,
    replayCount: 0,
    reviewedStepIndexes: [1],
    startedAt: '2026-07-31T00:00:00.000Z',
  };
}

function createCompletionRequest(): AlgorithmLabCompletionRequest<'cpu-scheduling'> {
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
