import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import * as algorithmLabWorkbench from '@/components/a3/features/algorithm-lab/algorithm-lab-workbench';
import * as algorithmLabClient from '@/lib/a3/algorithm-lab/client';
import {
  fetchAlgorithmLabCatalog,
  submitAlgorithmLabCompletion,
  type AlgorithmLabCompletionRequest,
} from '@/lib/a3/algorithm-lab/client';
import {
  clearLabSession as clearOwnedLabSession,
  loadLabSession as loadOwnedLabSession,
  saveLabSession as saveOwnedLabSession,
  type AlgorithmLabSession,
} from '@/lib/a3/algorithm-lab/session';

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: vi.fn(),
  a3PostJson: vi.fn(),
}));

const getJson = vi.mocked(a3GetJson);
const postJson = vi.mocked(a3PostJson);
const OWNER_ID = 'student-1';
const OWNED_CPU_KEY = `a3.algorithmLab.${OWNER_ID}.cpu-scheduling`;
const OWNED_PAGE_KEY = `a3.algorithmLab.${OWNER_ID}.page-replacement`;

function saveLabSession<TLabId extends AlgorithmLabSession['labId']>(
  labId: TLabId,
  session: AlgorithmLabSession<TLabId>,
) {
  return saveOwnedLabSession(labId, session, OWNER_ID);
}

function loadLabSession<TLabId extends AlgorithmLabSession['labId']>(labId: TLabId) {
  return loadOwnedLabSession(labId, OWNER_ID);
}

function clearLabSession(labId: AlgorithmLabSession['labId']) {
  return clearOwnedLabSession(labId, OWNER_ID);
}
const workbenchSource = readFileSync(
  join(process.cwd(), 'components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx'),
  'utf8',
);

type CompletionGateInput = {
  phase: string;
  currentStepIndex: number;
  finalStepIndex: number;
  requiredCheckpointIds: string[];
  checkpointAnswers: Record<string, string>;
  syncState: string;
};

type CompletionEvidence = {
  eventId: string;
  labId: 'cpu-scheduling';
  labVersion: string;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  selectedAlgorithms: Array<'fcfs' | 'sjf' | 'priority' | 'rr'>;
  prediction: { answer: string | null; skipped: boolean; correct: boolean | null };
  checkpointItems: Array<{ id: string; correct: boolean }>;
  durationSec: number;
  replayCount: number;
  reviewedStepIndexes: number[];
  resultFingerprints: Array<{ algorithm: 'fcfs' | 'sjf' | 'priority' | 'rr'; fingerprint: string }>;
};

function task10Export<T>(name: string): T {
  return (algorithmLabClient as unknown as Record<string, unknown>)[name] as T;
}

function workbenchExport<T>(name: string): T {
  return (algorithmLabWorkbench as unknown as Record<string, unknown>)[name] as T;
}

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
    expect(storage.getItem(OWNED_CPU_KEY)).not.toContain('steps');

    clearLabSession('cpu-scheduling');
    expect(loadLabSession('cpu-scheduling')).toBeNull();
  });

  it('does not expose an unfinished session to another authenticated user', () => {
    expect(saveOwnedLabSession('cpu-scheduling', createSession(), 'student-a')).toBe(true);

    expect(loadOwnedLabSession('cpu-scheduling', 'student-b')).toBeNull();
    expect(loadOwnedLabSession('cpu-scheduling', 'student-a')).toMatchObject({
      labId: 'cpu-scheduling',
      currentStepIndex: 3,
    });
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
    storage.setItem(OWNED_CPU_KEY, raw);

    expect(loadLabSession('cpu-scheduling')).toBeNull();
    expect(storage.getItem(OWNED_CPU_KEY)).toBeNull();
  });

  it.each([
    { referenceString: [], frameCount: 3 },
    { referenceString: [1, 1000], frameCount: 3 },
    { referenceString: [1, 2], frameCount: 9 },
  ])('drops page replacement sessions rejected by the official validator', (input) => {
    storage.setItem(OWNED_PAGE_KEY, JSON.stringify({
      ...createPageSession(),
      input,
    }));

    expect(loadLabSession('page-replacement')).toBeNull();
    expect(storage.getItem(OWNED_PAGE_KEY)).toBeNull();
  });

  it('rejects sessions whose UTF-8 serialization is not below 32 KB', () => {
    const oversized = {
      ...createSession(),
      checkpointAnswers: { oversized: '学'.repeat(11_000) },
    };

    expect(saveLabSession('cpu-scheduling', oversized)).toBe(false);
    expect(storage.getItem(OWNED_CPU_KEY)).toBeNull();
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
    expect(storage.getItem(OWNED_CPU_KEY)).toBeNull();
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
    storage.setItem(OWNED_CPU_KEY, JSON.stringify({ ...createSession(), currentStepIndex: 1 }));
    vi.stubGlobal('sessionStorage', {
      getItem: storage.getItem,
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: storage.removeItem,
    });

    expect(saveLabSession('cpu-scheduling', { ...createSession(), currentStepIndex: 4 })).toBe(false);
    expect(storage.getItem(OWNED_CPU_KEY)).toBeNull();
  });
});

