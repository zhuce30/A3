'use client';

import Link from 'next/link';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabAlgorithmById,
  AlgorithmLabId,
  AlgorithmLabInputById,
  AlgorithmLabPhase,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';
import { getAlgorithmLabDefinition } from '@/lib/a3/algorithm-lab/registry';
import { validateCpuSchedulingInput, validatePageReplacementInput } from '@/lib/a3/algorithm-lab/validators';
import {
  ALGORITHM_LAB_SESSION_SCHEMA_VERSION,
  clearLabSession,
  loadLabSession,
  saveLabSession,
  type AlgorithmLabSession,
} from '@/lib/a3/algorithm-lab/session';
import { trackAlgorithmLabStarted } from '@/lib/a3/learning-event-client';
import { AlgorithmLabControls } from './algorithm-lab-controls';
import { AlgorithmLabInputPanel } from './algorithm-lab-input-panel';
import { AlgorithmLabLayout } from './algorithm-lab-layout';
import { AlgorithmLabStatusPanel } from './algorithm-lab-status-panel';
import { AlgorithmLabStepExplanation } from './algorithm-lab-step-explanation';

type SyncState = 'idle' | 'pending' | 'failed' | 'submitted';

interface AlgorithmLabStateBase {
  phase: AlgorithmLabPhase;
  hydrated: boolean;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  prediction: { answer: string | null; skipped: boolean } | null;
  runs: SimulationRun<unknown, unknown>[];
  currentStepIndex: number;
  speed: number;
  checkpointAnswers: Record<string, string>;
  replayCount: number;
  reviewedStepIndexes: number[];
  syncState: SyncState;
  syncError: string;
  startedAt: string | null;
}

export type AlgorithmLabStateFor<TLabId extends AlgorithmLabId> = AlgorithmLabStateBase & {
  labId: TLabId;
  input: AlgorithmLabInputById[TLabId];
  selectedAlgorithms: AlgorithmLabAlgorithmById[TLabId][];
};

export type AlgorithmLabState =
  | AlgorithmLabStateFor<'cpu-scheduling'>
  | AlgorithmLabStateFor<'page-replacement'>;

type ConfigureAction = {
  [TLabId in AlgorithmLabId]: {
    type: 'configure';
    labId: TLabId;
    input: AlgorithmLabInputById[TLabId];
    algorithms: AlgorithmLabAlgorithmById[TLabId][];
  }
}[AlgorithmLabId];

type RestoreAction = {
  [TLabId in AlgorithmLabId]: {
    type: 'restore';
    labId: TLabId;
    session: AlgorithmLabSession<TLabId> | null;
  }
}[AlgorithmLabId];

export type AlgorithmLabAction =
  | ConfigureAction
  | RestoreAction
  | { type: 'predict'; answer: string | null; skipped: boolean }
  | { type: 'start'; runs: SimulationRun<unknown, unknown>[]; startedAt?: string }
  | { type: 'pause' }
  | { type: 'seek'; index: number }
  | { type: 'advance' }
  | { type: 'rewind' }
  | { type: 'finish' }
  | { type: 'answer_checkpoint'; checkpointId: string; answer: string }
  | { type: 'sync_pending' }
  | { type: 'sync_failed'; message: string }
  | { type: 'submitted' }
  | { type: 'reset' }
  | { type: 'set_speed'; speed: number }
  | { type: 'review_step'; index: number };

export function createAlgorithmLabState(
  labId: 'cpu-scheduling',
): AlgorithmLabStateFor<'cpu-scheduling'>;
export function createAlgorithmLabState(
  labId: 'page-replacement',
): AlgorithmLabStateFor<'page-replacement'>;
export function createAlgorithmLabState(labId: AlgorithmLabId): AlgorithmLabState;
export function createAlgorithmLabState(labId: AlgorithmLabId): AlgorithmLabState {
  if (labId === 'cpu-scheduling') {
    const definition = getAlgorithmLabDefinition('cpu-scheduling');
    if (!definition) throw new Error('CPU 调度实验未注册');
    const preset = definition.presets[0];
    return createStateForLab(labId, preset.input, definition.algorithms, preset.id, preset.version);
  }
  const definition = getAlgorithmLabDefinition('page-replacement');
  if (!definition) throw new Error('页面置换实验未注册');
  const preset = definition.presets[0];
  return createStateForLab(labId, preset.input, definition.algorithms, preset.id, preset.version);
}

