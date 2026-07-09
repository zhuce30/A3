'use client';

import { Camera, FileSearch, Focus, Loader2, Mic, MonitorUp, Phone, PhoneOff, Radio, ShieldCheck, VolumeX, Waves } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { resolveA3Endpoint } from '@/lib/a3/api-client';
import { cn } from '@/lib/utils';
import type { A3RealtimeEvidence, A3RealtimeStatus } from '@/lib/a3/realtime-coaching-types';
import { useRealtimeCoaching } from './use-realtime-coaching';

const statusCopy: Record<A3RealtimeStatus, string> = {
  idle: '待开始',
  requesting_permission: '正在请求权限',
  connecting: '正在创建会话',
  live: '实时通话中',
  visual_focus: '正在理解画面',
  degraded: '已降级，可继续录音/文字辅导',
  ending: '正在生成总结',
  ended: '通话已结束',
  error: '连接失败',
};

export function RealtimeCoachingCall() {
  const realtime = useRealtimeCoaching();
  const {
    cameraEnabled,
    cameraVideoRef,
    captureFrame,
    end,
    endWithoutSummary,
    error,
    evidence,
    audioLevel,
    assistantSpeaking,
    interruptAssistant,
    microphoneEnabled,
    retrieveEvidence,
    retrievalProgress,
    screenEnabled,
    screenVideoRef,
    session,
    shareScreen,
    setToolQuery,
    start,
    status,
    summary,
    toggleCamera,
    toggleMic,
    toolQuery,
    transcript,
  } = realtime;
  const provider = session?.provider || 'local_fallback_record_then_respond';
  const fallbackReason = session?.fallbackReason;

  const evidenceQueryFallback = session?.instructions.targetTitle || '当前知识点';

  return (
    <section data-testid="a3-realtime-coaching-call" className="overflow-hidden rounded-2xl border border-slate-200 bg-[var(--a3-surface-solid)] shadow-[0_24px_70px_rgba(15,23,42,0.10)]">
      <div className="flex flex-col gap-4 border-b border-slate-200 bg-slate-50/80 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex size-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-[0_10px_24px_rgba(37,99,235,0.22)]">
              <Radio className="size-5" />
            </span>
            <div>
              <h2 className="text-xl font-semibold text-[var(--a3-text)]">实时面对面辅导</h2>
              <div data-testid="a3-realtime-status" className="mt-1 text-sm text-[var(--a3-text-muted)]">
                {statusCopy[status]} · {provider} · {session?.model || '未连接'}
              </div>
            </div>
          </div>
          {fallbackReason && (
            <p className="mt-3 max-w-3xl rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
              {fallbackReason}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button data-testid="a3-realtime-start" type="button" onClick={start} disabled={status === 'connecting' || status === 'live'}>
            <Phone className="size-4" />
            开始
          </Button>
          <Button data-testid="a3-realtime-end-summary" type="button" variant="outline" onClick={end} disabled={status === 'idle' || status === 'ended' || status === 'ending'}>
            <PhoneOff className="size-4" />
            结束并总结
          </Button>
          <Button data-testid="a3-realtime-end-only" type="button" variant="outline" onClick={endWithoutSummary} disabled={status === 'idle' || status === 'ended' || status === 'ending'}>
            <PhoneOff className="size-4" />
            只结束
          </Button>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="bg-slate-950 p-5 text-white">
          <div className="relative flex min-h-[620px] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#080f1f] shadow-inner">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgba(37,99,235,0.30),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0),rgba(2,6,23,0.78))]" />
            <div className="absolute inset-x-8 top-20 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent" />
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill active={microphoneEnabled}>麦克风</Pill>
                <Pill active={cameraEnabled}>摄像头</Pill>
                <Pill active={screenEnabled}>屏幕共享</Pill>
                <Pill active={status === 'live'}>低延迟</Pill>
              </div>
              <div data-testid="a3-realtime-audio-level" className="min-w-[180px] rounded-full border border-white/10 bg-white/10 px-3 py-2">
                <div className="flex items-center gap-2 text-xs text-slate-200">
                  <span className={cn('size-2 rounded-full', microphoneEnabled ? 'bg-emerald-400' : 'bg-slate-500')} />
                  <span className="shrink-0">输入</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-emerald-400 transition-[width] duration-100"
                      style={{ width: `${Math.max(4, Math.round(audioLevel * 100))}%` }}
                    />
                  </div>
                  <span>{microphoneEnabled ? `${Math.round(audioLevel * 100)}%` : '未开启'}</span>
                </div>
              </div>
            </div>

            <div className="relative z-10 grid flex-1 gap-4 p-5 xl:grid-cols-[minmax(0,1fr)_210px]">
              <div className="relative flex min-h-[420px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] p-6 text-center">
                <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-300">
                  <span className={cn('size-2 rounded-full', status === 'live' ? 'bg-emerald-400' : status === 'error' ? 'bg-rose-400' : 'bg-slate-500')} />
                  {statusCopy[status]}
                </div>
                <div className="absolute right-5 top-5 rounded-full border border-white/10 bg-white/8 px-3 py-1.5 text-xs text-slate-300">
                  {assistantSpeaking ? 'AI 正在回答' : '等待输入'}
                </div>
                <div className={cn('relative flex size-32 items-center justify-center rounded-full bg-blue-600 text-5xl font-bold shadow-[0_0_90px_rgba(37,99,235,0.46)] transition-transform duration-200', assistantSpeaking && 'scale-105')}>
                  {assistantSpeaking && <span className="absolute inset-[-16px] rounded-full border border-blue-300/40" />}
                  AI
                </div>
                <div className="mt-7 flex items-center gap-2 text-sm font-medium text-slate-100">
                  <Waves className="size-4 text-blue-300" />
                  多模态实时辅导
                </div>
                <p className="mt-3 max-w-[560px] text-sm leading-6 text-slate-300">
                  语音、屏幕画面、知识库证据和视觉帧会合并为同一次会话上下文。
                </p>
                <div className="mt-6 grid w-full max-w-[560px] gap-2 text-xs text-slate-300 sm:grid-cols-3">
                  <span className="rounded-xl border border-white/10 bg-white/8 px-3 py-2">回答可打断</span>
                  <span className="rounded-xl border border-white/10 bg-white/8 px-3 py-2">证据可追溯</span>
                  <span className="rounded-xl border border-white/10 bg-white/8 px-3 py-2">不保存原始视频</span>
                </div>
              </div>
              <div className="grid gap-3">
                <PreviewTile active={cameraEnabled} label="摄像头">
                  <video
                    ref={cameraVideoRef}
                    data-testid="a3-realtime-camera-preview"
                    autoPlay
                    playsInline
                    muted
                    className={cn('size-full rounded-xl bg-black object-cover', !cameraEnabled && 'opacity-40')}
                  />
                </PreviewTile>
                <PreviewTile active={screenEnabled} label="屏幕">
                  <video
                    ref={screenVideoRef}
                    data-testid="a3-realtime-screen-preview"
                    autoPlay
                    playsInline
                    muted
                    className={cn('size-full rounded-xl bg-black object-cover', !screenEnabled && 'opacity-40')}
                  />
                </PreviewTile>
              </div>
            </div>

            <div className="relative z-10 border-t border-white/10 bg-slate-950/70 px-5 py-4">
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={toggleMic}>
                  <Mic className="size-4" />
                  {microphoneEnabled ? '关闭麦克风' : '开启麦克风'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={toggleCamera}>
                  <Camera className="size-4" />
                  {cameraEnabled ? '关闭摄像头' : '开启摄像头'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={shareScreen}>
                  <MonitorUp className="size-4" />
                  {screenEnabled ? '停止共享' : '共享屏幕'}
                </Button>
                <Button
                  data-testid="a3-realtime-capture-frame"
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={captureFrame}
                  title="截取当前摄像头或共享屏幕画面，并调用视觉模型分析"
                >
                  <Focus className="size-4" />
                  看这里/截屏分析
                </Button>
                <Button data-testid="a3-realtime-interrupt" type="button" variant="secondary" size="sm" onClick={interruptAssistant} disabled={status !== 'live' && !assistantSpeaking}>
                  <VolumeX className="size-4" />
                  打断AI
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4 bg-slate-50/70 p-5">
          {summary && <SummaryCard summary={summary} />}
          <div className="rounded-xl border border-slate-200 bg-[var(--a3-surface-solid)] p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--a3-text)]">实时知识库证据</div>
                <p className="mt-1 text-xs text-[var(--a3-text-muted)]">检索文本 chunk 与 visual_vector 缩略图证据。</p>
              </div>
              <ShieldCheck className="size-5 text-emerald-600" />
            </div>
            <div className="mt-3 flex gap-2">
              <input
                aria-label="实时检索问题"
                data-testid="a3-realtime-retrieval-input"
                value={toolQuery}
                onChange={(event) => setToolQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') retrieveEvidence(event.currentTarget.value);
                }}
                placeholder="输入要检索的知识点"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
              <Button data-testid="a3-realtime-retrieval-submit" type="button" size="sm" variant="outline" disabled={retrievalProgress.status === 'running'} onClick={() => retrieveEvidence(toolQuery || evidenceQueryFallback)}>
                {retrievalProgress.status === 'running' ? <Loader2 className="size-4 animate-spin" /> : <FileSearch className="size-4" />}
                {retrievalProgress.status === 'running' ? '检索中' : '检索'}
              </Button>
            </div>
            <div
              data-testid="a3-qa-retrieval-progress"
              className={cn(
                'mt-3 rounded-lg border px-3 py-2 text-xs leading-5',
                retrievalProgress.status === 'failed'
                  ? 'border-rose-200 bg-rose-50 text-rose-700'
                  : retrievalProgress.status === 'succeeded'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-blue-100 bg-blue-50 text-blue-700',
              )}
            >
              {retrievalProgress.status === 'idle' ? '正在检索本地资料前，会先展示检索阶段和命中数量。' : retrievalProgress.message}
            </div>
            <EvidenceList evidence={evidence} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-[var(--a3-surface-solid)] p-4 shadow-sm">
            <div className="text-sm font-semibold text-[var(--a3-text)]">实时字幕与事件</div>
            <div className="mt-3 max-h-[300px] space-y-2 overflow-auto text-sm">
              {transcript.length ? transcript.slice(-6).map((item) => (
                <div key={item.id} className="rounded-lg bg-[var(--a3-surface-muted)] px-3 py-2 text-[var(--a3-text-muted)]">
                  <span className="font-medium text-[var(--a3-text)]">{item.role === 'assistant' ? 'AI' : item.role === 'user' ? '你' : '系统'}：</span>
                  {item.content}
                </div>
              )) : (
                <p className="rounded-lg bg-[var(--a3-surface-muted)] px-3 py-2 text-[var(--a3-text-muted)]">开始通话后，这里显示 provider 状态、字幕和工具调用结果。</p>
              )}
            </div>
            {error && <p data-testid="a3-realtime-error" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function SummaryCard({ summary }: { summary: {
  questionCount?: number;
  assistantReplyCount?: number;
  verifiedReplyCount?: number;
  citationCount?: number;
  visualEvidenceCount?: number;
  latestQuestions?: string[];
  recommendedReviewTasks?: Array<{ title?: string; href?: string; reason?: string }>;
  nextAction?: { label?: string; href?: string; reason?: string };
  generatedAt?: string;
} }) {
  const nextHref = summary.nextAction?.href || '/a3/today';
  return (
    <div data-testid="a3-realtime-summary" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-emerald-900">本次实时辅导总结</div>
          <p className="mt-1 text-xs leading-5 text-emerald-800">
            结束并总结后生成，已写入当前辅导会话。
          </p>
        </div>
        <ShieldCheck className="size-5 shrink-0 text-emerald-600" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Metric label="提问" value={summary.questionCount ?? 0} />
        <Metric label="已验证回答" value={summary.verifiedReplyCount ?? 0} />
        <Metric label="引用来源" value={summary.citationCount ?? 0} />
        <Metric label="视觉证据" value={summary.visualEvidenceCount ?? 0} />
      </div>
      {summary.latestQuestions?.length ? (
        <div className="mt-3 rounded-lg bg-white/70 p-3">
          <div className="text-xs font-medium text-emerald-900">最近问题</div>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-emerald-800">
            {summary.latestQuestions.slice(-3).map((question, index) => <li key={`${question}-${index}`}>· {question}</li>)}
          </ul>
        </div>
      ) : null}
      {summary.nextAction?.label && (
        <a href={nextHref} className="mt-3 inline-flex h-9 items-center rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700">
          {summary.nextAction.label}
        </a>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-white/75 px-3 py-2">
      <div className="text-lg font-semibold text-emerald-950">{value}</div>
      <div className="mt-0.5 text-emerald-700">{label}</div>
    </div>
  );
}

function Pill({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span className={cn('rounded-full px-3 py-1 text-xs font-medium', active ? 'bg-emerald-400 text-slate-950' : 'bg-white/10 text-slate-300')}>
      {children}
    </span>
  );
}

function PreviewTile({ active, label, children }: { active: boolean; label: string; children: ReactNode }) {
  return (
    <div className="relative min-h-[160px] overflow-hidden rounded-2xl border border-white/10 bg-black">
      <div className="absolute left-3 top-3 z-10 rounded-full bg-slate-950/75 px-3 py-1 text-xs font-medium text-white">
        {label}
      </div>
      {children}
      {!active && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/72 text-xs text-slate-300">
          未开启
        </div>
      )}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: A3RealtimeEvidence[] }) {
  if (!evidence.length) {
    return <div className="mt-3 rounded-lg border border-dashed border-slate-300 p-3 text-sm text-[var(--a3-text-muted)]">暂无实时证据。开始检索后会展示引用和 previewUrl 缩略图。</div>;
  }
  return (
    <div className="mt-3 space-y-2" data-testid="a3-realtime-evidence-list">
      {evidence.slice(0, 5).map((item, index) => (
        <div key={`${item.title}-${index}`} className="flex gap-3 rounded-lg border border-slate-200 bg-white p-2">
          {item.previewUrl ? (
            <img src={resolvePreviewUrl(item.previewUrl)} alt="" className="h-16 w-24 shrink-0 rounded-md border border-slate-200 object-cover" />
          ) : (
            <div className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs text-slate-500">文本</div>
          )}
          <div className="min-w-0">
            <div className="line-clamp-1 text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
            <div className="mt-1 text-xs text-blue-700">{item.sourceType || 'text'} · {item.location || '本地知识库'}</div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.snippet}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function resolvePreviewUrl(previewUrl: string) {
  if (/^https?:\/\//i.test(previewUrl) || previewUrl.startsWith('data:image/')) return previewUrl;
  return resolveA3Endpoint(previewUrl);
}
