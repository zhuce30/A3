import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selectLatestResumeLabId } from '@/components/a3/features/algorithm-lab/algorithm-lab-catalog-view';
import {
  algorithmLabReducer,
  buildSimulationRuns,
  canStartAlgorithmLabRun,
  claimCheckpointSubmission,
  createAlgorithmLabCheckpointEventId,
  createAlgorithmLabStartedEventId,
  createAlgorithmLabState,
  createAttemptEventState,
  createNextAttemptStartedAt,
  createStartedEventGate,
  emitAlgorithmLabStartedOnce,
  getAlgorithmLabFinalStepIndex,
  renewAttemptEventState,
  type AlgorithmLabRunRequest,
} from '@/components/a3/features/algorithm-lab/algorithm-lab-workbench';
import { getNextMobilePanel } from '@/components/a3/features/algorithm-lab/algorithm-lab-layout';
import {
  buildCpuCheckpoints,
  buildCpuGlobalTimeAxis,
  deriveCpuGlobalCurrentTime,
  deriveCpuPredictionResult,
  findCpuGlobalTimeIndex,
  findCpuSegmentEventTime,
  findCpuSegmentStepIndex,
  getAvailableCpuCheckpoints,
  getCpuTimelineLayout,
  getCpuProcessVisual,
  isCpuCheckpointRevealed,
  selectCpuStepAtTime,
} from '@/components/a3/features/algorithm-lab/cpu-scheduling-visualizer';
import {
  addCpuProcess,
  parsePageReferenceString,
  removeCpuProcess,
  updateCpuProcess,
} from '@/components/a3/features/algorithm-lab/algorithm-lab-input-panel';
import {
  buildPageCheckpoints,
  buildPageGlobalIndexAxis,
  derivePageGlobalCurrentIndex,
  derivePagePredictionResult,
  findPageGlobalIndexPosition,
  getAvailablePageCheckpoints,
  getPageStepExplanation,
  isPageCheckpointRevealed,
  selectPageStepAtIndex,
} from '@/components/a3/features/algorithm-lab/page-replacement-visualizer';
import type { SimulationRun } from '@/lib/a3/algorithm-lab/contracts';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';

const root = process.cwd();
const catalogPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx');
const routePath = join(root, 'app/a3/labs/[labId]/page.tsx');
const workbenchPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx');
const layoutPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-layout.tsx');
const controlsPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-controls.tsx');
const explanationPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-step-explanation.tsx');
const cpuVisualizerPath = join(root, 'components/a3/features/algorithm-lab/cpu-scheduling-visualizer.tsx');
const checkpointPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-checkpoint.tsx');
const inputPanelPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx');
const statusPanelPath = join(root, 'components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx');
const pageVisualizerPath = join(root, 'components/a3/features/algorithm-lab/page-replacement-visualizer.tsx');
const cpuWorkerClientPath = join(root, 'lib/a3/algorithm-lab/cpu-simulation-worker-client.ts');
const cpuWorkerPath = join(root, 'workers/a3-cpu-scheduling.worker.ts');

