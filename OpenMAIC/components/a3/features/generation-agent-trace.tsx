'use client';

import { useMemo } from 'react';
import { Bot, CheckCircle2, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { A3Pill } from '@/components/a3/ui/a3-card';
import type { A3AgentTrace, A3AgentTraceStep } from '@/lib/a3/recommendation-types';

// Agent 名 → 中文职责（与 backend/apps/compat/resource_generation.py 的 Agent name 对齐）。
const AGENT_LABELS: Record<string, string> = {
  RetrieverAgent: '知识检索',
  PedagogyAgent: '教学策略设计',
  ResourceSynthesisAgent: '资源合成',
  PracticeGenerationAgent: '练习与实验生成',
  VerifierAgent: '引用与安全校验',
  ResourcePackCommitAgent: '资源包写回',
  ProfileAgent: '画像更新',
  ResourceFeedbackAgent: '资源反馈归集',
  LearningEffectAgent: '学习效果分析',
  LearningEffectAnalyzerAgent: '学习效果分析',
  StudyPlanAgent: '学习计划调整',
  MemoryCommitAgent: '记忆写回',
  A3ResourceBridgeAgent: 'OpenMAIC 课堂桥接',
  A3VideoBridgeAgent: 'OpenMAIC 视频桥接',
  A3PPTXExportBridgeAgent: 'PPTX 导出桥接',
};

// 只展示真实存在的 metadata 键（键名取自各 Agent 的 output_summary / evidence / quality）。
const METRIC_LABELS: Record<string, string> = {
  sourceCount: '检索证据',
  profileDimensionCount: '画像维度',
  profileDimensions: '画像维度',
  resourceCount: '生成资源',
  verifiedResourceCount: '已校验资源',
  citationCount: '引用来源',
  topK: '检索 topK',
  weakPoints: '薄弱点',
  strategy: '策略',
  resourceTypes: '资源类型',
  retrievalMode: '检索模式',
  citationCoverage: '引用覆盖',
  provider: '模型来源',
  model: '模型',
};

const FLAG_LABELS: Record<string, string> = {
  grounded: '有据可依',
  verified: '已校验',
  personalized: '已个性化',
  practiceReady: '练习就绪',
  codeLabReady: '实验就绪',
  coversRequiredSevenTypes: '覆盖七类资源',
  committed: '已写回',
  llmEnhanced: 'LLM 增强',
};

const WARN_FLAG_LABELS: Record<string, string> = {
  fallbackUsed: '降级生成',
  degraded: '降级',
  fallback: '降级',
};

function agentLabel(name: string) {
  return AGENT_LABELS[name] ?? name;
}

/**
 * 把 Agent 的 outputSummary 压成一行中文说明，例如「检索证据 6 · 画像维度 14」。
 * 生成过程中的实时进度条和生成后的 trace 面板共用这套键名映射。
 */
export function summarizeAgentOutput(summary?: Record<string, unknown>): string {
  if (!summary) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(summary)) {
    const label = METRIC_LABELS[key];
    if (!label) continue;
    const value = formatMetricValue(raw);
    if (value === null) continue;
    parts.push(`${label} ${value}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' · ');
}

function formatMetricValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '是' : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? (text.length > 18 ? `${text.slice(0, 18)}…` : text) : null;
  }
  if (Array.isArray(value)) return value.length ? String(value.length) : null;
  return null;
}

type StepMetric = { label: string; value: string };

/** 从真实 step.metadata 里抽出可展示的量化产出，而不是写死文案。 */
function stepMetrics(step: A3AgentTraceStep): StepMetric[] {
  const metadata = step.metadata ?? {};
  const pools: Array<Record<string, unknown> | undefined> = [
    metadata.outputSummary,
    metadata.evidence,
    metadata.quality,
  ];
  const metrics: StepMetric[] = [];
  const seen = new Set<string>();
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const [key, raw] of Object.entries(pool)) {
      const label = METRIC_LABELS[key];
      if (!label || seen.has(label)) continue;
      const value = formatMetricValue(raw);
      if (value === null) continue;
      seen.add(label);
      metrics.push({ label, value });
    }
  }
  return metrics.slice(0, 5);
}

function stepFlags(step: A3AgentTraceStep) {
  const metadata = step.metadata ?? {};
  const pools = [metadata.outputSummary, metadata.evidence, metadata.quality];
  const good = new Set<string>();
  const warn = new Set<string>();
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const [key, raw] of Object.entries(pool)) {
      if (raw === true && FLAG_LABELS[key]) good.add(FLAG_LABELS[key]);
      if (raw === true && WARN_FLAG_LABELS[key]) warn.add(WARN_FLAG_LABELS[key]);
    }
  }
  return { good: [...good].slice(0, 4), warn: [...warn].slice(0, 2) };
}

function statusVisual(status: string) {
  // kernel 记录的成功态是 "completed"（见 agent_kernel.run），"succeeded" 仅为兼容其他来源。
  if (status === 'completed' || status === 'succeeded') {
    return { icon: CheckCircle2, cls: 'text-emerald-600', bar: 'bg-emerald-500' };
  }
  if (status === 'degraded') return { icon: AlertTriangle, cls: 'text-amber-600', bar: 'bg-amber-500' };
  if (status === 'failed') return { icon: XCircle, cls: 'text-rose-600', bar: 'bg-rose-500' };
  return { icon: Clock, cls: 'text-slate-400', bar: 'bg-slate-400' };
}

export function GenerationAgentTrace({
  trace,
  loading = false,
  error = '',
  className = '',
}: {
  trace: A3AgentTrace | null;
  loading?: boolean;
  error?: string;
  className?: string;
}) {
  const steps = useMemo(
    () => [...(trace?.steps ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [trace],
  );
  // 后端 AgentRun.latency_ms 记录的是「自 workflow 启动以来的累计耗时」，
  // 因此单步耗时要用相邻两步的差值还原，否则每根耗时条都会接近满格。
  const durations = useMemo(
    () => steps.reduce<{ values: number[]; previous: number }>((accumulator, step) => {
      const cumulative = Number(step.latencyMs) || 0;
      return {
        values: [...accumulator.values, Math.max(0, cumulative - accumulator.previous)],
        previous: Math.max(accumulator.previous, cumulative),
      };
    }, { values: [], previous: 0 }).values,
    [steps],
  );
  const maxLatency = useMemo(
    () => durations.reduce((max, value) => Math.max(max, value), 0),
    [durations],
  );

  if (loading) {
    return (
      <div
        data-testid="a3-generation-agent-trace"
        className={`rounded-2xl border border-amber-100 bg-[var(--a3-surface-solid)] p-4 text-sm text-[var(--a3-text-muted)] ${className}`}
      >
        正在读取本次生成的 Agent 执行记录…
      </div>
    );
  }

  if (error || !trace || !steps.length) {
    if (!error && !trace) return null;
    return (
      <div
        data-testid="a3-generation-agent-trace"
        className={`rounded-2xl border border-slate-200 bg-[var(--a3-surface-solid)] p-4 text-sm text-[var(--a3-text-muted)] ${className}`}
      >
        {error || '本次生成没有返回可展示的 Agent 执行记录。'}
      </div>
    );
  }

  const totalLatency = Number(trace.latencyMs) || durations.reduce((sum, value) => sum + value, 0);
  const degradedCount = steps.filter((step) => step.status === 'degraded' || step.status === 'failed').length;

  return (
    <div
      data-testid="a3-generation-agent-trace"
      className={`rounded-2xl border border-amber-100 bg-[var(--a3-surface-solid)] p-4 shadow-sm dark:border-amber-900/50 ${className}`}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-amber-400 text-stone-900">
            <Bot className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[var(--a3-text)]">本次生成的 Agent 执行过程</div>
            <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
              {steps.length} 个 Agent 依次协作 · 总耗时 {totalLatency}ms · workflow {trace.workflow}
              {trace.traceId ? ` · trace ${trace.traceId.slice(0, 10)}` : ''}
            </p>
          </div>
        </div>
        <A3Pill tone={degradedCount ? 'orange' : 'green'}>
          {degradedCount ? `${degradedCount} 步降级` : '全部正常'}
        </A3Pill>
      </div>

      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => {
          const visual = statusVisual(step.status);
          const StatusIcon = visual.icon;
          const metrics = stepMetrics(step);
          const flags = stepFlags(step);
          const latency = durations[index] ?? 0;
          const widthPercent = maxLatency > 0 ? Math.max(4, Math.round((latency / maxLatency) * 100)) : 0;
          return (
            <li key={`${step.order}-${step.name}`} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                  {step.order}
                </span>
                <StatusIcon className={`size-4 shrink-0 ${visual.cls}`} />
                <span className="text-sm font-semibold text-[var(--a3-text)]">{agentLabel(step.name)}</span>
                <span className="font-mono text-[11px] text-[var(--a3-text-muted)]">{step.name}</span>
                <span className="ml-auto shrink-0 text-[11px] font-semibold text-[var(--a3-text-muted)]">{latency}ms</span>
              </div>

              {maxLatency > 0 && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                  <div className={`h-full rounded-full ${visual.bar}`} style={{ width: `${widthPercent}%` }} />
                </div>
              )}

              {(metrics.length > 0 || flags.good.length > 0 || flags.warn.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {metrics.map((metric) => (
                    <span key={metric.label} className="rounded-full bg-[var(--a3-surface-solid)] px-2 py-0.5 text-[11px] font-medium text-[var(--a3-text)]">
                      {metric.label} <span className="font-semibold">{metric.value}</span>
                    </span>
                  ))}
                  {flags.good.map((flag) => (
                    <span key={flag} className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {flag}
                    </span>
                  ))}
                  {flags.warn.map((flag) => (
                    <span key={flag} className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      {flag}
                    </span>
                  ))}
                </div>
              )}

              {step.detail && (
                <p className="mt-1.5 text-[11px] leading-5 text-[var(--a3-text-muted)]">{step.detail}</p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
