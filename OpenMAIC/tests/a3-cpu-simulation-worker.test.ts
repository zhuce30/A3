import { describe, expect, it, vi } from 'vitest';

import type { CpuSchedulingInput } from '@/lib/a3/algorithm-lab/contracts';
import {
  CpuSimulationCancelledError,
  CpuSimulationWorkerRunner,
  type CpuSimulationWorkerLike,
} from '@/lib/a3/algorithm-lab/cpu-simulation-worker-client';

class MockWorker implements CpuSimulationWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

const maximumInput = (): CpuSchedulingInput => ({
  processes: Array.from({ length: 12 }, (_, index) => ({
    processId: `P${index + 1}`,
    arrivalTime: 100,
    burstTime: 100,
    priority: 99,
  })),
  timeQuantum: 1,
});

describe('CPU simulation worker runner', () => {
  it('posts maximum legal RR work without synchronously computing it on the caller', async () => {
    const worker = new MockWorker();
    const runner = new CpuSimulationWorkerRunner(() => worker);
    let settled = false;

    const result = runner.run(maximumInput(), ['rr']).then((runs) => {
      settled = true;
      return runs;
    });

    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'simulate',
      input: maximumInput(),
      algorithms: ['rr'],
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    const requestId = worker.postMessage.mock.calls[0][0].requestId;
    worker.onmessage?.(new MessageEvent('message', { data: {
      type: 'result',
      requestId,
      runs: [{ algorithm: 'rr', steps: [], finalMetrics: {}, resultFingerprint: 'cpu:max' }],
    } }));
    await expect(result).resolves.toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancels reconfigured work and ignores its stale result', async () => {
    const workers = [new MockWorker(), new MockWorker()];
    const runner = new CpuSimulationWorkerRunner(() => workers.shift()!);
    const firstWorker = workers[0];
    const first = runner.run(maximumInput(), ['rr']);
    const staleHandler = firstWorker.onmessage;
    const secondWorker = workers[0];
    const second = runner.run(maximumInput(), ['fcfs']);

    await expect(first).rejects.toBeInstanceOf(CpuSimulationCancelledError);
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    staleHandler?.(new MessageEvent('message', { data: {
      type: 'result', requestId: 'stale', runs: [],
    } }));

    const requestId = secondWorker.postMessage.mock.calls[0][0].requestId;
    secondWorker.onmessage?.(new MessageEvent('message', { data: {
      type: 'result', requestId, runs: [],
    } }));
    await expect(second).resolves.toEqual([]);
  });

  it('surfaces worker errors and cancels active work on dispose', async () => {
    const errorWorker = new MockWorker();
    const runner = new CpuSimulationWorkerRunner(() => errorWorker);
    const failed = runner.run(maximumInput(), ['rr']);
    const requestId = errorWorker.postMessage.mock.calls[0][0].requestId;
    errorWorker.onmessage?.(new MessageEvent('message', { data: {
      type: 'error', requestId, error: '调度计算失败',
    } }));
    await expect(failed).rejects.toThrow('调度计算失败');

    const activeWorker = new MockWorker();
    const activeRunner = new CpuSimulationWorkerRunner(() => activeWorker);
    const active = activeRunner.run(maximumInput(), ['rr']);
    activeRunner.dispose();
    await expect(active).rejects.toBeInstanceOf(CpuSimulationCancelledError);
    expect(activeWorker.terminate).toHaveBeenCalledOnce();
  });
});
