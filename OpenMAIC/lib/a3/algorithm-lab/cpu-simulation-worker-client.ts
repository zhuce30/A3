import type { CpuSchedulingAlgorithm, CpuSchedulingInput } from './contracts';
import type {
  CpuSimulationRun,
  CpuSimulationWorkerRequest,
  CpuSimulationWorkerResponse,
} from './cpu-simulation-worker-contract';

export interface CpuSimulationWorkerLike {
  onmessage: ((event: MessageEvent<CpuSimulationWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: CpuSimulationWorkerRequest): void;
  terminate(): void;
}

type CpuSimulationWorkerFactory = () => CpuSimulationWorkerLike;

interface ActiveRequest {
  requestId: string;
  worker: CpuSimulationWorkerLike;
  reject: (error: Error) => void;
}

export class CpuSimulationCancelledError extends Error {
  constructor() {
    super('CPU 调度计算已取消');
    this.name = 'CpuSimulationCancelledError';
  }
}

export class CpuSimulationWorkerRunner {
  private activeRequest: ActiveRequest | null = null;
  private requestSequence = 0;

  constructor(private readonly createWorker: CpuSimulationWorkerFactory = createCpuSimulationWorker) {}

  run(
    input: CpuSchedulingInput,
    algorithms: CpuSchedulingAlgorithm[],
  ): Promise<CpuSimulationRun[]> {
    this.cancel();
    const requestId = `cpu-simulation-${++this.requestSequence}`;
    const worker = this.createWorker();

    return new Promise((resolve, reject) => {
      const activeRequest: ActiveRequest = { requestId, worker, reject };
      this.activeRequest = activeRequest;

      worker.onmessage = (event) => {
        const response = event.data;
        if (this.activeRequest !== activeRequest || response.requestId !== requestId) return;
        this.finish(activeRequest);
        if (response.type === 'result') {
          resolve(response.runs);
        } else {
          reject(new Error(response.error || 'CPU 调度计算失败，请重试'));
        }
      };
      worker.onerror = () => {
        if (this.activeRequest !== activeRequest) return;
        this.finish(activeRequest);
        reject(new Error('CPU 调度计算失败，请重试'));
      };

      try {
        worker.postMessage({
          type: 'simulate',
          requestId,
          input: structuredClone(input),
          algorithms: [...algorithms],
        });
      } catch {
        this.finish(activeRequest);
        reject(new Error('CPU 调度计算无法启动，请重试'));
      }
    });
  }

  cancel(): void {
    const activeRequest = this.activeRequest;
    if (!activeRequest) return;
    this.finish(activeRequest);
    activeRequest.reject(new CpuSimulationCancelledError());
  }

  dispose(): void {
    this.cancel();
  }

  private finish(activeRequest: ActiveRequest): void {
    if (this.activeRequest === activeRequest) this.activeRequest = null;
    activeRequest.worker.onmessage = null;
    activeRequest.worker.onerror = null;
    activeRequest.worker.terminate();
  }
}

function createCpuSimulationWorker(): CpuSimulationWorkerLike {
  return new Worker(
    new URL('../../../workers/a3-cpu-scheduling.worker.ts', import.meta.url),
    { type: 'module' },
  );
}
