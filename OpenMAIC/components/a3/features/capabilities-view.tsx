'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowRight, CheckCircle2, Download, Eye, FileJson, Loader2, ShieldCheck, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { trackPageView } from '@/lib/a3/learning-event-client';
import { buildEvaluationTargetStatuses } from '@/lib/a3/evaluation-targets';
import type { A3ApiResponse, StudyPlan } from '@/lib/a3/learning-types';
import { buildOpenMAICEvidenceSummary } from '@/lib/a3/openmaic-evidence-summary';
import { buildOpenMAICHandoffSyncSummary } from '@/lib/a3/openmaic-handoff-sync';
import { A3_OPENMAIC_PAGE_OWNERSHIP, buildOpenMAICPageOwnershipMetrics } from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICVerificationSummary } from '@/lib/a3/openmaic-verification-status';
import { buildResourcePackMetricCards, type ResourcePackMetrics } from '@/lib/a3/resource-pack-metrics';
import type { A3ResourceGenerateResponse, A3ResourcePackV2 } from '@/lib/a3/recommendation-types';
import { A3Card, A3Pill } from '../ui/a3-card';

const OPENMAIC_READABLE_TITLE = '\u004f\u0070\u0065\u006e\u004d\u0041\u0049\u0043 \u63a5\u5165\u603b\u89c8';
const OPENMAIC_READABLE_SUBTITLE = '\u0041\u0033 \u4fdd\u6301\u5b66\u4e60\u8f6f\u4ef6\u4e3b\u6d41\u7a0b\uff0c\u004f\u0070\u0065\u006e\u004d\u0041\u0049\u0043 \u53ea\u4f5c\u4e3a\u8bfe\u5802\u3001\u0050\u0050\u0054\u0058\u3001\u89c6\u9891\u7b49\u80fd\u529b\u5e95\u5ea7\uff1b\u6240\u6709\u4ea7\u7269\u5fc5\u987b\u56de\u5199\u5230 \u0041\u0033 \u8d44\u6e90\u5305\u548c \u0041\u0067\u0065\u006e\u0074 \u0074\u0072\u0061\u0063\u0065\u3002';
const OPENMAIC_READABLE_ROUTE_LABEL = '\u0041\u0033 \u9875\u9762';
const OPENMAIC_READABLE_API_LABEL = '\u63a5\u53e3\u5f52\u5c5e';
const OPENMAIC_READABLE_VERIFY_LABEL = '\u9a8c\u8bc1\u8bc1\u636e';

type DemoStatusResponse = {
  success: boolean;
  error?: string;
  summary: Record<string, boolean>;
  profile: { grade: string; majorDirection: string; foundationLevel: string; weakPoints: string[]; learningGoals: string[] } | null;
  path: { title: string; progress: number; itemCount: number };
  recommendation: {
    count: number;
    sourceCount: number;
    fallbackUsed: boolean;
    fast?: { mode: 'fast'; latencyMs: number; count: number; sourceCount: number; fallbackUsed: boolean };
    deep?: { mode: 'deep'; latencyMs: number; count: number; sourceCount: number; fallbackUsed: boolean | null; available?: boolean; trigger?: string; note?: string };
  };
  verification: { verified: boolean; citationCount: number; claimCount: number; verifiedClaims: number };
  safety: { safe: boolean; category: string; reason: string };
  evaluation: {
    totalCases: number;
    groundedCases: number;
    unsafeCases: number;
    missingEvidenceCases?: number;
    targetCases?: number;
    scaleReady?: boolean;
    latestMetricsFile: string;
    metrics: {
      available: boolean;
      path?: string;
      updatedAt?: string;
      caseCount?: number;
      topK?: number | null;
      retrievalTop1HitRate?: number;
      retrievalTop3HitRate?: number;
      retrievalTop5HitRate?: number;
      verifiedCoverage?: number;
      safetyRefusalRate?: number;
      missingEvidenceRefusalRate?: number;
    };
  };
  apis: Array<{ group: string; method: string; path: string; status: string }>;
  system: { overallStatus: string; checks: Array<{ name: string; status: string; message: string }> };
  agentRuns?: Array<{
    traceId: string;
    detailUrl?: string;
    exportJsonUrl?: string;
    exportMarkdownUrl?: string;
    schemaVersion?: string;
    workflow: string;
    goal: string;
    status: string;
    fallbackStrategy?: string;
    latencyMs: number;
    startedAt?: string;
    completedAt?: string | null;
    metadata?: Record<string, unknown>;
    steps: Array<{
      order?: number;
      name: string;
      role: string;
      status: string;
      detail: string;
      latencyMs: number;
      metadata?: Record<string, unknown>;
    }>;
  }>;
  agentRuntime?: {
    recentRuns: number;
    failedRuns: number;
    contractViolations: number;
    retryPolicies: number;
    retryAttempts: number;
    timedOutSteps: number;
    budgetBreaches?: number;
    slowSteps?: Array<{
      workflow?: string;
      agent?: string;
      status: 'slow' | 'breach' | 'timeout' | string;
      elapsedMs: number;
      timeoutMs: number;
      budgetRatio: number;
    }>;
    fallbackStrategies: Record<string, number>;
    failureRates?: Array<{ workflow: string; runs: number; failedRuns: number; failureRate: number }>;
    agentFailureRates?: Array<{ workflow: string; agent: string; steps: number; failedSteps: number; failureRate: number }>;
    circuitBreakers?: Array<{
      workflow: string;
      agent?: string;
      status: 'open' | 'watch' | string;
      reason: string;
      failureRate: number;
      runs?: number;
      failedRuns?: number;
      steps?: number;
      failedSteps?: number;
    }>;
    latestPolicy?: {
      workflow?: string;
      step?: string;
      maxRetries: number;
      timeoutMs?: number | null;
      attempts: number;
      elapsedMs?: number;
      errors: string[];
    } | null;
  };
  profileInterview?: {
    schemaVersion: string;
    status: 'complete' | 'collecting' | 'not_started' | string;
    turnCount: number;
    latestTraceId: string;
    profileCommitted?: boolean;
    confirmedAt?: string;
    pathAndPlanRefreshed?: boolean;
    generated?: { path?: boolean; studyPlan?: boolean };
    askFields: Array<{ field: string; label: string }>;
    askStrategy: { name?: string; priorityOrder?: string[]; reason?: string };
    missingDimensions: Array<{ field: string; label: string }>;
    nextQuestion: string;
    messageCount: number;
    updatedAt: string;
    detail: string;
  };
  agentWorkflowMetrics?: {
    available: boolean;
    path?: string;
    updatedAt?: string;
    schemaVersion?: string;
    overallStatus?: string;
    workflowCount?: number;
    contractCoverage?: number;
    traceCoverage?: number;
    evidenceSchemaCoverage?: number;
    apiEntryCoverage?: number;
    readyCoverage?: number;
    generatedTraceCount?: number;
    readyWorkflowCount?: number;
    latestTraceIds?: string[];
  };
  multimodalRag?: {
    metrics: {
      available: boolean;
      path?: string;
      updatedAt?: string;
      topK?: number | null;
      resources?: number;
      parsedResources?: number;
      parseSucceededResources?: number;
      visualIndexedEntries?: number;
      textIndexedEntries?: number;
      parseSuccessRate?: number;
      visualCoverage?: number;
      hybridReadyRate?: number;
    };
    visualIndex: {
      available: boolean;
      path: string;
      indexedEntries: number;
      failedEntries: number;
      latestStatus: string;
      backend: string;
      updatedAt: string;
      latestBlockId: string;
    };
  };
  materialKnowledgeGraph?: {
    schemaVersion: string;
    status: string;
    entityCount: number;
    relationCount: number;
    claimCount: number;
    degradedCount: number;
    workflow: string;
    workflowSchemaVersion: string;
    traceId: string;
    lastBuiltAt: string;
    degraded: boolean;
    reason: string;
    markdownEvidence?: {
      contentFormat: string;
      evidenceCount: number;
      mathCount: number;
      tableCount: number;
      rawTextPreserved: boolean;
    };
  };
  questionBankMetrics?: {
    available: boolean;
    path?: string;
    updatedAt?: string;
    source?: string;
    questionCount: number;
    approvedCount: number;
    autoVerifiedCount: number;
    rejectedCount: number;
    generatedCount: number;
    personalQuestionCount: number;
    evidenceCoverage: number;
    verificationPassRate: number;
    formalAssessmentSafe: boolean;
    latestJob?: {
      id: string;
      status: string;
      requestedCount: number;
      generatedCount: number;
      verifiedCount: number;
      rejectedCount: number;
      error?: string;
      updatedAt?: string | null;
    } | null;
  };
  realtimeCoaching?: {
    schemaVersion: string;
    available: boolean;
    latestProvider: string;
    sessionCount: number;
    averageLatencyMs: number;
    ragToolCallCount: number;
    ragHitRate: number;
    visualFrameCount: number;
    verifiedAnswerRate: number;
    fallbackCount: number;
    latestSessionId: string;
  };
  productReadiness?: {
    score: number;
    status: 'market_ready' | 'nearly_ready' | 'needs_work';
    readyCount: number;
    total: number;
    checks: Array<{ key: string; title: string; ready: boolean; detail: string; href: string }>;
    blockers: Array<{ key: string; title: string; ready: boolean; detail: string; href: string }>;
  };
  marketReadiness?: Array<{
    key: string;
    title: string;
    score: number;
    status: 'ready' | 'watch';
    evidence: string;
    nextAction: { label: string; href: string };
  }>;
  learningLoopReadiness?: Array<{
    key: string;
    title: string;
    ready: boolean;
    detail: string;
    evidence: string;
    href: string;
  }>;
  evidenceBoard?: Array<{
    key: string;
    title: string;
    status: string;
    detail: string;
    path: string;
  }>;
  resourcePackMetrics?: ResourcePackMetrics;
  wrongReviewEvidence?: {
    dueWrongCount: number;
    unreadNotificationCount: number;
    insight?: {
      schemaVersion: string;
      headline: string;
      summary: string;
      activeWrongQuestions: number;
      masteredWrongQuestions: number;
      recentKnowledgePoints: string[];
      nextAction: { label: string; href: string; reason: string };
    };
    csvFields: string[];
    links: { notification: string; wrongNotebook: string; report: string };
  };
};

type LearningEffectReportResponse = {
  success: boolean;
  error?: string;
  effectReport?: {
    schemaVersion?: string;
    overallEffectScore?: number;
    confidence?: 'high' | 'medium' | 'low' | string;
    missingEvidence?: string[];
    behavior?: {
      eventCount?: number;
      activeDays?: number;
      taskCompletionRate?: number;
    };
    assessment?: {
      attemptCount?: number;
      correctRate?: number;
      wrongQuestionCount?: number;
    };
    knowledgePoints?: Array<{
      knowledgePointId: string;
      name: string;
      learningGain: number;
      confidence: 'high' | 'medium' | 'low' | string;
      trend: string;
    }>;
    analysis?: {
      schemaVersion?: string;
      summary?: string;
      riskLevel?: 'low' | 'medium' | 'high' | string;
      riskReasons?: Array<{ reason?: string; evidenceKeys?: string[] }>;
      findings?: Array<{ type?: string; targetId?: string; finding?: string; confidence?: string; evidenceKeys?: string[] }>;
      nextIntervention?: { type?: string; reason?: string; targetKnowledgePointId?: string };
    };
    analysisSource?: string;
    analysisDegraded?: boolean;
    analysisDegradedReason?: string;
    planAdjustmentAction?: NonNullable<StudyPlan['lastLearningEffectAdjustment']>;
    agentTrace?: {
      traceId?: string;
      workflow?: string;
      status?: string;
      latencyMs?: number;
      steps?: Array<{ name?: string; status?: string; role?: string; latencyMs?: number; detail?: string }>;
    };
    trends?: {
      sevenDay?: { assessment?: { attemptCount?: number } };
      fourteenDay?: { assessment?: { attemptCount?: number } };
      thirtyDay?: { assessment?: { attemptCount?: number } };
    };
    resourceUsage?: {
      opened?: number;
      completed?: number;
      skipped?: number;
      favorited?: number;
      totalFeedback?: number;
    };
    eventStream?: {
      schemaVersion?: string;
      v2EventCount?: number;
      acceptedCount?: number;
      singleApi?: string;
      batchApi?: string;
      sourcePages?: Array<{ sourcePage?: string; count?: number }>;
    };
    resourceEffectiveness?: number;
    masterySignals?: {
      averageFeedbackScore?: number;
      weakPoints?: string[];
    };
    planExecution?: {
      taskCount?: number;
      completedTasks?: number;
      completionRate?: number;
    };
    planAdjustment?: {
      strategy?: string;
      reason?: string;
      evidence?: {
        opened?: number;
        completed?: number;
        skipped?: number;
        favorited?: number;
        averageFeedbackScore?: number;
        planCompletionRate?: number;
        latestGoal?: string;
      };
      nextAction?: { label: string; href: string; reason?: string };
    };
    optimizationPolicy?: {
      policyVersion?: string;
      decisionId?: string;
      selectedStrategy?: string;
      outcomeStatus?: string;
      selectedCandidate?: {
        decisionScore?: number;
        rankingBasis?: string[];
        expectedMetricDelta?: Record<string, number>;
      };
      candidates?: Array<{ strategy?: string; decisionScore?: number; rankingBasis?: string[] }>;
      successCriteria?: Array<{ metric?: string; target?: number; targetDelta?: number; windowDays?: number }>;
      observedMetricDelta?: Record<string, number>;
      outcomeMetrics?: PolicyOutcomeMetrics;
    };
    updatedAt?: string;
  };
};

type RuntimeStatusResponse = {
  success: boolean;
  error?: string;
  overallStatus?: 'ok' | 'warning' | 'error';
  checks?: Array<{
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    detail?: Record<string, string | boolean | number | Record<string, unknown>>;
  }>;
  openmaicSmokeReport?: {
    available: boolean;
    path: string;
    schemaVersion?: string;
    status: string;
    success: boolean;
    provider?: string;
    checkedAt?: string;
    command?: string;
    reason?: string;
    hasProviderKey?: boolean;
    hasVideoUrl?: boolean;
    duration?: number;
    width?: number;
    height?: number;
    elapsedMs?: number;
  };
};

