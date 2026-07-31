import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  CircleAlert,
  Eye,
  Layers3,
  Minus,
} from 'lucide-react';
import type {
  PageReplacementAlgorithm,
  SimulationRun,
} from '@/lib/a3/algorithm-lab/contracts';
import type {
  PageReplacementMetrics,
  PageReplacementState,
} from '@/lib/a3/algorithm-lab/page-replacement';

export type PageRun = SimulationRun<PageReplacementState, PageReplacementMetrics>;

export interface PagePredictionResult {
  correct: boolean | null;
  winners: PageReplacementAlgorithm[];
  fewestFaults: number;
}

export interface PageCheckpointDefinition {
  id: 'page-victim' | 'page-policy-reason';
  question: string;
  options: string[];
  correctAnswer: string;
  stepIndex: number;
  context: string;
}

interface PageReplacementVisualizerProps {
  runs: PageRun[];
  referenceString: number[];
  frameCount: number;
  currentStepIndex: number;
  completed: boolean;
  revealVictim?: boolean;
  revealPolicyReason?: boolean;
  onSeek: (index: number) => void;
}

const algorithmLabels: Record<PageReplacementAlgorithm, string> = {
  fifo: 'FIFO',
  lru: 'LRU',
  opt: 'OPT',
};

const policyReasons: Record<PageReplacementAlgorithm, string> = {
  fifo: '选择最早进入内存且仍驻留的页面',
  lru: '选择最久未被访问的驻留页面',
  opt: '选择未来最晚访问或不再访问的驻留页面',
};

