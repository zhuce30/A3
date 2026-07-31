import {
  Expand,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import type { AlgorithmLabPhase } from '@/lib/a3/algorithm-lab/contracts';

interface AlgorithmLabControlsProps {
  phase: AlgorithmLabPhase;
  hasRuns: boolean;
  currentStepIndex: number;
  finalStepIndex: number;
  onPlay: () => void;
  onPause: () => void;
  onRewind: () => void;
  onAdvance: () => void;
  onReset: () => void;
  onFullscreen: () => void;
}

export function AlgorithmLabControls({
  phase,
  hasRuns,
  currentStepIndex,
  finalStepIndex,
  onPlay,
  onPause,
  onRewind,
  onAdvance,
  onReset,
  onFullscreen,
}: AlgorithmLabControlsProps) {
  const running = phase === 'running';
  return (
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-[var(--a3-border)] px-3 py-2 sm:px-4">
      <div className="flex items-center gap-1.5" role="group" aria-label="实验播放控制">
        <ControlButton aria-label="播放" title="播放" onClick={onPlay} disabled={running || phase === 'submitted'}>
          <Play className="size-4" fill="currentColor" />
        </ControlButton>
        <ControlButton aria-label="暂停" title="暂停" onClick={onPause} disabled={!running}>
          <Pause className="size-4" fill="currentColor" />
        </ControlButton>
        <ControlButton aria-label="上一步" title="上一步" onClick={onRewind} disabled={!hasRuns || currentStepIndex <= 0}>
          <SkipBack className="size-4" />
        </ControlButton>
        <ControlButton aria-label="下一步" title="下一步" onClick={onAdvance} disabled={!hasRuns || currentStepIndex >= finalStepIndex}>
          <SkipForward className="size-4" />
        </ControlButton>
        <ControlButton aria-label="重置" title="重置" onClick={onReset}>
          <RotateCcw className="size-4" />
        </ControlButton>
      </div>

      <div className="flex items-center gap-3 text-xs text-[var(--a3-text-muted)]">
        <span aria-live="polite">步骤 {hasRuns ? currentStepIndex + 1 : 0} / {hasRuns ? finalStepIndex + 1 : 0}</span>
        <ControlButton aria-label="全屏画布" title="全屏画布" onClick={onFullscreen}>
          <Expand className="size-4" />
        </ControlButton>
      </div>
    </div>
  );
}

function ControlButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="inline-flex size-9 items-center justify-center rounded-md text-[var(--a3-text)] transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-35 dark:hover:bg-amber-950/50"
      {...props}
    >
      {children}
    </button>
  );
}