type PolicyOutcomeMetrics = {
  schemaVersion?: string;
  windowDays?: number;
  resourceTypeGain7d?: Array<{
    resourceType?: string;
    knowledgePointId?: string;
    completed7d?: number;
    opened7d?: number;
    postAssessmentGain7d?: number;
    practiceConversionRate7d?: number;
    historicalEffectiveness7d?: number;
    confidence?: string;
    explorationRecommended?: boolean;
  }>;
  summary?: {
    resourceTypeCount?: number;
    topResourceTypeGain7d?: number;
    effectScore?: number;
  };
};

type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan }>;
type OptimizationPolicyResponse = A3ApiResponse<{
  optimizationPolicy?: NonNullable<LearningEffectReportResponse['effectReport']>['optimizationPolicy'];
  decisionHistory?: Array<NonNullable<LearningEffectReportResponse['effectReport']>['optimizationPolicy'] & { decisionAt?: string; outcomeMetrics?: PolicyOutcomeMetrics }>;
}>;

const capabilityLabels: Record<string, { title: string; href: string; desc: string }> = {
  profileReady: { title: '学习画像', href: '/a3/profile-setup', desc: '年级、基础、目标、薄弱点和资源偏好可结构化沉淀。' },
  pathReady: { title: '学习路径', href: '/a3/learning-path', desc: '按先修关系、薄弱点和学习画像生成路径。' },
  recommendationsReady: { title: '资源推荐', href: '/a3/recommendations', desc: '推荐包含来源、理由、分数和收藏入口。' },
  verifiedQaReady: { title: '引用验证', href: '/a3/classroom', desc: '课堂回答经过 citations、claims 和 verified 校验。' },
  safetyReady: { title: '安全拒答', href: '/a3/coaching', desc: '拦截作弊、隐私、危险和越界请求。' },
  assessmentLoopReady: { title: '测评闭环', href: '/a3/assessment', desc: '测评结果回流错题本、画像和学习计划。' },
};

const readinessStatusLabel: Record<NonNullable<DemoStatusResponse['productReadiness']>['status'], string> = {
  market_ready: '市场级可用',
  nearly_ready: '接近可用',
  needs_work: '仍需补齐',
};

export function buildAgentTraceWorkflowOptions(agentRuns?: DemoStatusResponse['agentRuns']) {
  const workflows = Array.from(new Set((agentRuns ?? []).map((run) => run.workflow).filter(Boolean)));
  return ['all', 'resource_generate', ...workflows.filter((workflow) => workflow !== 'resource_generate')];
}

