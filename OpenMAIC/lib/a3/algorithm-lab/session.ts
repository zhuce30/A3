import type {
  AlgorithmLabAlgorithmById,
  AlgorithmLabId,
  AlgorithmLabInputById,
  AlgorithmLabPhase,
} from './contracts';

export const ALGORITHM_LAB_SESSION_SCHEMA_VERSION = 'a3.algorithm-lab.session.v1';

const MAX_SESSION_BYTES = 32 * 1024;
const ACTIVE_PHASES = new Set<AlgorithmLabPhase>([
  'idle',
  'configured',
  'predicted',
  'running',
  'paused',
  'completed',
]);
const ALGORITHMS_BY_LAB = {
  'cpu-scheduling': new Set(['fcfs', 'sjf', 'priority', 'rr']),
  'page-replacement': new Set(['fifo', 'lru', 'opt']),
} as const;

export interface AlgorithmLabSession<TLabId extends AlgorithmLabId = AlgorithmLabId> {
  schemaVersion: typeof ALGORITHM_LAB_SESSION_SCHEMA_VERSION;
  labId: TLabId;
  phase: Exclude<AlgorithmLabPhase, 'submitted'>;
  presetId: string;
  presetVersion: string;
  selectedAlgorithms: AlgorithmLabAlgorithmById[TLabId][];
  input: AlgorithmLabInputById[TLabId];
  prediction: Record<string, unknown> | null;
  checkpointAnswers: Record<string, unknown>;
  currentStepIndex: number;
  replayCount: number;
  reviewedStepIndexes: number[];
  startedAt: string;
}

export function saveLabSession<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  session: AlgorithmLabSession<TLabId>,
): boolean {
  const storage = getStorage();
  if (!storage) return false;
  const normalized = normalizeSession(labId, session);
  if (!normalized) {
    removeKey(storage, labId);
    return false;
  }
  try {
    const serialized = JSON.stringify(normalized);
    if (utf8ByteLength(serialized) >= MAX_SESSION_BYTES) {
      removeKey(storage, labId);
      return false;
    }
    storage.setItem(storageKey(labId), serialized);
    return true;
  } catch {
    return false;
  }
}

export function loadLabSession<TLabId extends AlgorithmLabId>(
  labId: TLabId,
): AlgorithmLabSession<TLabId> | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(labId));
    if (!raw) return null;
    if (utf8ByteLength(raw) >= MAX_SESSION_BYTES) {
      removeKey(storage, labId);
      return null;
    }
    const normalized = normalizeSession(labId, JSON.parse(raw));
    if (!normalized) {
      removeKey(storage, labId);
      return null;
    }
    return normalized;
  } catch {
    removeKey(storage, labId);
    return null;
  }
}

export function clearLabSession(labId: AlgorithmLabId): void {
  const storage = getStorage();
  if (storage) removeKey(storage, labId);
}

function normalizeSession<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  value: unknown,
): AlgorithmLabSession<TLabId> | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== ALGORITHM_LAB_SESSION_SCHEMA_VERSION || value.labId !== labId) return null;
  if (typeof value.phase !== 'string' || !ACTIVE_PHASES.has(value.phase as AlgorithmLabPhase)) return null;
  if (!isNonEmptyString(value.presetId) || !isNonEmptyString(value.presetVersion)) return null;
  if (!isNonNegativeInteger(value.currentStepIndex) || !isNonNegativeInteger(value.replayCount)) return null;
  if (!isIndexList(value.reviewedStepIndexes)) return null;
  if (!isRecord(value.checkpointAnswers)) return null;
  if (value.prediction !== null && !isRecord(value.prediction)) return null;
  if (containsSteps(value.prediction) || containsSteps(value.checkpointAnswers)) return null;
  if (!isValidStartedAt(value.startedAt)) return null;

  const selectedAlgorithms = normalizeAlgorithms(labId, value.selectedAlgorithms);
  const input = normalizeInput(labId, value.input);
  const prediction = value.prediction === null ? null : cloneJsonRecord(value.prediction);
  const checkpointAnswers = cloneJsonRecord(value.checkpointAnswers);
  if (!selectedAlgorithms || !input || (value.prediction !== null && !prediction) || !checkpointAnswers) return null;

  return {
    schemaVersion: ALGORITHM_LAB_SESSION_SCHEMA_VERSION,
    labId,
    phase: value.phase as Exclude<AlgorithmLabPhase, 'submitted'>,
    presetId: value.presetId,
    presetVersion: value.presetVersion,
    selectedAlgorithms,
    input,
    prediction,
    checkpointAnswers,
    currentStepIndex: value.currentStepIndex,
    replayCount: value.replayCount,
    reviewedStepIndexes: [...value.reviewedStepIndexes],
    startedAt: value.startedAt,
  } as AlgorithmLabSession<TLabId>;
}

function normalizeAlgorithms<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  value: unknown,
): AlgorithmLabAlgorithmById[TLabId][] | null {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) return null;
  const allowed = ALGORITHMS_BY_LAB[labId] as ReadonlySet<unknown>;
  if (!value.every((algorithm) => typeof algorithm === 'string' && allowed.has(algorithm))) return null;
  return [...value] as AlgorithmLabAlgorithmById[TLabId][];
}

function normalizeInput<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  value: unknown,
): AlgorithmLabInputById[TLabId] | null {
  if (!isRecord(value)) return null;
  if (labId === 'cpu-scheduling') {
    if (!Array.isArray(value.processes) || !isPositiveInteger(value.timeQuantum)) return null;
    const processes = value.processes.map((process) => {
      if (!isRecord(process)) return null;
      if (!isNonEmptyString(process.processId)) return null;
      if (![process.arrivalTime, process.burstTime, process.priority].every(isNonNegativeInteger)) return null;
      return {
        processId: process.processId,
        arrivalTime: process.arrivalTime,
        burstTime: process.burstTime,
        priority: process.priority,
      };
    });
    if (processes.some((process) => process === null)) return null;
    return { processes, timeQuantum: value.timeQuantum } as AlgorithmLabInputById[TLabId];
  }
  if (!Array.isArray(value.referenceString) || !value.referenceString.every(isNonNegativeInteger)) return null;
  if (!isPositiveInteger(value.frameCount)) return null;
  return {
    referenceString: [...value.referenceString],
    frameCount: value.frameCount,
  } as AlgorithmLabInputById[TLabId];
}

function cloneJsonRecord(value: unknown): Record<string, unknown> | null {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return isRecord(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function containsSteps(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSteps(item, seen));
  const record = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'steps')
    || Object.values(record).some((item) => containsSteps(item, seen));
}

function getStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function removeKey(storage: Storage, labId: AlgorithmLabId): void {
  try {
    storage.removeItem(storageKey(labId));
  } catch {
    // Storage can be blocked by browser privacy settings.
  }
}

function storageKey(labId: AlgorithmLabId): string {
  return `a3.algorithmLab.${labId}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isIndexList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 50 && value.every(isNonNegativeInteger) && new Set(value).size === value.length;
}

function isValidStartedAt(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}
