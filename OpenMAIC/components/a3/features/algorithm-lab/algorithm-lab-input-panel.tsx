import { Check, SlidersHorizontal } from 'lucide-react';
import type {
  AlgorithmLabAlgorithm,
  AlgorithmLabDefinition,
} from '@/lib/a3/algorithm-lab/contracts';

interface AlgorithmLabInputPanelProps {
  definition: AlgorithmLabDefinition;
  presetId: string;
  selectedAlgorithms: AlgorithmLabAlgorithm[];
  onSelectPreset: (presetId: string) => void;
  onToggleAlgorithm: (algorithm: AlgorithmLabAlgorithm) => void;
}

export function AlgorithmLabInputPanel({
  definition,
  presetId,
  selectedAlgorithms,
  onSelectPreset,
  onToggleAlgorithm,
}: AlgorithmLabInputPanelProps) {
  return (
    <section className="space-y-5" aria-label="实验输入设置">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
          <SlidersHorizontal className="size-4 text-amber-600" />
          输入与算法
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">选择预设和需要并排比较的算法。</p>
      </div>

      <label className="block text-xs font-medium text-[var(--a3-text-muted)]">
        实验预设
        <select
          value={presetId}
          onChange={(event) => onSelectPreset(event.target.value)}
          className="mt-2 h-10 w-full rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {presetId === 'custom' ? <option value="custom">自定义配置</option> : null}
          {definition.presets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.title}</option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="text-xs font-medium text-[var(--a3-text-muted)]">对比算法</legend>
        <div className="mt-2 space-y-1.5">
          {definition.algorithms.map((algorithm) => {
            const checked = selectedAlgorithms.includes(algorithm);
            return (
              <label key={algorithm} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-[var(--a3-text)] hover:bg-amber-50 dark:hover:bg-amber-950/30">
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
    </section>
  );
}
