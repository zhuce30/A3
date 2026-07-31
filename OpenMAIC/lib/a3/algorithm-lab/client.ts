import { a3GetJson, a3PostJson } from '../api-client';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabAlgorithmById,
  AlgorithmLabDifficulty,
  AlgorithmLabId,
  AlgorithmLabPhase,
} from './contracts';

export interface AlgorithmLabCatalogItem {
  id: AlgorithmLabId;
  version: string;
  title: string;
  description: string;
  knowledgePointCodes: string[];
  estimatedMinutes: number;
  algorithms: AlgorithmLabAlgorithm[];
  presets: Array<{
    id: string;
    version: string;
    title: string;
    difficulty: AlgorithmLabDifficulty;
  }>;
  progress: {
    completed: boolean;
    bestScore: number | null;
    lastCompletedAt: string | null;
    verifiedRuns: number;
  };
  recentSession: AlgorithmLabRecentSession | null;
}

export type AlgorithmLabCatalogResponse =
  | {
      success: true;
      schemaVersion: 'a3.algorithm-labs.catalog.v1';
      labs: AlgorithmLabCatalogItem[];
      error?: never;
      status?: never;
    }
  | {
      success: false;
      error: string;
      status?: number;
      schemaVersion?: never;
      labs?: never;
    };

export interface AlgorithmLabNextAction {
  type: 'assessment' | 'replay_lab';
  label: string;
  href: string;
  reason: string;
}

export interface AlgorithmLabCompletionResult {
  labId: AlgorithmLabId;
  verified: boolean;
  score: number;
  masteryEvidenceAccepted: boolean;
  nextAction: AlgorithmLabNextAction;
}

export interface AlgorithmLabRecentSession extends AlgorithmLabCompletionResult {
  schemaVersion?: 'a3.algorithm-lab.completion.v1';
  eventId?: string;
  labVersion?: string;
  presetId?: string;
  presetVersion?: string;
  customInput?: boolean;
  selectedAlgorithms?: AlgorithmLabAlgorithm[];
  prediction?: AlgorithmLabCompletionRequest['prediction'];
  checkpoints?: Omit<AlgorithmLabCompletionRequest['checkpoints'], 'items'> & {
    items?: AlgorithmLabCompletionRequest['checkpoints']['items'];
  };
  metrics?: AlgorithmLabCompletionRequest['metrics'] & { reviewedCount?: number };
  completedAt?: string;
}

interface AlgorithmLabCompletionRequestFields {
  schemaVersion: 'a3.algorithm-lab.completion.v1';
  eventId: string;
  labVersion: string;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  prediction: {
    answer: string;
    skipped: boolean;
    correct?: boolean;
  };
  checkpoints: {
    answered: number;
    correct: number;
    items: Array<{ id: string; correct: boolean }>;
  };
  metrics: {
    score: number;
    durationSec: number;
    replayCount: number;
    reviewedStepIndexes: number[];
  };
  resultFingerprint: string;
}

export type AlgorithmLabCompletionRequest<TLabId extends AlgorithmLabId = AlgorithmLabId> =
  TLabId extends AlgorithmLabId
    ? AlgorithmLabCompletionRequestFields & {
        labId: TLabId;
        selectedAlgorithms: AlgorithmLabAlgorithmById[TLabId][];
      }
    : never;

export type AlgorithmLabCompletionResponse =
  | {
      success: true;
      status: 'accepted' | 'duplicate';
      completion: AlgorithmLabCompletionResult;
      error?: never;
    }
  | {
      success: false;
      error: string;
      status?: number;
      completion?: never;
    };

export interface AlgorithmLabCompletionGateInput {
  phase: AlgorithmLabPhase;
  currentStepIndex: number;
  finalStepIndex: number;
  requiredCheckpointIds: readonly string[];
  checkpointAnswers: Readonly<Record<string, string>>;
  syncState: 'idle' | 'pending' | 'event_sync_failed' | 'submitted';
}

export interface AlgorithmLabCompletionEvidence<TLabId extends AlgorithmLabId> {
  eventId: string;
  labId: TLabId;
  labVersion: string;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  selectedAlgorithms: AlgorithmLabAlgorithmById[TLabId][];
  prediction: {
    answer: string | null;
    skipped: boolean;
    correct: boolean | null;
  };
  checkpointItems: Array<{ id: string; correct: boolean }>;
  durationSec: number;
  replayCount: number;
  reviewedStepIndexes: number[];
  resultFingerprints: Array<{
    algorithm: AlgorithmLabAlgorithmById[TLabId];
    fingerprint: string;
  }>;
}

export type AlgorithmLabCompletionSyncOutcome =
  | {
      syncState: 'submitted';
      completion: AlgorithmLabCompletionResult;
      retryLabel?: never;
      error?: never;
    }
  | {
      syncState: 'event_sync_failed';
      error: string;
      retryLabel: '重新同步学习记录';
      completion?: never;
    };

interface AlgorithmLabCompletionSyncOptions {
  submit?: (request: AlgorithmLabCompletionRequest) => Promise<AlgorithmLabCompletionResponse>;
  onSubmitted?: (completion: AlgorithmLabCompletionResult) => void;
}

export function fetchAlgorithmLabCatalog(): Promise<AlgorithmLabCatalogResponse> {
  return a3GetJson<AlgorithmLabCatalogResponse>('/api/learning/algorithm-labs/');
}

export function submitAlgorithmLabCompletion(
  request: AlgorithmLabCompletionRequest,
): Promise<AlgorithmLabCompletionResponse> {
  return a3PostJson<AlgorithmLabCompletionResponse>('/api/learning/algorithm-labs/complete/', request);
}

