'use client';

import Link from 'next/link';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabId,
  AlgorithmLabInput,
  AlgorithmLabPhase,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';
import { getAlgorithmLabDefinition } from '@/lib/a3/algorithm-lab/registry';
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

export interface AlgorithmLabState {
  labId: AlgorithmLabId;
  phase: AlgorithmLabPhase;
  presetId: string;
  presetVersion: string;
  customInput: boolean;
  input: AlgorithmLabInput;
  selectedAlgorithms: AlgorithmLabAlgorithm[];
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

export type AlgorithmLabAction =
  | { type: 'configure'; input: AlgorithmLabInput; algorithms: AlgorithmLabAlgorithm[] }
  | { type: 'predict'; answer: string | null; skipped: boolean }
  | { type: 'start'; runs: SimulationRun<unknown, unknown>[] }
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

export function createAlgorithmLabState(labId: AlgorithmLabId): AlgorithmLabState {
  const definition = getAlgorithmLabDefinition(labId)!;
  const preset = definition.presets[0];
  return {
    labId,
    phase: 'idle',
    presetId: preset.id,
    presetVersion: preset.version,
    customInput: false,
    input: structuredClone(preset.input),
    selectedAlgorithms: [...definition.algorithms],
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
    case 'configure': {
      const preset = findMatchingPreset(state.labId, action.input);
      return {
        ...state,
        phase: 'configured',
        presetId: preset?.id ?? 'custom',
        presetVersion: preset?.version ?? getAlgorithmLabDefinition(state.labId)!.version,
        customInput: !preset,
        input: structuredClone(action.input),
        selectedAlgorithms: [...action.algorithms],
        prediction: null,
        runs: [],
        currentStepIndex: 0,
        checkpointAnswers: {},
        reviewedStepIndexes: [],
        syncState: 'idle',
        syncError: '',
      };
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
        startedAt: state.startedAt ?? new Date().toISOString(),
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
      return createAlgorithmLabState(state.labId);
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
  return <KnownAlgorithmLabWorkbench labId={definition.id} />;
}

function KnownAlgorithmLabWorkbench({ labId }: { labId: AlgorithmLabId }) {
  const definition = getAlgorithmLabDefinition(labId)!;
  const [state, dispatch] = useReducer(algorithmLabReducer, labId, restoreAlgorithmLabState);
  const canvasRef = useRef<HTMLDivElement>(null);
  const startedEventSent = useRef(Boolean(state.startedAt));
  const finalStepIndex = useMemo(() => getFinalStepIndex(state.runs), [state.runs]);
  const currentStep = state.runs[0]?.steps[state.currentStepIndex];

  useEffect(() => {
    if (state.phase !== 'running') return;
    if (state.currentStepIndex >= finalStepIndex) {
      dispatch({ type: 'finish' });
      return;
    }
    const timer = window.setInterval(() => dispatch({ type: 'advance' }), Math.round(1000 / state.speed));
    return () => window.clearInterval(timer);
  }, [finalStepIndex, state.currentStepIndex, state.phase, state.speed]);

  useEffect(() => {
    if (state.phase === 'submitted' || state.syncState === 'submitted') {
      clearLabSession(labId);
      return;
    }
    if (!state.startedAt) return;
    saveLabSession(labId, toCompactSession(state));
  }, [labId, state]);

  useEffect(() => {
    if (!state.startedAt && state.phase === 'idle') startedEventSent.current = false;
  }, [state.phase, state.startedAt]);

  function play() {
    const runs = state.phase === 'paused' && state.runs.length > 0
      ? state.runs
      : buildSimulationRuns(labId, state.input, state.selectedAlgorithms);
    if (runs.length === 0) return;
    dispatch({ type: 'start', runs });
    if (!startedEventSent.current) {
      startedEventSent.current = true;
      void trackAlgorithmLabStarted({
        targetType: 'algorithm_lab',
        targetId: labId,
        resourceType: 'interactive_algorithm_lab',
        knowledgePointId: definition.knowledgePointCodes[0] ?? '',
        sourcePage: `/a3/labs/${labId}`,
        metadata: {
          labId,
          labVersion: definition.version,
          presetId: state.presetId,
          presetVersion: state.presetVersion,
          selectedAlgorithms: state.selectedAlgorithms,
        },
      });
    }
  }

  function fullscreen() {
    void canvasRef.current?.requestFullscreen?.();
  }

  const inputPanel = (
    <AlgorithmLabInputPanel
      definition={definition}
      presetId={state.presetId}
      input={state.input}
      selectedAlgorithms={state.selectedAlgorithms}
      onConfigure={(input, algorithms) => dispatch({ type: 'configure', input, algorithms })}
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
      onReset={() => dispatch({ type: 'reset' })}
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

function restoreAlgorithmLabState(labId: AlgorithmLabId): AlgorithmLabState {
  const base = createAlgorithmLabState(labId);
  const session = loadLabSession(labId);
  if (!session) return base;
  const runs = session.phase === 'running' || session.phase === 'paused' || session.phase === 'completed'
    ? buildSimulationRuns(labId, session.input, session.selectedAlgorithms)
    : [];
  return {
    ...base,
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

function toCompactSession(state: AlgorithmLabState): AlgorithmLabSession {
  return {
    schemaVersion: ALGORITHM_LAB_SESSION_SCHEMA_VERSION,
    labId: state.labId,
    phase: state.phase === 'submitted' ? 'completed' : state.phase,
    presetId: state.presetId,
    presetVersion: state.presetVersion,
    selectedAlgorithms: state.selectedAlgorithms as never,
    input: state.input as never,
    prediction: state.prediction,
    checkpointAnswers: state.checkpointAnswers,
    currentStepIndex: state.currentStepIndex,
    replayCount: state.replayCount,
    reviewedStepIndexes: state.reviewedStepIndexes,
    startedAt: state.startedAt!,
  };
}

function buildSimulationRuns(
  labId: AlgorithmLabId,
  input: AlgorithmLabInput,
  algorithms: AlgorithmLabAlgorithm[],
): SimulationRun<unknown, unknown>[] {
  if (labId === 'cpu-scheduling' && 'processes' in input) {
    return algorithms.map((algorithm) => simulateCpuScheduling(input, algorithm as 'fcfs' | 'sjf' | 'priority' | 'rr'));
  }
  if (labId === 'page-replacement' && 'referenceString' in input) {
    return algorithms.map((algorithm) => simulatePageReplacement(input, algorithm as 'fifo' | 'lru' | 'opt'));
  }
  return [];
}

function findMatchingPreset(labId: AlgorithmLabId, input: AlgorithmLabInput) {
  return getAlgorithmLabDefinition(labId)!.presets.find(
    (preset) => JSON.stringify(preset.input) === JSON.stringify(input),
  );
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