function createStateForLab<TLabId extends AlgorithmLabId>(
  labId: TLabId,
  input: AlgorithmLabInputById[TLabId],
  algorithms: AlgorithmLabAlgorithmById[TLabId][],
  presetId: string,
  presetVersion: string,
): AlgorithmLabStateFor<TLabId> {
  return {
    labId,
    phase: 'idle',
    hydrated: false,
    presetId,
    presetVersion,
    customInput: false,
    input: structuredClone(input),
    selectedAlgorithms: [...algorithms],
    prediction: null,
    runs: [],
    currentStepIndex: 0,
    speed: 1,
    checkpointAnswers: {},
    replayCount: 0,
    reviewedStepIndexes: [],
    syncState: 'idle',
    syncError: '',
    startedAt: null,
  };
}

export function algorithmLabReducer(
  state: AlgorithmLabState,
  action: AlgorithmLabAction,
): AlgorithmLabState {
  const finalStepIndex = getFinalStepIndex(state.runs);
  switch (action.type) {
    case 'restore':
      return restoreState(state, action);
    case 'configure': {
      return configureState(state, action);
    }
    case 'predict':
      return { ...state, phase: 'predicted', prediction: { answer: action.answer, skipped: action.skipped } };
    case 'start': {
      const resuming = state.phase === 'paused' && state.runs === action.runs;
      const replaying = state.runs.length > 0 && !resuming;
      return {
        ...state,
        phase: 'running',
        runs: action.runs,
        currentStepIndex: resuming ? state.currentStepIndex : 0,
        replayCount: replaying ? state.replayCount + 1 : state.replayCount,
        startedAt: state.startedAt ?? action.startedAt ?? new Date().toISOString(),
        syncState: 'idle',
        syncError: '',
      };
    }
    case 'pause':
      return state.phase === 'running' ? { ...state, phase: 'paused' } : state;
    case 'seek':
      return { ...state, currentStepIndex: clampStep(action.index, finalStepIndex) };
    case 'advance': {
      const nextIndex = clampStep(state.currentStepIndex + 1, finalStepIndex);
      return { ...state, currentStepIndex: nextIndex, phase: nextIndex >= finalStepIndex ? 'completed' : state.phase };
    }
    case 'rewind': {
      const index = clampStep(state.currentStepIndex - 1, finalStepIndex);
      return {
        ...state,
        phase: state.phase === 'running' ? 'paused' : state.phase,
        currentStepIndex: index,
        reviewedStepIndexes: uniqueIndexes([...state.reviewedStepIndexes, index]),
      };
    }
    case 'finish':
      return { ...state, phase: 'completed', currentStepIndex: Math.max(0, finalStepIndex) };
    case 'answer_checkpoint':
      return {
        ...state,
        checkpointAnswers: { ...state.checkpointAnswers, [action.checkpointId]: action.answer },
      };
    case 'sync_pending':
      return { ...state, syncState: 'pending', syncError: '' };
    case 'sync_failed':
      return { ...state, syncState: 'failed', syncError: action.message };
    case 'submitted':
      return { ...state, phase: 'submitted', syncState: 'submitted', syncError: '' };
    case 'set_speed':
      return { ...state, speed: [0.5, 1, 1.5, 2].includes(action.speed) ? action.speed : 1 };
    case 'review_step':
      return { ...state, reviewedStepIndexes: uniqueIndexes([...state.reviewedStepIndexes, action.index]) };
    case 'reset':
      return { ...createAlgorithmLabState(state.labId), hydrated: true };
  }
}

export function AlgorithmLabWorkbench({ labId }: { labId: string }) {
  const definition = getAlgorithmLabDefinition(labId);
  if (!definition) {
    return (
      <div className="mx-auto flex min-h-[52vh] max-w-lg flex-col items-center justify-center text-center">
        <FlaskConical className="size-10 text-[var(--a3-text-muted)]" />
        <h1 className="mt-4 text-xl font-semibold text-[var(--a3-text)]">未找到该实验</h1>
        <p className="mt-2 text-sm text-[var(--a3-text-muted)]">该实验可能已调整，请返回实验目录重新选择。</p>
        <Link href="/a3/labs" className="mt-5 inline-flex h-10 items-center gap-2 rounded-md bg-amber-500 px-4 text-sm font-semibold text-slate-950 hover:bg-amber-400">
          <ArrowLeft className="size-4" />返回实验目录
        </Link>
      </div>
    );
  }
  return <KnownAlgorithmLabWorkbench key={definition.id} labId={definition.id} />;
}