export function PageReplacementVisualizer({
  runs,
  referenceString,
  frameCount,
  currentStepIndex,
  completed,
  revealVictim = false,
  revealPolicyReason = false,
  onSeek,
}: PageReplacementVisualizerProps) {
  const indexAxis = buildPageGlobalIndexAxis(runs);
  const currentReferenceIndex = derivePageGlobalCurrentIndex(runs, currentStepIndex);
  const visibleIndexAxis = indexAxis.filter((referenceIndex) => (
    referenceIndex <= currentReferenceIndex
  ));

  if (runs.length === 0) {
    return (
      <div
        className="flex min-h-[430px] flex-col items-center justify-center px-6 text-center"
        data-testid="page-replacement-canvas"
      >
        <Layers3 className="size-10 text-amber-600" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--a3-text)]">页框矩阵等待运行</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-[var(--a3-text-muted)]">
          设置引用序列和页框数量，完成运行前预测后开始实验。
        </p>
      </div>
    );
  }

  return (
    <section
      className="min-h-[430px] min-w-0 overflow-hidden p-4 sm:p-5"
      data-testid="page-replacement-canvas"
      aria-label="页面置换页框矩阵"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--a3-text)]">引用序列与页框矩阵</h2>
          <p className="mt-1 text-xs text-[var(--a3-text-muted)]">
            选择任一历史列可定位到共享引用索引，不会重新运行算法。
          </p>
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-100">
          当前列 {currentReferenceIndex + 1} / {indexAxis.length}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto pb-2" data-testid="page-reference-sequence">
        <div className="min-w-max">
          <div className="grid grid-cols-[76px_auto] gap-3">
            <div className="flex items-center text-xs font-semibold text-[var(--a3-text-muted)]">引用序列</div>
            <div className="flex gap-2">
              {visibleIndexAxis.map((referenceIndex) => {
                const current = referenceIndex === currentReferenceIndex;
                return (
                  <button
                    key={referenceIndex}
                    type="button"
                    data-testid="page-reference-column"
                    data-reference-index={referenceIndex}
                    onClick={() => onSeek(findPageGlobalIndexPosition(indexAxis, referenceIndex))}
                    className={`flex h-12 w-[76px] shrink-0 flex-col items-center justify-center rounded-md border text-sm font-semibold tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${current ? 'border-amber-500 bg-amber-100 text-amber-950 ring-2 ring-amber-300 dark:bg-amber-950/45 dark:text-amber-100' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]'}`}
                    aria-label={`定位到引用索引 ${referenceIndex}，页面 ${referenceString[referenceIndex]}`}
                    aria-current={current ? 'step' : undefined}
                  >
                    <span>{referenceString[referenceIndex]}</span>
                    <span className="text-[9px] font-medium text-[var(--a3-text-muted)]">#{referenceIndex}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 space-y-4">
            {runs.map((run) => (
              <PageAlgorithmRow
                key={run.algorithm}
                run={run}
                indexAxis={visibleIndexAxis}
                frameCount={frameCount}
                currentReferenceIndex={currentReferenceIndex}
                revealVictim={revealVictim}
                onSeek={(referenceIndex) => onSeek(findPageGlobalIndexPosition(indexAxis, referenceIndex))}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-[var(--a3-border)] pt-3 text-[11px] text-[var(--a3-text-muted)]" aria-label="页框状态图例">
        <Cue icon={CheckCircle2} label="命中" className="text-emerald-600" />
        <Cue icon={CircleAlert} label="缺页" className="text-amber-600" />
        <Cue icon={ArrowUpFromLine} label="淘汰" className="text-rose-600" />
        <Cue icon={ArrowDownToLine} label="调入" className="text-cyan-600" />
        <Cue icon={Minus} label="保持不变" className="text-[var(--a3-text-muted)]" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3" aria-label="当前策略依据">
        {runs.map((run) => {
          const step = selectPageStepAtIndex(run, currentReferenceIndex);
          return (
            <div key={run.algorithm} className="border-l-2 border-amber-400 pl-3">
              <div className="text-xs font-semibold text-[var(--a3-text)]">{algorithmLabels[run.algorithm as PageReplacementAlgorithm]} 策略依据</div>
              <div className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
                {revealPolicyReason
                  ? describePolicyEvidence(run.algorithm as PageReplacementAlgorithm, step?.state, currentReferenceIndex)
                  : '提交策略原因检查点后显示当前证据。'}
              </div>
            </div>
          );
        })}
      </div>

      {completed ? <PageComparisonResult runs={runs} /> : null}
    </section>
  );
}

function PageAlgorithmRow({
  run,
  indexAxis,
  frameCount,
  currentReferenceIndex,
  revealVictim,
  onSeek,
}: {
  run: PageRun;
  indexAxis: number[];
  frameCount: number;
  currentReferenceIndex: number;
  revealVictim: boolean;
  onSeek: (referenceIndex: number) => void;
}) {
  return (
    <div className="grid grid-cols-[76px_auto] gap-3" data-testid={`page-algorithm-row-${run.algorithm}`}>
      <div className="pt-2">
        <div className="text-xs font-bold uppercase text-[var(--a3-text)]">{algorithmLabels[run.algorithm as PageReplacementAlgorithm]}</div>
        <div className="mt-1 text-[10px] text-[var(--a3-text-muted)]">{frameCount} 个固定页框</div>
      </div>
      <div className="flex gap-2">
        {indexAxis.map((referenceIndex) => {
          const step = selectPageStepAtIndex(run, referenceIndex);
          const previousStep = selectPageStepAtIndex(run, referenceIndex - 1);
          const current = referenceIndex === currentReferenceIndex;
          return (
            <button
              key={referenceIndex}
              type="button"
              data-testid="page-state-column"
              data-reference-index={referenceIndex}
              onClick={() => onSeek(referenceIndex)}
              className={`w-[76px] shrink-0 rounded-md border p-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${current ? 'border-amber-500 bg-amber-50 ring-2 ring-amber-200 dark:bg-amber-950/30' : 'border-[var(--a3-border)] bg-[var(--a3-surface-solid)] hover:bg-[var(--a3-surface-muted)]'}`}
              aria-label={`${algorithmLabels[run.algorithm as PageReplacementAlgorithm]} 引用索引 ${referenceIndex}，${step?.state.hit ? '命中' : '缺页'}`}
            >
              <div className={`mb-1.5 flex items-center gap-1 text-[9px] font-semibold ${step?.state.hit ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
                {step?.state.hit ? <CheckCircle2 className="size-3" /> : <CircleAlert className="size-3" />}
                {step?.state.hit ? '命中' : '缺页'}
              </div>
              <div className="space-y-1">
                {Array.from({ length: frameCount }, (_, frameIndex) => (
                  <FrameSlot
                    key={frameIndex}
                    page={step?.state.frames[frameIndex] ?? null}
                    cue={getFrameCue(previousStep?.state, step?.state, frameIndex)}
                  />
                ))}
              </div>
              <div className="mt-1.5 min-h-4 truncate text-[9px] font-medium text-rose-700 dark:text-rose-300">
                {step?.state.evictedPage !== null && step?.state.evictedPage !== undefined
                  ? revealVictim ? `淘汰 ${step.state.evictedPage}` : '淘汰待判断'
                  : '保持不变'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FrameSlot({ page, cue }: { page: number | null; cue: 'inserted' | 'hit' | 'unchanged' | 'empty' }) {
  const cueClass = cue === 'inserted'
    ? 'border-cyan-400 bg-cyan-50 text-cyan-950 dark:bg-cyan-950/40 dark:text-cyan-100'
    : cue === 'hit'
      ? 'border-emerald-400 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100'
      : 'border-[var(--a3-border)] bg-[var(--a3-surface-muted)] text-[var(--a3-text)]';
  return (
    <div className={`flex h-7 items-center justify-between rounded border px-1.5 text-[10px] font-semibold tabular-nums ${cueClass}`}>
      <span>{page ?? '—'}</span>
      {cue === 'inserted' ? <ArrowDownToLine className="size-3" aria-label="调入" /> : null}
      {cue === 'hit' ? <CheckCircle2 className="size-3" aria-label="命中" /> : null}
      {cue === 'unchanged' ? <Minus className="size-3 opacity-45" aria-label="保持不变" /> : null}
    </div>
  );
}

function Cue({ icon: Icon, label, className }: { icon: typeof Eye; label: string; className: string }) {
  return <span className="inline-flex items-center gap-1"><Icon className={`size-3.5 ${className}`} />{label}</span>;
}

function PageComparisonResult({ runs }: { runs: PageRun[] }) {
  const fewestFaults = Math.min(...runs.map((run) => run.finalMetrics.pageFaults));
  const winners = runs.filter((run) => run.finalMetrics.pageFaults === fewestFaults);
  return (
    <div className="mt-5 border-t border-[var(--a3-border)] pt-4" aria-live="polite">
      <div className="text-xs font-semibold text-[var(--a3-text)]">当前序列比较结论</div>
      <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
        {winners.length === 1
          ? `${algorithmLabels[winners[0].algorithm as PageReplacementAlgorithm]} 在本次引用序列中缺页最少，共 ${fewestFaults} 次。`
          : `${winners.map((run) => algorithmLabels[run.algorithm as PageReplacementAlgorithm]).join('、')} 并列最少，均为 ${fewestFaults} 次缺页。`}
        此结论仅代表当前引用序列，不表示某种策略在所有负载下都最优。
      </p>
    </div>
  );
}

function getFrameCue(
  previous: PageReplacementState | undefined,
  current: PageReplacementState | undefined,
  frameIndex: number,
): 'inserted' | 'hit' | 'unchanged' | 'empty' {
  const page = current?.frames[frameIndex] ?? null;
  if (page === null) return 'empty';
  if (current?.hit && page === current.currentPage) return 'hit';
  if (page !== (previous?.frames[frameIndex] ?? null)) return 'inserted';
  return 'unchanged';
}

function describePolicyEvidence(
  algorithm: PageReplacementAlgorithm,
  state: PageReplacementState | undefined,
  referenceIndex: number,
): string {
  if (!state) return '尚无可用状态。';
  if (algorithm === 'fifo') {
    return `FIFO 队列（旧 → 新）：${state.fifoQueue.join(' → ') || '空'}`;
  }
  if (algorithm === 'lru') {
    return `LRU 最近使用顺序（久 → 近）：${state.recentUseOrder.join(' → ') || '空'}`;
  }
  const distances = Object.entries(state.nextUseByPage).map(([page, nextIndex]) => (
    `${page}: ${nextIndex === null ? '不再访问' : `${nextIndex - referenceIndex} 列后`}`
  ));
  return `OPT 下次访问距离：${distances.join('；') || '无驻留页'}`;
}

export function getPageStepExplanation(
  run: PageRun | undefined,
  step: PageRun['steps'][number] | undefined,
  revealVictim: boolean,
  revealPolicyReason: boolean,
): string {
  if (!run || !step || !(run.algorithm in algorithmLabels)) return '';
  const algorithm = run.algorithm as PageReplacementAlgorithm;
  const outcome = step.state.hit ? '命中' : '缺页';
  const victim = step.state.evictedPage === null
    ? '无淘汰页'
    : revealVictim
      ? `淘汰页 ${step.state.evictedPage}`
      : '淘汰页将在提交检查点后显示';
  const policyEvidence = revealPolicyReason
    ? describePolicyEvidence(algorithm, step.state, step.state.referenceIndex)
    : '策略依据将在提交检查点后显示';
  return `页面 ${step.state.currentPage}：${outcome}；${victim}；${policyEvidence}。`;
}

export function buildPageGlobalIndexAxis(runs: PageRun[]): number[] {
  return [...new Set(runs.flatMap((run) => run.steps.map((step) => step.state.referenceIndex)))]
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

export function derivePageGlobalCurrentIndex(runs: PageRun[], currentStepIndex: number): number {
  const indexAxis = buildPageGlobalIndexAxis(runs);
  if (indexAxis.length === 0) return 0;
  const safeIndex = Number.isFinite(currentStepIndex) ? Math.trunc(currentStepIndex) : 0;
  return indexAxis[Math.max(0, Math.min(safeIndex, indexAxis.length - 1))];
}

export function findPageGlobalIndexPosition(indexAxis: number[], referenceIndex: number): number {
  const exactIndex = indexAxis.indexOf(referenceIndex);
  if (exactIndex >= 0) return exactIndex;
  for (let index = indexAxis.length - 1; index >= 0; index -= 1) {
    if (indexAxis[index] <= referenceIndex) return index;
  }
  return 0;
}

export function selectPageStepAtIndex(run: PageRun | undefined, referenceIndex: number) {
  if (!run) return undefined;
  let visibleStep: PageRun['steps'][number] | undefined;
  for (const step of run.steps) {
    if (step.state.referenceIndex <= referenceIndex) visibleStep = step;
    else break;
  }
  return visibleStep;
}

export function derivePagePredictionResult(
  prediction: { answer: string | null; skipped: boolean } | null,
  runs: PageRun[],
  completed: boolean,
): PagePredictionResult | null {
  if (!prediction || !completed || runs.length === 0) return null;
  const fewestFaults = Math.min(...runs.map((run) => run.finalMetrics.pageFaults));
  const winners = runs
    .filter((run) => run.finalMetrics.pageFaults === fewestFaults)
    .map((run) => run.algorithm as PageReplacementAlgorithm);
  return {
    correct: prediction.skipped || !prediction.answer
      ? null
      : winners.includes(prediction.answer as PageReplacementAlgorithm),
    winners,
    fewestFaults,
  };
}

export function buildPageCheckpoints(
  run: PageRun,
  indexAxis: number[] = buildPageGlobalIndexAxis([run]),
): PageCheckpointDefinition[] {
  const evictionSteps = run.steps.filter((step) => step.state.evictedPage !== null);
  const fallbackStep = run.steps.at(-1)!;
  const victimStep = evictionSteps[0] ?? fallbackStep;
  const reasonStep = evictionSteps.at(-1) ?? fallbackStep;
  const hasEviction = evictionSteps.length > 0;
  const victimAnswer = hasEviction ? String(victimStep.state.evictedPage) : '未淘汰页面';
  const reasonAnswer = hasEviction
    ? policyReasons[run.algorithm as PageReplacementAlgorithm]
    : '当前步骤没有发生淘汰';
  const pageOptions = stableOptions([
    victimAnswer,
    '未淘汰页面',
    ...run.steps.flatMap((step) => [String(step.state.currentPage), ...step.state.frames.map(String)]),
  ]).slice(0, 4);
  const algorithm = run.algorithm as PageReplacementAlgorithm;

  return [
    {
      id: 'page-victim',
      question: `${algorithmLabels[algorithm]} 在引用页面 ${victimStep.state.currentPage} 时淘汰了哪一页？`,
      options: pageOptions,
      correctAnswer: victimAnswer,
      stepIndex: findPageGlobalIndexPosition(indexAxis, victimStep.state.referenceIndex),
      context: '先根据淘汰前的页框和策略状态判断，再提交答案查看结果。',
    },
    {
      id: 'page-policy-reason',
      question: `${algorithmLabels[algorithm]} 在该步骤中为何这样处理页框？`,
      options: stableOptions([reasonAnswer, ...Object.values(policyReasons)]),
      correctAnswer: reasonAnswer,
      stepIndex: findPageGlobalIndexPosition(indexAxis, reasonStep.state.referenceIndex),
      context: `定位到引用页面 ${reasonStep.state.currentPage} 的淘汰步骤，判断策略依据。`,
    },
  ];
}

export function isPageCheckpointRevealed(
  checkpointId: PageCheckpointDefinition['id'],
  checkpointAnswers: Record<string, string>,
): boolean {
  return typeof checkpointAnswers[checkpointId] === 'string';
}

export function getAvailablePageCheckpoints(
  checkpoints: PageCheckpointDefinition[],
  currentStepIndex: number,
  checkpointAnswers: Record<string, string>,
): PageCheckpointDefinition[] {
  return checkpoints.filter((checkpoint) => (
    checkpoint.stepIndex <= currentStepIndex
    || isPageCheckpointRevealed(checkpoint.id, checkpointAnswers)
  ));
}

function stableOptions(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