describe('algorithm lab UI', () => {
  it('has catalog loading, error, empty, progress and resume states', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('正在读取实验进度');
    expect(source).toContain('重新加载');
    expect(source).toContain('暂无可用实验');
    expect(source).toContain('继续上次实验');
    expect(source).toContain('verifiedRuns');
  });

  it('recovers and clears local unfinished sessions without persisting steps', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('loadLabSession');
    expect(source).toContain('clearLabSession');
    expect(source).toContain('清除记录');
    expect(source).not.toContain('session.steps');
  });

  it('selects the most recently started unfinished session', () => {
    expect(selectLatestResumeLabId(
      [{ id: 'cpu-scheduling' }, { id: 'page-replacement' }],
      {
        'cpu-scheduling': { startedAt: '2026-07-31T08:00:00.000Z' },
        'page-replacement': { startedAt: '2026-07-31T09:00:00.000Z' },
      },
    )).toBe('page-replacement');
  });

  it('orders recommended labs first and renders repeated lab items with one clear action', () => {
    const source = readFileSync(catalogPath, 'utf8');

    expect(source).toContain('recommended');
    expect(source).toContain('sortedLabs.map');
    expect(source).toContain('data-testid="a3-algorithm-lab-item"');
    expect(source).toContain('data-testid="a3-algorithm-lab-action"');
  });

  it('defines the complete reducer-owned workbench phase and state contract', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    for (const phase of ['idle', 'configured', 'predicted', 'running', 'paused', 'completed', 'submitted']) {
      expect(source).toContain(`'${phase}'`);
    }
    for (const field of [
      'selectedAlgorithms',
      'prediction',
      'runs',
      'currentStepIndex',
      'speed',
      'checkpointAnswers',
      'replayCount',
      'reviewedStepIndexes',
      'syncState',
      'startedAt',
    ]) {
      expect(source).toContain(field);
    }
  });

  it('invalidates old runs on configure and seeks without recomputing runs', () => {
    const initial = createAlgorithmLabState('cpu-scheduling');
    const runs: SimulationRun[] = [{
      algorithm: 'fcfs',
      steps: [{ index: 0, time: 0, label: 'start', explanation: '', state: {}, metrics: {} }],
      finalMetrics: {},
      resultFingerprint: 'cpu:test',
    }];
    const running = algorithmLabReducer(initial, { type: 'start', runs });
    const sought = algorithmLabReducer(running, { type: 'seek', index: 0 });
    expect(sought.runs).toBe(running.runs);

    const configured = algorithmLabReducer(sought, {
      type: 'configure',
      labId: 'cpu-scheduling',
      input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }], timeQuantum: 1 },
      algorithms: ['fcfs'],
    });
    expect(configured.phase).toBe('configured');
    expect(configured.runs).toEqual([]);
    expect(configured.currentStepIndex).toBe(0);
    expect(configured.startedAt).toBeNull();
    expect(configured.checkpointAnswers).toEqual({});
    expect(configured.attemptNumber).toBe(running.attemptNumber + 1);
  });

  it('gives a configured attempt fresh started and checkpoint event gates', async () => {
    const firstAttempt = createAttemptEventState(0);
    firstAttempt.startedEventGate.status = 'in_flight';
    firstAttempt.checkpointEventGate.add('cpu-ready-queue');

    const nextAttempt = renewAttemptEventState(firstAttempt, 1);

    expect(nextAttempt).not.toBe(firstAttempt);
    expect(nextAttempt.startedEventGate.status).toBe('idle');
    expect(nextAttempt.checkpointEventGate.size).toBe(0);
    expect(renewAttemptEventState(nextAttempt, 1)).toBe(nextAttempt);
  });

  it('initializes deterministically and restores only through an explicit hydrated action', () => {
    const source = readFileSync(workbenchPath, 'utf8');
    const initial = createAlgorithmLabState('cpu-scheduling');

    expect(initial.hydrated).toBe(false);
    expect(source).toContain('useReducer(algorithmLabReducer, labId, createAlgorithmLabState)');
    expect(source).toContain("type: 'restore'");
    expect(source).toContain('if (!state.hydrated) return;');
    expect(source).not.toContain('useReducer(algorithmLabReducer, labId, restoreAlgorithmLabState)');

    const restored = algorithmLabReducer(initial, {
      type: 'restore',
      labId: 'cpu-scheduling',
      session: {
        schemaVersion: 'a3.algorithm-lab.session.v1',
        labId: 'cpu-scheduling',
        phase: 'paused',
        presetId: 'custom',
        presetVersion: '1.0.0',
        selectedAlgorithms: ['fcfs'],
        input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 2, priority: 0 }], timeQuantum: 1 },
        prediction: null,
        checkpointAnswers: {},
        currentStepIndex: 1,
        replayCount: 0,
        reviewedStepIndexes: [],
        startedAt: '2026-07-31T12:00:00.000Z',
      },
      runs: buildSimulationRuns({
        labId: 'cpu-scheduling',
        input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 2, priority: 0 }], timeQuantum: 1 },
        algorithms: ['fcfs'],
      }),
    });
    expect(restored).toMatchObject({ hydrated: true, phase: 'paused', presetId: 'custom' });
    expect(restored.runs.length).toBe(1);
  });

  it('keeps lab input and algorithms correlated at compile time and runtime', () => {
    const cpuRequest: AlgorithmLabRunRequest = {
      labId: 'cpu-scheduling',
      input: { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 1, priority: 0 }], timeQuantum: 1 },
      algorithms: ['fcfs'],
    };
    expect(buildSimulationRuns(cpuRequest)[0].algorithm).toBe('fcfs');

    expect(() => buildSimulationRuns({
      ...cpuRequest,
      algorithms: ['fifo'],
    } as unknown as AlgorithmLabRunRequest)).toThrow('算法与实验类型不匹配');

    if (false) {
      // @ts-expect-error FIFO cannot be paired with CPU scheduling input.
      void buildSimulationRuns({ ...cpuRequest, algorithms: ['fifo'] });
    }
  });

  it('retries a failed started event and stops after a successful write', async () => {
    const gate = createStartedEventGate();
    const send = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: true, status: 'accepted' });

    await expect(emitAlgorithmLabStartedOnce(gate, send)).resolves.toBe(false);
    expect(gate.status).toBe('idle');
    await expect(emitAlgorithmLabStartedOnce(gate, send)).resolves.toBe(true);
    expect(gate.status).toBe('sent');
    await expect(emitAlgorithmLabStartedOnce(gate, send)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('guards duplicate in-flight started events and uses a stable retry event id', async () => {
    const gate = createStartedEventGate();
    let resolveSend: ((value: { success: true; status: 'duplicate' }) => void) | undefined;
    const send = vi.fn(() => new Promise<{ success: true; status: 'duplicate' }>((resolve) => {
      resolveSend = resolve;
    }));

    const first = emitAlgorithmLabStartedOnce(gate, send);
    await expect(emitAlgorithmLabStartedOnce(gate, send)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    resolveSend?.({ success: true, status: 'duplicate' });
    await expect(first).resolves.toBe(true);

    const startedAt = '2026-07-31T12:00:00.000Z';
    expect(createAlgorithmLabStartedEventId('cpu-scheduling', startedAt)).toBe(
      createAlgorithmLabStartedEventId('cpu-scheduling', startedAt),
    );
  });

  it('renders a safe dynamic route and a real unknown-lab recovery link', () => {
    const route = readFileSync(routePath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');

    expect(route).toContain('params: Promise<{ labId: string }>');
    expect(route).toContain('<AlgorithmLabWorkbench labId={labId} />');
    expect(workbench).toContain('未找到该实验');
    expect(workbench).toContain('href="/a3/labs"');
  });

  it('uses one cleaned-up playback timer and compact local recovery', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    expect(source.match(/setInterval\(/g)).toHaveLength(1);
    expect(source).toContain('clearInterval');
    expect(source).toContain('}, [finalStepIndex, state.phase, state.speed]);');
    expect(source).toContain('loadLabSession');
    expect(source).toContain('saveLabSession');
    expect(source).toContain('simulateCpuScheduling');
    expect(source).toContain('simulatePageReplacement');
    expect(source).toContain('trackAlgorithmLabStarted');
    expect(source).toContain("resourceType: 'interactive_lab'");
    expect(source).not.toContain('steps: state.runs');
    expect(source).not.toContain('as never');
  });

  it('runs CPU simulation in a cancellable module worker with visible async states', () => {
    const workbench = readFileSync(workbenchPath, 'utf8');
    const workerClient = readFileSync(cpuWorkerClientPath, 'utf8');
    const worker = readFileSync(cpuWorkerPath, 'utf8');

    expect(workerClient).toContain('new Worker(');
    expect(workerClient).toContain("new URL('../../../workers/a3-cpu-scheduling.worker.ts', import.meta.url)");
    expect(workerClient).toContain("{ type: 'module' }");
    expect(workerClient).toContain('response.requestId !== requestId');
    expect(workerClient).not.toContain('setTimeout');
    expect(worker).toContain('simulateCpuScheduling');
    expect(workbench).toContain('正在后台计算调度结果');
    expect(workbench).toContain('role="alert"');
    expect(workbench).toContain('cpuSimulationRunnerRef.current?.dispose();');
    expect(workbench).toContain('cpuSimulationRunnerRef.current?.cancel();');
    expect(workbench).toContain('runner.run(session.input, session.selectedAlgorithms)');
    expect(workbench).not.toContain('buildRestoredCpuRuns');
  });

  it('clears persisted recovery, active CPU work, and attempt event state on reset', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    expect(source).toContain('function resetWorkbench()');
    expect(source).toContain('clearLabSession(labId);');
    expect(source).toContain('cpuSimulationRunnerRef.current?.cancel();');
    const started = algorithmLabReducer(createAlgorithmLabState('page-replacement'), {
      type: 'start',
      runs: [],
      startedAt: '2026-07-31T12:00:00.000Z',
    });
    const reset = algorithmLabReducer(started, { type: 'reset' });
    expect(reset.startedAt).toBeNull();
    expect(reset.attemptNumber).toBe(started.attemptNumber + 1);
    expect(source).toContain('onReset={resetWorkbench}');
  });

  it('creates distinct stable event IDs for a new page-replacement attempt', () => {
    const firstStartedAt = '2026-07-31T12:00:00.000Z';
    const nextStartedAt = createNextAttemptStartedAt(firstStartedAt, Date.parse(firstStartedAt));

    expect(nextStartedAt).toBe('2026-07-31T12:00:00.001Z');

    expect(createAlgorithmLabStartedEventId('page-replacement', firstStartedAt)).not.toBe(
      createAlgorithmLabStartedEventId('page-replacement', nextStartedAt),
    );
    expect(createAlgorithmLabCheckpointEventId(
      'page-replacement', 'page-victim', firstStartedAt,
    )).not.toBe(createAlgorithmLabCheckpointEventId(
      'page-replacement', 'page-victim', nextStartedAt,
    ));
  });

  it('provides the desktop, tablet and mobile workbench layouts', () => {
    const source = readFileSync(layoutPath, 'utf8');

    expect(source).toContain('grid-cols-[280px_minmax(0,1fr)_300px]');
    expect(source).toContain('min-h-[430px]');
    expect(source).toContain('输入');
    expect(source).toContain('运行');
    expect(source).toContain('结果');
    expect(source).toContain('aria-expanded={inputExpanded}');
    expect(source).toContain('aria-expanded={statusExpanded}');
    expect(source.match(/\{inputPanel\}/g)).toHaveLength(1);
    expect(source.match(/\{statusPanel\}/g)).toHaveLength(1);
  });

  it('shows a visible custom preset after restoring edited input', () => {
    const inputPanel = readFileSync(
      join(root, 'components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx'),
      'utf8',
    );

    expect(inputPanel).toContain('自定义配置');
    expect(inputPanel).toContain("presetId === 'custom'");
  });

  it('implements the complete keyboard-operable ARIA tabs pattern', () => {
    const source = readFileSync(layoutPath, 'utf8');

    expect(source).toContain('aria-controls');
    expect(source).toContain('aria-labelledby');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('tabIndex={mobilePanel === value ? 0 : -1}');
    expect(source).toContain('ArrowLeft');
    expect(source).toContain('ArrowRight');
    expect(source).toContain('Home');
    expect(source).toContain('End');

    expect(getNextMobilePanel('input', 'ArrowRight')).toBe('run');
    expect(getNextMobilePanel('input', 'ArrowLeft')).toBe('result');
    expect(getNextMobilePanel('result', 'Home')).toBe('input');
    expect(getNextMobilePanel('input', 'End')).toBe('result');
    expect(getNextMobilePanel('run', 'Enter')).toBe('run');
  });

  it('exposes accessible playback controls and a collapsed scrolling explanation', () => {
    const controls = readFileSync(controlsPath, 'utf8');
    const explanation = readFileSync(explanationPath, 'utf8');

    for (const label of ['播放', '暂停', '上一步', '下一步', '重置', '全屏画布']) {
      expect(controls).toContain(`aria-label="${label}"`);
    }
    expect(explanation).toContain('<details');
    expect(explanation).toContain('overflow-y-auto');
  });

  it('renders the complete CPU scheduling comparison canvas without layout animation', () => {
    const visualizer = readFileSync(cpuVisualizerPath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');

    expect(visualizer).toContain('data-testid="cpu-scheduling-canvas"');
    expect(visualizer).toContain('时间标尺');
    expect(visualizer).toContain('runs.map');
    expect(visualizer).toContain('getCpuProcessVisual');
    expect(visualizer).toContain('当前时间');
    expect(visualizer).toContain('就绪队列');
    expect(visualizer).toContain('运行进程');
    expect(visualizer).toContain('onSeek');
    expect(visualizer).toContain('duration-200');
    expect(visualizer).not.toContain('transition-all');
    expect(workbench).toContain('<CpuSchedulingVisualizer');
  });

  it('keeps the ruler, current-time line, and Gantt rows in one track after the 78px label', () => {
    const visualizer = readFileSync(cpuVisualizerPath, 'utf8');
    const layout = getCpuTimelineLayout(680);

    expect(layout).toEqual({
      columnGap: 12,
      gridTemplateColumns: '78px 680px',
      width: 770,
    });
    expect(visualizer).toContain('data-testid="cpu-timeline-coordinate-space"');
    expect(visualizer).toContain('data-testid="cpu-time-ruler"');
    expect(visualizer).toContain('data-testid="cpu-current-time-line"');
    expect(visualizer).toContain('data-testid="cpu-gantt-track"');
  });

  it('projects every algorithm to the controlling run time when third-step times differ', () => {
    const input = {
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 1, priority: 0 },
      ],
      timeQuantum: 2,
    };
    const rr = simulateCpuScheduling(input, 'rr');
    const fcfs = simulateCpuScheduling(input, 'fcfs');

    expect(rr.steps[2].time).toBe(3);
    expect(fcfs.steps[2].time).toBe(6);

    const currentTime = deriveCpuGlobalCurrentTime([rr, fcfs], 2);
    expect(currentTime).toBe(3);
    expect(selectCpuStepAtTime(rr, currentTime)).toBe(rr.steps[2]);
    expect(selectCpuStepAtTime(fcfs, currentTime)).toBe(fcfs.steps[0]);

    const statusPanel = readFileSync(statusPanelPath, 'utf8');
    expect(statusPanel).toContain('deriveCpuGlobalCurrentTime');
    expect(statusPanel).toContain('selectCpuStepAtTime');
  });

  it('drives playback and cross-row seeking from the sorted global CPU event-time axis', () => {
    const input = {
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 1, priority: 0 },
      ],
      timeQuantum: 2,
    };
    const fcfs = simulateCpuScheduling(input, 'fcfs');
    const sjf = simulateCpuScheduling(input, 'sjf');
    const rr = simulateCpuScheduling(input, 'rr');
    const runs = [fcfs, sjf, rr];
    const timeAxis = buildCpuGlobalTimeAxis(runs);

    expect(timeAxis).toEqual([0, 1, 2, 3, 5, 6]);
    expect(getAlgorithmLabFinalStepIndex('cpu-scheduling', runs)).toBe(5);
    expect(deriveCpuGlobalCurrentTime(runs, 2)).toBe(2);
    expect(selectCpuStepAtTime(undefined, 2)).toBeUndefined();
    expect(selectCpuStepAtTime(fcfs, 2)).toBe(fcfs.steps[0]);
    expect(selectCpuStepAtTime(rr, 2)).toBe(rr.steps[1]);

    const fcfsFirstSegment = fcfs.steps.at(-1)!.state.timeline[0];
    const eventTime = findCpuSegmentEventTime(fcfs, fcfsFirstSegment);
    expect(findCpuSegmentStepIndex(fcfs, fcfsFirstSegment)).toBe(1);
    expect(eventTime).toBe(5);
    expect(findCpuGlobalTimeIndex(timeAxis, eventTime)).toBe(4);

    let state = algorithmLabReducer(createAlgorithmLabState('cpu-scheduling'), {
      type: 'start',
      runs,
      startedAt: '2026-07-31T12:00:00.000Z',
    });
    const visitedTimes = [deriveCpuGlobalCurrentTime(runs, state.currentStepIndex)];
    while (state.phase !== 'completed') {
      state = algorithmLabReducer(state, { type: 'advance' });
      visitedTimes.push(deriveCpuGlobalCurrentTime(runs, state.currentStepIndex));
    }
    expect(visitedTimes).toEqual(timeAxis);

    const visualizer = readFileSync(cpuVisualizerPath, 'utf8');
    expect(visualizer).toContain('findCpuGlobalTimeIndex(timeAxis, eventTime)');
    expect(visualizer).not.toContain('onSeek(stepIndex)');
  });

  it('keeps process visuals and segment seeking deterministic across algorithms', () => {
    expect(getCpuProcessVisual('P2')).toEqual(getCpuProcessVisual('P2'));
    expect(getCpuProcessVisual('idle').label).toBe('空闲');

    const run = simulateCpuScheduling({
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 3, priority: 1 },
        { processId: 'P2', arrivalTime: 1, burstTime: 2, priority: 0 },
      ],
      timeQuantum: 1,
    }, 'rr');
    const segment = run.finalMetrics.completionOrder.length > 0
      ? run.steps.at(-1)!.state.timeline[1]
      : run.steps.at(-1)!.state.timeline[0];
    const stepIndex = findCpuSegmentStepIndex(run, segment);

    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(run.steps[stepIndex].state.timeline).toContainEqual(segment);
  });

  it('edits CPU rows within 1..12 and preserves official validation errors', () => {
    const base = { processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 2, priority: 0 }], timeQuantum: 2 };
    expect(removeCpuProcess(base, 0).processes).toHaveLength(1);

    let expanded = base;
    for (let index = 0; index < 20; index += 1) expanded = addCpuProcess(expanded);
    expect(expanded.processes).toHaveLength(12);

    const invalid = updateCpuProcess(base, 0, 'burstTime', 0);
    expect(invalid.processes[0].burstTime).toBe(0);

    const inputPanel = readFileSync(inputPanelPath, 'utf8');
    expect(inputPanel).toContain('validateCpuSchedulingInput');
    expect(inputPanel).toContain('disabled={input.processes.length >= 12}');
    expect(inputPanel).toContain('disabled={input.processes.length <= 1}');
    expect(inputPanel).toContain('到达时间');
    expect(inputPanel).toContain('运行时间');
    expect(inputPanel).toContain('优先级');
    expect(inputPanel).toContain('时间片');
    expect(inputPanel).toContain('自定义配置');
  });

  it('requires an answer or explicit skip and reveals prediction correctness only at completion', () => {
    const runs = (['fcfs', 'sjf', 'rr'] as const).map((algorithm) => simulateCpuScheduling({
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 1, priority: 0 },
      ],
      timeQuantum: 2,
    }, algorithm));

    expect(deriveCpuPredictionResult({ answer: 'sjf', skipped: false }, runs, false)).toBeNull();
    expect(deriveCpuPredictionResult({ answer: 'sjf', skipped: false }, runs, true)).toMatchObject({
      correct: true,
      winners: ['sjf'],
    });

    const inputPanel = readFileSync(inputPanelPath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');
    expect(inputPanel).toContain('哪种算法的平均等待时间最低');
    expect(inputPanel).toContain('跳过预测');
    expect(workbench).toContain('predictionReady');
    expect(workbench).toContain('predictionResult');
  });

  it('builds two once-only CPU checkpoints with correctness and step indexes', () => {
    const run = simulateCpuScheduling({
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 4, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 2, priority: 0 },
        { processId: 'P3', arrivalTime: 1, burstTime: 1, priority: 2 },
      ],
      timeQuantum: 2,
    }, 'rr');
    const checkpoints = buildCpuCheckpoints(run);

    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
      'cpu-ready-queue',
      'cpu-completion-order',
    ]);
    expect(checkpoints.every((checkpoint) => Number.isInteger(checkpoint.stepIndex))).toBe(true);

    const submissionGate = new Set<string>();
    expect(claimCheckpointSubmission(submissionGate, 'cpu-ready-queue')).toBe(true);
    expect(claimCheckpointSubmission(submissionGate, 'cpu-ready-queue')).toBe(false);
    expect(claimCheckpointSubmission(submissionGate, 'cpu-completion-order')).toBe(true);

    const checkpoint = readFileSync(checkpointPath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');
    expect(checkpoint).toContain('aria-live="polite"');
    expect(workbench).toContain('trackAlgorithmLabCheckpoint');
    expect(workbench).toContain("resourceType: 'interactive_lab'");
    expect(workbench).toContain('checkpointEventGate');
    expect(workbench).toContain('correct');
    expect(workbench).toContain('stepIndex');
  });

  it('gates CPU checkpoints and withholds their answer-bearing fields until submission', () => {
    const input = {
      processes: [
        { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 1 },
        { processId: 'P2', arrivalTime: 0, burstTime: 1, priority: 0 },
      ],
      timeQuantum: 2,
    };
    const runs = [
      simulateCpuScheduling(input, 'fcfs'),
      simulateCpuScheduling(input, 'sjf'),
      simulateCpuScheduling(input, 'rr'),
    ];
    const timeAxis = buildCpuGlobalTimeAxis(runs);
    const checkpoints = buildCpuCheckpoints(runs[0], timeAxis);

    expect(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint.stepIndex])).toEqual([
      ['cpu-ready-queue', 0],
      ['cpu-completion-order', timeAxis.length - 1],
    ]);
    expect(getAvailableCpuCheckpoints(checkpoints, 0, {})).toHaveLength(1);
    expect(getAvailableCpuCheckpoints(checkpoints, timeAxis.length - 2, {}).map(({ id }) => id)).toEqual([
      'cpu-ready-queue',
    ]);
    expect(getAvailableCpuCheckpoints(checkpoints, timeAxis.length - 1, {}).map(({ id }) => id)).toEqual([
      'cpu-ready-queue',
      'cpu-completion-order',
    ]);
    expect(isCpuCheckpointRevealed('cpu-ready-queue', {})).toBe(false);
    expect(isCpuCheckpointRevealed('cpu-ready-queue', { 'cpu-ready-queue': 'P2' })).toBe(true);
    expect(isCpuCheckpointRevealed('cpu-completion-order', {})).toBe(false);
    expect(isCpuCheckpointRevealed('cpu-completion-order', {
      'cpu-completion-order': runs[0].finalMetrics.completionOrder.join(' → '),
    })).toBe(true);

    const visualizer = readFileSync(cpuVisualizerPath, 'utf8');
    const statusPanel = readFileSync(statusPanelPath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');
    expect(visualizer).toContain('revealReadyQueue');
    expect(visualizer.indexOf('!revealReadyQueue')).toBeLessThan(
      visualizer.indexOf('focusedStep?.state.readyQueue.length'),
    );
    expect(statusPanel).toContain('revealCompletionOrder');
    expect(statusPanel).toContain('提交完成顺序检查点后显示');
    expect(workbench).toContain('getAvailableCpuCheckpoints');
    expect(workbench).toContain('isCpuCheckpointRevealed');
  });

  it('offers a non-answer completion-order distractor without leaking a single process answer', () => {
    const run = simulateCpuScheduling({
      processes: [{ processId: 'OnlyProcess', arrivalTime: 0, burstTime: 1, priority: 0 }],
      timeQuantum: 1,
    }, 'fcfs');
    const checkpoint = buildCpuCheckpoints(run).find(({ id }) => id === 'cpu-completion-order');

    expect(checkpoint).toBeDefined();
    expect(checkpoint!.options).toContain(checkpoint!.correctAnswer);
    expect(checkpoint!.options.some((option) => option !== checkpoint!.correctAnswer)).toBe(true);
    expect(`${checkpoint!.question}${checkpoint!.context}`).not.toContain(checkpoint!.correctAnswer);
  });

  it('shows all five CPU metrics in the status panel', () => {
    const source = readFileSync(statusPanelPath, 'utf8');
    for (const metric of ['平均等待', '平均周转', '平均响应', '上下文切换', '完成顺序']) {
      expect(source).toContain(metric);
    }
  });

  it('disables the first run until CPU input is valid and prediction is answered or skipped', () => {
    expect(canStartAlgorithmLabRun('cpu-scheduling', false, true)).toBe(false);
    expect(canStartAlgorithmLabRun('cpu-scheduling', true, false)).toBe(false);
    expect(canStartAlgorithmLabRun('cpu-scheduling', true, true)).toBe(true);
    expect(canStartAlgorithmLabRun('page-replacement', true, false)).toBe(false);
    expect(canStartAlgorithmLabRun('page-replacement', true, true)).toBe(true);
  });

  it('renders a complete page replacement canvas with fixed frames and explicit state cues', () => {
    const visualizer = readFileSync(pageVisualizerPath, 'utf8');
    const workbench = readFileSync(workbenchPath, 'utf8');

    expect(visualizer).toContain('data-testid="page-replacement-canvas"');
    expect(visualizer).toContain('引用序列');
    expect(visualizer).toContain('页框矩阵');
    expect(visualizer).toContain('当前列');
    for (const cue of ['命中', '缺页', '淘汰', '调入', '保持不变']) {
      expect(visualizer).toContain(cue);
    }
    for (const evidence of ['FIFO 队列', 'LRU 最近使用顺序', 'OPT 下次访问距离']) {
      expect(visualizer).toContain(evidence);
    }
    expect(visualizer).toContain('onSeek');
    expect(visualizer).not.toContain('transition-all');
    expect(workbench).toContain('<PageReplacementVisualizer');
  });

  it('parses editable page references and retains official shared validation', () => {
    expect(parsePageReferenceString('7, 0  1,2')).toEqual([7, 0, 1, 2]);
    expect(parsePageReferenceString('')).toEqual([]);
    expect(parsePageReferenceString('1, nope')).toEqual([1, Number.NaN]);

    const inputPanel = readFileSync(inputPanelPath, 'utf8');
    expect(inputPanel).toContain('validatePageReplacementInput');
    expect(inputPanel).toContain('页面引用序列');
    expect(inputPanel).toContain('页框数量');
    expect(inputPanel).toContain('标准预设');
    expect(inputPanel).toContain('自定义配置');
  });

  it('drives page rows and column seeking from the shared global reference-index axis', () => {
    const input = { referenceString: [1, 2, 3, 1, 4, 2], frameCount: 3 };
    const fifo = simulatePageReplacement(input, 'fifo');
    const lru = simulatePageReplacement(input, 'lru');
    const runs = [fifo, lru];
    const indexAxis = buildPageGlobalIndexAxis(runs);

    expect(indexAxis).toEqual([0, 1, 2, 3, 4, 5]);
    expect(getAlgorithmLabFinalStepIndex('page-replacement', runs)).toBe(5);
    expect(derivePageGlobalCurrentIndex(runs, 4)).toBe(4);
    expect(selectPageStepAtIndex(fifo, 4)).toBe(fifo.steps[4]);
    expect(findPageGlobalIndexPosition(indexAxis, 4)).toBe(4);

    let state = algorithmLabReducer(createAlgorithmLabState('page-replacement'), {
      type: 'start',
      runs,
      startedAt: '2026-07-31T12:00:00.000Z',
    });
    const originalRuns = state.runs;
    state = algorithmLabReducer(state, { type: 'seek', index: findPageGlobalIndexPosition(indexAxis, 2) });
    expect(state.currentStepIndex).toBe(2);
    expect(state.runs).toBe(originalRuns);
  });

  it('clears submitted page checkpoints when the page lab is reconfigured', () => {
    const input = { referenceString: [1, 2, 3, 4], frameCount: 3 };
    const runs = [simulatePageReplacement(input, 'fifo')];
    let state = algorithmLabReducer(createAlgorithmLabState('page-replacement'), {
      type: 'start',
      runs,
      startedAt: '2026-07-31T12:00:00.000Z',
    });
    state = algorithmLabReducer(state, {
      type: 'answer_checkpoint',
      checkpointId: 'page-victim',
      answer: '1',
    });
    state = algorithmLabReducer(state, {
      type: 'answer_checkpoint',
      checkpointId: 'page-policy-reason',
      answer: '选择最早进入内存且仍驻留的页面',
    });

    const configured = algorithmLabReducer(state, {
      type: 'configure',
      labId: 'page-replacement',
      input: { referenceString: [4, 3, 2, 1], frameCount: 2 },
      algorithms: ['fifo'],
    });

    expect(configured.phase).toBe('configured');
    expect(configured.runs).toEqual([]);
    expect(configured.checkpointAnswers).toEqual({});
    expect(configured.currentStepIndex).toBe(0);
  });

  it('sanitizes page step explanations until each answer-bearing checkpoint is submitted', () => {
    const run = simulatePageReplacement(
      { referenceString: [1, 2, 3, 4, 1, 5], frameCount: 3 },
      'fifo',
    );
    const victimStep = run.steps[3];

    const hidden = getPageStepExplanation(run, victimStep, false, false);
    expect(hidden).toContain('页面 4');
    expect(hidden).toContain('缺页');
    expect(hidden).not.toContain('淘汰页 1');
    expect(hidden).not.toContain('FIFO 队列');

    const victimRevealed = getPageStepExplanation(run, victimStep, true, false);
    expect(victimRevealed).toContain('淘汰页 1');
    expect(victimRevealed).not.toContain('FIFO 队列');

    const policyRevealed = getPageStepExplanation(run, victimStep, false, true);
    expect(policyRevealed).not.toContain('淘汰页 1');
    expect(policyRevealed).toContain('FIFO 队列');

    const workbench = readFileSync(workbenchPath, 'utf8');
    expect(workbench).toContain('getPageStepExplanation');
  });

  it('reveals the fewest-fault prediction and tie evidence only after completion', () => {
    const input = { referenceString: [7, 0, 1, 2, 0, 3, 0, 4], frameCount: 3 };
    const runs = (['fifo', 'lru', 'opt'] as const).map((algorithm) => simulatePageReplacement(input, algorithm));

    expect(derivePagePredictionResult({ answer: 'opt', skipped: false }, runs, false)).toBeNull();
    expect(derivePagePredictionResult({ answer: 'opt', skipped: false }, runs, true)).toMatchObject({
      correct: true,
      winners: ['lru', 'opt'],
    });
    const tieRuns = (['fifo', 'lru'] as const).map((algorithm) => simulatePageReplacement({
      referenceString: [1, 2, 1, 2],
      frameCount: 2,
    }, algorithm));
    expect(derivePagePredictionResult({ answer: 'fifo', skipped: false }, tieRuns, true)).toMatchObject({
      correct: true,
      winners: ['fifo', 'lru'],
      fewestFaults: 2,
    });

    const inputPanel = readFileSync(inputPanelPath, 'utf8');
    const statusPanel = readFileSync(statusPanelPath, 'utf8');
    expect(inputPanel).toContain('哪种算法的缺页次数最少');
    expect(inputPanel).toContain('跳过预测');
    expect(statusPanel).toContain('仅代表当前引用序列');
  });

  it('shows four page metrics and policy-specific comparison evidence', () => {
    const source = readFileSync(statusPanelPath, 'utf8');
    for (const metric of ['缺页次数', '命中次数', '缺页率', '淘汰次数']) {
      expect(source).toContain(metric);
    }
    expect(source).toContain('pageRuns');
    expect(source).toContain('selectPageStepAtIndex');
  });

  it('builds deterministic victim and policy checkpoints and gates each event once', () => {
    const input = { referenceString: [1, 2, 3, 4, 1, 5], frameCount: 3 };
    const run = simulatePageReplacement(input, 'fifo');
    const indexAxis = buildPageGlobalIndexAxis([run]);
    const checkpoints = buildPageCheckpoints(run, indexAxis);

    expect(checkpoints.map(({ id }) => id)).toEqual(['page-victim', 'page-policy-reason']);
    expect(checkpoints.map(({ stepIndex }) => stepIndex)).toEqual([3, 5]);
    expect(checkpoints.every(({ correctAnswer }) => typeof correctAnswer === 'string' && correctAnswer.length > 0)).toBe(true);
    expect(getAvailablePageCheckpoints(checkpoints, 2, {})).toEqual([]);
    expect(getAvailablePageCheckpoints(checkpoints, 3, {}).map(({ id }) => id)).toEqual(['page-victim']);
    expect(isPageCheckpointRevealed('page-victim', {})).toBe(false);
    expect(isPageCheckpointRevealed('page-victim', { 'page-victim': '1' })).toBe(true);

    const gate = new Set<string>();
    expect(claimCheckpointSubmission(gate, 'page-victim')).toBe(true);
    expect(claimCheckpointSubmission(gate, 'page-victim')).toBe(false);
    expect(claimCheckpointSubmission(gate, 'page-policy-reason')).toBe(true);

    const workbench = readFileSync(workbenchPath, 'utf8');
    expect(workbench).toContain('submitPageCheckpoint');
    expect(workbench).toContain("checkpointId: checkpoint.id");
    expect(workbench).toContain('correct');
    expect(workbench).toContain('stepIndex: checkpoint.stepIndex');
  });

  it('keeps both page checkpoint IDs when a custom run needs no eviction', () => {
    const run = simulatePageReplacement({ referenceString: [1, 1, 2], frameCount: 3 }, 'lru');
    const checkpoints = buildPageCheckpoints(run);

    expect(checkpoints.map(({ id }) => id)).toEqual(['page-victim', 'page-policy-reason']);
    expect(checkpoints[0].correctAnswer).toBe('未淘汰页面');
    expect(checkpoints[1].correctAnswer).toBe('当前步骤没有发生淘汰');
    expect(checkpoints.every(({ stepIndex }) => stepIndex === 2)).toBe(true);
  });
});