function KnownAlgorithmLabWorkbench({ labId }: { labId: AlgorithmLabId }) {
  const definition = getAlgorithmLabDefinition(labId)!;
  const [state, dispatch] = useReducer(algorithmLabReducer, labId, createAlgorithmLabState);
  const canvasRef = useRef<HTMLDivElement>(null);
  const startedEventGate = useRef(createStartedEventGate());
  const finalStepIndex = useMemo(() => getFinalStepIndex(state.runs), [state.runs]);
  const currentStep = state.runs[0]?.steps[state.currentStepIndex];

  useEffect(() => {
    if (labId === 'cpu-scheduling') {
      dispatch({ type: 'restore', labId, session: loadLabSession(labId) });
      return;
    }
    dispatch({ type: 'restore', labId, session: loadLabSession(labId) });
  }, [labId]);

  useEffect(() => {
    if (state.phase !== 'running') return;
    if (finalStepIndex < 0) {
      dispatch({ type: 'finish' });
      return;
    }
    const timer = window.setInterval(() => dispatch({ type: 'advance' }), Math.round(1000 / state.speed));
    return () => window.clearInterval(timer);
  }, [finalStepIndex, state.phase, state.speed]);

  useEffect(() => {
    if (!state.hydrated) return;
    if (state.phase === 'submitted' || state.syncState === 'submitted') {
      clearLabSession(labId);
      return;
    }
    if (!state.startedAt) return;
    saveLabSession(labId, toCompactSession(state));
  }, [labId, state]);

  function play() {
    const runs = state.phase === 'paused' && state.runs.length > 0
      ? state.runs
      : state.labId === 'cpu-scheduling'
        ? buildSimulationRuns({
            labId: state.labId,
            input: state.input,
            algorithms: state.selectedAlgorithms,
          })
        : buildSimulationRuns({
            labId: state.labId,
            input: state.input,
            algorithms: state.selectedAlgorithms,
          });
    if (runs.length === 0) return;
    const startedAt = state.startedAt ?? new Date().toISOString();
    dispatch({ type: 'start', runs, startedAt });
    void emitAlgorithmLabStartedOnce(startedEventGate.current, () => (
      trackAlgorithmLabStarted({
        eventId: createAlgorithmLabStartedEventId(labId, startedAt),
        targetType: 'algorithm_lab',
        targetId: labId,
        resourceType: 'interactive_lab',
        knowledgePointId: definition.knowledgePointCodes[0] ?? '',
        sourcePage: `/a3/labs/${labId}`,
        metadata: {
          labId,
          labVersion: definition.version,
          presetId: state.presetId,
          presetVersion: state.presetVersion,
          selectedAlgorithms: state.selectedAlgorithms,
        },
      })
    ));
  }

  function fullscreen() {
    void canvasRef.current?.requestFullscreen?.();
  }

  function resetWorkbench() {
    clearLabSession(labId);
    startedEventGate.current = createStartedEventGate();
    dispatch({ type: 'reset' });
  }

  function selectPreset(presetId: string) {
    if (presetId === 'custom') return;
    if (state.labId === 'cpu-scheduling') {
      const preset = getAlgorithmLabDefinition('cpu-scheduling')?.presets.find((item) => item.id === presetId);
      if (preset) dispatch({
        type: 'configure',
        labId: state.labId,
        input: structuredClone(preset.input),
        algorithms: state.selectedAlgorithms,
      });
      return;
    }
    const preset = getAlgorithmLabDefinition('page-replacement')?.presets.find((item) => item.id === presetId);
    if (preset) dispatch({
      type: 'configure',
      labId: state.labId,
      input: structuredClone(preset.input),
      algorithms: state.selectedAlgorithms,
    });
  }

  function toggleAlgorithm(algorithm: AlgorithmLabAlgorithm) {
    if (state.labId === 'cpu-scheduling') {
      if (!isCpuAlgorithm(algorithm)) return;
      const selected = state.selectedAlgorithms.includes(algorithm);
      if (selected && state.selectedAlgorithms.length === 1) return;
      dispatch({
        type: 'configure',
        labId: state.labId,
        input: state.input,
        algorithms: selected
          ? state.selectedAlgorithms.filter((item) => item !== algorithm)
          : [...state.selectedAlgorithms, algorithm],
      });
      return;
    }
    if (!isPageAlgorithm(algorithm)) return;
    const selected = state.selectedAlgorithms.includes(algorithm);
    if (selected && state.selectedAlgorithms.length === 1) return;
    dispatch({
      type: 'configure',
      labId: state.labId,
      input: state.input,
      algorithms: selected
        ? state.selectedAlgorithms.filter((item) => item !== algorithm)
        : [...state.selectedAlgorithms, algorithm],
    });
  }

  const inputPanel = (
    <AlgorithmLabInputPanel
      definition={definition}
      presetId={state.presetId}
      selectedAlgorithms={state.selectedAlgorithms}
      onSelectPreset={selectPreset}
      onToggleAlgorithm={toggleAlgorithm}
    />
  );
  const statusPanel = (
    <AlgorithmLabStatusPanel
      phase={state.phase}
      speed={state.speed}
      currentStepIndex={state.currentStepIndex}
      finalStepIndex={finalStepIndex}
      replayCount={state.replayCount}
      syncState={state.syncState}
      syncError={state.syncError}
      onSpeedChange={(speed) => dispatch({ type: 'set_speed', speed })}
    />
  );
  const controls = (
    <AlgorithmLabControls
      phase={state.phase}
      hasRuns={state.runs.length > 0}
      currentStepIndex={state.currentStepIndex}
      finalStepIndex={finalStepIndex}
      onPlay={play}
      onPause={() => dispatch({ type: 'pause' })}
      onRewind={() => dispatch({ type: 'rewind' })}
      onAdvance={() => dispatch({ type: 'advance' })}
      onReset={resetWorkbench}
      onFullscreen={fullscreen}
    />
  );
  const explanation = (
    <AlgorithmLabStepExplanation
      label={currentStep?.label ?? ''}
      explanation={currentStep?.explanation ?? ''}
      reviewed={state.reviewedStepIndexes.includes(state.currentStepIndex)}
      onReview={() => dispatch({ type: 'review_step', index: state.currentStepIndex })}
    />
  );

  return (
    <div className="mx-auto max-w-[1500px] pb-8" data-testid="a3-algorithm-lab-workbench">
      <header className="mb-5 flex flex-col gap-3 border-b border-[var(--a3-border)] pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/a3/labs" className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 hover:text-amber-600 dark:text-amber-300"><ArrowLeft className="size-3.5" />实验目录</Link>
          <h1 className="mt-2 text-2xl font-semibold text-[var(--a3-text)]">{definition.title}</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--a3-text-muted)]">{definition.description}</p>
        </div>
        <span className="text-xs text-[var(--a3-text-muted)]">版本 {definition.version}</span>
      </header>

      <AlgorithmLabLayout
        canvasRef={canvasRef}
        inputPanel={inputPanel}
        statusPanel={statusPanel}
        controls={controls}
        explanation={explanation}
        canvas={(
          <div className="flex min-h-[430px] flex-col items-center justify-center px-6 text-center">
            <FlaskConical className="size-10 text-amber-600" />
            <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">算法运行画布</h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-[var(--a3-text-muted)]">
              {state.runs.length > 0
                ? `已生成 ${state.runs.length} 组确定性运行结果，当前位于第 ${state.currentStepIndex + 1} 步。`
                : '选择输入和算法后点击播放。具体过程画布将在下一阶段接入。'}
            </p>
          </div>
        )}
      />
    </div>
  );
}

