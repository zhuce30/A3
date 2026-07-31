'use client';

import Link from 'next/link';
import { ArrowLeft, FlaskConical, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import {
  buildAlgorithmLabCompletionRequest,
  canSubmitAlgorithmLabCompletion,
  clearAlgorithmLabCompletionEventId,
  getOrCreateAlgorithmLabCompletionEventId,
  synchronizeAlgorithmLabCompletion,
  type AlgorithmLabCompletionResult,
} from '@/lib/a3/algorithm-lab/client';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabAlgorithmById,
  AlgorithmLabId,
  AlgorithmLabInputById,
  AlgorithmLabPhase,
  CpuSchedulingInput,
  PageReplacementInput,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';
import {
  simulateCpuScheduling,
  type CpuSchedulingMetrics,
  type CpuSchedulingState,
} from '@/lib/a3/algorithm-lab/cpu-scheduling';
import {
  CpuSimulationCancelledError,
  CpuSimulationWorkerRunner,
} from '@/lib/a3/algorithm-lab/cpu-simulation-worker-client';
import {
  simulatePageReplacement,
  type PageReplacementMetrics,
  type PageReplacementState,
} from '@/lib/a3/algorithm-lab/page-replacement';
import { getAlgorithmLabDefinition } from '@/lib/a3/algorithm-lab/registry';
import { validateCpuSchedulingInput, validatePageReplacementInput } from '@/lib/a3/algorithm-lab/validators';
import {
  ALGORITHM_LAB_SESSION_SCHEMA_VERSION,
  clearLabSession,
  loadLabSession,
  saveLabSession,
  type AlgorithmLabSession,
} from '@/lib/a3/algorithm-lab/session';
import { trackAlgorithmLabCheckpoint, trackAlgorithmLabStarted } from '@/lib/a3/learning-event-client';
import { AlgorithmLabCheckpoint } from './algorithm-lab-checkpoint';
import { AlgorithmLabControls } from './algorithm-lab-controls';
import { AlgorithmLabInputPanel } from './algorithm-lab-input-panel';
import { AlgorithmLabLayout } from './algorithm-lab-layout';
import { AlgorithmLabStatusPanel } from './algorithm-lab-status-panel';
import { AlgorithmLabStepExplanation } from './algorithm-lab-step-explanation';
import {
  buildCpuCheckpoints,
  buildCpuGlobalTimeAxis,
  CpuSchedulingVisualizer,
  deriveCpuGlobalCurrentTime,
  deriveCpuPredictionResult,
  getAvailableCpuCheckpoints,
  isCpuCheckpointRevealed,
  selectCpuStepAtTime,
  type CpuCheckpointDefinition,
} from './cpu-scheduling-visualizer';
import {
  buildPageCheckpoints,
  buildPageGlobalIndexAxis,
  derivePageGlobalCurrentIndex,
  derivePagePredictionResult,
  getPageStepExplanation,
  getAvailablePageCheckpoints,
  isPageCheckpointRevealed,
  PageReplacementVisualizer,
  selectPageStepAtIndex,
  type PageCheckpointDefinition,
} from './page-replacement-visualizer';

type SyncState = 'idle' | 'pending' | 'event_sync_failed' | 'submitted';
type CheckpointSyncState = 'pending' | 'event_sync_failed' | 'submitted';

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
  checkpointSyncStates: Record<string, CheckpointSyncState>;
  replayCount: number;
  reviewedStepIndexes: number[];
  syncState: SyncState;
  syncError: string;
  completionEventId: string | null;
  completionResult: AlgorithmLabCompletionResult | null;
  startedAt: string | null;
  attemptNumber: number;
  simulationStatus: 'idle' | 'loading' | 'error';
  simulationError: string;
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
    runs?: SimulationRun<unknown, unknown>[];
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
  | { type: 'checkpoint_sync_pending'; checkpointId: string }
  | { type: 'checkpoint_sync_failed'; checkpointId: string }
  | { type: 'checkpoint_synced'; checkpointId: string }
  | { type: 'completion_ready'; eventId: string }
  | { type: 'sync_pending' }
  | { type: 'sync_failed'; message: string }
  | { type: 'submitted'; completion: AlgorithmLabCompletionResult }
  | { type: 'reset' }
  | { type: 'set_speed'; speed: number }
  | { type: 'review_step'; index: number }
  | { type: 'simulation_pending' }
  | { type: 'simulation_failed'; message: string };

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
    checkpointSyncStates: {},
    replayCount: 0,
    reviewedStepIndexes: [],
    syncState: 'idle',
    syncError: '',
    completionEventId: null,
    completionResult: null,
    startedAt: null,
    attemptNumber: 0,
    simulationStatus: 'idle',
    simulationError: '',
  };
}

