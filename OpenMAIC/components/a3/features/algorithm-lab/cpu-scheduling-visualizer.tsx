import { Clock3, Cpu, Layers3 } from 'lucide-react';
import type { CpuSchedulingAlgorithm } from '@/lib/a3/algorithm-lab/contracts';
import type {
  CpuSchedulingMetrics,
  CpuSchedulingState,
} from '@/lib/a3/algorithm-lab/cpu-scheduling';
import type { SimulationRun } from '@/lib/a3/algorithm-lab/contracts';

type CpuRun = SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>;
type CpuSegment = CpuSchedulingState['timeline'][number];

const algorithmLabels: Record<CpuSchedulingAlgorithm, string> = {
  fcfs: 'FCFS',
  sjf: 'SJF',
  priority: '优先级',
  rr: 'RR',
};

const CPU_ALGORITHM_LABEL_WIDTH_PX = 78;
const CPU_TIMELINE_COLUMN_GAP_PX = 12;

const processVisuals = [
  { barClass: 'border-emerald-500/60 bg-emerald-100 text-emerald-950 dark:bg-emerald-900/55 dark:text-emerald-100', dotClass: 'bg-emerald-500' },
  { barClass: 'border-sky-500/60 bg-sky-100 text-sky-950 dark:bg-sky-900/55 dark:text-sky-100', dotClass: 'bg-sky-500' },
  { barClass: 'border-violet-500/60 bg-violet-100 text-violet-950 dark:bg-violet-900/55 dark:text-violet-100', dotClass: 'bg-violet-500' },
  { barClass: 'border-rose-500/60 bg-rose-100 text-rose-950 dark:bg-rose-900/55 dark:text-rose-100', dotClass: 'bg-rose-500' },
  { barClass: 'border-cyan-500/60 bg-cyan-100 text-cyan-950 dark:bg-cyan-900/55 dark:text-cyan-100', dotClass: 'bg-cyan-500' },
  { barClass: 'border-fuchsia-500/60 bg-fuchsia-100 text-fuchsia-950 dark:bg-fuchsia-900/55 dark:text-fuchsia-100', dotClass: 'bg-fuchsia-500' },
] as const;

export interface CpuProcessVisual {
  label: string;
  barClass: string;
  dotClass: string;
}

export interface CpuPredictionResult {
  correct: boolean | null;
  winners: CpuSchedulingAlgorithm[];
  lowestAverageWaitingTime: number;
}

export interface CpuCheckpointDefinition {
  id: 'cpu-ready-queue' | 'cpu-completion-order';
  question: string;
  options: string[];
  correctAnswer: string;
  stepIndex: number;
  context: string;
}

interface CpuSchedulingVisualizerProps {
  runs: CpuRun[];
  currentStepIndex: number;
  revealReadyQueue?: boolean;
  onSeek: (index: number) => void;
}

