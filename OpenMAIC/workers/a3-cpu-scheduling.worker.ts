import type { CpuSchedulingAlgorithm } from '@/lib/a3/algorithm-lab/contracts';
import type {
  CpuSimulationWorkerRequest,
  CpuSimulationWorkerResponse,
} from '@/lib/a3/algorithm-lab/cpu-simulation-worker-contract';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';

interface CpuWorkerScope {
  onmessage: ((event: MessageEvent<CpuSimulationWorkerRequest>) => void) | null;
  postMessage(message: CpuSimulationWorkerResponse): void;
}

const algorithms = new Set<CpuSchedulingAlgorithm>(['fcfs', 'sjf', 'priority', 'rr']);
const workerScope = self as unknown as CpuWorkerScope;

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request?.type !== 'simulate' || !Array.isArray(request.algorithms)) return;

  try {
    if (!request.algorithms.every((algorithm) => algorithms.has(algorithm))) {
      throw new Error('CPU 调度算法无效');
    }
    workerScope.postMessage({
      type: 'result',
      requestId: request.requestId,
      runs: request.algorithms.map((algorithm) => simulateCpuScheduling(request.input, algorithm)),
    });
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: request.requestId,
      error: error instanceof Error ? error.message : 'CPU 调度计算失败，请重试',
    });
  }
};