export function CapabilitiesView() {
  const [data, setData] = useState<DemoStatusResponse | null>(null);
  const [learningEffectReport, setLearningEffectReport] = useState<LearningEffectReportResponse['effectReport'] | null>(null);
  const [optimizationPolicyResponse, setOptimizationPolicyResponse] = useState<OptimizationPolicyResponse | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusResponse | null>(null);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<'validate' | 'evaluate' | 'resource' | 'smokeWriteback' | null>(null);
  const [actionResult, setActionResult] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState('resource_generate');
  const [generatedResourcePack, setGeneratedResourcePack] = useState<A3ResourcePackV2 | null>(null);
  const [smokeWritebackResult, setSmokeWritebackResult] = useState<{
    resourcePackId: string;
    traceId: string;
    videoUrl: string;
  } | null>(null);

  async function load() {
    setLoading(true);
    const [result, effectResult, optimizationResult, planResult, runtimeResult] = await Promise.all([
      a3GetJson<DemoStatusResponse>('/api/demo/status/'),
      a3GetJson<LearningEffectReportResponse>('/api/learning/effect/report/'),
      a3GetJson<OptimizationPolicyResponse>('/api/learning/effect/optimization-policy/?days=30'),
      a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
      fetch('/api/a3/system/runtime', { credentials: 'include', cache: 'no-store' })
        .then((response) => response.json() as Promise<RuntimeStatusResponse>)
        .catch((error) => ({ success: false, error: error instanceof Error ? error.message : 'runtime status unavailable' })),
    ]);
    setLoading(false);
    if (effectResult.success) {
      setLearningEffectReport(effectResult.effectReport ?? null);
    }
    setOptimizationPolicyResponse(optimizationResult.success ? optimizationResult : null);
    if (planResult.success) {
      setStudyPlan(planResult.plan ?? null);
    }
    if (runtimeResult.success) {
      setRuntimeStatus(runtimeResult);
    }
    if (!result.success) {
      setMessage(result.error ?? '能力状态加载失败');
      return;
    }
    setMessage('');
    setData(result);
  }

  async function runValidation() {
    setActionLoading('validate');
    setActionResult('');
    const result = await a3PostJson<{ success: boolean; error?: string; validation?: { overallStatus: string } }>('/api/demo/validate/', {});
    setActionLoading(null);
    if (!result.success) {
      setActionResult(result.error ?? '验收运行失败');
      return;
    }
    setActionResult(`验收结果：${result.validation?.overallStatus ?? 'unknown'}`);
    await load();
  }

  async function runEvaluation() {
    setActionLoading('evaluate');
    setActionResult('正在刷新检索、验证、安全和 Agent workflow 指标。Agent workflow 会真实运行 8 条工作流，通常需要几十秒。');
    const result = await a3PostJson<{
      success: boolean;
      error?: string;
      evaluation?: { metrics?: { retrievalTop3HitRate?: number } };
      agentWorkflowEvaluation?: { overallStatus?: string; generatedTraceIds?: string[]; metrics?: { workflowCount?: number; readyCoverage?: number } };
    }>('/api/demo/evaluate/', { topK: 3, includeAgentWorkflows: true });
    setActionLoading(null);
    if (!result.success) {
      setActionResult(result.error ?? '评测运行失败');
      return;
    }
    const firstTraceId = result.agentWorkflowEvaluation?.generatedTraceIds?.[0];
    setActionResult(
      `评测完成：Top3 ${formatPercent(result.evaluation?.metrics?.retrievalTop3HitRate)}，Agent ${result.agentWorkflowEvaluation?.overallStatus ?? 'skipped'}${firstTraceId ? `，trace ${firstTraceId.slice(0, 10)}` : ''}`
    );
    await load();
  }

  async function runResourceGenerationProbe() {
    setActionLoading('resource');
    setActionResult('');
    const result = await a3PostJson<A3ResourceGenerateResponse>('/api/resources/generate/', {
      goal: 'A3 能力页资源生成评测',
      topK: 3,
    });
    setActionLoading(null);
    if (!result.success || !result.resourcePack) {
      setActionResult(result.error ?? '资源生成评测运行失败');
      return;
    }
    setGeneratedResourcePack(result.resourcePack);
    const verifiedCount = result.resourcePack.resources.filter((resource) => resource.verified).length;
    setActionResult(`资源生成完成：${result.resourcePack.resources.length}/6 类，verified ${verifiedCount}/${result.resourcePack.resources.length}，trace ${result.resourcePack.traceId.slice(0, 10)}`);
    await load();
  }

  async function _writeBackVideoSmokeReport() {
    const resourcePackId = data?.resourcePackMetrics?.openmaicVideo?.packId
      || data?.resourcePackMetrics?.openmaicClassroom?.packId
      || generatedResourcePack?.resourcePackId
      || '';
    if (!openmaicSmokeReport?.success || !openmaicSmokeReport.hasVideoUrl) {
      setActionResult('视频 smoke 尚未成功，不能写回资源包。');
      return;
    }
    setActionLoading('smokeWriteback');
    setActionResult('');
    const result = await fetch('/api/a3/resources/openmaic-video-smoke-writeback', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourcePackId: resourcePackId || 'latest' }),
    }).then((response) => response.json()).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : '视频 smoke 写回失败',
    })) as { success: boolean; error?: string; traceId?: string };
    setActionLoading(null);
    if (!result.success) {
      setActionResult(result.error ?? '视频 smoke 写回失败');
      return;
    }
    setActionResult(`视频 smoke 已写回资源包：trace ${result.traceId?.slice(0, 10) ?? 'recorded'}`);
    await load();
  }

  async function writeBackVideoSmokeReportV2() {
    const resourcePackId = data?.resourcePackMetrics?.openmaicVideo?.packId
      || data?.resourcePackMetrics?.openmaicClassroom?.packId
      || generatedResourcePack?.resourcePackId
      || '';
    if (!openmaicSmokeReport?.success || !openmaicSmokeReport.hasVideoUrl) {
      setActionResult('视频 smoke 尚未成功，不能写回资源包。');
      return;
    }
    setActionLoading('smokeWriteback');
    setActionResult('');
    setSmokeWritebackResult(null);
    const result = await fetch('/api/a3/resources/openmaic-video-smoke-writeback', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourcePackId: resourcePackId || 'latest' }),
    }).then((response) => response.json()).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : '视频 smoke 写回失败',
    })) as {
      success: boolean;
      error?: string;
      traceId?: string;
      resourcePack?: A3ResourcePackV2;
      artifact?: { videoUrl?: string };
    };
    setActionLoading(null);
    if (!result.success) {
      setActionResult(result.error ?? '视频 smoke 写回失败');
      return;
    }
    const writtenPackId = result.resourcePack?.resourcePackId || resourcePackId || 'latest';
    setSmokeWritebackResult({
      resourcePackId: writtenPackId,
      traceId: result.traceId ?? '',
      videoUrl: result.artifact?.videoUrl ?? '',
    });
    setActionResult(`视频 smoke 已写回资源包：trace ${result.traceId?.slice(0, 10) ?? 'recorded'}`);
    await load();
  }

  useEffect(() => {
    void trackPageView('/a3/capabilities', { page: 'capabilities' });
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const readyCount = useMemo(() => Object.values(data?.summary ?? {}).filter(Boolean).length, [data]);
  const totalCount = Object.keys(capabilityLabels).length;
  const metrics = data?.evaluation.metrics;
  const resourcePackMetricCards = data?.resourcePackMetrics ? buildResourcePackMetricCards(data.resourcePackMetrics) : [];
  const openmaicPageOwnershipMetrics = buildOpenMAICPageOwnershipMetrics(A3_OPENMAIC_PAGE_OWNERSHIP);
  const openmaicHandoffSync = buildOpenMAICHandoffSyncSummary(A3_OPENMAIC_PAGE_OWNERSHIP);
  const celeryBeatCheck = runtimeStatus?.checks?.find((check) => check.name === 'celeryBeat');
  const openmaicVideoProviderCheck = runtimeStatus?.checks?.find((check) => check.name === 'openmaicVideoProvider');
  const openmaicVideoProviderConfigured = Boolean(openmaicVideoProviderCheck?.detail?.configured);
  const openmaicVerificationSummary = buildOpenMAICVerificationSummary(A3_OPENMAIC_PAGE_OWNERSHIP, openmaicVideoProviderConfigured);
  const openmaicSmokeReport = runtimeStatus?.openmaicSmokeReport;
  const openmaicSmokeWritebackPackId = data?.resourcePackMetrics?.openmaicVideo?.packId
    || data?.resourcePackMetrics?.openmaicClassroom?.packId
    || generatedResourcePack?.resourcePackId
    || '';
  const canWriteBackOpenMAICSmoke = Boolean(openmaicSmokeReport?.success && openmaicSmokeReport.hasVideoUrl);
  const policyOutcomeMetrics = learningEffectReport?.optimizationPolicy?.outcomeMetrics ?? optimizationPolicyResponse?.optimizationPolicy?.outcomeMetrics;
  const policyResourceGains = policyOutcomeMetrics?.resourceTypeGain7d ?? [];
  const artifactAudit = data?.resourcePackMetrics?.artifactAudit;
  const evaluationTargets = useMemo(() => buildEvaluationTargetStatuses(metrics ?? {}), [metrics]);
  const multimodalRag = data?.multimodalRag;
  const materialKnowledgeGraph = data?.materialKnowledgeGraph;
  const questionBankMetrics = data?.questionBankMetrics;
  const realtimeCoaching = data?.realtimeCoaching;
  const evaluationTargetCases = data?.evaluation.targetCases ?? 50;
  const evaluationScaleReady = Boolean(data?.evaluation.scaleReady ?? (data?.evaluation.totalCases ?? 0) >= evaluationTargetCases);
  const latestAgentRun = data?.agentRuns?.[0] ?? null;
  const latestResourceFeedbackRun = data?.agentRuns?.find((run) => run.workflow === 'resource_feedback') ?? null;
  const latestRagMode = extractLatestRetrievalMode(data?.agentRuns);
  const workflowOptions = useMemo(() => buildAgentTraceWorkflowOptions(data?.agentRuns), [data?.agentRuns]);
  const filteredAgentRuns = useMemo(() => {
    const runs = data?.agentRuns ?? [];
    if (workflowFilter === 'all') {
      return runs;
    }
    return runs.filter((run) => run.workflow === workflowFilter);
  }, [data?.agentRuns, workflowFilter]);
  const openmaicEvidenceSummary = buildOpenMAICEvidenceSummary({
    pageMetrics: openmaicPageOwnershipMetrics,
    verification: openmaicVerificationSummary,
    artifactAudit,
    smokeReport: openmaicSmokeReport,
    latestTraceId: latestAgentRun?.traceId ?? generatedResourcePack?.traceId ?? '',
    latestRagMode: latestRagMode.mode,
  });
  const generatedResourceStats = generatedResourcePack
    ? {
        total: generatedResourcePack.resources.length,
        verified: generatedResourcePack.resources.filter((resource) => resource.verified).length,
        citations: generatedResourcePack.resources.reduce((sum, resource) => sum + resource.citations.length, 0),
      }
    : null;

  return (
    <div className="space-y-5" data-testid="a3-capabilities-view">
      <section className="rounded-[16px] border border-slate-200 bg-slate-950 p-6 text-white shadow-[0_18px_38px_rgba(15,23,42,0.22)]">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <A3Pill tone="green">能力总览</A3Pill>
            <h1 className="mt-4 text-3xl font-semibold">产品级学习闭环与 Agent 评测指标</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
              展示 A3 的真实后端能力、产品闭环维度、检索评测、引用验证、安全拒答和 Agent 工作流覆盖率。答辩时可直接用本页证明系统不是静态页面。
            </p>
          </div>
          <div className="rounded-[14px] bg-white/10 px-5 py-4 text-right">
            <div className="text-xs text-slate-300">已就绪能力</div>
            <div className="mt-2 text-4xl font-semibold">{readyCount}/{totalCount}</div>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => void load()} disabled={loading} className="bg-emerald-500 text-slate-950 hover:bg-emerald-400">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
            刷新状态
          </Button>
          <Button onClick={() => void runValidation()} disabled={Boolean(actionLoading)} variant="outline" className="border-white/20 bg-white/10 text-white hover:bg-white/15">
            {actionLoading === 'validate' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            运行验收
          </Button>
          <Button onClick={() => void runEvaluation()} disabled={Boolean(actionLoading)} variant="outline" className="border-white/20 bg-white/10 text-white hover:bg-white/15">
            {actionLoading === 'evaluate' ? <Loader2 className="size-4 animate-spin" /> : <FileJson className="size-4" />}
            刷新评测
          </Button>
          <Button onClick={() => void runResourceGenerationProbe()} disabled={Boolean(actionLoading)} variant="outline" className="border-white/20 bg-white/10 text-white hover:bg-white/15">
            {actionLoading === 'resource' ? <Loader2 className="size-4 animate-spin" /> : <FileJson className="size-4" />}
            资源生成评测
          </Button>
          <Button asChild variant="outline" className="border-white/20 bg-white/10 text-white hover:bg-white/15">
            <Link href="/a3/demo-flow">
              进入演示闭环
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
        {actionLoading === 'evaluate' && (
          <div className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 px-4 py-3 text-sm leading-6 text-amber-100" data-testid="a3-agent-evaluation-running-note">
            正在刷新检索、验证、安全和 Agent workflow 指标。Agent workflow 会真实运行 8 条工作流，通常需要几十秒。
          </div>
        )}
        {actionResult && <div className="mt-4 rounded-lg bg-white/10 px-4 py-3 text-sm text-emerald-100" data-testid="a3-capability-action-result">{actionResult}</div>}
      </section>

      {message && <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">{message}</div>}

      {data?.productReadiness && (
        <A3Card
          title="产品就绪度"
          subtitle="按成熟学习软件的核心闭环检查：诊断、计划、今日任务、复习、报告、提醒和教师干预。"
          action={<A3Pill tone={data.productReadiness.score >= 90 ? 'green' : data.productReadiness.score >= 70 ? 'orange' : 'red'}>{data.productReadiness.score}%</A3Pill>}
        >
          <div className="grid gap-4 xl:grid-cols-[240px_1fr]">
            <div className="rounded-2xl bg-blue-50 p-5">
              <div className="text-sm text-blue-700">已完成闭环</div>
              <div className="mt-2 text-4xl font-semibold text-blue-800">
                {data.productReadiness.readyCount}/{data.productReadiness.total}
              </div>
              <div className="mt-4 h-3 rounded-full bg-white">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${data.productReadiness.score}%` }} />
              </div>
              <div className="mt-3 text-xs text-blue-700">{readinessStatusLabel[data.productReadiness.status]}</div>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {data.productReadiness.checks.map((item) => (
                <Link key={item.key} href={item.href} className={item.ready ? 'rounded-xl border border-emerald-200 bg-emerald-50 p-4' : 'rounded-xl border border-orange-200 bg-orange-50 p-4'}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                    <A3Pill tone={item.ready ? 'green' : 'orange'}>{item.ready ? 'ready' : 'todo'}</A3Pill>
                  </div>
                  <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
                </Link>
              ))}
            </div>
          </div>
        </A3Card>
      )}

      <section className="grid gap-5 xl:grid-cols-[1fr_0.8fr]">
        <A3Card
          title="市场级短板雷达"
          subtitle="把成熟学习软件的关键体验标准拆成可验证信号：连续体验、即时反馈、学习动机、接口真实性和评测证据。"
          action={<A3Pill tone={(data?.marketReadiness ?? []).every((item) => item.status === 'ready') ? 'green' : 'orange'}>market check</A3Pill>}
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5" data-testid="a3-market-readiness-radar">
            {(data?.marketReadiness ?? []).map((item) => (
              <Link key={item.key} href={item.nextAction.href} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition hover:border-blue-300 hover:bg-blue-50/50">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                  <A3Pill tone={item.status === 'ready' ? 'green' : 'orange'}>{item.score}%</A3Pill>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className={item.status === 'ready' ? 'h-full rounded-full bg-emerald-500' : 'h-full rounded-full bg-orange-500'} style={{ width: `${Math.min(100, Math.max(0, item.score))}%` }} />
                </div>
                <p className="mt-3 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.evidence}</p>
                <div className="mt-3 text-xs font-semibold text-blue-700">{item.nextAction.label}</div>
              </Link>
            ))}
          </div>
        </A3Card>

        <A3Card
          title="学习闭环证据"
          subtitle="展示报告、通知和今日任务之间的真实数据回流，证明连续体验不是静态入口。"
          action={<A3Pill tone={(data?.learningLoopReadiness ?? []).every((item) => item.ready) ? 'green' : 'orange'}>loop evidence</A3Pill>}
        >
          <div className="grid gap-3" data-testid="a3-learning-loop-readiness">
            {(data?.learningLoopReadiness ?? []).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                data-testid="a3-learning-loop-evidence"
                className={item.ready ? 'rounded-2xl border border-emerald-200 bg-emerald-50 p-4' : 'rounded-2xl border border-orange-200 bg-orange-50 p-4'}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                  <A3Pill tone={item.ready ? 'green' : 'orange'}>{item.ready ? 'ready' : 'watch'}</A3Pill>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
                <div className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-[11px] leading-5 text-slate-600">{item.evidence}</div>
              </Link>
            ))}
          </div>
        </A3Card>

        <A3Card
          title="风险与下一步"
          subtitle="只展示真实未达标项或需要持续观察的项，避免把演示包装成已完成产品。"
          action={<A3Pill tone={(data?.productReadiness?.blockers.length ?? 0) === 0 ? 'green' : 'orange'}>{data?.productReadiness?.blockers.length ?? 0} risks</A3Pill>}
        >
          <div className="space-y-3" data-testid="a3-capability-risk-list">
            {(data?.productReadiness?.blockers ?? []).length === 0 && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">
                当前核心闭环没有阻塞项。后续重点应放在更多真实课程数据、长期留存和部署稳定性。
              </div>
            )}
            {(data?.productReadiness?.blockers ?? []).map((item) => (
              <Link key={item.key} href={item.href} className="block rounded-xl border border-orange-200 bg-orange-50 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-orange-950">{item.title}</div>
                  <A3Pill tone="orange">待补齐</A3Pill>
                </div>
                <p className="mt-2 text-xs leading-5 text-orange-800">{item.detail}</p>
              </Link>
            ))}
          </div>
        </A3Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(capabilityLabels).map(([key, item]) => {
          const ready = Boolean(data?.summary?.[key]);
          return (
            <Link key={key} href={item.href} className={ready ? 'rounded-[14px] border border-emerald-200 bg-emerald-50/70 p-5' : 'rounded-[14px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5'}>
              <div className="flex items-start justify-between gap-3">
                <CheckCircle2 className={ready ? 'size-5 text-emerald-600' : 'size-5 text-slate-400'} />
                <A3Pill tone={ready ? 'green' : 'orange'}>{ready ? 'ready' : 'check'}</A3Pill>
              </div>
              <div className="mt-4 text-base font-semibold text-[var(--a3-text)]">{item.title}</div>
              <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{item.desc}</p>
            </Link>
          );
        })}
      </section>

      <A3Card
        title="修复任务流"
        subtitle="把短板直接转成可执行动作：先进入对应页面处理，再刷新验收和评测，确认数据闭环是否恢复。"
        action={<A3Pill tone="blue">actionable</A3Pill>}
      >
        <div className="grid gap-3 md:grid-cols-3" data-testid="a3-capability-fix-flow">
          {((data?.productReadiness?.blockers ?? []).length ? data?.productReadiness?.blockers ?? [] : data?.productReadiness?.checks.slice(0, 3) ?? []).map((item, index) => (
            <Link
              key={item.key}
              href={item.href}
              data-testid="a3-capability-fix-action"
              className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition hover:border-blue-300 hover:bg-blue-50/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--a3-text)]">{index + 1}. {item.title}</div>
                <A3Pill tone={item.ready ? 'green' : 'orange'}>{item.ready ? '复查' : '修复'}</A3Pill>
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
              <div className="mt-3 text-xs font-semibold text-blue-700">进入处理</div>
            </Link>
          ))}
          <button
            type="button"
            data-testid="a3-capability-fix-validate"
            onClick={() => void runValidation()}
            disabled={Boolean(actionLoading)}
            className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-emerald-950">刷新验收</div>
              <A3Pill tone="green">validate</A3Pill>
            </div>
            <p className="mt-2 text-xs leading-5 text-emerald-800">调用 /api/demo/validate/，重新跑主演示链路并刷新能力页。</p>
          </button>
          <button
            type="button"
            data-testid="a3-capability-fix-evaluate"
            onClick={() => void runEvaluation()}
            disabled={Boolean(actionLoading)}
            className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-left transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-blue-950">刷新评测</div>
              <A3Pill tone="blue">evaluate</A3Pill>
            </div>
            <p className="mt-2 text-xs leading-5 text-blue-800">调用 /api/demo/evaluate/，更新检索、验证、安全和 Agent workflow 指标文件。</p>
          </button>
        </div>
      </A3Card>

      <A3Card title="评测指标可视化" action={<A3Pill tone={metrics?.available ? 'green' : 'orange'}>{metrics?.available ? 'metrics ready' : '需要生成'}</A3Pill>}>
        <div
          data-testid="a3-evaluation-scale"
          className={evaluationScaleReady ? 'mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4' : 'mb-4 rounded-2xl border border-orange-200 bg-orange-50 p-4'}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className={evaluationScaleReady ? 'text-sm font-semibold text-emerald-950' : 'text-sm font-semibold text-orange-950'}>评测集规模</div>
              <p className={evaluationScaleReady ? 'mt-1 text-xs leading-5 text-emerald-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                当前 {data?.evaluation.totalCases ?? '--'} 条，目标 {evaluationTargetCases} 条，包含本地知识检索、安全拒答和 missing evidence 用例。
              </p>
            </div>
            <A3Pill tone={evaluationScaleReady ? 'green' : 'orange'}>
              {data?.evaluation.totalCases ?? '--'}/{evaluationTargetCases}
            </A3Pill>
          </div>
          <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="grounded" value={`${data?.evaluation.groundedCases ?? '--'} 条`} />
            <MetricInline label="unsafe" value={`${data?.evaluation.unsafeCases ?? '--'} 条`} />
            <MetricInline label="missing evidence" value={`${data?.evaluation.missingEvidenceCases ?? '--'} 条`} />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Top1 命中率" value={formatPercent(metrics?.retrievalTop1HitRate)} />
          <MetricCard label="Top3 命中率" value={formatPercent(metrics?.retrievalTop3HitRate)} />
          <MetricCard label="Top5 命中率" value={formatPercent(metrics?.retrievalTop5HitRate)} />
          <MetricCard label="验证覆盖率" value={formatPercent(metrics?.verifiedCoverage)} />
          <MetricCard label="安全拒答率" value={formatPercent(metrics?.safetyRefusalRate)} />
          <MetricCard label="缺证据拒答率" value={formatPercent(metrics?.missingEvidenceRefusalRate)} />
        </div>
        <div data-testid="a3-evaluation-target-status" className="mt-4 rounded-2xl border border-[var(--a3-border)] bg-white/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--a3-text)]">目标达成与风险</div>
              <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
                对照赛题验收阈值，标出已达标指标和下一批需要补测的指标。
              </p>
            </div>
            <A3Pill tone={evaluationTargets.every((item) => item.status === 'ready') ? 'green' : 'orange'}>
              {evaluationTargets.filter((item) => item.status === 'ready').length}/{evaluationTargets.length} ready
            </A3Pill>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {evaluationTargets.map((item) => (
              <div key={item.key} className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-[var(--a3-text)]">{item.label}</div>
                  <A3Pill tone={item.status === 'ready' ? 'green' : 'orange'}>{item.status === 'ready' ? '达标' : item.status === 'missing' ? '缺失' : '风险'}</A3Pill>
                </div>
                <div className="mt-2 text-sm font-semibold text-[var(--a3-text)]">
                  {item.current} / {item.target}
                </div>
                <p className="mt-2 text-[11px] leading-5 text-[var(--a3-text-muted)]">{item.nextAction}</p>
              </div>
            ))}
          </div>
        </div>
        <div
          data-testid="a3-evaluation-metrics-file"
          className="mt-4 rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[var(--a3-text)]">指标文件</div>
              <p className="mt-1 text-xs leading-5 text-[var(--a3-text-muted)]">
                读取真实 JSON 输出，答辩时可用同一命令复现检索、验证和安全指标。
              </p>
            </div>
            <A3Pill tone={metrics?.available ? 'green' : 'orange'}>{metrics?.available ? '已生成' : '待生成'}</A3Pill>
          </div>
          <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="文件路径" value={metrics?.path ?? data?.evaluation.latestMetricsFile ?? '--'} />
            <MetricInline label="更新时间" value={formatDateTime(metrics?.updatedAt)} />
            <MetricInline label="用例明细" value={metrics?.caseCount === undefined ? '--' : `${metrics.caseCount} 条 / TopK ${metrics.topK ?? 3}`} />
          </div>
          <CommandLine text="python backend/manage.py evaluate_demo_retrieval --top-k 3 --json --output backend/tmp/demo_retrieval_metrics.json" />
        </div>
      </A3Card>

      <A3Card
        title="验收证据区"
        subtitle="用真实命令、真实指标文件和真实 Agent 轨迹证明能力，不依赖静态页面。"
        action={<A3Pill tone={(data?.evidenceBoard ?? []).every((item) => ['ready', 'ok', 'warning'].includes(item.status)) ? 'green' : 'orange'}>evidence</A3Pill>}
      >
        <div
          className={data?.agentWorkflowMetrics?.available ? 'mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5' : 'mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-5'}
          data-testid="a3-agent-workflow-metrics"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={data?.agentWorkflowMetrics?.available ? 'text-sm font-semibold text-emerald-950' : 'text-sm font-semibold text-orange-950'}>
                Agent Workflow Evaluation
              </div>
              <p className={data?.agentWorkflowMetrics?.available ? 'mt-1 text-xs leading-5 text-emerald-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                Reads the generated backend metrics artifact and proves contract, trace, evidence-schema, API-entry, and readiness coverage.
              </p>
            </div>
            <A3Pill tone={data?.agentWorkflowMetrics?.overallStatus === 'pass' ? 'green' : 'orange'}>
              {data?.agentWorkflowMetrics?.overallStatus ?? 'missing'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="workflows" value={`${data?.agentWorkflowMetrics?.workflowCount ?? '--'}`} />
            <MetricCard label="ready" value={formatPercent(data?.agentWorkflowMetrics?.readyCoverage)} />
            <MetricCard label="contract" value={formatPercent(data?.agentWorkflowMetrics?.contractCoverage)} />
            <MetricCard label="trace" value={formatPercent(data?.agentWorkflowMetrics?.traceCoverage)} />
            <MetricCard label="evidence schema" value={formatPercent(data?.agentWorkflowMetrics?.evidenceSchemaCoverage)} />
            <MetricCard label="API entry" value={formatPercent(data?.agentWorkflowMetrics?.apiEntryCoverage)} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="artifact" value={data?.agentWorkflowMetrics?.path ?? 'backend/tmp/agent_workflow_metrics.json'} />
            <MetricInline label="generated traces" value={`${data?.agentWorkflowMetrics?.generatedTraceCount ?? '--'}`} />
            <MetricInline label="updated" value={formatDateTime(data?.agentWorkflowMetrics?.updatedAt)} />
          </div>
          {(data?.agentWorkflowMetrics?.latestTraceIds ?? []).length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" data-testid="a3-agent-workflow-latest-traces">
              {(data?.agentWorkflowMetrics?.latestTraceIds ?? []).slice(0, 4).map((traceId) => (
                <Link
                  key={traceId}
                  href={`/api/demo/agent-runs/${traceId}/`}
                  className="rounded-full bg-white/80 px-3 py-1 font-mono text-[11px] text-slate-700 hover:bg-white"
                >
                  {traceId.slice(0, 10)}
                </Link>
              ))}
            </div>
          )}
          <CommandLine text="python backend/manage.py evaluate_agent_workflows --generate-demo-traces --json --output backend/tmp/agent_workflow_metrics.json" />
        </div>

        <div
          className={materialKnowledgeGraph?.status === 'ready' ? 'mb-5 rounded-2xl border border-teal-200 bg-teal-50 p-5' : 'mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-5'}
          data-testid="a3-material-knowledge-graph-status"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={materialKnowledgeGraph?.status === 'ready' ? 'text-sm font-semibold text-teal-950' : 'text-sm font-semibold text-orange-950'}>
                Material Knowledge Graph
              </div>
              <p className={materialKnowledgeGraph?.status === 'ready' ? 'mt-1 text-xs leading-5 text-teal-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                Shows the downstream graph built from uploaded-material KnowledgeBlock evidence, including schema, workflow trace, degradation and counts.
              </p>
            </div>
            <A3Pill tone={materialKnowledgeGraph?.status === 'ready' ? 'green' : 'orange'}>
              {materialKnowledgeGraph?.status ?? 'missing'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="entities" value={`${materialKnowledgeGraph?.entityCount ?? 0}`} />
            <MetricCard label="relations" value={`${materialKnowledgeGraph?.relationCount ?? 0}`} />
            <MetricCard label="claims" value={`${materialKnowledgeGraph?.claimCount ?? 0}`} />
            <MetricCard label="degraded" value={`${materialKnowledgeGraph?.degradedCount ?? 0}`} />
            <MetricCard label="schema" value={materialKnowledgeGraph?.schemaVersion ?? 'a3.material-knowledge-graph.v1'} />
            <MetricCard label="workflow" value={materialKnowledgeGraph?.workflow ?? 'material_knowledge_graph'} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="workflow schema" value={materialKnowledgeGraph?.workflowSchemaVersion ?? 'a3.agent-workflow.v1'} />
            <MetricInline label="trace" value={materialKnowledgeGraph?.traceId ? materialKnowledgeGraph.traceId.slice(0, 12) : '--'} />
            <MetricInline label="updated" value={formatDateTime(materialKnowledgeGraph?.lastBuiltAt)} />
            <MetricInline
              label="markdown evidence"
              value={`${materialKnowledgeGraph?.markdownEvidence?.mathCount ?? 0} formulas · ${materialKnowledgeGraph?.markdownEvidence?.tableCount ?? 0} tables · ${materialKnowledgeGraph?.markdownEvidence?.rawTextPreserved ? 'raw preserved' : 'raw pending'}`}
            />
            <MetricInline label="markdown format" value={materialKnowledgeGraph?.markdownEvidence?.contentFormat ?? 'plain'} />
            <MetricInline label="markdown rows" value={`${materialKnowledgeGraph?.markdownEvidence?.evidenceCount ?? 0}`} />
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-700">{materialKnowledgeGraph?.reason ?? '暂无资料图谱构建证据。'}</p>
          <CommandLine text="GET /api/demo/status/ -> materialKnowledgeGraph; GET /api/kb/graph/" />
        </div>

        <div
          className={multimodalRag?.metrics?.available ? 'mb-5 rounded-2xl border border-indigo-200 bg-indigo-50 p-5' : 'mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-5'}
          data-testid="a3-multimodal-rag-metrics"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={multimodalRag?.metrics?.available ? 'text-sm font-semibold text-indigo-950' : 'text-sm font-semibold text-orange-950'}>
                Multimodal RAG Evaluation
              </div>
              <p className={multimodalRag?.metrics?.available ? 'mt-1 text-xs leading-5 text-indigo-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                Reads backend/tmp/multimodal_rag_metrics.json and the latest visual_vector index record.
              </p>
            </div>
            <A3Pill tone={multimodalRag?.visualIndex?.available ? 'green' : 'orange'}>
              visual index: {multimodalRag?.visualIndex?.latestStatus ?? 'missing'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="resources" value={`${multimodalRag?.metrics?.resources ?? '--'}`} />
            <MetricCard label="parse success" value={formatRatioPercent(multimodalRag?.metrics?.parseSuccessRate)} />
            <MetricCard label="hybrid ready" value={formatRatioPercent(multimodalRag?.metrics?.hybridReadyRate)} />
            <MetricCard label="visual coverage" value={formatRatioPercent(multimodalRag?.metrics?.visualCoverage)} />
            <MetricCard label="visualIndexedEntries" value={`${multimodalRag?.metrics?.visualIndexedEntries ?? multimodalRag?.visualIndex?.indexedEntries ?? '--'}`} />
            <MetricCard label="text indexed" value={`${multimodalRag?.metrics?.textIndexedEntries ?? '--'}`} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-4">
            <MetricInline label="metrics file" value={multimodalRag?.metrics?.path ?? 'backend/tmp/multimodal_rag_metrics.json'} />
            <MetricInline label="visual index" value={multimodalRag?.visualIndex?.path ?? '--'} />
            <MetricInline label="backend" value={multimodalRag?.visualIndex?.backend || '--'} />
            <MetricInline label="updated" value={formatDateTime(multimodalRag?.metrics?.updatedAt || multimodalRag?.visualIndex?.updatedAt)} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="indexed entries" value={`${multimodalRag?.visualIndex?.indexedEntries ?? 0}`} />
            <MetricInline label="failed entries" value={`${multimodalRag?.visualIndex?.failedEntries ?? 0}`} />
            <MetricInline label="latest block" value={multimodalRag?.visualIndex?.latestBlockId ? multimodalRag.visualIndex.latestBlockId.slice(0, 10) : '--'} />
          </div>
          <CommandLine text="python backend/manage.py evaluate_multimodal_rag --top-k 3 --json --output backend/tmp/multimodal_rag_metrics.json" />
        </div>

        <div
          className={realtimeCoaching?.available ? 'mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5' : 'mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-5'}
          data-testid="a3-realtime-coaching-capability"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={realtimeCoaching?.available ? 'text-sm font-semibold text-emerald-950' : 'text-sm font-semibold text-orange-950'}>
                Realtime Coaching
              </div>
              <p className={realtimeCoaching?.available ? 'mt-1 text-xs leading-5 text-emerald-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                Tracks provider, realtime tutoring sessions, hybrid RAG tool evidence, visual frames, verification and fallback count.
              </p>
            </div>
            <A3Pill tone={(realtimeCoaching?.fallbackCount ?? 0) > 0 ? 'orange' : 'green'}>
              {realtimeCoaching?.latestProvider ?? 'not_configured'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="sessions" value={`${realtimeCoaching?.sessionCount ?? 0}`} />
            <MetricCard label="latency" value={`${realtimeCoaching?.averageLatencyMs ?? 0}ms`} />
            <MetricCard label="RAG hit" value={formatRatioPercent(realtimeCoaching?.ragHitRate)} />
            <MetricCard label="visual frames" value={`${realtimeCoaching?.visualFrameCount ?? 0}`} />
            <MetricCard label="verified" value={formatRatioPercent(realtimeCoaching?.verifiedAnswerRate)} />
            <MetricCard label="fallback" value={`${realtimeCoaching?.fallbackCount ?? 0}`} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-3">
            <MetricInline label="schema" value={realtimeCoaching?.schemaVersion ?? 'a3.realtime-coaching-metrics.v1'} />
            <MetricInline label="tool calls" value={`${realtimeCoaching?.ragToolCallCount ?? 0}`} />
            <MetricInline label="latest session" value={realtimeCoaching?.latestSessionId ? realtimeCoaching.latestSessionId.slice(0, 10) : '--'} />
          </div>
          <CommandLine text="POST /api/a3/coaching/realtime/session -> /api/a3/coaching/realtime/tool -> /api/a3/coaching/realtime/end" />
        </div>

        <div
          className={questionBankMetrics?.available ? 'mb-5 rounded-2xl border border-sky-200 bg-sky-50 p-5' : 'mb-5 rounded-2xl border border-orange-200 bg-orange-50 p-5'}
          data-testid="a3-question-bank-metrics"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className={questionBankMetrics?.available ? 'text-sm font-semibold text-sky-950' : 'text-sm font-semibold text-orange-950'}>
                Question Bank Agent Evaluation
              </div>
              <p className={questionBankMetrics?.available ? 'mt-1 text-xs leading-5 text-sky-800' : 'mt-1 text-xs leading-5 text-orange-800'}>
                Tracks QuestionGeneratorAgent, QuestionVerifierAgent and AdaptivePracticeAgent output: evidence-backed candidates, teacher review state, and formal assessment safety.
              </p>
            </div>
            <A3Pill tone={questionBankMetrics?.formalAssessmentSafe ? 'green' : 'orange'}>
              formal: {questionBankMetrics?.formalAssessmentSafe ? 'approved only' : 'check needed'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard label="questions" value={`${questionBankMetrics?.questionCount ?? '--'}`} />
            <MetricCard label="approved" value={`${questionBankMetrics?.approvedCount ?? '--'}`} />
            <MetricCard label="待审候选" value={`${questionBankMetrics?.autoVerifiedCount ?? '--'}`} />
            <MetricCard label="generated" value={`${questionBankMetrics?.generatedCount ?? '--'}`} />
            <MetricCard label="evidence" value={formatPercent(questionBankMetrics?.evidenceCoverage)} />
            <MetricCard label="verification" value={formatPercent(questionBankMetrics?.verificationPassRate)} />
          </div>
          <div className="mt-4 grid gap-2 text-xs md:grid-cols-4">
            <MetricInline label="metrics file" value={questionBankMetrics?.path ?? 'backend/tmp/question_bank_metrics.json'} />
            <MetricInline label="updated" value={formatDateTime(questionBankMetrics?.updatedAt)} />
            <MetricInline label="personal" value={`${questionBankMetrics?.personalQuestionCount ?? 0}`} />
            <MetricInline label="rejected" value={`${questionBankMetrics?.rejectedCount ?? 0}`} />
          </div>
          {questionBankMetrics?.latestJob ? (
            <div className="mt-4 rounded-xl border border-sky-200 bg-white/80 p-3" data-testid="a3-question-bank-latest-job">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-900">Latest generation job</div>
                <A3Pill tone={questionBankMetrics.latestJob.status === 'succeeded' ? 'green' : questionBankMetrics.latestJob.status === 'failed' ? 'red' : 'orange'}>
                  {questionBankMetrics.latestJob.status}
                </A3Pill>
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-5">
                <MetricInline label="requested" value={`${questionBankMetrics.latestJob.requestedCount}`} />
                <MetricInline label="generated" value={`${questionBankMetrics.latestJob.generatedCount}`} />
                <MetricInline label="verified" value={`${questionBankMetrics.latestJob.verifiedCount}`} />
                <MetricInline label="rejected" value={`${questionBankMetrics.latestJob.rejectedCount}`} />
                <MetricInline label="updated" value={formatDateTime(questionBankMetrics.latestJob.updatedAt ?? undefined)} />
              </div>
              {questionBankMetrics.latestJob.error ? (
                <div className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                  {questionBankMetrics.latestJob.error}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-sky-200 bg-white/80 px-3 py-2 text-xs leading-5 text-sky-800">
              No generation job yet. Use the teacher question bank panel to generate candidates from indexed knowledge-base resources.
            </div>
          )}
          <CommandLine text="python backend/manage.py evaluate_question_bank --json --output backend/tmp/question_bank_metrics.json" />
        </div>

        <div className="mb-5 grid gap-4 xl:grid-cols-4" data-testid="a3-resource-generation-rag-trace">
          <div className="rounded-2xl border border-cyan-100 bg-cyan-50 p-5" data-testid="a3-profile-interview-evidence">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-cyan-950">画像访谈 Agent</div>
              <A3Pill tone={data?.profileInterview?.status === 'complete' || data?.profileInterview?.status === 'collecting' ? 'green' : 'orange'}>
                {data?.profileInterview?.status ?? 'missing'}
              </A3Pill>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MetricInline label="turns" value={`${data?.profileInterview?.turnCount ?? 0}`} />
              <MetricInline label="messages" value={`${data?.profileInterview?.messageCount ?? 0}`} />
              <MetricInline label="strategy" value={data?.profileInterview?.askStrategy?.name ?? '--'} />
              <MetricInline label="trace" value={data?.profileInterview?.latestTraceId ? data.profileInterview.latestTraceId.slice(0, 10) : '--'} />
              <MetricInline label="committed" value={data?.profileInterview?.profileCommitted ? 'yes' : 'no'} />
              <MetricInline label="refreshed" value={data?.profileInterview?.pathAndPlanRefreshed ? 'path+plan' : '--'} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs" data-testid="a3-profile-interview-commit-evidence">
              <div className="rounded-xl bg-white px-3 py-2 text-cyan-900">
                路径：{data?.profileInterview?.generated?.path ? '已刷新' : '待刷新'}
              </div>
              <div className="rounded-xl bg-white px-3 py-2 text-cyan-900">
                计划：{data?.profileInterview?.generated?.studyPlan ? '已生成' : '待生成'}
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-cyan-800">
              {data?.profileInterview?.detail ?? '读取 /api/demo/status/ 的 profileInterview 字段，展示对话式画像 session、追问策略和 Agent trace。'}
            </p>
            {(data?.profileInterview?.askFields?.length ?? 0) > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {data?.profileInterview?.askFields.map((item) => (
                  <span key={item.field} className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-cyan-800">
                    {item.label || item.field}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-2xl border border-blue-100 bg-blue-50 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-blue-950">资源生成评测</div>
              <A3Pill tone={generatedResourceStats?.total === 6 ? 'green' : 'orange'}>{generatedResourceStats ? `${generatedResourceStats.total}/6` : '待运行'}</A3Pill>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MetricInline label="verified" value={generatedResourceStats ? `${generatedResourceStats.verified}/${generatedResourceStats.total}` : '--'} />
              <MetricInline label="citations" value={generatedResourceStats ? `${generatedResourceStats.citations}` : '--'} />
            </div>
            <p className="mt-3 text-xs leading-5 text-blue-800">
              点击顶部“资源生成评测”会调用真实 `/api/resources/generate/`，返回 a3.resource-pack.v2 和七类资源覆盖结果。
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-emerald-950">RAG 模式</div>
              <A3Pill tone={latestRagMode.mode === 'unknown' ? 'orange' : 'green'}>{latestRagMode.mode}</A3Pill>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MetricInline label="agent" value={latestRagMode.agent} />
              <MetricInline label="trace" value={latestRagMode.traceId ? latestRagMode.traceId.slice(0, 10) : '--'} />
            </div>
            <p className="mt-3 text-xs leading-5 text-emerald-800">
                来源于最近 Agent trace 中 RetrieverAgent 的 metadata.evidence.retrievalMode，用于证明课堂/资源链路不是前端假状态。
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-slate-100">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-100">最新 Agent trace</div>
              <A3Pill tone={latestAgentRun ? 'green' : 'orange'}>{latestAgentRun?.status ?? 'missing'}</A3Pill>
            </div>
            <div className="mt-4 space-y-2 text-xs leading-5 text-slate-300">
              <div>workflow: {latestAgentRun?.workflow ?? '--'}</div>
              <div>traceId: <span className="font-mono">{latestAgentRun?.traceId ?? generatedResourcePack?.traceId ?? '--'}</span></div>
              <div>latency: {latestAgentRun ? `${latestAgentRun.latencyMs}ms` : '--'}</div>
            </div>
          </div>
        </div>

        <div className="mb-5 rounded-2xl border border-emerald-100 bg-emerald-50 p-5" data-testid="a3-learning-effect-evidence">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-emerald-950">学习效果评估闭环</div>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-emerald-800">
                读取 `/api/learning/effect/report/`，证明资源包按钮的打开、完成、跳过、收藏会进入后端效果评估，而不是停留在页面状态。
              </p>
            </div>
            <A3Pill tone={(learningEffectReport?.resourceUsage?.totalFeedback ?? 0) > 0 ? 'green' : 'orange'}>
              {learningEffectReport?.schemaVersion ?? 'a3.learning-effect.v1'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <MetricInline label="opened" value={`${learningEffectReport?.resourceUsage?.opened ?? 0}`} />
            <MetricInline label="completed" value={`${learningEffectReport?.resourceUsage?.completed ?? 0}`} />
            <MetricInline label="skipped" value={`${learningEffectReport?.resourceUsage?.skipped ?? 0}`} />
            <MetricInline label="favorited" value={`${learningEffectReport?.resourceUsage?.favorited ?? 0}`} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <MetricInline label="effect score" value={`${learningEffectReport?.overallEffectScore ?? 0}`} />
            <MetricInline label="confidence" value={learningEffectReport?.confidence ?? '--'} />
            <MetricInline label="events" value={`${learningEffectReport?.behavior?.eventCount ?? 0}`} />
          </div>
          <div className="mt-4 rounded-xl border border-emerald-200 bg-white/85 px-4 py-3" data-testid="a3-event-stream-v2-evidence">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-emerald-950">事件流 v2 / 埋点采集证据</div>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  单条与批量 ingest 均写入 LearningEvent，来源页面和客户端时间会进入效果评估证据。
                </p>
              </div>
              <A3Pill tone={(learningEffectReport?.eventStream?.v2EventCount ?? 0) > 0 ? 'green' : 'orange'}>
                {learningEffectReport?.eventStream?.schemaVersion ?? 'a3.learning-event.v2'}
              </A3Pill>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-4">
              <MetricInline label="v2 events" value={`${learningEffectReport?.eventStream?.v2EventCount ?? 0}`} />
              <MetricInline label="accepted" value={`${learningEffectReport?.eventStream?.acceptedCount ?? 0}`} />
              <MetricInline label="single API" value={learningEffectReport?.eventStream?.singleApi ?? '/api/learning/events/'} />
              <MetricInline label="batch API" value={learningEffectReport?.eventStream?.batchApi ?? '/api/learning/events/batch/'} />
            </div>
            {(learningEffectReport?.eventStream?.sourcePages ?? []).length > 0 && (
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {(learningEffectReport?.eventStream?.sourcePages ?? []).slice(0, 3).map((page) => (
                  <MetricInline key={page.sourcePage ?? 'unknown'} label={page.sourcePage || 'unknown'} value={`${page.count ?? 0}`} />
                ))}
              </div>
            )}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <MetricInline
              label="plan execution"
              value={`${learningEffectReport?.planExecution?.completedTasks ?? 0}/${learningEffectReport?.planExecution?.taskCount ?? 0}`}
            />
            <MetricInline label="avg score" value={`${learningEffectReport?.masterySignals?.averageFeedbackScore ?? 0}`} />
            <MetricInline label="adjustment" value={learningEffectReport?.planAdjustment?.strategy ?? '--'} />
          </div>
          {learningEffectReport?.optimizationPolicy && (
            <div className="mt-4 rounded-xl border border-blue-200 bg-white/85 px-4 py-3" data-testid="a3-optimization-policy-evidence">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-blue-950">持续优化策略引擎</div>
                  <p className="mt-1 text-xs leading-5 text-blue-800">
                    候选策略先评分，再写入计划调整，并在 7 天窗口内回看 outcome。
                  </p>
                </div>
                <A3Pill tone={learningEffectReport.optimizationPolicy.outcomeStatus === 'succeeded' ? 'green' : learningEffectReport.optimizationPolicy.outcomeStatus === 'failed' ? 'red' : 'orange'}>
                  {learningEffectReport.optimizationPolicy.outcomeStatus ?? 'pending'}
                </A3Pill>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <MetricInline label="policy" value={learningEffectReport.optimizationPolicy.policyVersion ?? '--'} />
                <MetricInline label="decision" value={learningEffectReport.optimizationPolicy.decisionId ?? '--'} />
                <MetricInline label="strategy" value={learningEffectReport.optimizationPolicy.selectedStrategy ?? '--'} />
                <MetricInline label="score" value={`${learningEffectReport.optimizationPolicy.selectedCandidate?.decisionScore ?? 0}`} />
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <MetricInline label="independent API" value={optimizationPolicyResponse?.success ? 'ready' : 'not loaded'} />
                <MetricInline label="history" value={`${optimizationPolicyResponse?.decisionHistory?.length ?? 0}/12`} />
                <MetricInline label="latest" value={optimizationPolicyResponse?.decisionHistory?.[0]?.decisionAt ?? '--'} />
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                {(learningEffectReport.optimizationPolicy.candidates ?? []).slice(0, 3).map((candidate) => (
                  <MetricInline key={candidate.strategy ?? 'candidate'} label={candidate.strategy ?? '--'} value={`${candidate.decisionScore ?? 0}`} />
                ))}
              </div>
              <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/70 p-3" data-testid="a3-policy-outcome-resource-gain">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-blue-950">资源类型 7 天效果回看</div>
                  <A3Pill tone={(policyOutcomeMetrics?.summary?.resourceTypeCount ?? 0) > 0 ? 'green' : 'orange'}>
                    {policyOutcomeMetrics?.schemaVersion ?? 'a3.policy-outcome-metrics.v1'}
                  </A3Pill>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <MetricInline label="window" value={`${policyOutcomeMetrics?.windowDays ?? 7}d`} />
                  <MetricInline label="resource types" value={`${policyOutcomeMetrics?.summary?.resourceTypeCount ?? 0}`} />
                  <MetricInline label="top gain" value={`${policyOutcomeMetrics?.summary?.topResourceTypeGain7d ?? 0}`} />
                </div>
                {policyResourceGains.length > 0 ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    {policyResourceGains.slice(0, 3).map((item) => (
                      <MetricInline
                        key={`${item.resourceType}-${item.knowledgePointId}`}
                        label={`${item.resourceType ?? '--'} · ${item.confidence ?? 'low'}`}
                        value={`gain ${item.postAssessmentGain7d ?? 0} / done ${item.completed7d ?? 0}`}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-lg bg-white/80 px-3 py-2 text-xs leading-5 text-blue-800">
                    等待资源打开、完成和后续测评事件形成可归因样本。
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <MetricInline label="7d answers" value={`${learningEffectReport?.trends?.sevenDay?.assessment?.attemptCount ?? 0}`} />
            <MetricInline label="14d answers" value={`${learningEffectReport?.trends?.fourteenDay?.assessment?.attemptCount ?? 0}`} />
            <MetricInline label="30d answers" value={`${learningEffectReport?.trends?.thirtyDay?.assessment?.attemptCount ?? 0}`} />
          </div>
          {(learningEffectReport?.knowledgePoints ?? []).length > 0 && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-white/85 px-4 py-3">
              <div className="text-sm font-semibold text-emerald-950">知识点增益证据</div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {(learningEffectReport?.knowledgePoints ?? []).slice(0, 3).map((point) => (
                  <MetricInline
                    key={point.knowledgePointId}
                    label={`${point.name} · ${point.confidence}`}
                    value={`${point.learningGain > 0 ? '+' : ''}${point.learningGain} / ${point.trend}`}
                  />
                ))}
              </div>
            </div>
          )}
          {(learningEffectReport?.missingEvidence ?? []).length > 0 && (
            <div className="mt-4 rounded-xl border border-orange-200 bg-white/85 px-4 py-3 text-sm leading-6 text-orange-800">
              证据不足：{learningEffectReport?.missingEvidence?.join('；')}
            </div>
          )}
          {learningEffectReport?.analysis && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-white/85 px-4 py-3" data-testid="a3-capabilities-learning-effect-analysis">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-emerald-950">LearningEffectAnalyzerAgent</div>
                <A3Pill tone={learningEffectReport.analysisDegraded ? 'orange' : 'green'}>
                  {learningEffectReport.analysisSource ?? '--'}
                </A3Pill>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <MetricInline label="risk" value={learningEffectReport.analysis.riskLevel ?? '--'} />
                <MetricInline label="degraded" value={learningEffectReport.analysisDegraded ? 'yes' : 'no'} />
                <MetricInline label="trace" value={learningEffectReport.agentTrace?.traceId ?? '--'} />
                <MetricInline label="workflow" value={learningEffectReport.agentTrace?.workflow ?? '--'} />
              </div>
              <p className="mt-3 text-sm leading-6 text-emerald-800">
                {learningEffectReport.analysis.summary ?? '暂无结构化分析摘要。'}
              </p>
              {learningEffectReport.analysis.nextIntervention && (
                <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-900">
                  下一步：{learningEffectReport.analysis.nextIntervention.type ?? '--'}，{learningEffectReport.analysis.nextIntervention.reason ?? '继续执行当前计划。'}
                </div>
              )}
              {learningEffectReport.analysisDegradedReason && (
                <div className="mt-3 rounded-lg bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">
                  降级原因：{learningEffectReport.analysisDegradedReason}
                </div>
              )}
              {(learningEffectReport.agentTrace?.steps ?? []).length > 0 && (
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {(learningEffectReport.agentTrace?.steps ?? []).slice(0, 3).map((step, index) => (
                    <div key={`${step.name ?? 'step'}-${index}`} className="rounded-lg bg-slate-950 px-3 py-2 text-xs text-slate-100">
                      <div className="font-semibold">{step.name ?? '--'}</div>
                      <div className="mt-1 text-slate-400">{step.status ?? '--'} · {step.latencyMs == null ? '--' : `${step.latencyMs}ms`}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {(learningEffectReport?.planAdjustmentAction || studyPlan?.lastLearningEffectAdjustment) && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-white/85 px-4 py-3" data-testid="a3-capabilities-learning-effect-plan-writeback">
              <div className="text-sm font-semibold text-emerald-950">LearningEffect 计划写回</div>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <MetricInline
                  label="strategy"
                  value={(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.strategy ?? '--'}
                />
                <MetricInline
                  label="task"
                  value={(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.taskId ?? '--'}
                />
                <MetricInline
                  label="risk"
                  value={(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.evidence?.riskLevel ?? '--'}
                />
                <MetricInline
                  label="applied"
                  value={(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.applied ? 'yes' : 'no'}
                />
              </div>
              {(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.expectedImpact && (
                <div className="mt-3 text-xs leading-5 text-emerald-800">
                  预期影响：{(studyPlan?.lastLearningEffectAdjustment ?? learningEffectReport?.planAdjustmentAction)?.expectedImpact}
                </div>
              )}
            </div>
          )}
          {learningEffectReport?.planAdjustment?.evidence && (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <MetricInline label="latest goal" value={learningEffectReport.planAdjustment.evidence.latestGoal || '--'} />
              <MetricInline label="score evidence" value={`${learningEffectReport.planAdjustment.evidence.averageFeedbackScore ?? 0}`} />
              <MetricInline label="next action" value={learningEffectReport.planAdjustment.nextAction?.label ?? '--'} />
            </div>
          )}
          {learningEffectReport?.planAdjustment?.reason && (
            <div className="mt-4 rounded-xl bg-white/80 px-4 py-3 text-sm leading-6 text-emerald-800">
              {learningEffectReport.planAdjustment.reason}
            </div>
          )}
          {studyPlan?.lastResourceFeedbackAdjustment && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-white/85 px-4 py-3" data-testid="a3-capabilities-plan-feedback-writeback">
              <div className="text-sm font-semibold text-emerald-950">StudyPlan 写回证据</div>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <MetricInline label="strategy" value={studyPlan.lastResourceFeedbackAdjustment.strategy} />
                <MetricInline label="task id" value={studyPlan.lastResourceFeedbackAdjustment.taskId ?? '--'} />
                <MetricInline label="latest goal" value={studyPlan.lastResourceFeedbackAdjustment.evidence?.latestGoal || '--'} />
                <MetricInline label="applied" value={studyPlan.lastResourceFeedbackAdjustment.appliedAt ? 'yes' : 'no'} />
              </div>
              {studyPlan.lastResourceFeedbackAdjustment.nextAction && (
                <div className="mt-3 text-xs leading-5 text-emerald-800">
                  下一步：{studyPlan.lastResourceFeedbackAdjustment.nextAction.label}，{studyPlan.lastResourceFeedbackAdjustment.nextAction.reason ?? '继续执行当前学习计划。'}
                </div>
              )}
            </div>
          )}
          {latestResourceFeedbackRun && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-950 px-4 py-3 text-slate-100" data-testid="a3-capabilities-resource-feedback-trace">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">ResourceFeedback Agent Trace</div>
                  <div className="mt-1 text-xs text-slate-400">
                    traceId: <span className="font-mono">{latestResourceFeedbackRun.traceId}</span> · {latestResourceFeedbackRun.steps.length} steps · {latestResourceFeedbackRun.status}
                  </div>
                </div>
                <A3Pill tone={latestResourceFeedbackRun.status === 'completed' ? 'green' : 'orange'}>{latestResourceFeedbackRun.workflow}</A3Pill>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-4">
                {latestResourceFeedbackRun.steps.slice(0, 4).map((step) => (
                  <div key={`${latestResourceFeedbackRun.traceId}-${step.order ?? step.name}`} className="rounded-lg bg-white/10 px-3 py-2">
                    <div className="text-xs font-semibold text-slate-100">{step.name}</div>
                    <div className="mt-1 text-[11px] text-slate-400">{step.status} · {step.latencyMs}ms</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Link className="rounded-full bg-white/10 px-3 py-1.5 text-slate-100 hover:bg-white/15" href={latestResourceFeedbackRun.detailUrl ?? `/api/demo/agent-runs/${latestResourceFeedbackRun.traceId}/`}>
                  查看 trace
                </Link>
                <Link className="rounded-full bg-white/10 px-3 py-1.5 text-slate-100 hover:bg-white/15" href={latestResourceFeedbackRun.exportJsonUrl ?? `/api/demo/agent-runs/${latestResourceFeedbackRun.traceId}/export/?format=json`}>
                  导出 JSON
                </Link>
              </div>
            </div>
          )}
        </div>

        <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_300px]" data-testid="a3-resource-pack-capability">
          <div className="grid gap-3 md:grid-cols-4">
            {resourcePackMetricCards.map((card) => (
              <div key={card.label} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4" data-testid="a3-resource-pack-metric-card">
                <A3Pill tone={card.tone}>{card.label}</A3Pill>
                <div className="mt-3 text-3xl font-semibold text-[var(--a3-text)]">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{card.detail}</p>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-violet-100 bg-violet-50 p-5">
            <div className="text-sm font-semibold text-violet-950">推荐资源转化闭环</div>
            <div className="mt-3 text-xl font-semibold text-violet-950">{data?.resourcePackMetrics?.nextAction.label ?? '获取推荐资源包'}</div>
            <p className="mt-3 text-sm leading-6 text-violet-800">{data?.resourcePackMetrics?.nextAction.reason ?? '先从推荐页加入一个资源包。'}</p>
            {data?.resourcePackMetrics?.message && (
              <div className="mt-4 rounded-xl bg-white/80 p-3 text-xs leading-5 text-violet-800">{data.resourcePackMetrics.message}</div>
            )}
            <Button asChild className="mt-5 w-full bg-violet-600 hover:bg-violet-700">
              <Link href={data?.resourcePackMetrics?.nextAction.href ?? '/a3/recommendations'}>
                进入闭环
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
        <div className="mb-5 rounded-2xl border border-indigo-100 bg-indigo-50 p-5" data-testid="a3-openmaic-evidence-summary">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-indigo-950">OpenMAIC 接入证据总览</div>
              <p className="mt-2 text-sm leading-6 text-indigo-800">{openmaicEvidenceSummary.headline}</p>
            </div>
            <A3Pill tone={openmaicEvidenceSummary.status === 'ready' ? 'green' : 'orange'}>
              {openmaicEvidenceSummary.status}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {openmaicEvidenceSummary.cards.map((card) => (
              <div key={card.key} className="rounded-xl border border-indigo-100 bg-white p-4" data-testid="a3-openmaic-evidence-card">
                <A3Pill tone={card.tone}>{card.title}</A3Pill>
                <div className="mt-3 text-2xl font-semibold text-indigo-950">{card.value}</div>
                <p className="mt-2 text-xs leading-5 text-indigo-800">{card.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-[1fr_360px]">
            <div className="rounded-xl border border-indigo-100 bg-white p-4">
              <div className="text-xs font-semibold text-indigo-950">答辩验证命令</div>
              <div className="mt-3 space-y-2" data-testid="a3-openmaic-evidence-commands">
                {openmaicEvidenceSummary.proofCommands.slice(0, 3).map((command) => (
                  <CommandLine key={command} text={command} />
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-indigo-100 bg-white p-4">
              <div className="text-xs font-semibold text-indigo-950">剩余动作</div>
              <div className="mt-3 space-y-2 text-xs leading-5 text-indigo-800" data-testid="a3-openmaic-evidence-next-actions">
                {openmaicEvidenceSummary.nextActions.length ? (
                  openmaicEvidenceSummary.nextActions.map((action) => (
                    <div key={action} className="rounded-lg bg-indigo-50 px-3 py-2">{action}</div>
                  ))
                ) : (
                  <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">页面分工、artifact、smoke 和 trace 证据已连通。</div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="mb-5 rounded-2xl border border-sky-100 bg-sky-50 p-5" data-testid="a3-openmaic-handoff-sync">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-sky-950">OpenMAIC 页面分工文档同步</div>
              <p className="mt-2 text-sm leading-6 text-sky-800">
                这里把代码里的 A3 页面分工、交接文档和文本质量扫描绑定到同一条验证命令，避免“页面改了但文档没改”。
              </p>
            </div>
            <A3Pill tone={openmaicHandoffSync.status === 'ready' ? 'green' : 'orange'}>
              {openmaicHandoffSync.coverage}% synced
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 text-xs md:grid-cols-4">
            <MetricInline label="schema" value={openmaicHandoffSync.schemaVersion} />
            <MetricInline label="document" value={openmaicHandoffSync.documentPath} />
            <MetricInline label="tokens" value={`${openmaicHandoffSync.coveredTokens}/${openmaicHandoffSync.expectedTokens}`} />
            <MetricInline label="missing" value={`${openmaicHandoffSync.missingTokens.length}`} />
          </div>
          <div className="mt-4 rounded-xl border border-sky-100 bg-white p-4">
            <div className="text-xs font-semibold text-sky-950">同步验证命令</div>
            <CommandLine text={openmaicHandoffSync.proofCommand} />
            <p className="mt-3 text-xs leading-5 text-sky-800">{openmaicHandoffSync.detail}</p>
            {openmaicHandoffSync.missingTokens.length > 0 && (
              <div className="mt-3 rounded-lg bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">
                缺失：{openmaicHandoffSync.missingTokens.slice(0, 6).join('、')}
              </div>
            )}
          </div>
        </div>
        <div className="mb-5 rounded-2xl border border-blue-100 bg-blue-50 p-5" data-testid="a3-openmaic-classroom-capability">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-blue-950">OpenMAIC 多模态课堂桥接</div>
              <p className="mt-2 text-sm leading-6 text-blue-800">
                A3 推荐页生成资源包后，可调用 OpenMAIC generate-classroom，将 classroom job、场景数和 PPTX 可导出状态回写到 A3 resourcePack。
              </p>
            </div>
            <A3Pill tone={data?.resourcePackMetrics?.openmaicClassroom?.status === 'succeeded' ? 'green' : 'orange'}>
              {data?.resourcePackMetrics?.openmaicClassroom?.status ?? 'missing'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 text-xs md:grid-cols-4">
            <MetricInline label="job" value={data?.resourcePackMetrics?.openmaicClassroom?.jobId || '--'} />
            <MetricInline label="scenes" value={`${data?.resourcePackMetrics?.openmaicClassroom?.scenesCount ?? 0}`} />
            <MetricInline label="pptx" value={data?.resourcePackMetrics?.openmaicClassroom?.pptxExportable ? 'exportable' : 'pending'} />
            <MetricInline label="provider" value={data?.resourcePackMetrics?.openmaicClassroom?.provider || '--'} />
          </div>
          {data?.resourcePackMetrics?.openmaicClassroom?.classroomUrl && (
            <Button asChild size="sm" variant="outline" className="mt-4 bg-white" data-testid="a3-openmaic-classroom-capability-open">
              <Link href={data.resourcePackMetrics.openmaicClassroom.classroomUrl}>打开生成课堂</Link>
            </Button>
          )}
          {data?.resourcePackMetrics?.openmaicClassroom?.degradedReason && (
            <div className="mt-3 rounded-xl bg-white px-3 py-2 text-xs leading-5 text-blue-800">
              降级原因：{data.resourcePackMetrics.openmaicClassroom.degradedReason}
            </div>
          )}
        </div>
        <div className="mb-5 rounded-2xl border border-amber-100 bg-amber-50 p-5" data-testid="a3-openmaic-video-capability">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-amber-950">OpenMAIC 视频生成桥接</div>
              <p className="mt-2 text-sm leading-6 text-amber-800">
                A3 七类资源包中的短视频脚本可提交到 /api/generate/video。没有视频 provider key 时，任务会以 failed/degraded 状态写回资源包，并在这里展示。
              </p>
            </div>
            <A3Pill tone={data?.resourcePackMetrics?.openmaicVideo?.status === 'succeeded' ? 'green' : 'orange'}>
              {data?.resourcePackMetrics?.openmaicVideo?.status ?? 'missing'}
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 text-xs md:grid-cols-4">
            <MetricInline label="provider" value={data?.resourcePackMetrics?.openmaicVideo?.provider || '--'} />
            <MetricInline label="resource" value={data?.resourcePackMetrics?.openmaicVideo?.resourceType || '--'} />
            <MetricInline label="duration" value={`${data?.resourcePackMetrics?.openmaicVideo?.duration ?? 0}s`} />
            <MetricInline label="elapsed" value={`${data?.resourcePackMetrics?.openmaicVideo?.elapsedMs ?? 0}ms`} />
          </div>
          {data?.resourcePackMetrics?.openmaicVideo?.videoUrl && (
            <Button asChild size="sm" variant="outline" className="mt-4 bg-white" data-testid="a3-openmaic-video-capability-open">
              <Link href={data.resourcePackMetrics.openmaicVideo.videoUrl}>打开生成视频</Link>
            </Button>
          )}
          {data?.resourcePackMetrics?.openmaicVideo?.degradedReason && (
            <div className="mt-3 rounded-xl bg-white px-3 py-2 text-xs leading-5 text-amber-900">
              降级原因：{data.resourcePackMetrics.openmaicVideo.degradedReason}
            </div>
          )}
        </div>
        <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 p-5" data-testid="a3-openmaic-artifact-audit">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-slate-950">OpenMAIC artifact 审计表</div>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                这里直接读取后端 OpenMAICArtifact 审计表，证明课堂、PPT 和视频产物不是前端临时状态，而是已写入 A3 后端证据链。
              </p>
            </div>
            <A3Pill tone={(artifactAudit?.total ?? 0) > 0 ? 'green' : 'orange'}>
              {artifactAudit?.total ?? 0} records
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 text-xs md:grid-cols-5">
            <MetricInline label="classroom" value={`${artifactAudit?.classroomSucceeded ?? 0}/${artifactAudit?.classroom ?? 0}`} />
            <MetricInline label="pptx" value={`${artifactAudit?.pptxExportSucceeded ?? 0}/${artifactAudit?.pptxExport ?? 0}`} />
            <MetricInline label="video" value={`${artifactAudit?.videoSucceeded ?? 0}/${artifactAudit?.video ?? 0}`} />
            <MetricInline label="degraded" value={`${artifactAudit?.videoDegraded ?? 0}`} />
            <MetricInline label="schema" value={artifactAudit?.schemaVersion ?? 'a3.openmaic-artifact-audit.v1'} />
            <MetricInline label="latest" value={artifactAudit?.latestArtifacts?.[0]?.type ?? '--'} />
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
            {(artifactAudit?.latestArtifacts ?? []).slice(0, 4).map((artifact, index) => (
              <div key={`${artifact.type}-${artifact.jobId || artifact.resourcePackId || index}`} className="rounded-xl border border-slate-200 bg-white p-4" data-testid="a3-openmaic-artifact-audit-item">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-900">{artifact.type}</div>
                  <A3Pill tone={artifact.status === 'succeeded' ? 'green' : 'orange'}>{artifact.status}</A3Pill>
                </div>
                <div className="mt-3 grid gap-1 text-xs leading-5 text-slate-600">
                  <span>provider：{artifact.provider || '--'}</span>
                  <span>pack：{artifact.resourcePackId || artifact.packId || '--'}</span>
                  {artifact.jobId ? <span>job：{artifact.jobId}</span> : null}
                  {artifact.degradedReason ? <span className="text-orange-700">降级：{artifact.degradedReason}</span> : null}
                </div>
              </div>
            ))}
            {!(artifactAudit?.latestArtifacts ?? []).length && (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                暂无 OpenMAIC artifact 审计记录。请先在推荐页生成课堂或视频，或在能力页写回真实 smoke 视频。
              </div>
            )}
          </div>
        </div>
        <div className="mb-5 rounded-2xl border border-emerald-100 bg-emerald-50 p-5" data-testid="a3-openmaic-verification-status">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-emerald-950">OpenMAIC 接入验证状态</div>
              <p className="mt-2 text-sm leading-6 text-emerald-800">
                把“页面分工”和“开源能力接入”对应到可执行测试命令：单元测试证明 payload 转换，E2E 证明 A3 页面链路，smoke 证明真实视频 provider 是否可用。
              </p>
            </div>
            <A3Pill tone={openmaicVerificationSummary.warnings > 0 ? 'orange' : 'green'}>
              {openmaicVerificationSummary.ready}/{openmaicVerificationSummary.total} ready
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 text-xs md:grid-cols-4">
            <MetricInline label="coverage" value={`${openmaicVerificationSummary.coverage}%`} />
            <MetricInline label="E2E" value="a3-openmaic-bridge.spec.ts" />
            <MetricInline label="video provider" value={openmaicVideoProviderConfigured ? 'configured' : 'not configured'} />
            <MetricInline label="smoke" value={openmaicVideoProviderCheck?.detail?.smokeCommand?.toString() || 'pnpm smoke:a3-video'} />
          </div>
          <div className="mt-4 rounded-xl border border-emerald-100 bg-white p-4" data-testid="a3-openmaic-smoke-report">
            <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
              <div>
                <div className="text-sm font-semibold text-emerald-950">最近视频 smoke 报告</div>
                <p className="mt-2 text-xs leading-5 text-emerald-800">
                  脚本会把成功、失败或跳过结果写入 `tmp/a3-openmaic-smoke-report.json`，用于答辩时证明真实 provider 验收状态。页面只展示脱敏摘要，不暴露临时视频 URL。
                </p>
              </div>
              <A3Pill tone={openmaicSmokeReport?.success ? 'green' : 'orange'}>{openmaicSmokeReport?.status ?? 'not_run'}</A3Pill>
            </div>
            <div className="mt-3 grid gap-3 text-xs md:grid-cols-4">
              <MetricInline label="provider" value={openmaicSmokeReport?.provider || '--'} />
              <MetricInline label="checked" value={formatShortDateTime(openmaicSmokeReport?.checkedAt)} />
              <MetricInline label="video" value={openmaicSmokeReport?.hasVideoUrl ? 'url generated' : 'no url'} />
              <MetricInline label="path" value={openmaicSmokeReport?.path || 'tmp/a3-openmaic-smoke-report.json'} />
            </div>
            {openmaicSmokeReport?.reason && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  原因：{openmaicSmokeReport.reason}
              </div>
            )}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="bg-white"
                data-testid="a3-openmaic-smoke-writeback"
                disabled={!canWriteBackOpenMAICSmoke || actionLoading === 'smokeWriteback'}
                onClick={() => void writeBackVideoSmokeReportV2()}
              >
                {actionLoading === 'smokeWriteback' && <Loader2 className="size-4 animate-spin" />}
                <span>写回最近 smoke 视频到资源包</span>
              </Button>
              <span className="text-xs leading-5 text-emerald-700">
                <span className="block">
                  {canWriteBackOpenMAICSmoke
                    ? openmaicSmokeWritebackPackId
                      ? `将写回资源包 ${openmaicSmokeWritebackPackId}`
                      : '未指定资源包时将自动写回最近一个 A3 资源包。'
                    : '只有真实 provider smoke 成功并生成 videoUrl 后才允许写回。'}
                </span>
              </span>
            </div>
            {smokeWritebackResult && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-5 text-emerald-900" data-testid="a3-openmaic-smoke-writeback-result">
                <div className="font-semibold">smoke 视频已写回 A3 资源包</div>
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  <MetricInline label="resourcePack" value={smokeWritebackResult.resourcePackId} />
                  <MetricInline label="trace" value={smokeWritebackResult.traceId || 'recorded'} />
                  <MetricInline label="video" value={smokeWritebackResult.videoUrl ? 'url generated' : 'recorded'} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline" className="bg-white">
                    <Link href={`/a3/resources/${smokeWritebackResult.resourcePackId}`}>查看资源包详情</Link>
                  </Button>
                  {smokeWritebackResult.traceId && (
                    <Button asChild size="sm" variant="outline" className="bg-white">
                      <Link href={`/api/demo/agent-runs/${smokeWritebackResult.traceId}/`}>查看写回 trace</Link>
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {openmaicVerificationSummary.items.map((item) => (
              <div key={item.key} className="rounded-xl border border-emerald-100 bg-white p-4" data-testid="a3-openmaic-verification-item">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-emerald-950">{item.title}</div>
                  <A3Pill tone={item.status === 'ready' ? 'green' : 'orange'}>{item.status}</A3Pill>
                </div>
                <p className="mt-2 text-xs leading-5 text-emerald-800">{item.evidence}</p>
                <div className="mt-3 rounded-lg bg-slate-950 px-3 py-2 font-mono text-[11px] leading-5 text-emerald-200">{item.command}</div>
                <div className="mt-2 line-clamp-2 text-xs leading-5 text-emerald-700">
                  覆盖页面：{item.covers.join('、')}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mb-5 rounded-2xl border border-cyan-100 bg-cyan-50 p-5" data-testid="a3-openmaic-readable-ownership">
          <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
            <div>
              <div className="text-sm font-semibold text-cyan-950">{OPENMAIC_READABLE_TITLE}</div>
              <p className="mt-2 text-sm leading-6 text-cyan-800">{OPENMAIC_READABLE_SUBTITLE}</p>
            </div>
            <A3Pill tone={openmaicPageOwnershipMetrics.ready ? 'green' : 'orange'}>
              {openmaicPageOwnershipMetrics.pagesWithVerification}/{openmaicPageOwnershipMetrics.totalPages} verified
            </A3Pill>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {A3_OPENMAIC_PAGE_OWNERSHIP.map((item) => (
              <div key={`readable-${item.a3Page}`} className="rounded-xl border border-cyan-100 bg-white p-4">
                <div className="text-sm font-semibold text-cyan-950">{item.pageName}</div>
                <div className="mt-3 grid gap-2 text-xs leading-5 text-cyan-800">
                  <MetricInline label={OPENMAIC_READABLE_ROUTE_LABEL} value={item.a3Page} />
                  <MetricInline label={OPENMAIC_READABLE_API_LABEL} value={item.a3Apis.slice(0, 2).join(' | ') || '--'} />
                  <MetricInline label={OPENMAIC_READABLE_VERIFY_LABEL} value={item.verification[0] || '--'} />
                </div>
                <p className="mt-3 text-xs leading-5 text-cyan-700">{item.handoffRule}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3" data-testid="a3-capability-evidence-board">
          {(data?.evidenceBoard ?? []).map((item) => (
            <div key={item.key} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--a3-text)]">{item.title}</div>
                <A3Pill tone={['ready', 'ok', 'warning'].includes(item.status) ? 'green' : 'orange'}>{item.status}</A3Pill>
              </div>
              <p className="mt-3 text-xs leading-5 text-[var(--a3-text-muted)]">{item.detail}</p>
              <div className="mt-3 rounded-lg bg-slate-950 px-3 py-2 font-mono text-[11px] text-emerald-200">{item.path}</div>
            </div>
          ))}
        </div>
      </A3Card>

      <A3Card
        title="推荐检索模式"
        subtitle="默认快速返回学习路径与课堂上下文推荐，深度检索按需触发，避免首页和能力页被知识库向量检索阻塞。"
        action={<A3Pill tone={data?.recommendation.fast?.latencyMs !== undefined && data.recommendation.fast.latencyMs < 1000 ? 'green' : 'orange'}>{data?.recommendation.fast?.latencyMs ?? '--'}ms</A3Pill>}
      >
        <div data-testid="a3-capability-recommendation-modes" className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-emerald-900">Fast 推荐</div>
              <A3Pill tone="green">{data?.recommendation.fast?.mode ?? 'fast'}</A3Pill>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <MetricInline label="耗时" value={`${data?.recommendation.fast?.latencyMs ?? '--'}ms`} />
              <MetricInline label="推荐" value={`${data?.recommendation.fast?.count ?? data?.recommendation.count ?? '--'} 条`} />
              <MetricInline label="来源" value={`${data?.recommendation.fast?.sourceCount ?? data?.recommendation.sourceCount ?? '--'} 条`} />
            </div>
            <p className="mt-3 text-xs leading-5 text-emerald-800">用于首屏体验、今日任务和演示验收，保证反馈及时。</p>
          </div>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-semibold text-blue-900">Deep 推荐</div>
              <A3Pill tone={data?.recommendation.deep?.available ? 'blue' : 'orange'}>{data?.recommendation.deep?.mode ?? 'deep'}</A3Pill>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <MetricInline label="触发" value={data?.recommendation.deep?.trigger ?? '/api/recommend/'} />
              <MetricInline label="状态" value={data?.recommendation.deep?.available ? '可用' : '待检查'} />
              <MetricInline label="阻塞" value="否" />
            </div>
            <p className="mt-3 text-xs leading-5 text-blue-800">{data?.recommendation.deep?.note ?? '推荐页点击深度刷新后触发。'}</p>
          </div>
        </div>
      </A3Card>

      <section className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <A3Card title="核心数据快照" action={<FileJson className="size-4 text-blue-600" />}>
          <div className="grid gap-3 md:grid-cols-2">
            <Metric label="画像" value={data?.profile ? `${data.profile.grade || '未填'} / ${data.profile.foundationLevel || '未判定'}` : '未准备'} />
            <Metric label="路径" value={data?.path ? `${data.path.itemCount} 节点 / ${data.path.progress}%` : '未准备'} />
            <Metric label="推荐" value={data ? `${data.recommendation.count} 条 / 来源 ${data.recommendation.sourceCount}` : '加载中'} />
            <Metric label="句级验证" value={data ? `${data.verification.verifiedClaims}/${data.verification.claimCount} claims` : '加载中'} />
            <Metric label="安全策略" value={data ? `${data.safety.category} / ${data.safety.safe ? '放行' : '拒答'}` : '加载中'} />
            <Metric label="评测集" value={data ? `${data.evaluation.totalCases} 条 (${data.evaluation.groundedCases}+${data.evaluation.unsafeCases})` : '加载中'} />
          </div>
        </A3Card>

        <A3Card title="验收命令" action={<TerminalSquare className="size-4 text-blue-600" />}>
          <CommandLine text="python backend/manage.py validate_demo_flow --strict" />
          <CommandLine text="python backend/manage.py evaluate_demo_retrieval --top-k 3" />
          <CommandLine text="python backend/manage.py evaluate_agent_workflows --generate-demo-traces --json --output backend/tmp/agent_workflow_metrics.json" />
          <CommandLine text="docker compose up --build" />
          <div className="mt-4 rounded-lg bg-blue-50 p-3 text-sm leading-6 text-blue-700">
            指标文件：{data?.evaluation.latestMetricsFile ?? 'backend/tmp/demo_retrieval_metrics.json'}
          </div>
        </A3Card>
      </section>

      <A3Card
        title="Celery Beat 定时任务"
        subtitle="展示后端部署定时任务是否注册，用于证明策略 outcome 回看不是只能手动运行。"
        action={<A3Pill tone={celeryBeatCheck?.status === 'ok' ? 'green' : celeryBeatCheck?.status === 'error' ? 'red' : 'orange'}>{celeryBeatCheck?.status ?? 'missing'}</A3Pill>}
      >
        <div className="grid gap-3 md:grid-cols-4" data-testid="a3-celery-beat-runtime-status">
          <MetricInline label="task" value={String(celeryBeatCheck?.detail?.task ?? 'learning.evaluate_optimization_policy_outcomes')} />
          <MetricInline label="entry" value={String(celeryBeatCheck?.detail?.entry ?? 'a3-evaluate-optimization-policy-outcomes-daily')} />
          <MetricInline label="schedule" value={String(celeryBeatCheck?.detail?.schedule ?? '--')} />
          <MetricInline label="kwargs" value={formatRuntimeDetail(celeryBeatCheck?.detail?.kwargs)} />
        </div>
        <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
          {celeryBeatCheck?.message ?? '等待 /api/a3/system/runtime 合并 Django system health 的 celeryBeat 检查。'}
          <span className="ml-2 text-xs font-semibold">{String(celeryBeatCheck?.detail?.deployment ?? 'docker compose service celery-beat')}</span>
        </div>
      </A3Card>

      <A3Card
        title="Agent 运行治理"
        subtitle="展示最近工作流的重试、超时、契约校验和降级策略，答辩时可直接证明多智能体不是黑盒调用。"
        action={<A3Pill tone={(data?.agentRuntime?.contractViolations ?? 0) > 0 ? 'orange' : 'green'}>runtime</A3Pill>}
      >
        <div className="grid gap-4 xl:grid-cols-[1fr_320px]" data-testid="a3-agent-runtime-governance">
          <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
            <MetricCard label="最近 Trace" value={`${data?.agentRuntime?.recentRuns ?? data?.agentRuns?.length ?? 0}`} />
            <MetricCard label="失败工作流" value={`${data?.agentRuntime?.failedRuns ?? 0}`} />
            <MetricCard label="契约失败" value={`${data?.agentRuntime?.contractViolations ?? 0}`} />
            <MetricCard label="重试策略" value={`${data?.agentRuntime?.retryPolicies ?? 0}`} />
            <MetricCard label="实际重试" value={`${data?.agentRuntime?.retryAttempts ?? 0}`} />
            <MetricCard label="超时步骤" value={`${data?.agentRuntime?.timedOutSteps ?? 0}`} />
            <MetricCard label="预算违约" value={`${data?.agentRuntime?.budgetBreaches ?? 0}`} />
            <MetricCard label="慢步骤" value={`${data?.agentRuntime?.slowSteps?.length ?? 0}`} />
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-slate-100">
            <div className="text-sm font-semibold text-emerald-200">Latest Runtime Policy</div>
            {data?.agentRuntime?.latestPolicy ? (
              <div className="mt-4 space-y-2 text-xs leading-5">
                <MetricInline label="workflow" value={data.agentRuntime.latestPolicy.workflow ?? '--'} />
                <MetricInline label="step" value={data.agentRuntime.latestPolicy.step ?? '--'} />
                <MetricInline label="max retries" value={`${data.agentRuntime.latestPolicy.maxRetries}`} />
                <MetricInline label="timeout" value={data.agentRuntime.latestPolicy.timeoutMs == null ? 'none' : `${data.agentRuntime.latestPolicy.timeoutMs}ms`} />
                <MetricInline label="attempts" value={`${data.agentRuntime.latestPolicy.attempts}`} />
                <MetricInline label="elapsed" value={data.agentRuntime.latestPolicy.elapsedMs == null ? '--' : `${data.agentRuntime.latestPolicy.elapsedMs}ms`} />
                <MetricInline label="errors" value={`${data.agentRuntime.latestPolicy.errors.length}`} />
              </div>
            ) : (
              <p className="mt-4 text-sm leading-6 text-slate-300">暂无 runtimePolicy，触发推荐或课堂问答后会显示重试和超时策略。</p>
            )}
            <div className="mt-4 rounded-xl bg-white/10 p-3 text-xs leading-5 text-slate-300">
              fallback: {formatFallbackStrategies(data?.agentRuntime?.fallbackStrategies)}
            </div>
          </div>
          <div className="xl:col-span-2 rounded-2xl border border-amber-200 bg-amber-50 p-5" data-testid="a3-agent-runtime-slow-steps">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-amber-950">Agent 性能预算追踪</div>
                <p className="mt-1 text-xs leading-5 text-amber-800">展示接近超时或已经超出预算的步骤，用于定位 Retriever、Teacher、Verifier 等慢 Agent。</p>
              </div>
              <A3Pill tone={(data?.agentRuntime?.budgetBreaches ?? 0) > 0 ? 'orange' : 'green'}>
                {data?.agentRuntime?.budgetBreaches ?? 0} breaches
              </A3Pill>
            </div>
            {(data?.agentRuntime?.slowSteps ?? []).length > 0 ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(data?.agentRuntime?.slowSteps ?? []).slice(0, 4).map((step, index) => (
                  <div key={`${step.workflow}-${step.agent}-${index}`} className="rounded-xl border border-amber-200 bg-white/80 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-slate-950">{step.agent ?? 'unknown agent'}</div>
                      <A3Pill tone={step.status === 'timeout' || step.status === 'breach' ? 'orange' : 'slate'}>{step.status}</A3Pill>
                    </div>
                    <div className="mt-2 text-xs text-slate-600">{step.workflow ?? 'unknown workflow'}</div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-amber-100">
                      <div className={step.status === 'timeout' || step.status === 'breach' ? 'h-full rounded-full bg-orange-500' : 'h-full rounded-full bg-amber-500'} style={{ width: `${Math.min(100, Math.max(4, Math.round(step.budgetRatio * 100)))}%` }} />
                    </div>
                    <div className="mt-2 text-xs font-medium text-amber-900">
                      {step.elapsedMs}ms / {step.timeoutMs}ms 路 {formatBudgetRatio(step.budgetRatio)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">
                当前最近 trace 没有接近预算或超预算步骤。
              </div>
            )}
          </div>
        </div>
      </A3Card>

      <A3Card
        title="Agent Trace Waterfall"
        subtitle="展示最近关键工作流的 traceId、schema、耗时、降级策略和每个 Agent 步骤，便于答辩时证明系统可追踪、可解释、可降级。"
        action={<A3Pill tone={filteredAgentRuns.length > 0 ? 'green' : 'orange'}>{filteredAgentRuns.length}/{data?.agentRuns?.length ?? 0} traces</A3Pill>}
      >
        <div className="space-y-4" data-testid="a3-agent-trace-waterfall">
          <div className="flex flex-wrap gap-2" data-testid="a3-agent-trace-workflow-filter">
            {workflowOptions.map((workflow) => (
              <button
                key={workflow}
                type="button"
                onClick={() => setWorkflowFilter(workflow)}
                className={
                  workflowFilter === workflow
                    ? 'rounded-full bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm'
                    : 'rounded-full border border-[var(--a3-border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--a3-text-muted)] hover:border-blue-200 hover:text-blue-700'
                }
              >
                {workflow === 'all' ? '全部' : workflow}
              </button>
            ))}
          </div>
          {(data?.agentRuns ?? []).length === 0 && (
            <div className="rounded-xl bg-slate-50 p-4 text-sm text-[var(--a3-text-muted)]">
              暂无 Agent 轨迹。完成推荐、课堂问答、验证或测评后会自动生成 trace。
            </div>
          )}
          {(data?.agentRuns ?? []).length > 0 && filteredAgentRuns.length === 0 && (
            <div className="rounded-xl bg-slate-50 p-4 text-sm text-[var(--a3-text-muted)]">
              当前没有 `{workflowFilter}` 的最近 trace。点击“资源生成评测”或对应业务按钮后会写入真实 AgentRun。
            </div>
          )}
          {filteredAgentRuns.map((run) => (
            <div key={run.traceId} className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-[var(--a3-text)]">{run.workflow}</span>
                    <A3Pill tone={run.status === 'completed' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>{run.status}</A3Pill>
                    <A3Pill tone={run.fallbackStrategy && run.fallbackStrategy !== 'none' ? 'orange' : 'slate'}>
                      fallback: {run.fallbackStrategy ?? 'none'}
                    </A3Pill>
                  </div>
                  <div className="mt-2 text-xs text-[var(--a3-text-muted)]">
                    traceId: <span className="font-mono">{run.traceId}</span> · schema: {run.schemaVersion ?? 'legacy'} · {run.goal}
                  </div>
                  <div className="mt-1 text-xs text-blue-700">{formatTracePolicy(run.metadata)}</div>
                </div>
                <div className="rounded-xl bg-white px-3 py-2 text-right text-sm font-semibold text-blue-700 shadow-sm">
                  {run.latencyMs}ms
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2" data-testid="a3-agent-trace-actions">
                <TraceAuditAction href={run.detailUrl} label="查看详情" icon={<Eye className="size-3.5" />} />
                <TraceAuditAction href={run.exportJsonUrl} label="导出 JSON" icon={<FileJson className="size-3.5" />} download />
                <TraceAuditAction href={run.exportMarkdownUrl} label="导出 Markdown" icon={<Download className="size-3.5" />} download />
              </div>
              <div className="mt-4 space-y-3">
                {run.steps.map((step, index) => {
                  const width = `${Math.min(100, Math.max(8, Math.round((step.latencyMs / Math.max(run.latencyMs, 1)) * 100)))}%`;
                  const runtimePolicy = getRuntimePolicy(step.metadata);
                  const outputSchema = getOutputSchema(step.metadata);
                  const degradation = getDegradation(step.metadata);
                  const stepRetrievalMode = getRetrievalModeFromMetadata(step.metadata);
                  return (
                    <div key={`${run.traceId}-${step.order ?? index}`} className="grid gap-2 md:grid-cols-[190px_1fr_80px] md:items-center">
                      <div className="text-sm">
                        <div className="font-semibold text-[var(--a3-text)]">
                          {step.order ?? index + 1}. {step.name}
                        </div>
                        <div className="text-xs text-[var(--a3-text-muted)]">{step.role}</div>
                      </div>
                      <div>
                        <div className="h-3 overflow-hidden rounded-full bg-white">
                          <div className={step.status === 'failed' ? 'h-full rounded-full bg-rose-500' : 'h-full rounded-full bg-blue-600'} style={{ width }} />
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{step.detail}</div>
                        {stepRetrievalMode && (
                          <div className="mt-2 inline-flex rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700" data-testid="a3-agent-step-rag-mode">
                            RAG: {stepRetrievalMode}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px]" data-testid="a3-agent-step-schema-degradation">
                          {outputSchema && (
                            <span className={outputSchema.valid ? 'rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700' : 'rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700'}>
                              schema {outputSchema.schemaVersion} · {outputSchema.valid ? 'valid' : `${outputSchema.errors.length} errors`}
                            </span>
                          )}
                          {degradation && (
                            <span className={degradation.degraded ? 'rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 font-semibold text-orange-700' : 'rounded-full border border-slate-200 bg-white px-2.5 py-1 font-semibold text-slate-600'}>
                              {degradation.degraded ? 'degraded' : 'normal'} · {degradation.fallbackStrategy || 'none'}
                            </span>
                          )}
                        </div>
                        {runtimePolicy && (
                          <div className="mt-2 rounded-xl border border-slate-200 bg-white/80 p-2 text-[11px] text-slate-600" data-testid="a3-agent-step-runtime-policy">
                            <div className="grid gap-2 md:grid-cols-4">
                              <span>retry {runtimePolicy.maxRetries}</span>
                              <span>attempts {runtimePolicy.attempts}</span>
                              <span>timeout {runtimePolicy.timeoutMs == null ? 'none' : `${runtimePolicy.timeoutMs}ms`}</span>
                              <span className={runtimePolicy.timedOut ? 'font-semibold text-rose-600' : 'text-slate-500'}>
                                {runtimePolicy.timedOut ? 'timed out' : formatRuntimePolicyErrors(runtimePolicy.errors)}
                              </span>
                            </div>
                            {runtimePolicy.errors.length > 0 && (
                              <div className="mt-2 rounded-lg bg-rose-50 px-2 py-1 font-mono text-[10px] leading-4 text-rose-700" title={runtimePolicy.errors.join('\n')}>
                                {runtimePolicy.errors[0]}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-xs font-semibold text-[var(--a3-text-muted)]">{step.latencyMs}ms</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </A3Card>

      <A3Card title="系统健康" action={<ShieldCheck className="size-4 text-emerald-600" />}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(data?.system.checks ?? []).map((check) => (
            <div key={check.name} className="rounded-xl border border-[var(--a3-border)] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--a3-text)]">{check.name}</div>
                <A3Pill tone={check.status === 'ok' ? 'green' : check.status === 'warning' ? 'orange' : 'red'}>{check.status}</A3Pill>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{check.message}</p>
            </div>
          ))}
        </div>
      </A3Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] p-3">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-surface-muted)] p-4">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function MetricInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/70 p-2">
      <div className="text-[11px] text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 truncate text-xs font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function formatRuntimeDetail(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return '--';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatShortDateTime(value?: string) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function CommandLine({ text }: { text: string }) {
  return <div className="mt-2 rounded-lg bg-slate-950 px-3 py-2 font-mono text-xs text-emerald-200">{text}</div>;
}

function TraceAuditAction({ href, label, icon, download = false }: { href?: string; label: string; icon: React.ReactNode; download?: boolean }) {
  if (!href) {
    return (
      <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-100 px-2.5 text-xs font-medium text-slate-400" aria-disabled="true">
        {icon}
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      download={download}
      target={download ? '_blank' : undefined}
      rel={download ? 'noreferrer' : undefined}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
    >
      {icon}
      {label}
    </a>
  );
}

type RuntimePolicy = {
  maxRetries: number;
  timeoutMs?: number | null;
  attempts: number;
  timedOut?: boolean;
  errors: string[];
};

type OutputSchemaStatus = {
  schemaVersion: string;
  valid: boolean;
  errors: string[];
};

type DegradationStatus = {
  status: string;
  degraded: boolean;
  fallbackStrategy: string;
  reason?: string;
};

function extractLatestRetrievalMode(runs?: DemoStatusResponse['agentRuns']) {
  for (const run of runs ?? []) {
    for (const step of run.steps ?? []) {
      const mode = getRetrievalModeFromMetadata(step.metadata);
      if (mode) {
        return { mode, agent: step.name, traceId: run.traceId };
      }
    }
  }
  return { mode: 'unknown', agent: '--', traceId: '' };
}

function getRetrievalModeFromMetadata(metadata?: Record<string, unknown>) {
  const evidence = metadata?.evidence;
  if (evidence && typeof evidence === 'object') {
    const mode = (evidence as Record<string, unknown>).retrievalMode;
    if (typeof mode === 'string' && mode.trim()) {
      return mode;
    }
  }
  const direct = metadata?.retrievalMode;
  if (typeof direct === 'string' && direct.trim()) {
    return direct;
  }
  return '';
}

function getRuntimePolicy(metadata?: Record<string, unknown>): RuntimePolicy | null {
  const policy = metadata?.runtimePolicy;
  if (!policy || typeof policy !== 'object') {
    return null;
  }
  const value = policy as Record<string, unknown>;
  return {
    maxRetries: Number(value.maxRetries ?? 0),
    timeoutMs: value.timeoutMs == null ? null : Number(value.timeoutMs),
    attempts: Number(value.attempts ?? 0),
    timedOut: Boolean(value.timedOut),
    errors: Array.isArray(value.errors) ? value.errors.map(String) : [],
  };
}

function getOutputSchema(metadata?: Record<string, unknown>): OutputSchemaStatus | null {
  const schema = metadata?.outputSchema;
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const value = schema as Record<string, unknown>;
  return {
    schemaVersion: typeof value.schemaVersion === 'string' ? value.schemaVersion : 'a3.agent-output.v1',
    valid: Boolean(value.valid),
    errors: Array.isArray(value.errors) ? value.errors.map(String) : [],
  };
}

function getDegradation(metadata?: Record<string, unknown>): DegradationStatus | null {
  const degradation = metadata?.degradation;
  if (!degradation || typeof degradation !== 'object') {
    return null;
  }
  const value = degradation as Record<string, unknown>;
  return {
    status: typeof value.status === 'string' ? value.status : '',
    degraded: Boolean(value.degraded),
    fallbackStrategy: typeof value.fallbackStrategy === 'string' ? value.fallbackStrategy : 'none',
    reason: typeof value.reason === 'string' ? value.reason : '',
  };
}

function formatRuntimePolicyErrors(errors: string[]) {
  if (!errors.length) {
    return 'ok';
  }
  return `${errors.length} errors`;
}

function formatTracePolicy(metadata?: Record<string, unknown>) {
  const policy = metadata?.runtimePolicy;
  if (!policy || typeof policy !== 'object') {
    return 'runtime policy: recorded at step level';
  }
  return 'runtime policy: available';
}

function formatFallbackStrategies(strategies?: Record<string, number>) {
  if (!strategies || Object.keys(strategies).length === 0) {
    return 'none';
  }
  return Object.entries(strategies)
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}

function formatPercent(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '--';
  }
  return `${Math.round(value)}%`;
}

function formatRatioPercent(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '--';
  }
  return `${Math.round(value * 100)}%`;
}

function formatBudgetRatio(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return '--';
  }
  return `${Math.round(value * 100)}% budget`;
}

function formatDateTime(value?: string) {
  if (!value) {
    return '--';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}
