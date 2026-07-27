'use client';

import { Check, Loader2, MessageSquareHeart, RefreshCw, Star } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { cn } from '@/lib/utils';

export const TUTOR_FEEDBACK_TAGS = [
  '讲解清楚',
  '节奏合适',
  '帮助理解',
  '仍然困惑',
] as const;

type TutorFeedbackTag = (typeof TUTOR_FEEDBACK_TAGS)[number];

type TutorFeedback = {
  rating: number;
  tags: TutorFeedbackTag[];
  personaId: string;
  createdAt: string;
  updatedAt: string;
};

type TutorFeedbackResponse = {
  success: boolean;
  error?: string;
  feedback: TutorFeedback | null;
};

type FeedbackSession = {
  id?: string;
  status?: string;
};

type TutorFeedbackPanelViewProps = {
  sessionId: string;
  rating: number;
  tags: readonly string[];
  loading: boolean;
  submitting: boolean;
  existing: boolean;
  loadError: string;
  submitError: string;
  successMessage: string;
  onRatingChange: (rating: number) => void;
  onTagToggle: (tag: TutorFeedbackTag) => void;
  onSubmit: () => void;
  onRetryLoad: () => void;
  onRetrySubmit: () => void;
};

export function isTutorFeedbackVisible(session: FeedbackSession | null) {
  return session?.status === 'ended';
}

export function loadTutorFeedback(sessionId: string) {
  return a3GetJson<TutorFeedbackResponse>(feedbackEndpoint(sessionId));
}

export function saveTutorFeedback(sessionId: string, rating: number, tags: TutorFeedbackTag[]) {
  return a3PostJson<TutorFeedbackResponse>(feedbackEndpoint(sessionId), { rating, tags });
}

function feedbackEndpoint(sessionId: string) {
  return `/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/tutor-feedback/`;
}

export function TutorFeedbackPanel({ sessionId }: { sessionId: string }) {
  return <TutorFeedbackSessionPanel key={sessionId || 'missing'} sessionId={sessionId} />;
}

function TutorFeedbackSessionPanel({ sessionId }: { sessionId: string }) {
  const [rating, setRating] = useState(0);
  const [tags, setTags] = useState<TutorFeedbackTag[]>([]);
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [submitting, setSubmitting] = useState(false);
  const [existing, setExisting] = useState(false);
  const [loadError, setLoadError] = useState(
    sessionId ? '' : '缺少辅导会话 ID，请重新选择已结束的会话。',
  );
  const [submitError, setSubmitError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    const requestGeneration = ++requestGenerationRef.current;
    if (!sessionId) {
      return () => { requestGenerationRef.current += 1; };
    }
    void loadTutorFeedback(sessionId).then((result) => {
      if (requestGeneration !== requestGenerationRef.current) return;
      setLoading(false);
      if (!result.success) {
        setLoadError(result.error || '反馈暂时无法加载，请检查登录状态或网络后重试。');
        return;
      }
      if (result.feedback) {
        setRating(result.feedback.rating);
        setTags(result.feedback.tags.filter(isTutorFeedbackTag));
        setExisting(true);
      }
    });
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [reloadKey, sessionId]);

  function toggleTag(tag: TutorFeedbackTag) {
    setSuccessMessage('');
    setTags((selected) => (
      selected.includes(tag)
        ? selected.filter((item) => item !== tag)
        : TUTOR_FEEDBACK_TAGS.filter((item) => item === tag || selected.includes(item))
    ));
  }

  async function submit() {
    if (!sessionId) {
      setSubmitError('缺少辅导会话 ID，请重新选择已结束的会话。');
      return;
    }
    if (rating < 1 || rating > 5) {
      setSubmitError('请先选择 1 到 5 星评分。');
      return;
    }
    const requestGeneration = requestGenerationRef.current;
    const wasExisting = existing;
    setSubmitting(true);
    setSubmitError('');
    setSuccessMessage('');
    const result = await saveTutorFeedback(sessionId, rating, tags);
    if (requestGeneration !== requestGenerationRef.current) return;
    setSubmitting(false);
    if (!result.success || !result.feedback) {
      setSubmitError(result.error || '反馈提交失败，请检查登录状态或网络后重试。');
      return;
    }
    setRating(result.feedback.rating);
    setTags(result.feedback.tags.filter(isTutorFeedbackTag));
    setExisting(true);
    setSuccessMessage(wasExisting ? '反馈已更新' : '反馈已提交');
  }

  return (
    <TutorFeedbackPanelView
      sessionId={sessionId}
      rating={rating}
      tags={tags}
      loading={loading}
      submitting={submitting}
      existing={existing}
      loadError={loadError}
      submitError={submitError}
      successMessage={successMessage}
      onRatingChange={(value) => {
        setRating(value);
        setSubmitError('');
        setSuccessMessage('');
      }}
      onTagToggle={toggleTag}
      onSubmit={() => void submit()}
      onRetryLoad={() => {
        setLoading(true);
        setLoadError('');
        setReloadKey((value) => value + 1);
      }}
      onRetrySubmit={() => void submit()}
    />
  );
}

