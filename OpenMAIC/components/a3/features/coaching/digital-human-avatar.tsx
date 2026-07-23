'use client';

import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';
import type { A3DigitalHumanAvatarProps } from '@/lib/a3/digital-human-types';

const DigitalHumanThreeStage = dynamic(
  () => import('./digital-human-three-stage').then((module) => module.DigitalHumanThreeStage),
  {
    ssr: false,
    loading: DigitalHumanStageLoading,
  },
);

function DigitalHumanStageLoading() {
  return (
    <div
      data-testid="a3-digital-human-three-stage"
      data-avatar-renderer="loading"
      role="status"
      aria-label="数字助教加载中"
      className="relative z-10 flex h-[420px] w-full max-w-[820px] items-center justify-center bg-transparent md:h-[500px] xl:h-[560px]"
    >
      <span className="rounded-full border border-white/20 bg-slate-950/40 px-4 py-2 text-xs text-white backdrop-blur-lg">
        数字助教加载中
      </span>
    </div>
  );
}

const stateCopy: Record<string, string> = {
  idle: '待开始',
  connecting: '连接中',
  listening: '正在听',
  thinking: '思考中',
  speaking: '讲解中',
  visual_focus: '看画面',
  degraded: '已降级',
  error: '连接异常',
  ended: '已结束',
};

export function DigitalHumanAvatar({
  state,
  mode = 'local_vrm',
  audioLevel,
  assistantSpeaking,
  providerLabel,
  modelLabel,
  fallbackReason,
  speechCues,
  renderSuspended = false,
}: A3DigitalHumanAvatarProps) {
  const displayState = stateCopy[state] || stateCopy.idle;

  return (
    <div
      data-testid="a3-digital-human-avatar"
      data-state={state}
      data-mode={mode}
      className="relative flex h-full min-h-[580px] w-full flex-col items-center justify-center overflow-hidden rounded-[28px] border border-white/60 bg-[linear-gradient(135deg,#dbeafe_0%,#9fb7da_42%,#516b91_100%)] p-5 text-center shadow-[inset_0_-120px_180px_rgba(15,23,42,0.42)] md:p-6"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_28%,rgba(255,255,255,0.34),transparent_24%),radial-gradient(circle_at_82%_22%,rgba(30,64,175,0.20),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(15,23,42,0.26))]" />
      <div className="absolute left-5 top-5 z-20 flex items-center gap-2 rounded-full border border-white/30 bg-slate-950/42 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-xl">
        <span
          className={cn(
            'size-2 rounded-full',
            state === 'speaking'
              ? 'bg-emerald-400'
              : state === 'error'
                ? 'bg-rose-400'
                : 'bg-slate-500',
          )}
        />
        {displayState}
      </div>
      <div className="absolute left-5 top-14 z-20 max-w-[72%] truncate rounded-full border border-white/25 bg-white/18 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-xl md:left-auto md:right-5 md:top-5 md:max-w-[46%]">
        {providerLabel} · {modelLabel}
      </div>

      <DigitalHumanThreeStage
        state={state}
        audioLevel={audioLevel}
        assistantSpeaking={assistantSpeaking}
        speechCues={speechCues}
        renderSuspended={renderSuspended}
      />

      <div className="sr-only">
        <div className="text-base font-semibold text-white">数字助教</div>
        <p className="mt-2 max-w-[560px] text-sm leading-6 text-slate-300">
          {fallbackReason || '实时辅导、知识库证据和视觉帧分析仍由 A3 后端统一处理。'}
        </p>
      </div>
    </div>
  );
}
