import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { selectLatestResumeLabId } from '@/components/a3/features/algorithm-lab/algorithm-lab-catalog-view';
import {
  algorithmLabReducer,
  buildSimulationRuns,
  canStartAlgorithmLabRun,
  claimCheckpointSubmission,
  createAlgorithmLabStartedEventId,
  createAlgorithmLabState,
  createStartedEventGate,
  emitAlgorithmLabStartedOnce,
  type AlgorithmLabRunRequest,
} from '@/components/a3/features/algorithm-lab/algorithm-lab-workbench';
import { getNextMobilePanel } from '@/components/a3/features/algorithm-lab/algorithm-lab-layout';
import {
  buildCpuCheckpoints,
  deriveCpuGlobalCurrentTime,
  deriveCpuPredictionResult,
  findCpuSegmentStepIndex,
  getCpuTimelineLayout,
  getCpuProcessVisual,
  selectCpuStepAtTime,
} from '@/components/a3/features/algorithm-lab/cpu-scheduling-visualizer';
import {
  addCpuProcess,
  removeCpuProcess,
  updateCpuProcess,
} from '@/components/a3/features/algorithm-lab/algorithm-lab-input-panel';
import type { SimulationRun } from '@/lib/a3/algorithm-lab/contracts';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';

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

  it('clears persisted recovery and started-event state on reset', () => {
    const source = readFileSync(workbenchPath, 'utf8');

    expect(source).toContain('function resetWorkbench()');
    expect(source).toContain('clearLabSession(labId);');
    expect(source).toContain('startedEventGate.current = createStartedEventGate();');
    expect(source).toContain('onReset={resetWorkbench}');
  });

  it('provides the desktop, tablet and mobile workbench layouts', () => {
    const source = readFileSync(layoutPath, 'utf8');

    expect(source).toContain('grid-cols-[280px_minmax(0,1fr)_300px]');
    expect(source).toContain('min-h-[430px]');
    expect(source).toContain('输入');
    expect(source).toContain('运行');
    expect(source).toContain('结果');
    expect(source).toContain('details');
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
    expect(canStartAlgorithmLabRun('page-replacement', true, false)).toBe(true);
  });
});