function configureState(state: AlgorithmLabState, action: ConfigureAction): AlgorithmLabState {
  if (state.labId === 'cpu-scheduling' && action.labId === 'cpu-scheduling') {
    const definition = getAlgorithmLabDefinition('cpu-scheduling')!;
    const preset = definition.presets.find(
      (candidate) => JSON.stringify(candidate.input) === JSON.stringify(action.input),
    );
    return configuredState(state, action.input, action.algorithms, preset?.id, preset?.version, definition.version);
  }
  if (state.labId === 'page-replacement' && action.labId === 'page-replacement') {
    const definition = getAlgorithmLabDefinition('page-replacement')!;
    const preset = definition.presets.find(
      (candidate) => JSON.stringify(candidate.input) === JSON.stringify(action.input),
    );
    return configuredState(state, action.input, action.algorithms, preset?.id, preset?.version, definition.version);
  }
  return state;
}

function configuredState<TLabId extends AlgorithmLabId>(
  state: AlgorithmLabStateFor<TLabId>,
  input: AlgorithmLabInputById[TLabId],
  algorithms: AlgorithmLabAlgorithmById[TLabId][],
  presetId: string | undefined,
  presetVersion: string | undefined,
  labVersion: string,
): AlgorithmLabStateFor<TLabId> {
  return {
    ...state,
    phase: 'configured',
    presetId: presetId ?? 'custom',
    presetVersion: presetVersion ?? labVersion,
    customInput: !presetId,
    input: structuredClone(input),
    selectedAlgorithms: [...algorithms],
    prediction: null,
    runs: [],
    currentStepIndex: 0,
    checkpointAnswers: {},
    reviewedStepIndexes: [],
    syncState: 'idle',
    syncError: '',
  };
}

