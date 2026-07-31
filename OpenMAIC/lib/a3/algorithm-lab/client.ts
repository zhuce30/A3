import { a3GetJson, a3PostJson } from '../api-client';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabDifficulty,
  AlgorithmLabId,
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
}

export interface AlgorithmLabCatalogResponse {
  success: boolean;
  error?: string;
  schemaVersion?: 'a3.algorithm-labs.catalog.v1';
  labs: AlgorithmLabCatalogItem[];
  recentSession: AlgorithmLabCompletionResponse['completion'] | null;
}

export interface AlgorithmLabCompletionRequest {
  schemaVersion: 'a3.algorithm-lab.completion.v1';
  eventId: string;
  labId: AlgorithmLabId;
  labVersion: string;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  selectedAlgorithms: AlgorithmLabAlgorithm[];
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

export interface AlgorithmLabCompletionResponse {
  success: boolean;
  error?: string;
  status?: 'accepted' | 'duplicate';
  completion?: {
    labId: AlgorithmLabId;
    verified: boolean;
    score: number;
    masteryEvidenceAccepted: boolean;
    nextAction: {
      type?: string;
      label: string;
      href: string;
      reason: string;
    };
  };
}

export function fetchAlgorithmLabCatalog(): Promise<AlgorithmLabCatalogResponse> {
  return a3GetJson<AlgorithmLabCatalogResponse>('/api/learning/algorithm-labs/');
}

export function submitAlgorithmLabCompletion(
  request: AlgorithmLabCompletionRequest,
): Promise<AlgorithmLabCompletionResponse> {
  return a3PostJson<AlgorithmLabCompletionResponse>('/api/learning/algorithm-labs/complete/', request);
}
