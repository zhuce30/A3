'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileQuestion, Loader2, RefreshCw, Search, ShieldCheck, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type QuestionEvidence = {
  resourceTitle: string;
  pageNumber: number | null;
  previewUrl: string;
  quote: string;
  modality: string;
  score: number;
};

type QuestionBankItem = {
  id: string;
  stem: string;
  options: Array<{ key: string; text: string }>;
  correctAnswer: string;
  explanation: string;
  difficulty: number;
  knowledgePoint: { title: string; chapter: string };
  sourceType: string;
  reviewStatus: string;
  scope: string;
  qualityScore: number;
  sourceResourceTitle: string;
  evidence: QuestionEvidence[];
  metadata?: {
    questionKind?: string;
    generationReason?: string;
    profileSignals?: {
      foundationLevel?: string;
      weakPoints?: string[];
      recentErrorCauses?: string[];
      learningGoals?: string[];
      expectedResources?: string[];
    };
    sourceEvidence?: Array<{ resourceTitle?: string; quote?: string }>;
    [key: string]: unknown;
  };
};

type QuestionBankResponse = A3ApiResponse<{
  questions: QuestionBankItem[];
  summary: {
    count: number;
    autoVerified: number;
    approved: number;
    rejected: number;
  };
}>;

type ReviewResponse = A3ApiResponse<{ question: QuestionBankItem }>;

type BatchReviewResponse = A3ApiResponse<{
  action: 'approve' | 'reject';
  processedCount: number;
  failedCount: number;
  questions: QuestionBankItem[];
  failures: Array<{ id: string; error: string }>;
}>;

type GenerateResponse = A3ApiResponse<{
  traceId?: string;
  job: {
    id: string;
    status: string;
    requestedCount: number;
    generatedCount: number;
    verifiedCount: number;
    rejectedCount: number;
    error?: string;
  };
}>;

const statusLabels: Record<string, string> = {
  auto_verified: '自动验证',
  approved: '已审核',
  rejected: '已拒绝',
  draft: '草稿',
  disabled: '已停用',
};

const sourceLabels: Record<string, string> = {
  seeded: '标准题库',
  teacher: '教师录入',
  kb_generated: '知识库生成',
  personal_generated: '个人资料生成',
  variant: '错题变式',
};