function restoreState(state: AlgorithmLabState, action: RestoreAction): AlgorithmLabState {
  if (state.labId === 'cpu-scheduling' && action.labId === 'cpu-scheduling') {
    return restoredState(state, action.session, action.session ? buildRestoredCpuRuns(action.session) : []);
  }
  if (state.labId === 'page-replacement' && action.labId === 'page-replacement') {
    return restoredState(state, action.session, action.session ? buildRestoredPageRuns(action.session) : []);
  }
  return state;
}

function restoredState<TLabId extends AlgorithmLabId>(
  base: AlgorithmLabStateFor<TLabId>,
  session: AlgorithmLabSession<TLabId> | null,
  runs: SimulationRun<unknown, unknown>[],
): AlgorithmLabStateFor<TLabId> {
  if (!session) return { ...base, hydrated: true };
  return {
    ...base,
    hydrated: true,
    phase: session.phase === 'running' ? 'paused' : session.phase,
    presetId: session.presetId,
    presetVersion: session.presetVersion,
    customInput: session.presetId === 'custom',
    input: structuredClone(session.input),
    selectedAlgorithms: [...session.selectedAlgorithms],
    prediction: normalizePrediction(session.prediction),
    runs,
    currentStepIndex: clampStep(session.currentStepIndex, getFinalStepIndex(runs)),
    checkpointAnswers: normalizeCheckpointAnswers(session.checkpointAnswers),
    replayCount: session.replayCount,
    reviewedStepIndexes: [...session.reviewedStepIndexes],
    startedAt: session.startedAt,
  };
}

function buildRestoredCpuRuns(session: AlgorithmLabSession<'cpu-scheduling'>) {
  return shouldRestoreRuns(session.phase)
    ? buildSimulationRuns({ labId: session.labId, input: session.input, algorithms: session.selectedAlgorithms })
    : [];
}

function buildRestoredPageRuns(session: AlgorithmLabSession<'page-replacement'>) {
  return shouldRestoreRuns(session.phase)
    ? buildSimulationRuns({ labId: session.labId, input: session.input, algorithms: session.selectedAlgorithms })
    : [];
}

function shouldRestoreRuns(phase: AlgorithmLabSession['phase']) {
  return phase === 'running' || phase === 'paused' || phase === 'completed';
}

type CompactAlgorithmLabSession =
  | AlgorithmLabSession<'cpu-scheduling'>
  | AlgorithmLabSession<'page-replacement'>;

type CompactSessionCommon = Pick<
  AlgorithmLabSession<'cpu-scheduling'>,
  | 'schemaVersion'
  | 'phase'
  | 'presetId'
  | 'presetVersion'
  | 'prediction'
  | 'checkpointAnswers'
  | 'currentStepIndex'
  | 'replayCount'
  | 'reviewedStepIndexes'
  | 'startedAt'
>;