export function canSubmitAlgorithmLabCompletion(input: AlgorithmLabCompletionGateInput): boolean {
  return input.phase === 'completed'
    && input.finalStepIndex >= 0
    && input.currentStepIndex === input.finalStepIndex
    && input.requiredCheckpointIds.length === 2
    && input.requiredCheckpointIds.every((checkpointId) => (
      typeof input.checkpointAnswers[checkpointId] === 'string'
    ))
    && input.syncState !== 'pending'
    && input.syncState !== 'submitted';
}

export function buildAlgorithmLabCompletionRequest<TLabId extends AlgorithmLabId>(
  evidence: AlgorithmLabCompletionEvidence<TLabId>,
): AlgorithmLabCompletionRequest<TLabId> {
  const checkpointItems = evidence.checkpointItems.map((item) => ({ ...item }));
  const correct = checkpointItems.filter((item) => item.correct).length;
  const score = checkpointItems.length === 0
    ? 0
    : roundToOne(correct * 100 / checkpointItems.length);
  const presetId = evidence.customInput ? '' : evidence.presetId;
  const presetVersion = evidence.customInput ? '' : evidence.presetVersion;

  return {
    schemaVersion: 'a3.algorithm-lab.completion.v1',
    eventId: evidence.eventId,
    labId: evidence.labId,
    labVersion: evidence.labVersion,
    presetId,
    presetVersion,
    customInput: evidence.customInput,
    selectedAlgorithms: [...evidence.selectedAlgorithms],
    prediction: {
      answer: evidence.prediction.answer ?? '',
      skipped: evidence.prediction.skipped,
      correct: evidence.prediction.correct === true,
    },
    checkpoints: {
      answered: checkpointItems.length,
      correct,
      items: checkpointItems,
    },
    metrics: {
      score,
      durationSec: boundedInteger(evidence.durationSec, 0, 86400),
      replayCount: boundedInteger(evidence.replayCount, 0, 100),
      reviewedStepIndexes: normalizeReviewedStepIndexes(evidence.reviewedStepIndexes),
    },
    resultFingerprint: buildAlgorithmLabResultFingerprint({
      labId: evidence.labId,
      presetId: evidence.presetId,
      presetVersion: evidence.presetVersion,
      resultFingerprints: evidence.resultFingerprints,
    }),
  } as AlgorithmLabCompletionRequest<TLabId>;
}

export function buildAlgorithmLabResultFingerprint(input: {
  labId: AlgorithmLabId;
  presetId: string;
  presetVersion: string;
  resultFingerprints: Array<{ algorithm: AlgorithmLabAlgorithm; fingerprint: string }>;
}): string {
  const sortedPairs = [...input.resultFingerprints]
    .sort((left, right) => left.algorithm.localeCompare(right.algorithm, 'en'))
    .map(({ algorithm, fingerprint }) => `${algorithm}=${fingerprint}`);
  return [
    'a3lab-result.v1',
    input.labId,
    input.presetId,
    input.presetVersion,
    ...sortedPairs,
  ].join('|');
}

export function getOrCreateAlgorithmLabCompletionEventId(
  labId: AlgorithmLabId,
  startedAt: string,
): string {
  const storage = getSessionStorage();
  const key = completionEventIdStorageKey(labId);
  const parsedStartedAt = Date.parse(startedAt);
  const stableTime = Number.isFinite(parsedStartedAt) ? parsedStartedAt : 0;
  const eventId = `a3lab_complete_${labId.replaceAll('-', '_')}_${stableTime}`;
  try {
    const existing = storage?.getItem(key);
    if (existing === eventId) return existing;
  } catch {
    // A deterministic fallback still keeps retries idempotent when storage is blocked.
  }

  try {
    storage?.setItem(key, eventId);
  } catch {
    // Browser privacy settings may block session storage.
  }
  return eventId;
}

export function clearAlgorithmLabCompletionEventId(labId: AlgorithmLabId): void {
  try {
    getSessionStorage()?.removeItem(completionEventIdStorageKey(labId));
  } catch {
    // Browser privacy settings may block session storage.
  }
}

export async function synchronizeAlgorithmLabCompletion(
  request: AlgorithmLabCompletionRequest,
  options: AlgorithmLabCompletionSyncOptions = {},
): Promise<AlgorithmLabCompletionSyncOutcome> {
  try {
    const response = await (options.submit ?? submitAlgorithmLabCompletion)(request);
    if (response.success && (response.status === 'accepted' || response.status === 'duplicate')) {
      options.onSubmitted?.(response.completion);
      return { syncState: 'submitted', completion: response.completion };
    }
    return {
      syncState: 'event_sync_failed',
      error: response.error || '学习记录同步失败，请重试。',
      retryLabel: '重新同步学习记录',
    };
  } catch {
    return {
      syncState: 'event_sync_failed',
      error: '暂时无法同步学习记录，请检查网络后重试。',
      retryLabel: '重新同步学习记录',
    };
  }
}

function normalizeReviewedStepIndexes(indexes: number[]): number[] {
  return [...new Set(indexes.filter((index) => (
    Number.isInteger(index) && index >= 0 && index <= 10000
  )))]
    .sort((left, right) => left - right)
    .slice(0, 50);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function roundToOne(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function getSessionStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function completionEventIdStorageKey(labId: AlgorithmLabId): string {
  return `a3.algorithmLab.${labId}.completionEventId`;
}