export function CpuSchedulingVisualizer({
  runs,
  currentStepIndex,
  revealReadyQueue = false,
  onSeek,
}: CpuSchedulingVisualizerProps) {
  if (runs.length === 0) {
    return (
      <div
        className="flex min-h-[430px] flex-col items-center justify-center px-6 text-center"
        data-testid="cpu-scheduling-canvas"
      >
        <Cpu className="size-10 text-amber-600" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">等待运行 CPU 调度</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--a3-text-muted)]">
          完成预测并点击播放后，这里会同步展示各算法的调度轨道、就绪队列和运行状态。
        </p>
      </div>
    );
  }

  const totalTime = getTotalElapsedTime(runs);
  const focusedRun = runs[0];
  const timeAxis = buildCpuGlobalTimeAxis(runs);
  const currentTime = deriveCpuGlobalCurrentTime(runs, currentStepIndex);
  const visibleSteps = new Map(runs.map((run) => [run, selectCpuStepAtTime(run, currentTime)]));
  const focusedStep = visibleSteps.get(focusedRun);
  const rulerTicks = buildTimeRuler(totalTime);
  const timelineTrackWidth = Math.max(680, totalTime * 38);
  const processIds = uniqueStrings(
    runs.flatMap((run) => run.steps.at(-1)?.state.processes.map((process) => process.processId) ?? []),
  );

  return (
    <section
      className="min-h-[430px] overflow-hidden bg-[var(--a3-surface-solid)]"
      data-testid="cpu-scheduling-canvas"
      aria-label="CPU 调度算法运行画布"
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--a3-border)] px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--a3-text)]">调度轨道对比</h2>
          <p className="mt-1 text-xs text-[var(--a3-text-muted)]">点击已执行时间片可定位到它首次出现的步骤。</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          <Clock3 className="size-3.5" />当前时间 {currentTime}
        </div>
      </div>

      <div className="overflow-x-auto px-4 pb-4 pt-3" tabIndex={0} role="region" aria-label="可横向滚动的甘特图">
        <div className="grid items-start" style={getCpuTimelineLayout(timelineTrackWidth)}>
          <div className="space-y-3 pt-9" aria-label="算法标签">
            {runs.map((run) => (
              <div key={run.algorithm} className="flex h-12 items-center text-xs font-semibold text-[var(--a3-text)]">
                {algorithmLabels[run.algorithm as CpuSchedulingAlgorithm]}
              </div>
            ))}
          </div>
          <div className="relative" data-testid="cpu-timeline-coordinate-space">
            <div
              className="relative mb-2 h-7 text-[10px] text-[var(--a3-text-muted)]"
              data-testid="cpu-time-ruler"
              aria-label="时间标尺"
            >
              {rulerTicks.map((tick) => (
                <span
                  key={tick}
                  className="absolute bottom-0 -translate-x-1/2 border-l border-[var(--a3-border)] pl-1"
                  style={{ left: `${timeToPercent(tick, totalTime)}%` }}
                >
                  {tick}
                </span>
              ))}
            </div>

            <div
              className="pointer-events-none absolute bottom-0 top-7 z-20 w-px bg-amber-600 transition-[left] duration-200 ease-out"
              data-testid="cpu-current-time-line"
              style={{ left: `${timeToPercent(currentTime, totalTime)}%` }}
              aria-hidden="true"
            />

            <div className="space-y-3">
              {runs.map((run) => {
                const visibleSegments = visibleSteps.get(run)?.state.timeline ?? [];
                return (
                  <div
                    key={run.algorithm}
                    className="relative h-12 overflow-hidden rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-muted)]"
                    data-testid="cpu-gantt-track"
                  >
                    {buildTimeCells(totalTime).map((time) => (
                      <span
                        key={time}
                        className="pointer-events-none absolute inset-y-0 border-l border-dashed border-[var(--a3-border)]/70"
                        style={{ left: `${timeToPercent(time, totalTime)}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    {visibleSegments.map((segment) => {
                      const visual = getCpuProcessVisual(segment.processId);
                      const eventTime = findCpuSegmentEventTime(run, segment);
                      const globalStepIndex = findCpuGlobalTimeIndex(timeAxis, eventTime);
                      return (
                        <button
                          key={`${run.algorithm}-${segment.processId}-${segment.start}-${segment.end}`}
                          type="button"
                          onClick={() => onSeek(findCpuGlobalTimeIndex(timeAxis, eventTime))}
                          className={`absolute inset-y-1 flex min-w-7 items-center justify-center overflow-hidden rounded border px-1 text-[11px] font-semibold transition-colors duration-200 focus-visible:z-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${visual.barClass}`}
                          style={{
                            left: `${timeToPercent(segment.start, totalTime)}%`,
                            width: `${timeToPercent(segment.end - segment.start, totalTime)}%`,
                          }}
                          aria-label={`${algorithmLabels[run.algorithm as CpuSchedulingAlgorithm]}：${visual.label}，${segment.start} 到 ${segment.end}，跳到全局步骤 ${globalStepIndex + 1}`}
                        >
                          {visual.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 border-t border-[var(--a3-border)] px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(230px,0.72fr)]">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--a3-text)]">
            <Layers3 className="size-3.5 text-amber-600" />
            就绪队列 · {algorithmLabels[focusedRun.algorithm as CpuSchedulingAlgorithm]}
          </div>
          <div className="mt-2 flex min-h-10 flex-wrap items-center gap-2" aria-label="就绪队列">
            {!revealReadyQueue ? (
              <span className="text-xs text-[var(--a3-text-muted)]">提交就绪队列检查点后显示</span>
            ) : focusedStep?.state.readyQueue.length ? focusedStep.state.readyQueue.map((processId, index) => {
              const visual = getCpuProcessVisual(processId);
              return (
                <span key={`${processId}-${index}`} className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-semibold ${visual.barClass}`}>
                  <span className={`size-2 rounded-full ${visual.dotClass}`} aria-hidden="true" />
                  {index + 1}. {processId}
                </span>
              );
            }) : (
              <span className="text-xs text-[var(--a3-text-muted)]">当前队列为空</span>
            )}
          </div>
        </div>

        <div className="rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 py-3">
          <div className="text-[11px] font-medium text-[var(--a3-text-muted)]">运行进程</div>
          {focusedStep?.state.currentProcessId ? (
            <ActiveProcessDetail state={focusedStep.state} processId={focusedStep.state.currentProcessId} />
          ) : (
            <div className="mt-2 text-sm font-semibold text-[var(--a3-text)]">CPU 空闲</div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-[var(--a3-border)] px-4 py-3" aria-label="进程颜色图例">
        {processIds.map((processId) => {
          const visual = getCpuProcessVisual(processId);
          return (
            <span key={processId} className="inline-flex items-center gap-1.5 text-xs text-[var(--a3-text-muted)]">
              <span className={`size-2.5 rounded-sm ${visual.dotClass}`} aria-hidden="true" />
              {processId}
            </span>
          );
        })}
        <span className="inline-flex items-center gap-1.5 text-xs text-[var(--a3-text-muted)]">
          <span className="size-2.5 rounded-sm bg-slate-400" aria-hidden="true" />空闲
        </span>
      </div>
    </section>
  );
}

function ActiveProcessDetail({ state, processId }: { state: CpuSchedulingState; processId: string }) {
  const process = state.processes.find((candidate) => candidate.processId === processId);
  const visual = getCpuProcessVisual(processId);
  if (!process) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-3 transition-colors duration-200">
      <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
        <span className={`size-2.5 rounded-full ${visual.dotClass}`} aria-hidden="true" />{processId}
      </span>
      <span className="text-xs tabular-nums text-[var(--a3-text-muted)]">剩余 {process.remainingTime} / {process.burstTime}</span>
    </div>
  );
}

export function getCpuProcessVisual(processId: string): CpuProcessVisual {
  if (processId === 'idle') {
    return {
      label: '空闲',
      barClass: 'border-slate-400/60 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
      dotClass: 'bg-slate-400',
    };
  }
  let hash = 0;
  for (let index = 0; index < processId.length; index += 1) {
    hash = (Math.imul(hash, 31) + processId.charCodeAt(index)) | 0;
  }
  const visual = processVisuals[Math.abs(hash) % processVisuals.length];
  return { label: processId, ...visual };
}

export function findCpuSegmentStepIndex(run: CpuRun, segment: CpuSegment): number {
  const index = run.steps.findIndex((step) => step.state.timeline.some((candidate) => (
    candidate.processId === segment.processId
    && candidate.start === segment.start
    && candidate.end === segment.end
  )));
  return Math.max(0, index);
}

export function findCpuSegmentEventTime(run: CpuRun, segment: CpuSegment): number {
  const step = run.steps.find((candidateStep) => candidateStep.state.timeline.some((candidate) => (
    candidate.processId === segment.processId
    && candidate.start === segment.start
    && candidate.end === segment.end
  )));
  return step?.time ?? segment.end;
}

export function getCpuTimelineLayout(trackWidth: number) {
  const stableTrackWidth = Math.max(1, trackWidth);
  return {
    columnGap: CPU_TIMELINE_COLUMN_GAP_PX,
    gridTemplateColumns: `${CPU_ALGORITHM_LABEL_WIDTH_PX}px ${stableTrackWidth}px`,
    width: CPU_ALGORITHM_LABEL_WIDTH_PX + CPU_TIMELINE_COLUMN_GAP_PX + stableTrackWidth,
  };
}

export function deriveCpuGlobalCurrentTime(runs: CpuRun[], currentStepIndex: number): number {
  const timeAxis = buildCpuGlobalTimeAxis(runs);
  if (timeAxis.length === 0) return 0;
  const safeIndex = Number.isFinite(currentStepIndex) ? Math.trunc(currentStepIndex) : 0;
  const index = Math.max(0, Math.min(safeIndex, timeAxis.length - 1));
  return timeAxis[index];
}

export function buildCpuGlobalTimeAxis(runs: CpuRun[]): number[] {
  return [...new Set(runs.flatMap((run) => run.steps.map((step) => step.time)))]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function findCpuGlobalTimeIndex(timeAxis: number[], eventTime: number): number {
  const exactIndex = timeAxis.indexOf(eventTime);
  if (exactIndex >= 0) return exactIndex;
  for (let index = timeAxis.length - 1; index >= 0; index -= 1) {
    if (timeAxis[index] <= eventTime) return index;
  }
  return 0;
}

export function selectCpuStepAtTime(run: CpuRun | undefined, currentTime: number) {
  if (!run) return undefined;
  let visibleStep: CpuRun['steps'][number] | undefined;
  for (const step of run.steps) {
    if (step.time <= currentTime && (!visibleStep || step.time >= visibleStep.time)) {
      visibleStep = step;
    }
  }
  return visibleStep;
}

export function deriveCpuPredictionResult(
  prediction: { answer: string | null; skipped: boolean } | null,
  runs: CpuRun[],
  completed: boolean,
): CpuPredictionResult | null {
  if (!prediction || !completed || runs.length === 0) return null;
  const lowestAverageWaitingTime = Math.min(...runs.map((run) => run.finalMetrics.averageWaitingTime));
  const winners = runs
    .filter((run) => run.finalMetrics.averageWaitingTime === lowestAverageWaitingTime)
    .map((run) => run.algorithm as CpuSchedulingAlgorithm);
  return {
    correct: prediction.skipped || !prediction.answer ? null : winners.includes(prediction.answer as CpuSchedulingAlgorithm),
    winners,
    lowestAverageWaitingTime,
  };
}

export function buildCpuCheckpoints(
  run: CpuRun,
  timeAxis: number[] = buildCpuGlobalTimeAxis([run]),
): CpuCheckpointDefinition[] {
  const readyStepIndex = Math.max(0, run.steps.findIndex((step) => step.state.readyQueue.length > 0));
  const readyStep = run.steps[readyStepIndex] ?? run.steps[0];
  const readyAnswer = readyStep?.state.readyQueue[0] ?? '队列为空';
  const processIds = readyStep?.state.processes.map((process) => process.processId) ?? [];
  const readyOptions = stableOptions([readyAnswer, ...processIds, '队列为空']);
  const completionOrder = run.finalMetrics.completionOrder;
  const completionAnswer = completionOrder.join(' → ') || '无';
  const completionOptions = stableOptions([
    completionAnswer,
    [...completionOrder].reverse().join(' → '),
    [...completionOrder.slice(1), completionOrder[0]].filter(Boolean).join(' → '),
    processIds.join(' → '),
  ]);

  return [
    {
      id: 'cpu-ready-queue',
      question: `在 ${algorithmLabels[run.algorithm as CpuSchedulingAlgorithm]} 的时间 ${readyStep?.time ?? 0}，就绪队列首项是什么？`,
      options: readyOptions,
      correctAnswer: readyAnswer,
      stepIndex: findCpuGlobalTimeIndex(timeAxis, readyStep?.time ?? 0),
      context: '判断调度器下一次可选的进程。',
    },
    {
      id: 'cpu-completion-order',
      question: `${algorithmLabels[run.algorithm as CpuSchedulingAlgorithm]} 的进程完成顺序是什么？`,
      options: completionOptions,
      correctAnswer: completionAnswer,
      stepIndex: Math.max(0, timeAxis.length - 1),
      context: '按完成时刻从早到晚排列全部进程。',
    },
  ];
}

export function isCpuCheckpointRevealed(
  checkpointId: CpuCheckpointDefinition['id'],
  checkpointAnswers: Record<string, string>,
): boolean {
  return typeof checkpointAnswers[checkpointId] === 'string';
}

export function getAvailableCpuCheckpoints(
  checkpoints: CpuCheckpointDefinition[],
  currentStepIndex: number,
  checkpointAnswers: Record<string, string>,
): CpuCheckpointDefinition[] {
  return checkpoints.filter((checkpoint) => (
    checkpoint.stepIndex <= currentStepIndex
    || isCpuCheckpointRevealed(checkpoint.id, checkpointAnswers)
  ));
}

function getTotalElapsedTime(runs: CpuRun[]) {
  return Math.max(1, ...runs.map((run) => run.steps.at(-1)?.state.timeline.at(-1)?.end ?? 0));
}

function timeToPercent(time: number, totalTime: number) {
  return Math.max(0, Math.min(100, (time / Math.max(1, totalTime)) * 100));
}

function buildTimeRuler(totalTime: number) {
  const interval = Math.max(1, Math.ceil(totalTime / 12));
  const ticks = Array.from({ length: Math.floor(totalTime / interval) + 1 }, (_, index) => index * interval);
  if (ticks.at(-1) !== totalTime) ticks.push(totalTime);
  return ticks;
}

function buildTimeCells(totalTime: number) {
  const interval = Math.max(1, Math.ceil(totalTime / 20));
  return Array.from({ length: Math.floor(totalTime / interval) }, (_, index) => (index + 1) * interval);
}

function stableOptions(values: Array<string | undefined>) {
  return uniqueStrings(values.filter((value): value is string => Boolean(value))).sort((left, right) => {
    const leftWeight = optionWeight(left);
    const rightWeight = optionWeight(right);
    return leftWeight - rightWeight || left.localeCompare(right, 'zh-CN');
  });
}

function optionWeight(value: string) {
  let weight = 0;
  for (let index = 0; index < value.length; index += 1) weight += value.charCodeAt(index) * (index + 1);
  return weight;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}
