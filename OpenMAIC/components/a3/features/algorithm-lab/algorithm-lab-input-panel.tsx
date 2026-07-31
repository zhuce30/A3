'use client';

import { Check, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabDefinition,
  CpuProcessInput,
  CpuSchedulingInput,
  PageReplacementInput,
} from '@/lib/a3/algorithm-lab/contracts';
import { validateCpuSchedulingInput, validatePageReplacementInput } from '@/lib/a3/algorithm-lab/validators';
import type { CpuPredictionResult } from './cpu-scheduling-visualizer';
import type { PagePredictionResult } from './page-replacement-visualizer';

interface AlgorithmLabInputPanelProps {
  definition: AlgorithmLabDefinition;
  presetId: string;
  selectedAlgorithms: AlgorithmLabAlgorithm[];
  cpuInput?: CpuSchedulingInput;
  pageInput?: PageReplacementInput;
  prediction?: { answer: string | null; skipped: boolean } | null;
  predictionResult?: CpuPredictionResult | null;
  pagePredictionResult?: PagePredictionResult | null;
  predictionLocked?: boolean;
  onSelectPreset: (presetId: string) => void;
  onToggleAlgorithm: (algorithm: AlgorithmLabAlgorithm) => void;
  onCpuInputChange?: (input: CpuSchedulingInput) => void;
  onPageInputChange?: (input: PageReplacementInput) => void;
  onPredict?: (answer: string) => void;
  onSkipPrediction?: () => void;
}