export function TutorFeedbackPanelView({
  sessionId,
  rating,
  tags,
  loading,
  submitting,
  existing,
  loadError,
  submitError,
  successMessage,
  onRatingChange,
  onTagToggle,
  onSubmit,
  onRetryLoad,
  onRetrySubmit,
}: TutorFeedbackPanelViewProps) {
  return (
    <section
      data-testid="a3-tutor-feedback-panel"
      className="mt-5 border-y border-amber-200 bg-[#fffaf2] px-4 py-5 sm:px-6"
      aria-labelledby="a3-tutor-feedback-title"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-amber-900">
            <MessageSquareHeart className="size-5" aria-hidden="true" />
            <h2 id="a3-tutor-feedback-title" className="text-base font-semibold">这次辅导对你有帮助吗？</h2>
          </div>

          {loading && (
            <div data-testid="a3-tutor-feedback-loading" className="mt-4 flex min-h-10 items-center gap-2 text-sm text-amber-800" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              正在读取已有反馈
            </div>
          )}
          <fieldset className="mt-4" disabled={loading || submitting}>
            <legend className="text-sm font-medium text-amber-950">辅导评分</legend>
            <div className="mt-2 flex min-h-10 flex-wrap items-center gap-2">
                {[1, 2, 3, 4, 5].map((value) => (
                  <label key={value} className="relative cursor-pointer">
                    <input
                      type="radio"
                      name={`tutor-feedback-rating-${sessionId || 'missing'}`}
                      value={value}
                      data-testid={`a3-tutor-feedback-rating-${value}`}
                      aria-label={`${value} 星`}
                      checked={rating === value}
                      onChange={() => onRatingChange(value)}
                      className="peer sr-only"
                    />
                    <span className={cn(
                      'inline-flex size-10 items-center justify-center rounded-lg border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-amber-500',
                      rating >= value
                        ? 'border-amber-400 bg-amber-100 text-amber-700'
                        : 'border-amber-200 bg-white text-amber-300 hover:border-amber-400 hover:text-amber-600',
                    )}>
                      <Star className={cn('size-5', rating >= value && 'fill-current')} aria-hidden="true" />
                    </span>
                  </label>
                ))}
            </div>
          </fieldset>

          <div className="mt-3 flex min-h-9 flex-wrap gap-2" role="group" aria-label="辅导反馈标签">
                {TUTOR_FEEDBACK_TAGS.map((tag) => {
                  const selected = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-testid={`a3-tutor-feedback-tag-${tag}`}
                      aria-pressed={selected}
                      disabled={loading || submitting}
                      onClick={() => onTagToggle(tag)}
                      className={cn(
                        'inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500',
                        selected
                          ? 'border-amber-500 bg-amber-100 text-amber-900'
                          : 'border-amber-200 bg-white text-slate-700 hover:border-amber-400',
                      )}
                    >
                      {selected && <Check className="size-3.5" aria-hidden="true" />}
                      {tag}
                    </button>
                  );
                })}
          </div>

          {loadError && (
            <div data-testid="a3-tutor-feedback-error" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-rose-700" role="alert">
              <span>{loadError}</span>
              {sessionId && !submitting && (
                <button data-testid="a3-tutor-feedback-load-retry" type="button" onClick={onRetryLoad} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  重新读取
                </button>
              )}
            </div>
          )}
          {submitError && (
            <div data-testid="a3-tutor-feedback-submit-error" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-rose-700" role="alert">
              <span>{submitError}</span>
              {!submitting && rating >= 1 && rating <= 5 && sessionId && (
                <button data-testid="a3-tutor-feedback-submit-retry" type="button" onClick={onRetrySubmit} className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  重试提交
                </button>
              )}
            </div>
          )}
          {successMessage && (
            <div data-testid="a3-tutor-feedback-success" className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700" role="status">
              <Check className="size-4" aria-hidden="true" />
              {successMessage}
            </div>
          )}
        </div>

        <Button
          type="button"
          data-testid="a3-tutor-feedback-submit"
          disabled={loading || submitting || rating < 1 || rating > 5 || !sessionId}
          onClick={onSubmit}
          className="min-w-28 bg-amber-700 text-white hover:bg-amber-800"
        >
          {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {submitting ? '提交中' : existing ? '更新反馈' : '提交反馈'}
        </Button>
      </div>
    </section>
  );
}

function isTutorFeedbackTag(value: string): value is TutorFeedbackTag {
  return TUTOR_FEEDBACK_TAGS.includes(value as TutorFeedbackTag);
}