describe('retry-safe algorithm lab completion', () => {
  let storage: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    storage = createMemoryStorage();
    vi.stubGlobal('sessionStorage', storage);
  });

  it('blocks completion until the global final step and both checkpoints are answered', () => {
    const canSubmit = task10Export<(input: CompletionGateInput) => boolean>(
      'canSubmitAlgorithmLabCompletion',
    );
    expect(typeof canSubmit).toBe('function');
    const ready = {
      phase: 'completed',
      currentStepIndex: 12,
      finalStepIndex: 12,
      requiredCheckpointIds: ['cpu-ready-queue', 'cpu-completion-order'],
      checkpointAnswers: {
        'cpu-ready-queue': 'P2',
        'cpu-completion-order': 'P1 → P2 → P3',
      },
      syncState: 'idle',
    };

    expect(canSubmit({ ...ready, phase: 'running' })).toBe(false);
    expect(canSubmit({ ...ready, currentStepIndex: 11 })).toBe(false);
    expect(canSubmit({ ...ready, checkpointAnswers: { 'cpu-ready-queue': 'P2' } })).toBe(false);
    expect(canSubmit({ ...ready, syncState: 'pending' })).toBe(false);
    expect(canSubmit(ready)).toBe(true);
  });

  it('builds a step-free request with checkpoint score, separate prediction, canonical fingerprint, and normalized reviews', () => {
    const buildRequest = task10Export<(
      evidence: CompletionEvidence,
    ) => AlgorithmLabCompletionRequest<'cpu-scheduling'>>('buildAlgorithmLabCompletionRequest');
    expect(typeof buildRequest).toBe('function');
    const request = buildRequest(createCompletionEvidence());

    expect(request.metrics.score).toBe(50);
    expect(request.prediction).toEqual({ answer: 'sjf', skipped: false, correct: true });
    expect(request.checkpoints).toMatchObject({ answered: 2, correct: 1 });
    expect(request.metrics.reviewedStepIndexes).toEqual(Array.from({ length: 50 }, (_, index) => index));
    expect(request.resultFingerprint).toBe(
      'a3lab-result.v1|cpu-scheduling|cpu-foundation|1.0.0|'
      + 'fcfs=cpu:30f71277755e0281d134aa1ca82e049c|'
      + 'priority=cpu:4aae8cbcb315ec683110dcf7aa793990|'
      + 'rr=cpu:7a045a7da6352c4488d7a567d0ff26c2|'
      + 'sjf=cpu:7958460a04842ebeb1e53aebf42d471a',
    );
    expect(JSON.stringify(request)).not.toContain('steps');
  });

  it('persists one completion event ID and reuses it for a retry', () => {
    const getOrCreateEventId = task10Export<(
      labId: 'cpu-scheduling',
      startedAt: string,
      ownerId: string,
    ) => string>('getOrCreateAlgorithmLabCompletionEventId');
    expect(typeof getOrCreateEventId).toBe('function');

    const startedAt = '2026-07-31T00:00:00.000Z';
    const first = getOrCreateEventId('cpu-scheduling', startedAt, OWNER_ID);
    const retry = getOrCreateEventId('cpu-scheduling', startedAt, OWNER_ID);
    const nextAttempt = getOrCreateEventId('cpu-scheduling', '2026-08-01T00:00:00.000Z', OWNER_ID);

    expect(first).toMatch(/^a3lab_complete_cpu_scheduling_/);
    expect(retry).toBe(first);
    expect(nextAttempt).not.toBe(first);
    expect(storage.getItem(`${OWNED_CPU_KEY}.completionEventId`)).toBe(nextAttempt);
  });

  it('isolates completion event storage between authenticated users', () => {
    const getOrCreateEventId = task10Export<(
      labId: 'cpu-scheduling',
      startedAt: string,
      ownerId: string,
    ) => string>('getOrCreateAlgorithmLabCompletionEventId');

    const first = getOrCreateEventId('cpu-scheduling', '2026-07-31T00:00:00.000Z', 'student-a');
    const second = getOrCreateEventId('cpu-scheduling', '2026-08-01T00:00:00.000Z', 'student-b');

    expect(storage.getItem('a3.algorithmLab.student-a.cpu-scheduling.completionEventId')).toBe(first);
    expect(storage.getItem('a3.algorithmLab.student-b.cpu-scheduling.completionEventId')).toBe(second);
  });

  it('ignores a completion response after reset or unmount changes the active attempt', () => {
    const isCurrent = workbenchExport<(
      current: { attemptNumber: number; eventId: string | null } | null,
      submitted: { attemptNumber: number; eventId: string | null },
    ) => boolean>('isCurrentCompletionAttempt');
    const submitted = { attemptNumber: 3, eventId: 'completion-3' };

    expect(isCurrent(submitted, submitted)).toBe(true);
    expect(isCurrent({ attemptNumber: 4, eventId: null }, submitted)).toBe(false);
    expect(isCurrent({ attemptNumber: 3, eventId: 'completion-4' }, submitted)).toBe(false);
    expect(isCurrent(null, submitted)).toBe(false);
  });

  it.each(['accepted', 'duplicate'] as const)('clears the compact session after a %s response', async (status) => {
    const synchronize = task10Export<(
      request: AlgorithmLabCompletionRequest,
      options: {
        submit: () => Promise<unknown>;
        onSubmitted: () => void;
      },
    ) => Promise<{ syncState: string }>>('synchronizeAlgorithmLabCompletion');
    const clearEventId = task10Export<(labId: 'cpu-scheduling', ownerId: string) => void>(
      'clearAlgorithmLabCompletionEventId',
    );
    expect(typeof synchronize).toBe('function');
    expect(typeof clearEventId).toBe('function');
    saveLabSession('cpu-scheduling', { ...createSession(), phase: 'completed' });
    const eventId = task10Export<(labId: 'cpu-scheduling', startedAt: string, ownerId: string) => string>(
      'getOrCreateAlgorithmLabCompletionEventId',
    )('cpu-scheduling', '2026-07-31T00:00:00.000Z', OWNER_ID);

    const outcome = await synchronize(
      { ...createCompletionRequest(), eventId },
      {
        submit: async () => ({
          success: true,
          status,
          completion: {
            labId: 'cpu-scheduling',
            verified: true,
            score: 100,
            masteryEvidenceAccepted: true,
            nextAction: {
              type: 'assessment',
              label: '完成专项练习',
              href: '/a3/assessment',
              reason: '继续验证调度算法判断',
            },
          },
        }),
        onSubmitted: () => {
          clearLabSession('cpu-scheduling');
          clearEventId('cpu-scheduling', OWNER_ID);
        },
      },
    );

    expect(outcome.syncState).toBe('submitted');
    expect(loadLabSession('cpu-scheduling')).toBeNull();
    expect(storage.getItem(`${OWNED_CPU_KEY}.completionEventId`)).toBeNull();
  });

  it.each([
    ['network', async () => { throw new Error('offline'); }],
    ['5xx', async () => ({ success: false, status: 503, error: '服务暂不可用' })],
  ] as const)('preserves the completed session and exposes retry after a %s failure', async (_kind, submit) => {
    const synchronize = task10Export<(
      request: AlgorithmLabCompletionRequest,
      options: { submit: () => Promise<unknown> },
    ) => Promise<{ syncState: string; retryLabel?: string }>>('synchronizeAlgorithmLabCompletion');
    expect(typeof synchronize).toBe('function');
    saveLabSession('cpu-scheduling', { ...createSession(), phase: 'completed' });

    const outcome = await synchronize(createCompletionRequest(), { submit });

    expect(outcome).toMatchObject({
      syncState: 'event_sync_failed',
      retryLabel: '重新同步学习记录',
    });
    expect(loadLabSession('cpu-scheduling')).toMatchObject({ phase: 'completed', currentStepIndex: 3 });
    expect(workbenchSource).toContain('重新同步学习记录');
    expect(workbenchSource).toMatch(/disabled=\{[^}]*syncState[^}]*pending/);
  });

  it('retries a checkpoint event with the same ID and keeps its submitted answer on failure', async () => {
    type Gate = { eventId: string; status: 'idle' | 'in_flight' | 'sent' };
    const createGate = workbenchExport<(eventId: string) => Gate>('createCheckpointEventGate');
    const synchronizeCheckpoint = workbenchExport<(
      gate: Gate,
      send: (eventId: string) => Promise<{ success: boolean; status?: string }>,
    ) => Promise<boolean>>('synchronizeAlgorithmLabCheckpointEvent');
    const createState = workbenchExport<(labId: 'cpu-scheduling') => { checkpointAnswers: Record<string, string> }>(
      'createAlgorithmLabState',
    );
    const reduce = workbenchExport<(
      state: ReturnType<typeof createState>,
      action: { type: 'answer_checkpoint'; checkpointId: string; answer: string },
    ) => ReturnType<typeof createState>>('algorithmLabReducer');
    expect(typeof createGate).toBe('function');
    expect(typeof synchronizeCheckpoint).toBe('function');
    const eventId = 'a3lab_checkpoint_cpu_scheduling_cpu_ready_queue_1785456000000';
    const gate = createGate(eventId);
    const send = vi.fn()
      .mockResolvedValueOnce({ success: false, status: 503 })
      .mockResolvedValueOnce({ success: true, status: 'duplicate' });
    const answered = reduce(createState('cpu-scheduling'), {
      type: 'answer_checkpoint',
      checkpointId: 'cpu-ready-queue',
      answer: 'P2',
    });

    await expect(synchronizeCheckpoint(gate, send)).resolves.toBe(false);
    expect(gate).toEqual({ eventId, status: 'idle' });
    expect(answered.checkpointAnswers['cpu-ready-queue']).toBe('P2');
    await expect(synchronizeCheckpoint(gate, send)).resolves.toBe(true);
    expect(gate).toEqual({ eventId, status: 'sent' });
    await expect(synchronizeCheckpoint(gate, send)).resolves.toBe(false);
    expect(send.mock.calls.map(([stableEventId]) => stableEventId)).toEqual([eventId, eventId]);
    expect(workbenchSource).toContain('重新同步检查点记录');
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

function createCompletionEvidence(): CompletionEvidence {
  return {
    eventId: 'a3lab-completion-1',
    labId: 'cpu-scheduling',
    labVersion: '1.0.0',
    presetId: 'cpu-foundation',
    presetVersion: '1.0.0',
    customInput: false,
    selectedAlgorithms: ['fcfs', 'sjf', 'priority', 'rr'],
    prediction: { answer: 'sjf', skipped: false, correct: true },
    checkpointItems: [
      { id: 'cpu-ready-queue', correct: true },
      { id: 'cpu-completion-order', correct: false },
    ],
    durationSec: 18,
    replayCount: 1,
    reviewedStepIndexes: [55, ...Array.from({ length: 56 }, (_, index) => 55 - index), 7, -1, 2.5],
    resultFingerprints: [
      { algorithm: 'rr', fingerprint: 'cpu:7a045a7da6352c4488d7a567d0ff26c2' },
      { algorithm: 'fcfs', fingerprint: 'cpu:30f71277755e0281d134aa1ca82e049c' },
      { algorithm: 'sjf', fingerprint: 'cpu:7958460a04842ebeb1e53aebf42d471a' },
      { algorithm: 'priority', fingerprint: 'cpu:4aae8cbcb315ec683110dcf7aa793990' },
    ],
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
