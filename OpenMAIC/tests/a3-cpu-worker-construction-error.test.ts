import { describe, expect, it } from 'vitest';

import type { CpuSchedulingInput } from '@/lib/a3/algorithm-lab/contracts';
import { CpuSimulationWorkerRunner } from '@/lib/a3/algorithm-lab/cpu-simulation-worker-client';

const input: CpuSchedulingInput = {
  processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }],
  timeQuantum: 1,
};

describe('CPU worker construction errors', () => {
  it('returns a controlled rejected promise when Worker construction throws synchronously', async () => {
    const runner = new CpuSimulationWorkerRunner(() => {
      throw new DOMException('worker unavailable', 'SecurityError');
    });
    let request: Promise<unknown> | undefined;

    expect(() => {
      request = runner.run(input, ['fcfs']);
    }).not.toThrow();
    await expect(request).rejects.toThrow('CPU 调度计算无法启动，请重试');
  });
});