export function algorithmLabReducer(
  state: AlgorithmLabState,
  action: AlgorithmLabAction,
): AlgorithmLabState {
  const finalStepIndex = getAlgorithmLabFinalStepIndex(state.labId, state.runs);
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
        simulationStatus: 'idle',
        simulationError: '',
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
    case 'checkpoint_sync_pending':
      return {
        ...state,
        checkpointSyncStates: { ...state.checkpointSyncStates, [action.checkpointId]: 'pending' },
      };
    case 'checkpoint_sync_failed':
      return {
        ...state,
        checkpointSyncStates: { ...state.checkpointSyncStates, [action.checkpointId]: 'event_sync_failed' },
      };
    case 'checkpoint_synced':
      return {
        ...state,
        checkpointSyncStates: { ...state.checkpointSyncStates, [action.checkpointId]: 'submitted' },
      };
    case 'completion_ready':
      return state.completionEventId ? state : { ...state, completionEventId: action.eventId };
    case 'sync_pending':
      return { ...state, syncState: 'pending', syncError: '' };
    case 'sync_failed':
      return { ...state, syncState: 'event_sync_failed', syncError: action.message };
    case 'submitted':
      return {
        ...state,
        phase: 'submitted',
        syncState: 'submitted',
        syncError: '',
        completionResult: action.completion,
      };
    case 'set_speed':
      return { ...state, speed: [0.5, 1, 1.5, 2].includes(action.speed) ? action.speed : 1 };
    case 'review_step':
      return { ...state, reviewedStepIndexes: uniqueIndexes([...state.reviewedStepIndexes, action.index]) };
    case 'simulation_pending':
      return { ...state, simulationStatus: 'loading', simulationError: '' };
    case 'simulation_failed':
      return { ...state, simulationStatus: 'error', simulationError: action.message };
    case 'reset':
      return {
        ...createAlgorithmLabState(state.labId),
        hydrated: true,
        attemptNumber: state.attemptNumber + 1,
      };
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
  const attemptEventStateRef = useRef(createAttemptEventState(0));
  const cpuSimulationRunnerRef = useRef<CpuSimulationWorkerRunner | null>(null);
  const lastStartedAtRef = useRef<string | null>(null);
  attemptEventStateRef.current = renewAttemptEventState(
    attemptEventStateRef.current,
    state.attemptNumber,
  );
  const finalStepIndex = useMemo(
    () => getAlgorithmLabFinalStepIndex(state.labId, state.runs),
    [state.labId, state.runs],
  );
  const inputValidation = state.labId === 'cpu-scheduling'
    ? validateCpuSchedulingInput(state.input)
    : validatePageReplacementInput(state.input);
  const predictionReady = state.prediction !== null || state.runs.length > 0;
  const canStartRun = canStartAlgorithmLabRun(state.labId, inputValidation.valid, predictionReady);
  const cpuRuns = useMemo(
    () => state.labId === 'cpu-scheduling' ? state.runs.filter(isCpuSchedulingRun) : [],
    [state.labId, state.runs],
  );
  const cpuTimeAxis = useMemo(() => buildCpuGlobalTimeAxis(cpuRuns), [cpuRuns]);
  const pageRuns = useMemo(
    () => state.labId === 'page-replacement' ? state.runs.filter(isPageReplacementRun) : [],
    [state.labId, state.runs],
  );
  const pageIndexAxis = useMemo(() => buildPageGlobalIndexAxis(pageRuns), [pageRuns]);
  const currentCpuStep = selectCpuStepAtTime(
    cpuRuns[0],
    deriveCpuGlobalCurrentTime(cpuRuns, state.currentStepIndex),
  );
  const currentPageStep = selectPageStepAtIndex(
    pageRuns[0],
    derivePageGlobalCurrentIndex(pageRuns, state.currentStepIndex),
  );
  const currentStep = state.labId === 'cpu-scheduling' ? currentCpuStep : currentPageStep;
  const completed = state.phase === 'completed' || state.phase === 'submitted';
  const predictionResult = state.labId === 'cpu-scheduling'
    ? deriveCpuPredictionResult(state.prediction, cpuRuns, completed)
    : null;
  const pagePredictionResult = state.labId === 'page-replacement'
    ? derivePagePredictionResult(state.prediction, pageRuns, completed)
    : null;
  const cpuCheckpoints = useMemo(
    () => cpuRuns[0] ? buildCpuCheckpoints(cpuRuns[0], cpuTimeAxis) : [],
    [cpuRuns, cpuTimeAxis],
  );
  const availableCpuCheckpoints = getAvailableCpuCheckpoints(
    cpuCheckpoints,
    state.currentStepIndex,
    state.checkpointAnswers,
  );
  const revealReadyQueue = isCpuCheckpointRevealed('cpu-ready-queue', state.checkpointAnswers);
  const revealCompletionOrder = isCpuCheckpointRevealed('cpu-completion-order', state.checkpointAnswers);
  const pageCheckpoints = useMemo(
    () => pageRuns[0] ? buildPageCheckpoints(pageRuns[0], pageIndexAxis) : [],
    [pageIndexAxis, pageRuns],
  );
  const availablePageCheckpoints = getAvailablePageCheckpoints(
    pageCheckpoints,
    state.currentStepIndex,
    state.checkpointAnswers,
  );
  const revealPageVictim = isPageCheckpointRevealed('page-victim', state.checkpointAnswers);
  const revealPagePolicyReason = isPageCheckpointRevealed('page-policy-reason', state.checkpointAnswers);
  const requiredCheckpoints = state.labId === 'cpu-scheduling' ? cpuCheckpoints : pageCheckpoints;
  const completionReady = canSubmitAlgorithmLabCompletion({
    phase: state.phase,
    currentStepIndex: state.currentStepIndex,
    finalStepIndex,
    requiredCheckpointIds: requiredCheckpoints.map(({ id }) => id),
    checkpointAnswers: state.checkpointAnswers,
    syncState: state.syncState,
  });

  useEffect(() => {
    if (labId === 'cpu-scheduling') {
      const session = loadLabSession(labId);
      if (!session || !shouldRestoreRuns(session.phase)) {
        dispatch({ type: 'restore', labId, session });
        return;
      }
      dispatch({ type: 'simulation_pending' });
      cpuSimulationRunnerRef.current ??= new CpuSimulationWorkerRunner();
      const runner = cpuSimulationRunnerRef.current;
      void runner.run(session.input, session.selectedAlgorithms)
        .then((runs) => {
          if (runs.length === 0) throw new Error('未生成可恢复的调度结果');
          dispatch({ type: 'restore', labId, session, runs });
        })
        .catch((error) => {
          if (error instanceof CpuSimulationCancelledError) return;
          clearLabSession(labId);
          dispatch({ type: 'restore', labId, session: null });
          dispatch({
            type: 'simulation_failed',
            message: error instanceof Error ? error.message : 'CPU 调度恢复失败，请重新运行',
          });
        });
      return;
    }
    dispatch({ type: 'restore', labId, session: loadLabSession(labId) });
  }, [labId]);

  useEffect(() => () => {
    cpuSimulationRunnerRef.current?.dispose();
    cpuSimulationRunnerRef.current = null;
  }, []);

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
      clearAlgorithmLabCompletionEventId(labId);
      return;
    }
    if (!state.startedAt) return;
    saveLabSession(labId, toCompactSession(state));
  }, [labId, state]);

  useEffect(() => {
    if (!state.hydrated || state.phase !== 'completed' || !state.startedAt || state.completionEventId) return;
    dispatch({
      type: 'completion_ready',
      eventId: getOrCreateAlgorithmLabCompletionEventId(labId, state.startedAt),
    });
  }, [labId, state.completionEventId, state.hydrated, state.phase, state.startedAt]);

  useEffect(() => {
    for (const checkpointId of Object.keys(state.checkpointAnswers)) {
      attemptEventStateRef.current.checkpointEventGate.add(checkpointId);
    }
  }, [state.checkpointAnswers]);

  async function play() {
    if (!canStartRun) return;
    const attemptEvents = attemptEventStateRef.current;
    let runs: SimulationRun<unknown, unknown>[];
    if (state.phase === 'paused' && state.runs.length > 0) {
      runs = state.runs;
    } else if (state.labId === 'cpu-scheduling') {
      dispatch({ type: 'simulation_pending' });
      cpuSimulationRunnerRef.current ??= new CpuSimulationWorkerRunner();
      try {
        runs = await cpuSimulationRunnerRef.current.run(state.input, state.selectedAlgorithms);
      } catch (error) {
        if (error instanceof CpuSimulationCancelledError) return;
        dispatch({
          type: 'simulation_failed',
          message: error instanceof Error ? error.message : 'CPU 调度计算失败，请重试',
        });
        return;
      }
    } else {
      runs = buildSimulationRuns({
        labId: state.labId,
        input: state.input,
        algorithms: state.selectedAlgorithms,
      });
    }
    if (runs.length === 0) {
      dispatch({ type: 'simulation_failed', message: '未生成可播放的调度结果，请重试' });
      return;
    }
    const startedAt = state.startedAt ?? createNextAttemptStartedAt(lastStartedAtRef.current);
    lastStartedAtRef.current = startedAt;
    dispatch({ type: 'start', runs, startedAt });
    void emitAlgorithmLabStartedOnce(attemptEvents.startedEventGate, () => (
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
    clearAlgorithmLabCompletionEventId(labId);
    lastStartedAtRef.current = state.startedAt ?? lastStartedAtRef.current;
    cpuSimulationRunnerRef.current?.cancel();
    dispatch({ type: 'reset' });
  }

  function configureAttempt(action: ConfigureAction) {
    clearLabSession(labId);
    clearAlgorithmLabCompletionEventId(labId);
    lastStartedAtRef.current = state.startedAt ?? lastStartedAtRef.current;
    cpuSimulationRunnerRef.current?.cancel();
    dispatch(action);
  }

  function updateCpuInput(input: CpuSchedulingInput) {
    if (state.labId !== 'cpu-scheduling') return;
    configureAttempt({
      type: 'configure',
      labId: state.labId,
      input,
      algorithms: state.selectedAlgorithms,
    });
  }

  function updatePageInput(input: PageReplacementInput) {
    if (state.labId !== 'page-replacement') return;
    configureAttempt({
      type: 'configure',
      labId: state.labId,
      input,
      algorithms: state.selectedAlgorithms,
    });
  }

  function submitCpuCheckpoint(checkpoint: CpuCheckpointDefinition, answer: string) {
    if (state.labId !== 'cpu-scheduling' || !claimCheckpointSubmission(attemptEventStateRef.current.checkpointEventGate, checkpoint.id)) return;
    dispatch({ type: 'answer_checkpoint', checkpointId: checkpoint.id, answer });
    void syncCheckpointEvent(checkpoint, answer, cpuRuns[0]?.algorithm ?? '');
  }

  function submitPageCheckpoint(checkpoint: PageCheckpointDefinition, answer: string) {
    if (state.labId !== 'page-replacement' || !claimCheckpointSubmission(attemptEventStateRef.current.checkpointEventGate, checkpoint.id)) return;
    dispatch({ type: 'answer_checkpoint', checkpointId: checkpoint.id, answer });
    void syncCheckpointEvent(checkpoint, answer, pageRuns[0]?.algorithm ?? '');
  }

  async function syncCheckpointEvent(
    checkpoint: CpuCheckpointDefinition | PageCheckpointDefinition,
    answer: string,
    algorithm: string,
  ) {
    const correct = answer === checkpoint.correctAnswer;
    const eventId = createAlgorithmLabCheckpointEventId(state.labId, checkpoint.id, state.startedAt);
    const gate = getOrCreateCheckpointEventGate(
      attemptEventStateRef.current.checkpointSyncGates,
      checkpoint.id,
      eventId,
    );
    dispatch({ type: 'checkpoint_sync_pending', checkpointId: checkpoint.id });
    const synced = await synchronizeAlgorithmLabCheckpointEvent(gate, (stableEventId) => (
      trackAlgorithmLabCheckpoint({
        eventId: stableEventId,
        targetType: 'algorithm_lab_checkpoint',
        targetId: `${state.labId}:${checkpoint.id}`,
        resourceType: 'interactive_lab',
        knowledgePointId: definition.knowledgePointCodes[0] ?? '',
        sourcePage: `/a3/labs/${state.labId}`,
        score: correct ? 100 : 0,
        quality: { correct },
        metadata: {
          labId: state.labId,
          labVersion: definition.version,
          presetId: state.presetId,
          checkpointId: checkpoint.id,
          answer,
          correct,
          stepIndex: checkpoint.stepIndex,
          algorithm,
        },
      })
    ));
    dispatch({
      type: synced ? 'checkpoint_synced' : 'checkpoint_sync_failed',
      checkpointId: checkpoint.id,
    });
  }

  async function submitCompletion() {
    if (!completionReady || !state.completionEventId || !state.prediction || !state.startedAt) return;
    const checkpointItems = requiredCheckpoints.map((checkpoint) => ({
      id: checkpoint.id,
      correct: state.checkpointAnswers[checkpoint.id] === checkpoint.correctAnswer,
    }));
    const durationSec = Math.max(0, Math.floor((Date.now() - Date.parse(state.startedAt)) / 1000));
    dispatch({ type: 'sync_pending' });

    const common = {
      eventId: state.completionEventId,
      labVersion: definition.version,
      presetId: state.presetId,
      presetVersion: state.presetVersion,
      customInput: state.customInput,
      prediction: {
        answer: state.prediction.answer,
        skipped: state.prediction.skipped,
        correct: state.labId === 'cpu-scheduling'
          ? predictionResult?.correct ?? null
          : pagePredictionResult?.correct ?? null,
      },
      checkpointItems,
      durationSec,
      replayCount: state.replayCount,
      reviewedStepIndexes: state.reviewedStepIndexes,
    };
    const request = state.labId === 'cpu-scheduling'
      ? buildAlgorithmLabCompletionRequest({
          ...common,
          labId: state.labId,
          selectedAlgorithms: state.selectedAlgorithms,
          resultFingerprints: cpuRuns.map((run) => ({
            algorithm: run.algorithm as AlgorithmLabAlgorithmById['cpu-scheduling'],
            fingerprint: run.resultFingerprint,
          })),
        })
      : buildAlgorithmLabCompletionRequest({
          ...common,
          labId: state.labId,
          selectedAlgorithms: state.selectedAlgorithms,
          resultFingerprints: pageRuns.map((run) => ({
            algorithm: run.algorithm as AlgorithmLabAlgorithmById['page-replacement'],
            fingerprint: run.resultFingerprint,
          })),
        });
    const outcome = await synchronizeAlgorithmLabCompletion(request, {
      onSubmitted: () => {
        clearLabSession(labId);
        clearAlgorithmLabCompletionEventId(labId);
      },
    });
    if (outcome.syncState === 'submitted') {
      dispatch({ type: 'submitted', completion: outcome.completion });
      return;
    }
    dispatch({ type: 'sync_failed', message: outcome.error });
  }

  function selectPreset(presetId: string) {
    if (presetId === 'custom') return;
    if (state.labId === 'cpu-scheduling') {
      const preset = getAlgorithmLabDefinition('cpu-scheduling')?.presets.find((item) => item.id === presetId);
      if (preset) configureAttempt({
        type: 'configure',
        labId: state.labId,
        input: structuredClone(preset.input),
        algorithms: state.selectedAlgorithms,
      });
      return;
    }
    const preset = getAlgorithmLabDefinition('page-replacement')?.presets.find((item) => item.id === presetId);
    if (preset) configureAttempt({
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
      configureAttempt({
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
    configureAttempt({
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
      cpuInput={state.labId === 'cpu-scheduling' ? state.input : undefined}
      pageInput={state.labId === 'page-replacement' ? state.input : undefined}
      prediction={state.prediction}
      predictionResult={predictionResult}
      pagePredictionResult={pagePredictionResult}
      predictionLocked={state.runs.length > 0}
      onSelectPreset={selectPreset}
      onToggleAlgorithm={toggleAlgorithm}
      onCpuInputChange={updateCpuInput}
      onPageInputChange={updatePageInput}
      onPredict={(answer) => dispatch({ type: 'predict', answer, skipped: false })}
      onSkipPrediction={() => dispatch({ type: 'predict', answer: null, skipped: true })}
    />
  );
  const statusPanel = (
    <div className="space-y-5">
      <AlgorithmLabStatusPanel
        phase={state.phase}
        speed={state.speed}
        currentStepIndex={state.currentStepIndex}
        finalStepIndex={finalStepIndex}
        replayCount={state.replayCount}
        syncState={state.syncState === 'event_sync_failed' ? 'failed' : state.syncState}
        syncError={state.syncError}
        cpuRuns={cpuRuns}
        pageRuns={pageRuns}
        revealCompletionOrder={revealCompletionOrder}
        onSpeedChange={(speed) => dispatch({ type: 'set_speed', speed })}
      />
      {availableCpuCheckpoints.map((checkpoint) => (
        <div key={checkpoint.id} className="space-y-2">
          <AlgorithmLabCheckpoint
            checkpoint={checkpoint}
            submittedAnswer={state.checkpointAnswers[checkpoint.id]}
            onSubmit={(answer) => submitCpuCheckpoint(checkpoint, answer)}
          />
          {state.checkpointSyncStates[checkpoint.id] === 'pending' ? (
            <p className="text-xs text-[var(--a3-text-muted)]" role="status">正在同步检查点记录…</p>
          ) : null}
          {state.checkpointSyncStates[checkpoint.id] === 'event_sync_failed' ? (
            <button
              type="button"
              onClick={() => void syncCheckpointEvent(
                checkpoint,
                state.checkpointAnswers[checkpoint.id],
                cpuRuns[0]?.algorithm ?? '',
              )}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-500 px-3 text-xs font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30"
            >
              <RefreshCw className="size-3.5" />重新同步检查点记录
            </button>
          ) : null}
        </div>
      ))}
      {availablePageCheckpoints.map((checkpoint) => (
        <div key={checkpoint.id} className="space-y-2">
          <AlgorithmLabCheckpoint
            checkpoint={checkpoint as unknown as CpuCheckpointDefinition}
            submittedAnswer={state.checkpointAnswers[checkpoint.id]}
            onSubmit={(answer) => submitPageCheckpoint(checkpoint, answer)}
          />
          {state.checkpointSyncStates[checkpoint.id] === 'pending' ? (
            <p className="text-xs text-[var(--a3-text-muted)]" role="status">正在同步检查点记录…</p>
          ) : null}
          {state.checkpointSyncStates[checkpoint.id] === 'event_sync_failed' ? (
            <button
              type="button"
              onClick={() => void syncCheckpointEvent(
                checkpoint,
                state.checkpointAnswers[checkpoint.id],
                pageRuns[0]?.algorithm ?? '',
              )}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-500 px-3 text-xs font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30"
            >
              <RefreshCw className="size-3.5" />重新同步检查点记录
            </button>
          ) : null}
        </div>
      ))}
      {state.completionResult ? (
        <section className="border-t border-[var(--a3-border)] pt-4" aria-label="学习证据写回结果">
          <div className="flex items-start gap-2">
            {state.completionResult.verified ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            )}
            <div>
              <p className="text-sm font-semibold text-[var(--a3-text)]">
                {state.completionResult.verified ? '已验证学习证据' : '未验证探索记录'}
              </p>
              <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
                检查点得分 {state.completionResult.score} 分
                {state.completionResult.masteryEvidenceAccepted ? '，已计入掌握证据。' : '，未计入掌握证据。'}
              </p>
            </div>
          </div>
          <Link
            href={state.completionResult.nextAction.href}
            className="mt-3 inline-flex min-h-10 w-full items-center justify-center rounded-md bg-emerald-700 px-3 text-center text-sm font-semibold text-white hover:bg-emerald-600"
          >
            {state.completionResult.nextAction.label}
          </Link>
        </section>
      ) : completed ? (
        <section className="border-t border-[var(--a3-border)] pt-4" aria-label="提交学习记录">
          <button
            type="button"
            onClick={() => void submitCompletion()}
            disabled={state.syncState === 'pending' || !completionReady || !state.completionEventId}
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.syncState === 'pending' ? (
              <><RefreshCw className="size-4 animate-spin" />正在同步学习记录</>
            ) : state.syncState === 'event_sync_failed' ? (
              <><RefreshCw className="size-4" />重新同步学习记录</>
            ) : (
              <><ShieldCheck className="size-4" />提交学习记录</>
            )}
          </button>
          {!completionReady && state.syncState !== 'pending' ? (
            <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">到达最终步骤并完成两个检查点后可提交。</p>
          ) : null}
          {state.syncState === 'event_sync_failed' ? (
            <p className="mt-2 text-xs leading-5 text-red-700 dark:text-red-300" role="alert">{state.syncError}</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
  const controls = (
    <fieldset className="min-w-0 border-0 p-0" disabled={state.simulationStatus === 'loading' || (state.runs.length === 0 && !canStartRun)}>
      <legend className="sr-only">实验播放控制</legend>
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
    </fieldset>
  );
  const explanation = (
    <AlgorithmLabStepExplanation
      label={currentStep?.label ?? ''}
      explanation={state.labId === 'page-replacement'
        ? getPageStepExplanation(
            pageRuns[0],
            currentPageStep,
            revealPageVictim,
            revealPagePolicyReason,
          )
        : currentStep?.explanation ?? ''}
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
        canvas={state.labId === 'cpu-scheduling' ? (
          <div className="relative min-h-[430px]">
            <CpuSchedulingVisualizer
              runs={cpuRuns}
              currentStepIndex={state.currentStepIndex}
              revealReadyQueue={revealReadyQueue}
              onSeek={(index) => dispatch({ type: 'seek', index })}
            />
            {state.simulationStatus === 'loading' ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[var(--a3-surface-solid)]/90 px-6" role="status" aria-live="polite">
                <p className="text-sm font-medium text-[var(--a3-text)]">正在后台计算调度结果…</p>
              </div>
            ) : null}
            {state.simulationStatus === 'error' ? (
              <div className="absolute inset-x-4 top-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200" role="alert">
                {state.simulationError}
              </div>
            ) : null}
          </div>
        ) : (
          <PageReplacementVisualizer
            runs={pageRuns}
            referenceString={state.input.referenceString}
            frameCount={state.input.frameCount}
            currentStepIndex={state.currentStepIndex}
            completed={completed}
            revealVictim={revealPageVictim}
            revealPolicyReason={revealPagePolicyReason}
            onSeek={(index) => dispatch({ type: 'seek', index })}
          />
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
    checkpointSyncStates: {},
    reviewedStepIndexes: [],
    syncState: 'idle',
    syncError: '',
    completionEventId: null,
    completionResult: null,
    startedAt: null,
    attemptNumber: state.attemptNumber + 1,
    simulationStatus: 'idle',
    simulationError: '',
  };
}

function restoreState(state: AlgorithmLabState, action: RestoreAction): AlgorithmLabState {
  if (state.labId === 'cpu-scheduling' && action.labId === 'cpu-scheduling') {
    return restoredState(state, action.session, action.runs ?? []);
  }
  if (state.labId === 'page-replacement' && action.labId === 'page-replacement') {
    return restoredState(
      state,
      action.session,
      action.runs ?? (action.session ? buildRestoredPageRuns(action.session) : []),
    );
  }
  return state;
}

function restoredState<TLabId extends AlgorithmLabId>(
  base: AlgorithmLabStateFor<TLabId>,
  session: AlgorithmLabSession<TLabId> | null,
  runs: SimulationRun<unknown, unknown>[],
): AlgorithmLabStateFor<TLabId> {
  if (!session) return {
    ...base,
    hydrated: true,
    simulationStatus: 'idle',
    simulationError: '',
  };
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
    currentStepIndex: clampStep(
      session.currentStepIndex,
      getAlgorithmLabFinalStepIndex(base.labId, runs),
    ),
    checkpointAnswers: normalizeCheckpointAnswers(session.checkpointAnswers),
    checkpointSyncStates: Object.fromEntries(
      Object.keys(session.checkpointAnswers).map((checkpointId) => [checkpointId, 'event_sync_failed']),
    ),
    replayCount: session.replayCount,
    reviewedStepIndexes: [...session.reviewedStepIndexes],
    startedAt: session.startedAt,
    completionEventId: null,
    completionResult: null,
    simulationStatus: 'idle',
    simulationError: '',
  };
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

export interface AttemptEventState {
  attemptNumber: number;
  startedEventGate: StartedEventGate;
  checkpointEventGate: Set<string>;
  checkpointSyncGates: Map<string, CheckpointEventGate>;
}

export function createAttemptEventState(attemptNumber: number): AttemptEventState {
  return {
    attemptNumber,
    startedEventGate: createStartedEventGate(),
    checkpointEventGate: new Set<string>(),
    checkpointSyncGates: new Map<string, CheckpointEventGate>(),
  };
}

export function renewAttemptEventState(
  current: AttemptEventState,
  attemptNumber: number,
): AttemptEventState {
  return current.attemptNumber === attemptNumber
    ? current
    : createAttemptEventState(attemptNumber);
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

export function createNextAttemptStartedAt(previousStartedAt: string | null, now = Date.now()): string {
  const previousTime = Date.parse(previousStartedAt ?? '');
  const nextTime = Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now;
  return new Date(nextTime).toISOString();
}

export function createAlgorithmLabCheckpointEventId(
  labId: AlgorithmLabId,
  checkpointId: string,
  startedAt: string | null,
): string {
  const timestamp = Date.parse(startedAt ?? '');
  const stableTime = Number.isFinite(timestamp) ? timestamp : 0;
  return `a3lab_checkpoint_${labId.replaceAll('-', '_')}_${checkpointId.replaceAll('-', '_')}_${stableTime}`;
}

export interface CheckpointEventGate {
  eventId: string;
  status: 'idle' | 'in_flight' | 'sent';
}

export function createCheckpointEventGate(eventId: string): CheckpointEventGate {
  return { eventId, status: 'idle' };
}

export function getOrCreateCheckpointEventGate(
  gates: Map<string, CheckpointEventGate>,
  checkpointId: string,
  eventId: string,
): CheckpointEventGate {
  const existing = gates.get(checkpointId);
  if (existing?.eventId === eventId) return existing;
  const gate = createCheckpointEventGate(eventId);
  gates.set(checkpointId, gate);
  return gate;
}

export async function synchronizeAlgorithmLabCheckpointEvent(
  gate: CheckpointEventGate,
  send: (eventId: string) => Promise<StartedEventResult>,
): Promise<boolean> {
  if (gate.status !== 'idle') return false;
  gate.status = 'in_flight';
  try {
    const result = await send(gate.eventId);
    const accepted = result.status === 'accepted' || result.status === 'duplicate';
    gate.status = accepted ? 'sent' : 'idle';
    return accepted;
  } catch {
    gate.status = 'idle';
    return false;
  }
}

export function canStartAlgorithmLabRun(
  _labId: AlgorithmLabId,
  inputValid: boolean,
  predictionReady: boolean,
): boolean {
  return inputValid && predictionReady;
}

export function claimCheckpointSubmission(gate: Set<string>, checkpointId: string): boolean {
  if (gate.has(checkpointId)) return false;
  gate.add(checkpointId);
  return true;
}

function isCpuSchedulingRun(
  run: SimulationRun<unknown, unknown>,
): run is SimulationRun<CpuSchedulingState, CpuSchedulingMetrics> {
  return isCpuAlgorithm(run.algorithm);
}

function isPageReplacementRun(
  run: SimulationRun<unknown, unknown>,
): run is SimulationRun<PageReplacementState, PageReplacementMetrics> {
  return isPageAlgorithm(run.algorithm);
}

export function getAlgorithmLabFinalStepIndex(
  labId: AlgorithmLabId,
  runs: SimulationRun<unknown, unknown>[],
): number {
  if (labId === 'cpu-scheduling') {
    return buildCpuGlobalTimeAxis(runs.filter(isCpuSchedulingRun)).length - 1;
  }
  return buildPageGlobalIndexAxis(runs.filter(isPageReplacementRun)).length - 1;
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
