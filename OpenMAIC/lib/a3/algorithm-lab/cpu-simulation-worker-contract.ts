import type {
  CpuSchedulingAlgorithm,
  CpuSchedulingInput,
  SimulationRun,
} from './contracts';
import type { CpuSchedulingMetrics, CpuSchedulingState } from './cpu-scheduling';

export type CpuSimulationRun = SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>;

export interface CpuSimulationWorkerRequest {
  type: 'simulate';
  requestId: string;
  input: CpuSchedulingInput;
  algorithms: CpuSchedulingAlgorithm[];
}

export type CpuSimulationWorkerResponse =
  | { type: 'result'; requestId: string; runs: CpuSimulationRun[] }
  | { type: 'error'; requestId: string; error: string };
