import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  simulateCpuScheduling,
  type CpuProcessState,
  type CpuSchedulingMetrics,
  type CpuSchedulingState,
} from '@/lib/a3/algorithm-lab/cpu-scheduling';
import type {
  CpuSchedulingAlgorithm,
  CpuSchedulingInput,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';

const baseInput = (): CpuSchedulingInput => ({
  processes: [
    { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 2 },
    { processId: 'P2', arrivalTime: 1, burstTime: 3, priority: 1 },
    { processId: 'P3', arrivalTime: 2, burstTime: 1, priority: 3 },
  ],
  timeQuantum: 2,
});

const finalState = (
  run: SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>,
): CpuSchedulingState => run.steps.at(-1)!.state;

const completionOrder = (algorithm: CpuSchedulingAlgorithm): string[] =>
  simulateCpuScheduling(baseInput(), algorithm).finalMetrics.completionOrder;

describe('deterministic CPU scheduling kernel', () => {
  it('exports the required typed simulation contract', () => {
    const process: CpuProcessState = {
      processId: 'P1',
      arrivalTime: 0,
      burstTime: 1,
      priority: 1,
      remainingTime: 1,
      startTime: null,
      completionTime: null,
    };
    const run = simulateCpuScheduling({ processes: [process], timeQuantum: 1 }, 'fcfs');

    expectTypeOf(run).toEqualTypeOf<SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>>();
    expect(process.remainingTime).toBe(1);
  });

  it('uses the required completion order for every policy', () => {
    expect(completionOrder('fcfs')).toEqual(['P1', 'P2', 'P3']);
    expect(completionOrder('sjf')).toEqual(['P1', 'P3', 'P2']);
    expect(completionOrder('priority')).toEqual(['P1', 'P2', 'P3']);
    expect(completionOrder('rr')).toEqual(['P3', 'P2', 'P1']);
  });

  it.each<CpuSchedulingAlgorithm>(['fcfs', 'sjf', 'priority', 'rr'])(
    '%s finishes every process and reports stable aggregate evidence',
    (algorithm) => {
      const first = simulateCpuScheduling(baseInput(), algorithm);
      const second = simulateCpuScheduling(structuredClone(baseInput()), algorithm);

      expect(finalState(first).processes.every((process) => process.remainingTime === 0)).toBe(
        true,
      );
      expect(first.finalMetrics.totalBusyTime).toBe(9);
      expect(first.finalMetrics.averageWaitingTime).toBeGreaterThanOrEqual(0);
      expect(first.finalMetrics.averageTurnaroundTime).toBeGreaterThanOrEqual(0);
      expect(first.finalMetrics.averageResponseTime).toBeGreaterThanOrEqual(0);
      expect(second.finalMetrics).toEqual(first.finalMetrics);
    },
  );

  it('creates a wide stable fingerprint from the algorithm, input, and execution events', () => {
    const first = simulateCpuScheduling(baseInput(), 'fcfs');
    const repeated = simulateCpuScheduling(structuredClone(baseInput()), 'fcfs');
    const otherAlgorithm = simulateCpuScheduling(baseInput(), 'sjf');
    const singleProcess = {
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 4, priority: 0 }],
    };
    const quantumOne = simulateCpuScheduling({ ...singleProcess, timeQuantum: 1 }, 'rr');
    const quantumTwo = simulateCpuScheduling({ ...singleProcess, timeQuantum: 2 }, 'rr');

    expect(first.resultFingerprint).toMatch(/^cpu:[0-9a-f]{32}$/);
    expect(repeated.resultFingerprint).toBe(first.resultFingerprint);
    expect(otherAlgorithm.resultFingerprint).not.toBe(first.resultFingerprint);
    expect(finalState(quantumOne).timeline).toEqual(finalState(quantumTwo).timeline);
    expect(quantumOne.finalMetrics).toEqual(quantumTwo.finalMetrics);
    expect(quantumOne.resultFingerprint).not.toBe(quantumTwo.resultFingerprint);
  });

  it('computes exact FCFS timeline and metrics', () => {
    const run = simulateCpuScheduling(baseInput(), 'fcfs');

    expect(finalState(run).timeline).toEqual([
      { processId: 'P1', start: 0, end: 5 },
      { processId: 'P2', start: 5, end: 8 },
      { processId: 'P3', start: 8, end: 9 },
    ]);
    expect(run.finalMetrics).toEqual({
      averageWaitingTime: 3.33,
      averageTurnaroundTime: 6.33,
      averageResponseTime: 3.33,
      contextSwitches: 2,
      totalBusyTime: 9,
      completionOrder: ['P1', 'P2', 'P3'],
    });
  });

  it('computes exact SJF and priority timelines and metrics', () => {
    const cases = [
      {
        algorithm: 'sjf' as const,
        timeline: [
          { processId: 'P1', start: 0, end: 5 },
          { processId: 'P3', start: 5, end: 6 },
          { processId: 'P2', start: 6, end: 9 },
        ],
        metrics: {
          averageWaitingTime: 2.67,
          averageTurnaroundTime: 5.67,
          averageResponseTime: 2.67,
          contextSwitches: 2,
          totalBusyTime: 9,
          completionOrder: ['P1', 'P3', 'P2'],
        },
      },
      {
        algorithm: 'priority' as const,
        timeline: [
          { processId: 'P1', start: 0, end: 5 },
          { processId: 'P2', start: 5, end: 8 },
          { processId: 'P3', start: 8, end: 9 },
        ],
        metrics: {
          averageWaitingTime: 3.33,
          averageTurnaroundTime: 6.33,
          averageResponseTime: 3.33,
          contextSwitches: 2,
          totalBusyTime: 9,
          completionOrder: ['P1', 'P2', 'P3'],
        },
      },
    ];

    for (const { algorithm, timeline, metrics } of cases) {
      const run = simulateCpuScheduling(baseInput(), algorithm);

      expect(finalState(run).timeline).toEqual(timeline);
      expect(run.finalMetrics).toEqual(metrics);
    }
  });

  it('does not mutate input and freezes the run with deep-independent step snapshots', () => {
    const input = baseInput();
    const before = structuredClone(input);
    const run = simulateCpuScheduling(input, 'rr');
    const first = run.steps[0].state;
    const second = run.steps[1].state;

    expect(input).toEqual(before);
    expect(first).not.toBe(second);
    expect(first.processes).not.toBe(second.processes);
    expect(first.processes[0]).not.toBe(second.processes[0]);
    expect(first.timeline).not.toBe(second.timeline);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.steps)).toBe(true);
    expect(Object.isFrozen(run.finalMetrics)).toBe(true);
    expect(Object.isFrozen(run.finalMetrics.completionOrder)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.processes)).toBe(true);
    expect(Object.isFrozen(first.processes[0])).toBe(true);
    expect(Object.isFrozen(first.timeline)).toBe(true);
    expect(() => run.steps.pop()).toThrow(TypeError);
    expect(() => {
      run.finalMetrics.contextSwitches = 99;
    }).toThrow(TypeError);
    expect(() => run.finalMetrics.completionOrder.push('mutated')).toThrow(TypeError);
    expect(() => {
      first.processes[0].remainingTime = 99;
    }).toThrow(TypeError);
  });

  it('breaks identical policy ties by arrival time and then process ID', () => {
    const input: CpuSchedulingInput = {
      processes: [
        { processId: 'P2', arrivalTime: 0, burstTime: 2, priority: 1 },
        { processId: 'P1', arrivalTime: 0, burstTime: 2, priority: 1 },
      ],
      timeQuantum: 2,
    };

    for (const algorithm of ['fcfs', 'sjf', 'priority', 'rr'] as const) {
      expect(simulateCpuScheduling(input, algorithm).finalMetrics.completionOrder).toEqual([
        'P1',
        'P2',
      ]);
    }
  });

  it('records and merges initial and intermediate idle slices', () => {
    const initialIdle = simulateCpuScheduling(
      {
        processes: [{ processId: 'P1', arrivalTime: 3, burstTime: 1, priority: 0 }],
        timeQuantum: 1,
      },
      'fcfs',
    );
    const intermediateIdle = simulateCpuScheduling(
      {
        processes: [
          { processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 },
          { processId: 'P2', arrivalTime: 3, burstTime: 1, priority: 0 },
        ],
        timeQuantum: 1,
      },
      'sjf',
    );

    expect(finalState(initialIdle).timeline[0]).toEqual({ processId: 'idle', start: 0, end: 3 });
    expect(finalState(intermediateIdle).timeline).toEqual([
      { processId: 'P1', start: 0, end: 1 },
      { processId: 'idle', start: 1, end: 3 },
      { processId: 'P2', start: 3, end: 4 },
    ]);
  });

  it('does not count a process dispatch after an idle gap as a context switch', () => {
    const run = simulateCpuScheduling(
      {
        processes: [
          { processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 },
          { processId: 'P2', arrivalTime: 3, burstTime: 1, priority: 0 },
        ],
        timeQuantum: 1,
      },
      'fcfs',
    );

    expect(run.finalMetrics.contextSwitches).toBe(0);
  });

  it('enqueues RR arrivals before the expired process at quantum boundaries', () => {
    const run = simulateCpuScheduling(baseInput(), 'rr');

    expect(finalState(run).timeline).toEqual([
      { processId: 'P1', start: 0, end: 2 },
      { processId: 'P2', start: 2, end: 4 },
      { processId: 'P3', start: 4, end: 5 },
      { processId: 'P1', start: 5, end: 7 },
      { processId: 'P2', start: 7, end: 8 },
      { processId: 'P1', start: 8, end: 9 },
    ]);
    expect(run.steps.map((step) => step.time)).toEqual([0, 2, 4, 5, 7, 8, 9]);
    expect(run.steps.find((step) => step.time === 2)?.state).toMatchObject({
      currentProcessId: 'P2',
      readyQueue: ['P3', 'P1'],
    });
    expect(run.steps.find((step) => step.time === 4)?.state).toMatchObject({
      currentProcessId: 'P3',
      readyQueue: ['P1', 'P2'],
    });
    expect(run.finalMetrics).toEqual({
      averageWaitingTime: 3.33,
      averageTurnaroundTime: 6.33,
      averageResponseTime: 1,
      contextSwitches: 5,
      totalBusyTime: 9,
      completionOrder: ['P3', 'P2', 'P1'],
    });
  });

  it('handles one process and all processes arriving together', () => {
    const single = simulateCpuScheduling(
      {
        processes: [{ processId: 'only', arrivalTime: 0, burstTime: 5, priority: 0 }],
        timeQuantum: 2,
      },
      'rr',
    );
    const simultaneous: CpuSchedulingInput = {
      processes: [
        { processId: 'P3', arrivalTime: 0, burstTime: 3, priority: 2 },
        { processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 2, priority: 1 },
      ],
      timeQuantum: 1,
    };

    expect(finalState(single).timeline).toEqual([{ processId: 'only', start: 0, end: 5 }]);
    expect(single.finalMetrics.contextSwitches).toBe(0);
    expect(simulateCpuScheduling(simultaneous, 'sjf').finalMetrics.completionOrder).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
    expect(simulateCpuScheduling(simultaneous, 'priority').finalMetrics.completionOrder).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
  });

  it.each([
    { processes: [], timeQuantum: 2 },
    {
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 0, priority: 1 }],
      timeQuantum: 2,
    },
    {
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 1 }],
      timeQuantum: 0,
    },
  ])('throws a normal Error for invalid input %#', (input) => {
    expect(() => simulateCpuScheduling(input as CpuSchedulingInput, 'fcfs')).toThrow(Error);
  });

  it('preserves exact shared validation errors for invalid runtime input', () => {
    expect(() =>
      simulateCpuScheduling(
        {
          processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }],
          timeQuantum: 0,
        },
        'rr',
      ),
    ).toThrowError(new Error('时间片必须是 1 到 20 之间的整数'));

    expect(() =>
      simulateCpuScheduling(
        {
          processes: [
            { processId: ' P1 ', arrivalTime: 0, burstTime: 1, priority: 0 },
            { processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 },
          ],
          timeQuantum: 1,
        },
        'fcfs',
      ),
    ).toThrowError(new Error('进程编号不能重复'));

    expect(() =>
      simulateCpuScheduling(
        { processes: [null], timeQuantum: 1 } as unknown as CpuSchedulingInput,
        'fcfs',
      ),
    ).toThrowError(new Error('每个进程必须是对象'));
  });

  it('accepts exact boundaries and terminates for twelve maximum-burst processes', () => {
    const lower = simulateCpuScheduling(
      {
        processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }],
        timeQuantum: 1,
      },
      'rr',
    );
    const upper = simulateCpuScheduling(
      {
        processes: Array.from({ length: 12 }, (_, index) => ({
          processId: `P${String(index + 1).padStart(2, '0')}`,
          arrivalTime: 100,
          burstTime: 100,
          priority: 99,
        })),
        timeQuantum: 20,
      },
      'rr',
    );

    expect(lower.finalMetrics.totalBusyTime).toBe(1);
    expect(finalState(lower).processes[0]).toMatchObject({
      remainingTime: 0,
      completionTime: 1,
    });
    expect(upper.finalMetrics.totalBusyTime).toBe(1200);
    expect(finalState(upper).processes).toHaveLength(12);
    expect(finalState(upper).processes.every((process) => process.remainingTime === 0)).toBe(true);
    expect(upper.steps.at(-1)?.time).toBe(1300);
  });

  it.each(['idle', 'IDLE', ' Idle '])('rejects reserved process ID %s before simulation', (processId) => {
    expect(() => simulateCpuScheduling({
      processes: [{ processId, arrivalTime: 0, burstTime: 1, priority: 0 }],
      timeQuantum: 1,
    }, 'fcfs')).toThrowError(new Error('进程编号不能使用保留值 idle'));
  });
});