function toCompactSession(state: AlgorithmLabState): CompactAlgorithmLabSession {
  const phase = state.phase === 'submitted' ? 'completed' : state.phase;
  const common: CompactSessionCommon = {
    schemaVersion: ALGORITHM_LAB_SESSION_SCHEMA_VERSION,
    phase,
    presetId: state.presetId,
    presetVersion: state.presetVersion,
    prediction: state.prediction,
    checkpointAnswers: state.checkpointAnswers,
    currentStepIndex: state.currentStepIndex,
    replayCount: state.replayCount,
    reviewedStepIndexes: state.reviewedStepIndexes,
    startedAt: state.startedAt!,
  };
  if (state.labId === 'cpu-scheduling') {
    return {
      ...common,
      labId: state.labId,
      input: structuredClone(state.input),
      selectedAlgorithms: [...state.selectedAlgorithms],
    };
  }
  return {
    ...common,
    labId: state.labId,
    input: structuredClone(state.input),
    selectedAlgorithms: [...state.selectedAlgorithms],
  };
}

export type AlgorithmLabRunRequest = {
  [TLabId in AlgorithmLabId]: {
    labId: TLabId;
    input: AlgorithmLabInputById[TLabId];
    algorithms: AlgorithmLabAlgorithmById[TLabId][];
  }
}[AlgorithmLabId];

const cpuAlgorithmIds: ReadonlySet<AlgorithmLabAlgorithm> = new Set(['fcfs', 'sjf', 'priority', 'rr']);
const pageAlgorithmIds: ReadonlySet<AlgorithmLabAlgorithm> = new Set(['fifo', 'lru', 'opt']);

function isCpuAlgorithm(
  algorithm: AlgorithmLabAlgorithm,
): algorithm is AlgorithmLabAlgorithmById['cpu-scheduling'] {
  return cpuAlgorithmIds.has(algorithm);
}

function isPageAlgorithm(
  algorithm: AlgorithmLabAlgorithm,
): algorithm is AlgorithmLabAlgorithmById['page-replacement'] {
  return pageAlgorithmIds.has(algorithm);
}

export function buildSimulationRuns(
  request: AlgorithmLabRunRequest,
): SimulationRun<unknown, unknown>[] {
  if (request.labId === 'cpu-scheduling') {
    if (!request.algorithms.every(isCpuAlgorithm)) {
      throw new Error('算法与实验类型不匹配');
    }
    if (!validateCpuSchedulingInput(request.input).valid) throw new Error('输入与实验类型不匹配');
    return request.algorithms.map((algorithm) => simulateCpuScheduling(request.input, algorithm));
  }
  if (!request.algorithms.every(isPageAlgorithm)) {
    throw new Error('算法与实验类型不匹配');
  }
  if (!validatePageReplacementInput(request.input).valid) throw new Error('输入与实验类型不匹配');
  return request.algorithms.map((algorithm) => simulatePageReplacement(request.input, algorithm));
}

export interface StartedEventGate {
  status: 'idle' | 'in_flight' | 'sent';
}

interface StartedEventResult {
  success: boolean;
  status?: string | number;
}

export function createStartedEventGate(): StartedEventGate {
  return { status: 'idle' };
}

export async function emitAlgorithmLabStartedOnce(
  gate: StartedEventGate,
  send: () => Promise<StartedEventResult>,
): Promise<boolean> {
  if (gate.status !== 'idle') return false;
  gate.status = 'in_flight';
  try {
    const result = await send();
    const accepted = result.success || result.status === 'duplicate';
    gate.status = accepted ? 'sent' : 'idle';
    return accepted;
  } catch {
    gate.status = 'idle';
    return false;
  }
}

export function createAlgorithmLabStartedEventId(labId: AlgorithmLabId, startedAt: string): string {
  const timestamp = Date.parse(startedAt);
  const stableTime = Number.isFinite(timestamp) ? timestamp : 0;
  return `a3lab_started_${labId.replaceAll('-', '_')}_${stableTime}`;
}

function getFinalStepIndex(runs: SimulationRun<unknown, unknown>[]): number {
  return runs.length === 0 ? -1 : Math.max(...runs.map((run) => run.steps.length - 1));
}

function clampStep(index: number, finalStepIndex: number): number {
  return Math.max(0, Math.min(Math.max(0, finalStepIndex), index));
}

function uniqueIndexes(indexes: number[]): number[] {
  return [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))].slice(-50);
}

function normalizePrediction(value: Record<string, unknown> | null) {
  if (!value) return null;
  return {
    answer: typeof value.answer === 'string' ? value.answer : null,
    skipped: value.skipped === true,
  };
}

function normalizeCheckpointAnswers(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
