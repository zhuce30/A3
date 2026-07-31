import { Activity, CircleCheck, Clock3 } from 'lucide-react';
import type { AlgorithmLabPhase } from '@/lib/a3/algorithm-lab/contracts';

const phaseLabels: Record<AlgorithmLabPhase, string> = {
  idle: '等待配置',
  configured: '配置已更新',
  predicted: '预测已记录',
  running: '正在运行',
  paused: '已暂停',
  completed: '运行完成',
  submitted: '结果已提交',
};

interface AlgorithmLabStatusPanelProps {
  phase: AlgorithmLabPhase;
  speed: number;
  currentStepIndex: number;
  finalStepIndex: number;
  replayCount: number;
  syncState: 'idle' | 'pending' | 'failed' | 'submitted';
  syncError: string;
  onSpeedChange: (speed: number) => void;
}

export function AlgorithmLabStatusPanel({
  phase,
  speed,
  currentStepIndex,
  finalStepIndex,
  replayCount,
  syncState,
  syncError,
  onSpeedChange,
}: AlgorithmLabStatusPanelProps) {
  return (
    <section className="space-y-5" aria-label="实验结果状态">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--a3-text)]">
          <Activity className="size-4 text-amber-600" />
          运行状态
        </div>
        <div className="mt-3 flex items-center gap-2 text-sm text-[var(--a3-text)]" role="status">
          <span className={`size-2 rounded-full ${phase === 'running' ? 'animate-pulse bg-emerald-500' : 'bg-amber-500'}`} />
          {phaseLabels[phase]}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-y border-[var(--a3-border)] py-4 text-sm">
        <StatusMetric icon={Clock3} label="当前步骤" value={`${finalStepIndex >= 0 ? currentStepIndex + 1 : 0}/${finalStepIndex + 1}`} />
        <StatusMetric icon={CircleCheck} label="重新运行" value={`${replayCount} 次`} />
      </div>

      <label className="block text-xs font-medium text-[var(--a3-text-muted)]">
        播放速度
        <select
          value={speed}
          onChange={(event) => onSpeedChange(Number(event.target.value))}
          className="mt-2 h-10 w-full rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm text-[var(--a3-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          <option value={0.5}>0.5x</option>
          <option value={1}>1x</option>
          <option value={1.5}>1.5x</option>
          <option value={2}>2x</option>
        </select>
      </label>

      <div className="text-xs leading-5 text-[var(--a3-text-muted)]" aria-live="polite">
        {syncState === 'failed' ? syncError : syncState === 'submitted' ? '学习证据已写回' : '完成实验后将验证并写回学习报告'}
      </div>
    </section>
  );
}

function StatusMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-[var(--a3-text-muted)]"><Icon className="size-3.5" />{label}</div>
      <div className="mt-1 font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}