export function QuestionBankReviewPanel() {
  const [status, setStatus] = useState('auto_verified');
  const [questionKind, setQuestionKind] = useState('all');
  const [questions, setQuestions] = useState<QuestionBankItem[]>([]);
  const [summary, setSummary] = useState<QuestionBankResponse['summary'] | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState('');
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([]);
  const [reviewReason, setReviewReason] = useState('');
  const [batchReviewAction, setBatchReviewAction] = useState<'' | 'approve' | 'reject'>('');
  const [resourceId, setResourceId] = useState('');
  const [knowledgePointId, setKnowledgePointId] = useState('');
  const [generating, setGenerating] = useState(false);

  const loadQuestions = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ limit: '30' });
    if (status !== 'all') query.set('status', status);
    if (questionKind !== 'all') query.set('questionKind', questionKind);
    const result = await a3GetJson<QuestionBankResponse>(`/api/assessments/questions/?${query.toString()}`);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '题库候选题加载失败');
      return;
    }
    const nextQuestions = result.questions ?? [];
    setQuestions(nextQuestions);
    const reviewableIds = new Set(nextQuestions.filter((question) => question.reviewStatus === 'auto_verified').map((question) => question.id));
    setSelectedQuestionIds((current) => current.filter((id) => reviewableIds.has(id)));
    setSummary(result.summary ?? null);
    setMessage('');
  }, [questionKind, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadQuestions();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadQuestions]);

  async function reviewQuestion(question: QuestionBankItem, action: 'approve' | 'reject') {
    const reason = reviewReason.trim();
    if (!reason) {
      setMessage('请先填写审核理由');
      return;
    }
    setReviewingId(question.id);
    const result = await a3PostJson<ReviewResponse>(`/api/assessments/questions/${question.id}/review/`, {
      action,
      reason,
    });
    setReviewingId('');
    if (!result.success) {
      setMessage(result.error ?? '审核操作失败');
      return;
    }
    setMessage(action === 'approve' ? '已审核通过，题目可进入正式题库。' : '已拒绝，题目不会被抽取。');
    await loadQuestions();
  }

  async function batchReview(action: 'approve' | 'reject') {
    const reason = reviewReason.trim();
    if (!selectedQuestionIds.length) {
      setMessage('请至少选择一道待审核题目');
      return;
    }
    if (!reason) {
      setMessage('请先填写审核理由');
      return;
    }
    if (action === 'reject' && !window.confirm(`确认拒绝已选中的 ${selectedQuestionIds.length} 道题吗？`)) {
      return;
    }
    setBatchReviewAction(action);
    const result = await a3PostJson<BatchReviewResponse>('/api/assessments/questions/batch-review/', {
      questionIds: selectedQuestionIds,
      action,
      reason,
    });
    setBatchReviewAction('');
    if (!result.success) {
      setMessage(result.error ?? '批量审核失败');
      return;
    }
    const failureHint = result.failedCount > 0 ? `，${result.failedCount} 道因状态变化未处理` : '';
    setMessage(`${action === 'approve' ? '批量通过' : '批量拒绝'} ${result.processedCount} 道题${failureHint}`);
    setSelectedQuestionIds([]);
    await loadQuestions();
  }

  async function generateQuestions() {
    setGenerating(true);
    const result = await a3PostJson<GenerateResponse>('/api/assessments/questions/generate/', {
      resourceId: resourceId.trim(),
      knowledgePointId: knowledgePointId.trim(),
      scope: 'teacher',
      count: 5,
    });
    setGenerating(false);
    if (!result.success) {
      setMessage(result.error ?? result.job?.error ?? '生成任务失败');
      return;
    }
    setMessage(`生成任务已完成，验证通过 ${result.job.verifiedCount} 道，trace ${result.traceId ?? '-'}`);
    setStatus('auto_verified');
    await loadQuestions();
  }

  const counts = useMemo(() => ({
    all: summary?.count ?? questions.length,
    autoVerified: summary?.autoVerified ?? 0,
    approved: summary?.approved ?? 0,
    rejected: summary?.rejected ?? 0,
  }), [questions.length, summary]);
  const reviewableQuestions = useMemo(
    () => questions.filter((question) => question.reviewStatus === 'auto_verified'),
    [questions],
  );
  const allReviewableSelected = reviewableQuestions.length > 0
    && reviewableQuestions.every((question) => selectedQuestionIds.includes(question.id));

  function toggleQuestion(questionId: string) {
    setSelectedQuestionIds((current) => current.includes(questionId)
      ? current.filter((id) => id !== questionId)
      : [...current, questionId]);
  }

  function toggleAllReviewable() {
    setSelectedQuestionIds(allReviewableSelected ? [] : reviewableQuestions.map((question) => question.id));
  }

  return (
    <A3Card
      title="题库候选审核"
      subtitle="从知识库生成的候选题必须经过自动验证和教师审核，正式测评只抽已审核题。"
      action={<A3Pill tone={counts.autoVerified > 0 ? 'orange' : 'green'}>{counts.autoVerified} 待审核</A3Pill>}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {[
              ['auto_verified', '待审核'],
              ['approved', '已审核'],
              ['rejected', '已拒绝'],
              ['all', '全部'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatus(value)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium ${status === value ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'}`}
              >
                {label}
              </button>
            ))}
            <select
              aria-label="筛选题型"
              value={questionKind}
              onChange={(event) => setQuestionKind(event.target.value)}
              className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            >
              <option value="all">全部题型</option>
              {Object.entries(questionKindLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => void loadQuestions()} disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="min-w-0 flex-1">
                <span className="text-xs font-semibold text-slate-700">审核理由</span>
                <textarea
                  value={reviewReason}
                  onChange={(event) => setReviewReason(event.target.value.slice(0, 500))}
                  placeholder="填写判断依据，例如：答案唯一、解析完整、证据与题干一致"
                  rows={2}
                  className="mt-1 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-5 text-slate-800 outline-none focus:border-blue-400"
                />
              </label>
              <div className="flex flex-wrap items-center gap-2 lg:pb-0.5">
                <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={allReviewableSelected}
                    onChange={toggleAllReviewable}
                    disabled={!reviewableQuestions.length || Boolean(batchReviewAction)}
                    className="size-4 rounded border-slate-300 text-blue-600"
                  />
                  全选待审核
                </label>
                <Button
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={Boolean(batchReviewAction) || !selectedQuestionIds.length || !reviewReason.trim()}
                  onClick={() => void batchReview('approve')}
                >
                  {batchReviewAction === 'approve' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  批量通过 ({selectedQuestionIds.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-rose-200 text-rose-700 hover:bg-rose-50"
                  disabled={Boolean(batchReviewAction) || !selectedQuestionIds.length || !reviewReason.trim()}
                  onClick={() => void batchReview('reject')}
                >
                  {batchReviewAction === 'reject' ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}
                  批量拒绝
                </Button>
              </div>
            </div>
            <div className="mt-1 text-right text-xs text-slate-400">{reviewReason.length}/500</div>
          </div>

          {message && <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-700">{message}</div>}

          <div className="space-y-3">
            {loading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
                <Loader2 className="mr-2 inline size-4 animate-spin" />
                正在读取候选题
              </div>
            ) : questions.length === 0 ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
                当前筛选下没有候选题。先从已索引知识库资源生成题目，或切换到其他审核状态。
              </div>
            ) : questions.map((question) => (
              <QuestionReviewRow
                key={question.id}
                question={question}
                reviewing={reviewingId === question.id}
                disabled={Boolean(batchReviewAction)}
                selected={selectedQuestionIds.includes(question.id)}
                canReview={Boolean(reviewReason.trim())}
                onToggle={() => toggleQuestion(question.id)}
                onApprove={() => reviewQuestion(question, 'approve')}
                onReject={() => reviewQuestion(question, 'reject')}
              />
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Search className="size-4 text-blue-600" />
              从知识库生成
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              填入已索引资源 ID 后生成教师候选题。没有模型 Key 或没有证据时任务会失败，不会创建假题。
            </p>
            <input
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
              placeholder="资源 ID"
              className="mt-3 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
            />
            <input
              value={knowledgePointId}
              onChange={(event) => setKnowledgePointId(event.target.value)}
              placeholder="知识点 ID，可选"
              className="mt-2 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
            />
            <Button className="mt-3 w-full bg-blue-600 hover:bg-blue-700" disabled={generating || !resourceId.trim()} onClick={() => void generateQuestions()}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : <FileQuestion className="size-4" />}
              生成候选题
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ReviewMetric label="待审核" value={counts.autoVerified} />
            <ReviewMetric label="已审核" value={counts.approved} />
            <ReviewMetric label="已拒绝" value={counts.rejected} />
            <ReviewMetric label="当前列表" value={counts.all} />
          </div>
        </div>
      </div>
    </A3Card>
  );
}

function QuestionReviewRow({
  question,
  reviewing,
  disabled,
  selected,
  canReview,
  onToggle,
  onApprove,
  onReject,
}: {
  question: QuestionBankItem;
  reviewing: boolean;
  disabled: boolean;
  selected: boolean;
  canReview: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const primaryEvidence = question.evidence?.[0];
  const questionKind = String(question.metadata?.questionKind ?? '');
  const profileSignals = question.metadata?.profileSignals;
  const weakPoints = profileSignals?.weakPoints ?? [];
  const recentErrorCauses = profileSignals?.recentErrorCauses ?? [];
  const generationReason = String(question.metadata?.generationReason ?? '');
  return (
    <div data-testid="a3-question-bank-review-row" className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          {question.reviewStatus === 'auto_verified' ? (
            <input
              type="checkbox"
              aria-label={`选择题目：${question.stem}`}
              checked={selected}
              onChange={onToggle}
              disabled={reviewing || disabled}
              className="mt-1 size-4 shrink-0 rounded border-slate-300 text-blue-600"
            />
          ) : null}
          <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <A3Pill tone={question.reviewStatus === 'auto_verified' ? 'orange' : question.reviewStatus === 'approved' ? 'green' : 'slate'}>
              {statusLabels[question.reviewStatus] ?? question.reviewStatus}
            </A3Pill>
            <A3Pill tone="blue">{sourceLabels[question.sourceType] ?? question.sourceType}</A3Pill>
            {questionKind ? <A3Pill tone="violet">{questionKindLabels[questionKind] ?? questionKind}</A3Pill> : null}
            <span className="text-xs text-slate-500">{question.knowledgePoint.chapter} / {question.knowledgePoint.title}</span>
          </div>
          <div className="mt-3 text-sm font-semibold leading-6 text-slate-950">{question.stem}</div>
          <div className="mt-2 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
            {question.options.map((option) => (
              <div key={option.key} className={`rounded-lg border px-3 py-2 ${question.correctAnswer === option.key ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-50'}`}>
                {option.key}. {option.text}
              </div>
            ))}
          </div>
          </div>
        </div>
        {question.reviewStatus === 'auto_verified' && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" disabled={reviewing || disabled || !canReview} onClick={onApprove}>
              {reviewing ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              通过并转正式题
            </Button>
            <Button size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50" disabled={reviewing || disabled || !canReview} onClick={onReject}>
              <XCircle className="size-4" />
              拒绝
            </Button>
          </div>
        )}
      </div>

      {(generationReason || questionKind || weakPoints.length || recentErrorCauses.length || profileSignals?.foundationLevel) && (
        <div data-testid="a3-question-bank-kind" className="mt-3 rounded-lg border border-violet-100 bg-violet-50/70 p-3 text-xs leading-5 text-slate-700">
          <div className="font-semibold text-slate-900">个性化生成依据</div>
          {generationReason ? <p className="mt-1">{generationReason}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {questionKind ? <A3Pill tone="violet">题型：{questionKindLabels[questionKind] ?? questionKind}</A3Pill> : null}
            {profileSignals?.foundationLevel ? <A3Pill tone="blue">基础：{profileSignals.foundationLevel}</A3Pill> : null}
            {weakPoints.slice(0, 3).map((item) => (
              <A3Pill key={`weak-${question.id}-${item}`} tone="orange">薄弱点：{item}</A3Pill>
            ))}
            {recentErrorCauses.slice(0, 2).map((item) => (
              <A3Pill key={`cause-${question.id}-${item}`} tone="red">错因：{item}</A3Pill>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        <div className="flex items-center gap-2 font-semibold text-slate-800">
          <ShieldCheck className="size-4 text-emerald-600" />
          解析与证据
        </div>
        <p className="mt-1">{question.explanation}</p>
        {primaryEvidence ? (
          <div className="mt-3 flex gap-3 rounded-lg border border-slate-200 bg-white p-3">
            {primaryEvidence.previewUrl ? (
              <img src={resolveA3Endpoint(primaryEvidence.previewUrl)} alt="" className="h-16 w-24 rounded-md border border-slate-200 object-cover" />
            ) : null}
            <div className="min-w-0">
              <div className="font-medium text-slate-800">
                {primaryEvidence.resourceTitle || question.sourceResourceTitle || '知识库证据'}
                {primaryEvidence.pageNumber ? ` · 第 ${primaryEvidence.pageNumber} 页` : ''}
              </div>
              <div className="mt-1 line-clamp-2 text-slate-500">{primaryEvidence.quote}</div>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-orange-700">暂无证据，不能进入正式题库。</div>
        )}
      </div>
    </div>
  );
}

const questionKindLabels: Record<string, string> = {
  concept: '概念辨析',
  scenario: '场景题',
  judgement_correction: '判断纠错',
  application: '应用题',
  wrong_variant: '错题变式',
};

function ReviewMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-950">{value}</div>
    </div>
  );
}
