import type {
  CpuProcessInput,
  CpuSchedulingAlgorithm,
  CpuSchedulingInput,
  SimulationRun,
  SimulationStep,
} from './contracts';
import { validateCpuSchedulingInput } from './validators';

export interface CpuProcessState extends CpuProcessInput {
  remainingTime: number;
  startTime: number | null;
  completionTime: number | null;
}

export interface CpuSchedulingState {
  currentProcessId: string | null;
  readyQueue: string[];
  completedProcessIds: string[];
  processes: CpuProcessState[];
  timeline: Array<{ processId: string | 'idle'; start: number; end: number }>;
}

export interface CpuSchedulingMetrics {
  averageWaitingTime: number;
  averageTurnaroundTime: number;
  averageResponseTime: number;
  contextSwitches: number;
  totalBusyTime: number;
  completionOrder: string[];
}

type TimelineSlice = CpuSchedulingState['timeline'][number];

const CPU_ALGORITHMS: readonly CpuSchedulingAlgorithm[] = ['fcfs', 'sjf', 'priority', 'rr'];

const compareProcessId = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareArrivalAndId = (left: CpuProcessState, right: CpuProcessState): number =>
  left.arrivalTime - right.arrivalTime || compareProcessId(left.processId, right.processId);

const policyComparator = (
  algorithm: Exclude<CpuSchedulingAlgorithm, 'rr'>,
): ((left: CpuProcessState, right: CpuProcessState) => number) => {
  if (algorithm === 'sjf') {
    return (left, right) => left.burstTime - right.burstTime || compareArrivalAndId(left, right);
  }
  if (algorithm === 'priority') {
    return (left, right) => left.priority - right.priority || compareArrivalAndId(left, right);
  }
  return compareArrivalAndId;
};

const roundToTwo = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
};

const appendTimelineSlice = (
  timeline: TimelineSlice[],
  processId: TimelineSlice['processId'],
  start: number,
  end: number,
): void => {
  if (end <= start) return;

  const previous = timeline.at(-1);
  if (previous?.processId === processId && previous.end === start) {
    previous.end = end;
    return;
  }
  timeline.push({ processId, start, end });
};

const calculateMetrics = (
  processes: CpuProcessState[],
  timeline: TimelineSlice[],
  completionOrder: string[],
  contextSwitches: number,
): CpuSchedulingMetrics => {
  const completed = processes.filter(
    (process): process is CpuProcessState & { startTime: number; completionTime: number } =>
      process.startTime !== null && process.completionTime !== null,
  );
  const divisor = completed.length || 1;
  const waitingTotal = completed.reduce(
    (total, process) => total + (process.completionTime - process.arrivalTime - process.burstTime),
    0,
  );
  const turnaroundTotal = completed.reduce(
    (total, process) => total + (process.completionTime - process.arrivalTime),
    0,
  );
  const responseTotal = completed.reduce(
    (total, process) => total + (process.startTime - process.arrivalTime),
    0,
  );

  return {
    averageWaitingTime: roundToTwo(waitingTotal / divisor),
    averageTurnaroundTime: roundToTwo(turnaroundTotal / divisor),
    averageResponseTime: roundToTwo(responseTotal / divisor),
    contextSwitches,
    totalBusyTime: timeline.reduce(
      (total, slice) => total + (slice.processId === 'idle' ? 0 : slice.end - slice.start),
      0,
    ),
    completionOrder: [...completionOrder],
  };
};

