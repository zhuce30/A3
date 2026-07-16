import { CheckCircle2, Circle, Loader2, ShieldCheck, Star, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';

type FeedbackAction = 'completed' | 'skipped' | 'favorited';
type FeedbackHandler = (action: FeedbackAction, score?: number | null) => void;

export function ResourceLearningRail({
  resource,
  progress,
  progressLabel,
  steps,
  checkpoints = [],
  feedbackMessage,
  feedbackSaving,
  onFeedback,
  extra,
  onToggleCheckpoint,
  canComplete = true,
  completionScore = null,
  completionHint = '',
}: {
  resource: A3ResourcePackV2Resource;
  progress: number;
  progressLabel: string;
  steps: string[];
  checkpoints?: Array<{ label: string; completed: boolean }>;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: FeedbackHandler;
  extra?: ReactNode;
  onToggleCheckpoint?: (index: number) => void;
  canComplete?: boolean;
  completionScore?: number | null;
  completionHint?: string;
}) {
  return (
    <>
      <RailSection title="学习进度">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-slate-600">{progressLabel}</span>
          <span className="font-semibold text-slate-950">{progress}%</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-blue-600 transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </div>
      </RailSection>

      {steps.length > 0 && (
        <RailSection title="学习步骤">
          <div className="space-y-3">
            {steps.map((step, index) => (
              <div key={`${step}-${index}`} className="flex items-start gap-3 text-sm leading-6 text-slate-700">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-xs font-semibold text-blue-700">{index + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        </RailSection>
      )}

      {checkpoints.length > 0 && (
        <RailSection title="完成标准">
          <div className="space-y-2">
            {checkpoints.map((checkpoint, index) => (
              <button
                key={`${checkpoint.label}-${index}`}
                type="button"
                disabled={!onToggleCheckpoint}
                onClick={() => onToggleCheckpoint?.(index)}
                className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left text-sm leading-6 text-slate-700 transition enabled:hover:bg-slate-50 disabled:cursor-default"
              >
                {checkpoint.completed ? <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-600" /> : <Circle className="mt-1 size-4 shrink-0 text-slate-300" />}
                <span>{checkpoint.label}</span>
              </button>
            ))}
          </div>
        </RailSection>
      )}

      {extra}

      <RailSection title="资料证据">
        <div className="space-y-3">
          {resource.citations.slice(0, 4).map((citation, index) => (
            <div key={`${citation.id ?? citation.title}-${index}`} className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
              <div className="flex items-start gap-2 text-sm font-medium text-slate-900">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-blue-600" />
                <span>{citation.title || `资料 ${index + 1}`}</span>
              </div>
              {citation.snippet && <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{citation.snippet}</p>}
            </div>
          ))}
          {!resource.citations.length && <p className="text-sm leading-6 text-slate-500">当前资源没有可展示的资料证据。</p>}
        </div>
      </RailSection>

      <RailSection title="学习反馈">
        <div className="grid gap-2">
          <Button type="button" onClick={() => onFeedback('completed', completionScore)} disabled={Boolean(feedbackSaving) || !canComplete} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="a3-resource-feedback-completed">
            {feedbackSaving === 'completed' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            完成学习
          </Button>
          <Button type="button" variant="outline" onClick={() => onFeedback('favorited')} disabled={Boolean(feedbackSaving)} className="bg-white" data-testid="a3-resource-feedback-favorited">
            {feedbackSaving === 'favorited' ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}
            收藏资源
          </Button>
          <Button type="button" variant="outline" onClick={() => onFeedback('skipped')} disabled={Boolean(feedbackSaving)} className="bg-white" data-testid="a3-resource-feedback-skipped">
            {feedbackSaving === 'skipped' ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
            暂不学习
          </Button>
        </div>
        {!canComplete && completionHint && <p className="mt-3 text-xs leading-5 text-slate-500">{completionHint}</p>}
        {feedbackMessage && <p className="mt-3 text-xs leading-5 text-emerald-700" data-testid="a3-resource-feedback-message">{feedbackMessage}</p>}
      </RailSection>
    </>
  );
}

export function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