export function AlgorithmLabInputPanel({
  definition,
  presetId,
  selectedAlgorithms,
  cpuInput,
  pageInput,
  prediction,
  predictionResult,
  pagePredictionResult,
  predictionLocked = false,
  onSelectPreset,
  onToggleAlgorithm,
  onCpuInputChange,
  onPageInputChange,
  onPredict,
  onSkipPrediction,
}: AlgorithmLabInputPanelProps) {
  const cpuValidation = cpuInput ? validateCpuSchedulingInput(cpuInput) : null;
  const pageValidation = pageInput ? validatePageReplacementInput(pageInput) : null;
  const isCustom = presetId === 'custom';

  return (
    <section className="space-y-5" aria-label="实验输入设置">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
          <SlidersHorizontal className="size-4 text-amber-600" />
          输入与算法
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">选择预设，也可以修改参数形成自定义实验。</p>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="algorithm-lab-preset" className="text-xs font-medium text-[var(--a3-text-muted)]">实验预设</label>
          <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${isCustom ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'}`}>
            {isCustom ? '自定义配置' : '标准预设'}
          </span>
        </div>
        <select
          id="algorithm-lab-preset"
          value={presetId}
          onChange={(event) => onSelectPreset(event.target.value)}
          className="mt-2 h-10 w-full rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {presetId === 'custom' ? <option value="custom">自定义配置</option> : null}
          {definition.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.title}</option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend className="text-xs font-medium text-[var(--a3-text-muted)]">对比算法</legend>
        <div className="mt-2 grid grid-cols-2 gap-1.5 xl:grid-cols-1">
          {definition.algorithms.map((algorithm) => {
            const checked = selectedAlgorithms.includes(algorithm);
            return (
              <label key={algorithm} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-[var(--a3-text)] transition-colors duration-200 hover:bg-amber-50 dark:hover:bg-amber-950/30">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleAlgorithm(algorithm)}
                  className="sr-only"
                />
                <span className={`flex size-4 items-center justify-center rounded border ${checked ? 'border-amber-500 bg-amber-500 text-slate-950' : 'border-[var(--a3-border)]'}`}>
                  {checked ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
                {algorithm.toUpperCase()}
              </label>
            );
          })}
        </div>
      </fieldset>

      {definition.id === 'cpu-scheduling' && cpuInput && onCpuInputChange ? (
        <CpuProcessEditor input={cpuInput} onChange={onCpuInputChange} />
      ) : null}

      {definition.id === 'page-replacement' && pageInput && onPageInputChange ? (
        <PageReplacementEditor input={pageInput} onChange={onPageInputChange} />
      ) : null}

      {cpuValidation && !cpuValidation.valid ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/30" role="alert">
          <div className="text-xs font-semibold text-rose-800 dark:text-rose-200">请修正输入后再运行</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-rose-700 dark:text-rose-300">
            {cpuValidation.errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      ) : null}

      {pageValidation && !pageValidation.valid ? (
        <ValidationErrors errors={pageValidation.errors} />
      ) : null}

      {definition.id === 'cpu-scheduling' ? (
        <CpuPrediction
          algorithms={selectedAlgorithms}
          prediction={prediction ?? null}
          result={predictionResult ?? null}
          locked={predictionLocked}
          onPredict={onPredict}
          onSkip={onSkipPrediction}
        />
      ) : null}

      {definition.id === 'page-replacement' ? (
        <PagePrediction
          algorithms={selectedAlgorithms}
          prediction={prediction ?? null}
          result={pagePredictionResult ?? null}
          locked={predictionLocked}
          onPredict={onPredict}
          onSkip={onSkipPrediction}
        />
      ) : null}
    </section>
  );
}

function PageReplacementEditor({
  input,
  onChange,
}: {
  input: PageReplacementInput;
  onChange: (input: PageReplacementInput) => void;
}) {
  const [draftState, setDraftState] = useState(() => ({
    value: input.referenceString.join(', '),
    referenceString: [...input.referenceString],
  }));
  const externalDraft = input.referenceString.join(', ');

  if (!pageReferencesEqual(draftState.referenceString, input.referenceString)) {
    setDraftState({
      value: externalDraft,
      referenceString: [...input.referenceString],
    });
  }

  return (
    <fieldset className="space-y-3 border-t border-[var(--a3-border)] pt-4">
      <legend className="sr-only">页面置换参数</legend>
      <label className="block text-xs font-medium text-[var(--a3-text-muted)]">
        页面引用序列
        <textarea
          value={draftState.value}
          rows={3}
          spellCheck={false}
          placeholder="例如：7, 0, 1, 2, 0, 3"
          onChange={(event) => {
            const referenceString = parsePageReferenceString(event.target.value);
            setDraftState({ value: event.target.value, referenceString: [...referenceString] });
            onChange({ ...input, referenceString });
          }}
          className="mt-2 w-full resize-y rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 py-2 text-sm leading-6 tabular-nums text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        />
        <span className="mt-1 block text-[10px] leading-4">使用逗号或空格分隔，最多 60 个非负整数。</span>
      </label>
      <NumericField
        label="页框数量"
        value={input.frameCount}
        min={1}
        max={8}
        onChange={(frameCount) => onChange({ ...input, frameCount })}
        wide
      />
    </fieldset>
  );
}

function ValidationErrors({ errors }: { errors: string[] }) {
  return (
    <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/30" role="alert">
      <div className="text-xs font-semibold text-rose-800 dark:text-rose-200">请修正输入后再运行</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5 text-rose-700 dark:text-rose-300">
        {errors.map((error) => <li key={error}>{error}</li>)}
      </ul>
    </div>
  );
}

function CpuProcessEditor({ input, onChange }: { input: CpuSchedulingInput; onChange: (input: CpuSchedulingInput) => void }) {
  return (
    <fieldset className="border-t border-[var(--a3-border)] pt-4">
      <legend className="sr-only">进程参数</legend>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--a3-text)]" aria-hidden="true">进程参数</span>
        <button
          type="button"
          onClick={() => onChange(addCpuProcess(input))}
          disabled={input.processes.length >= 12}
          className="inline-flex size-8 items-center justify-center rounded-md text-amber-700 transition-colors duration-200 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-35 dark:text-amber-300 dark:hover:bg-amber-950/40"
          aria-label="添加进程"
          title="添加进程"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {input.processes.map((process, index) => (
          <div key={`${process.processId}-${index}`} className="rounded-md border border-[var(--a3-border)] p-2.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-medium text-[var(--a3-text-muted)]">
                进程编号
                <input
                  type="text"
                  value={process.processId}
                  maxLength={16}
                  onChange={(event) => onChange(updateCpuProcess(input, index, 'processId', event.target.value))}
                  className="mt-1 h-8 w-24 rounded border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-2 text-xs text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  aria-label={`进程 ${index + 1} 编号`}
                />
              </label>
              <button
                type="button"
                onClick={() => onChange(removeCpuProcess(input, index))}
                disabled={input.processes.length <= 1}
                className="inline-flex size-8 items-center justify-center rounded-md text-[var(--a3-text-muted)] transition-colors duration-200 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
                aria-label={`删除进程 ${process.processId || index + 1}`}
                title="删除进程"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <NumericField label="到达时间" value={process.arrivalTime} min={0} max={100} onChange={(value) => onChange(updateCpuProcess(input, index, 'arrivalTime', value))} />
              <NumericField label="运行时间" value={process.burstTime} min={1} max={100} onChange={(value) => onChange(updateCpuProcess(input, index, 'burstTime', value))} />
              <NumericField label="优先级" value={process.priority} min={0} max={99} onChange={(value) => onChange(updateCpuProcess(input, index, 'priority', value))} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <NumericField
          label="RR 时间片"
          value={input.timeQuantum}
          min={1}
          max={20}
          onChange={(value) => onChange({ ...input, timeQuantum: value })}
          wide
        />
      </div>
    </fieldset>
  );
}

function NumericField({
  label,
  value,
  min,
  max,
  onChange,
  wide = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  wide?: boolean;
}) {
  return (
    <label className={`text-[10px] font-medium text-[var(--a3-text-muted)] ${wide ? 'block' : ''}`}>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={1}
        onChange={(event) => onChange(Number(event.target.value))}
        className={`mt-1 h-8 rounded border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-2 text-xs tabular-nums text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${wide ? 'w-full' : 'w-full min-w-0'}`}
      />
    </label>
  );
}

function CpuPrediction({
  algorithms,
  prediction,
  result,
  locked,
  onPredict,
  onSkip,
}: {
  algorithms: AlgorithmLabAlgorithm[];
  prediction: { answer: string | null; skipped: boolean } | null;
  result: CpuPredictionResult | null;
  locked: boolean;
  onPredict?: (answer: string) => void;
  onSkip?: () => void;
}) {
  return (
    <section className="border-t border-[var(--a3-border)] pt-4" aria-labelledby="cpu-prediction-title">
      <h3 id="cpu-prediction-title" className="text-xs font-semibold leading-5 text-[var(--a3-text)]">
        运行前预测：哪种算法的平均等待时间最低？
      </h3>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="选择预测算法">
        {algorithms.map((algorithm) => (
          <button
            key={algorithm}
            type="button"
            disabled={locked}
            onClick={() => onPredict?.(algorithm)}
            className={`h-8 rounded-md border px-2.5 text-xs font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default ${prediction?.answer === algorithm ? 'border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : 'border-[var(--a3-border)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]'}`}
          >
            {algorithm.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          disabled={locked}
          onClick={() => onSkip?.()}
          className={`h-8 rounded-md px-2.5 text-xs font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default ${prediction?.skipped ? 'bg-[var(--a3-surface-muted)] text-[var(--a3-text)]' : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]'}`}
        >
          跳过预测
        </button>
      </div>
      {!prediction ? (
        <p className="mt-2 text-[11px] leading-5 text-[var(--a3-text-muted)]">选择一个答案或明确跳过，才能开始首次运行。</p>
      ) : null}
      {result ? (
        <div className="mt-3 rounded-md bg-[var(--a3-surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--a3-text)]" aria-live="polite">
          {result.correct === null
            ? `你跳过了预测。最低值为 ${result.lowestAverageWaitingTime}，对应 ${result.winners.map((item) => item.toUpperCase()).join('、')}。`
            : result.correct
              ? `预测正确：${result.winners.map((item) => item.toUpperCase()).join('、')} 的平均等待时间最低。`
              : `预测未命中。实际最低的是 ${result.winners.map((item) => item.toUpperCase()).join('、')}（${result.lowestAverageWaitingTime}）。`}
        </div>
      ) : null}
    </section>
  );
}

function PagePrediction({
  algorithms,
  prediction,
  result,
  locked,
  onPredict,
  onSkip,
}: {
  algorithms: AlgorithmLabAlgorithm[];
  prediction: { answer: string | null; skipped: boolean } | null;
  result: PagePredictionResult | null;
  locked: boolean;
  onPredict?: (answer: string) => void;
  onSkip?: () => void;
}) {
  return (
    <section className="border-t border-[var(--a3-border)] pt-4" aria-labelledby="page-prediction-title">
      <h3 id="page-prediction-title" className="text-xs font-semibold leading-5 text-[var(--a3-text)]">
        运行前预测：哪种算法的缺页次数最少？
      </h3>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="选择缺页最少的算法">
        {algorithms.map((algorithm) => (
          <button
            key={algorithm}
            type="button"
            disabled={locked}
            onClick={() => onPredict?.(algorithm)}
            className={`h-8 rounded-md border px-2.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default ${prediction?.answer === algorithm ? 'border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100' : 'border-[var(--a3-border)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]'}`}
          >
            {algorithm.toUpperCase()}
          </button>
        ))}
        <button
          type="button"
          disabled={locked}
          onClick={() => onSkip?.()}
          className={`h-8 rounded-md px-2.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-default ${prediction?.skipped ? 'bg-[var(--a3-surface-muted)] text-[var(--a3-text)]' : 'text-[var(--a3-text-muted)] hover:bg-[var(--a3-surface-muted)]'}`}
        >
          跳过预测
        </button>
      </div>
      {!prediction ? (
        <p className="mt-2 text-[11px] leading-5 text-[var(--a3-text-muted)]">选择答案或明确跳过后才能开始运行；完成前不会显示正确答案。</p>
      ) : null}
      {result ? (
        <div className="mt-3 rounded-md bg-[var(--a3-surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--a3-text)]" aria-live="polite">
          {result.correct === null
            ? `你跳过了预测。当前序列缺页最少的是 ${result.winners.map((item) => item.toUpperCase()).join('、')}，共 ${result.fewestFaults} 次。`
            : result.correct
              ? `预测正确。${result.winners.map((item) => item.toUpperCase()).join('、')} 在当前序列中缺页最少。`
              : `预测未命中。当前序列缺页最少的是 ${result.winners.map((item) => item.toUpperCase()).join('、')}，共 ${result.fewestFaults} 次。`}
        </div>
      ) : null}
    </section>
  );
}

export function parsePageReferenceString(value: string): number[] {
  const normalized = value.trim();
  if (!normalized) return [];
  return normalized.split(/[\s,]+/).map((token) => Number(token));
}

function pageReferencesEqual(left: number[], right: number[]): boolean {
  return left.length === right.length
    && left.every((page, index) => Object.is(page, right[index]));
}

export function addCpuProcess(input: CpuSchedulingInput): CpuSchedulingInput {
  if (input.processes.length >= 12) return input;
  const usedIds = new Set(input.processes.map((process) => process.processId));
  let suffix = 1;
  while (usedIds.has(`P${suffix}`)) suffix += 1;
  return {
    ...input,
    processes: [
      ...input.processes.map((process) => ({ ...process })),
      { processId: `P${suffix}`, arrivalTime: 0, burstTime: 1, priority: 0 },
    ],
  };
}

export function removeCpuProcess(input: CpuSchedulingInput, index: number): CpuSchedulingInput {
  if (input.processes.length <= 1 || index < 0 || index >= input.processes.length) return input;
  return {
    ...input,
    processes: input.processes.filter((_, processIndex) => processIndex !== index).map((process) => ({ ...process })),
  };
}

export function updateCpuProcess<K extends keyof CpuProcessInput>(
  input: CpuSchedulingInput,
  index: number,
  field: K,
  value: CpuProcessInput[K],
): CpuSchedulingInput {
  if (index < 0 || index >= input.processes.length) return input;
  return {
    ...input,
    processes: input.processes.map((process, processIndex) => (
      processIndex === index ? { ...process, [field]: value } : { ...process }
    )),
  };
}