const fingerprintDigest = (value: string): string => {
  const states = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const multipliers = [0x01000193, 0x27d4eb2d, 0x165667b1, 0x85ebca77];

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (let lane = 0; lane < states.length; lane += 1) {
      states[lane] ^= code + Math.imul(index + 1, lane + 1);
      states[lane] = Math.imul(states[lane], multipliers[lane]);
      states[lane] ^= states[lane] >>> (11 + lane);
    }
  }

  return states
    .map((state, lane) => {
      let mixed = state ^ (value.length + lane);
      mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
      mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
      mixed ^= mixed >>> 16;
      return (mixed >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
};

const createFingerprint = (
  algorithm: CpuSchedulingAlgorithm,
  timeQuantum: number,
  steps: Array<SimulationStep<CpuSchedulingState, CpuSchedulingMetrics>>,
  state: CpuSchedulingState,
  metrics: CpuSchedulingMetrics,
): string => {
  const canonicalResult = {
    algorithm,
    processes: [...state.processes]
      .sort((left, right) => compareProcessId(left.processId, right.processId))
      .map((process) => ({
        processId: process.processId,
        arrivalTime: process.arrivalTime,
        burstTime: process.burstTime,
        priority: process.priority,
      })),
    timeQuantum,
    execution: {
      timeline: state.timeline,
      events: steps.map((step) => ({
        time: step.time,
        currentProcessId: step.state.currentProcessId,
        readyQueue: step.state.readyQueue,
        completedProcessIds: step.state.completedProcessIds,
        processes: [...step.state.processes]
          .sort((left, right) => compareProcessId(left.processId, right.processId))
          .map((process) => ({
            processId: process.processId,
            remainingTime: process.remainingTime,
            startTime: process.startTime,
            completionTime: process.completionTime,
          })),
      })),
    },
    completionOrder: metrics.completionOrder,
    finalMetrics: metrics,
  };

  return `cpu:${fingerprintDigest(JSON.stringify(canonicalResult))}`;
};

export function simulateCpuScheduling(
  input: CpuSchedulingInput,
  algorithm: CpuSchedulingAlgorithm,
): SimulationRun<CpuSchedulingState, CpuSchedulingMetrics> {
  const validation = validateCpuSchedulingInput(input);
  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }
  if (!CPU_ALGORITHMS.includes(algorithm)) {
    throw new Error(`Unsupported CPU scheduling algorithm: ${String(algorithm)}`);
  }

  const processes: CpuProcessState[] = input.processes.map((process) => ({
    processId: process.processId.trim(),
    arrivalTime: process.arrivalTime,
    burstTime: process.burstTime,
    priority: process.priority,
    remainingTime: process.burstTime,
    startTime: null,
    completionTime: null,
  }));
  const pending = [...processes].sort(compareArrivalAndId);
  const ready: CpuProcessState[] = [];
  const completedProcessIds: string[] = [];
  const timeline: TimelineSlice[] = [];
  const steps: Array<SimulationStep<CpuSchedulingState, CpuSchedulingMetrics>> = [];
  let clock = 0;
  let contextSwitches = 0;
  let lastExecutedProcessId: string | null = null;

  const enqueueArrivals = (throughTime: number): void => {
    while (pending.length > 0 && pending[0].arrivalTime <= throughTime) {
      ready.push(pending.shift()!);
    }
  };

  const takeNextProcess = (): CpuProcessState => {
    if (algorithm !== 'rr') {
      ready.sort(policyComparator(algorithm));
    }
    return ready.shift()!;
  };

  const captureStep = (
    currentProcessId: string | null,
    label: string,
    explanation: string,
  ): void => {
    const state = deepFreeze<CpuSchedulingState>({
      currentProcessId,
      readyQueue: ready.map((process) => process.processId),
      completedProcessIds: [...completedProcessIds],
      processes: processes.map((process) => ({ ...process })),
      timeline: timeline.map((slice) => ({ ...slice })),
    });
    const metrics = deepFreeze(
      calculateMetrics(processes, timeline, completedProcessIds, contextSwitches),
    );
    steps.push(
      deepFreeze({
        index: steps.length,
        time: clock,
        label,
        explanation,
        state,
        metrics,
      }),
    );
  };

  while (completedProcessIds.length < processes.length) {
    enqueueArrivals(clock);

    if (ready.length === 0) {
      captureStep(null, 'CPU idle', 'No process is ready to run.');
      const nextArrivalTime = pending[0]?.arrivalTime;
      if (nextArrivalTime === undefined || nextArrivalTime <= clock) {
        throw new Error('CPU scheduling simulation could not advance.');
      }
      appendTimelineSlice(timeline, 'idle', clock, nextArrivalTime);
      lastExecutedProcessId = null;
      clock = nextArrivalTime;
      continue;
    }

    const current = takeNextProcess();
    if (current.startTime === null) current.startTime = clock;
    if (lastExecutedProcessId !== null && lastExecutedProcessId !== current.processId) {
      contextSwitches += 1;
    }
    lastExecutedProcessId = current.processId;
    captureStep(
      current.processId,
      `Run ${current.processId}`,
      `${current.processId} is selected by ${algorithm.toUpperCase()}.`,
    );

    const duration =
      algorithm === 'rr'
        ? Math.min(input.timeQuantum, current.remainingTime)
        : current.remainingTime;
    const endTime = clock + duration;
    appendTimelineSlice(timeline, current.processId, clock, endTime);
    current.remainingTime -= duration;
    clock = endTime;

    // Arrivals at the boundary enter the RR queue before the expired process is requeued.
    enqueueArrivals(clock);
    if (current.remainingTime === 0) {
      current.completionTime = clock;
      completedProcessIds.push(current.processId);
    } else {
      ready.push(current);
    }
  }

  captureStep(null, 'Simulation complete', 'All processes have completed.');
  const finalState = steps.at(-1)!.state;
  const finalMetrics = steps.at(-1)!.metrics;

  return deepFreeze({
    algorithm,
    steps,
    finalMetrics,
    resultFingerprint: createFingerprint(
      algorithm,
      input.timeQuantum,
      steps,
      finalState,
      finalMetrics,
    ),
  });
}
