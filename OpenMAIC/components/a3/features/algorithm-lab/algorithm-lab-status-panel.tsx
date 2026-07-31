import { Activity, CircleCheck, Clock3 } from 'lucide-react';
import type { AlgorithmLabPhase, SimulationRun } from '@/lib/a3/algorithm-lab/contracts';
import type { CpuSchedulingMetrics, CpuSchedulingState } from '@/lib/a3/algorithm-lab/cpu-scheduling';

type CpuRun = SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>;

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
  cpuRuns?: CpuRun[];
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
  cpuRuns = [],
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

      {cpuRuns.length > 0 ? <CpuMetricsTable runs={cpuRuns} currentStepIndex={currentStepIndex} /> : null}

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

function CpuMetricsTable({ runs, currentStepIndex }: { runs: CpuRun[]; currentStepIndex: number }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[var(--a3-text)]">调度指标</div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left text-[11px]">
          <thead className="text-[var(--a3-text-muted)]">
            <tr className="border-b border-[var(--a3-border)]">
              <th className="px-2 py-2 font-medium">算法</th>
              <th className="px-2 py-2 font-medium">平均等待</th>
              <th className="px-2 py-2 font-medium">平均周转</th>
              <th className="px-2 py-2 font-medium">平均响应</th>
              <th className="px-2 py-2 font-medium">上下文切换</th>
              <th className="px-2 py-2 font-medium">完成顺序</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const step = run.steps[Math.max(0, Math.min(currentStepIndex, run.steps.length - 1))];
              const metrics = step?.metrics ?? run.finalMetrics;
              return (
                <tr key={run.algorithm} className="border-b border-[var(--a3-border)]/70 text-[var(--a3-text)] last:border-0">
                  <th className="px-2 py-2 font-semibold uppercase">{run.algorithm}</th>
                  <td className="px-2 py-2 tabular-nums">{metrics.averageWaitingTime}</td>
                  <td className="px-2 py-2 tabular-nums">{metrics.averageTurnaroundTime}</td>
                  <td className="px-2 py-2 tabular-nums">{metrics.averageResponseTime}</td>
                  <td className="px-2 py-2 tabular-nums">{metrics.contextSwitches}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{metrics.completionOrder.join(' → ') || '尚未完成'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
