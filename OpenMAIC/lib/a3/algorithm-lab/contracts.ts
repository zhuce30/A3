export type AlgorithmLabId = 'cpu-scheduling' | 'page-replacement';

export type CpuSchedulingAlgorithm = 'fcfs' | 'sjf' | 'priority' | 'rr';

export type PageReplacementAlgorithm = 'fifo' | 'lru' | 'opt';

export type AlgorithmLabAlgorithm = CpuSchedulingAlgorithm | PageReplacementAlgorithm;

export type AlgorithmLabDifficulty = 'foundation' | 'misconception' | 'comparison';

export type AlgorithmLabPhase =
  | 'idle'
  | 'configured'
  | 'predicted'
  | 'running'
  | 'paused'
  | 'completed'
  | 'submitted';

export interface CpuProcessInput {
  processId: string;
  arrivalTime: number;
  burstTime: number;
  priority: number;
}

export interface CpuSchedulingInput {
  processes: CpuProcessInput[];
  timeQuantum: number;
}

export interface PageReplacementInput {
  referenceString: number[];
  frameCount: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type AlgorithmLabInput = CpuSchedulingInput | PageReplacementInput;

export interface AlgorithmLabInputById {
  'cpu-scheduling': CpuSchedulingInput;
  'page-replacement': PageReplacementInput;
}

export interface AlgorithmLabAlgorithmById {
  'cpu-scheduling': CpuSchedulingAlgorithm;
  'page-replacement': PageReplacementAlgorithm;
}

export interface AlgorithmLabPreset<TInput extends AlgorithmLabInput = AlgorithmLabInput> {
  id: string;
  version: string;
  title: string;
  description: string;
  difficulty: AlgorithmLabDifficulty;
  input: TInput;
}

export interface SimulationStep<
  TState = Record<string, unknown>,
  TMetrics = Record<string, unknown>,
> {
  index: number;
  time: number;
  label: string;
  explanation: string;
  state: TState;
  metrics: TMetrics;
  checkpointId?: string;
}

export interface SimulationRun<
  TState = Record<string, unknown>,
  TMetrics = Record<string, unknown>,
> {
  algorithm: AlgorithmLabAlgorithm;
  steps: SimulationStep<TState, TMetrics>[];
  finalMetrics: TMetrics;
  resultFingerprint: string;
}

export type AlgorithmLabDefinitionFor<TLabId extends AlgorithmLabId> =
  TLabId extends AlgorithmLabId
    ? {
        id: TLabId;
        version: string;
        title: string;
        description: string;
        estimatedMinutes: number;
        knowledgePointCodes: string[];
        algorithms: AlgorithmLabAlgorithmById[TLabId][];
        presets: AlgorithmLabPreset<AlgorithmLabInputById[TLabId]>[];
      }
    : never;

export type AlgorithmLabDefinition<TLabId extends AlgorithmLabId = AlgorithmLabId> =
  AlgorithmLabDefinitionFor<TLabId>;
