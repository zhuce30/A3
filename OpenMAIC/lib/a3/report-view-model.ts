import type { KnowledgePointInsight, LearningReport } from './assessment-types';
import type { StudyPlan, StudyPlanTask } from './learning-types';

export type ReportAction = {
  label: string;
  href: string;
  estimatedMinutes: number;
  expectedOutcome: string;
};

export type ReportChange = {
  kind: 'progress' | 'stable' | 'risk' | 'insufficient';
  title: string;
  value: string;
  comparison: string;
  explanation: string;
};

export type WeakKnowledgePointInsight = {
  knowledgePoint: string;
  evidence: string;
  status: '待巩固' | '改善中' | '较稳定' | '证据不足';
  reason: string;
  action: ReportAction;
};

export type SevenDayReportAction = ReportAction & {
  id: string;
  order: number;
  completionCriteria: string;
  feedback: string;
};

export type SevenDayReportPlan = {
  title: '从今天开始的 7 天行动';
  goal: string;
  actions: SevenDayReportAction[];
  latestAdjustment: { title: string; reason: string } | null;
};

export type LearningMethodEffect = {
  title: string;
  conclusion: string;
  evidence: string[];
  evidenceState: 'ready' | 'partial' | 'insufficient';
  action?: ReportAction;
};

export type AlgorithmLabReportSection = {
  title: '算法实验学习证据';
  conclusion: string;
  evidenceLabel: string;
  metrics: Array<{ label: string; value: string }>;
  reviewSignal: string | null;
  action: { label: string; href: string };
};

export type LearningEffectReport = {
  assessment?: {
    attemptCount?: number;
    averageScore?: number;
    correctRate?: number;
    wrongQuestionCount?: number;
    reviewedWrongQuestionCount?: number;
  };
  knowledgePoints?: Array<{
    knowledgePointId: string;
    name: string;
    preScore: number;
    postScore: number;
    learningGain: number;
    attemptCount: number;
    correctRate: number;
    wrongCount: number;
    reviewCount: number;
    trend: string;
    confidence: string;
    evidence?: string[];
  }>;
  resourceUsage?: {
    opened?: number;
    completed?: number;
    skipped?: number;
    favorited?: number;
    totalFeedback?: number;
  };
  resourceEffectiveness?: number;
  masterySignals?: { averageFeedbackScore?: number; weakPoints?: string[] };
  planExecution?: { taskCount?: number; completedTasks?: number; completionRate?: number };
  updatedAt?: string;
  [key: string]: unknown;
};

export type StudentReportViewModel = {
  period: {
    key: '7d' | '30d' | 'term';
    label: string;
    start: string;
    end: string;
    updatedAt: string;
  };
  overview: {
    headline: string;
    summary: string;
    progressSignal: string;
    primaryRisk: string;
    primaryAction: ReportAction;
  };
  changes: ReportChange[];
  weakKnowledgePoints: WeakKnowledgePointInsight[];
  sevenDayPlan: SevenDayReportPlan;
  effectiveMethods: LearningMethodEffect[];
  algorithmLabEffect: AlgorithmLabReportSection | null;
  evidenceState: 'ready' | 'partial' | 'insufficient';
};

const INTERNAL_LABELS = [
  'eventStream',
  'decisionHistory',
  'schemaVersion',
  'v2 事件',
  '候选数',
  '决策分',
  'pending',
];

export function buildStudentReportViewModel(input: {
  report: LearningReport;
  studyPlan?: StudyPlan | null;
  effectReport?: LearningEffectReport | null;
}): StudentReportViewModel {
  const { report, studyPlan = null, effectReport = null } = input;
  const periodKey = normalizePeriodKey(report.period.key);
  const answered = nonNegative(report.metrics.answeredQuestions);
  const activeWrong = nonNegative(report.metrics.activeWrongQuestions);
  const savedPlanAction = firstPendingPlanTask(studyPlan);
  const fallbackAction = buildFallbackAction({ answered, activeWrong, savedPlanAction });
  const backendSummary = report.studentSummary;
  const primaryAction = normalizeAction(backendSummary?.primaryAction, fallbackAction);
  const evidenceState = report.dataQuality?.evidenceState ?? deriveEvidenceState(report);

  return {
    period: {
      key: periodKey,
      label: periodLabel(periodKey),
      start: report.period.start,
      end: report.period.end,
      updatedAt: report.updatedAt,
    },
    overview: {
      headline: safeStudentText(backendSummary?.headline, fallbackHeadline(answered, activeWrong)),
      summary: safeStudentText(backendSummary?.summary, fallbackSummary(report)),
      progressSignal: safeStudentText(backendSummary?.progressSignal, fallbackProgressSignal(report)),
      primaryRisk: safeStudentText(backendSummary?.primaryRisk, fallbackRisk(report)),
      primaryAction,
    },
    changes: buildChanges(report),
    weakKnowledgePoints: (report.knowledgePointInsights ?? []).slice(0, 3).map(mapKnowledgePointInsight),
    sevenDayPlan: buildSevenDayPlan(report, studyPlan),
    effectiveMethods: buildEffectiveMethods(report, effectReport),
    algorithmLabEffect: buildAlgorithmLabEffect(report),
    evidenceState,
  };
}

function buildAlgorithmLabEffect(report: LearningReport): AlgorithmLabReportSection | null {
  const effect = report.algorithmLabEffect;
  const completedRuns = Math.floor(nonNegative(effect?.completedRuns));
  if (!effect || completedRuns === 0) return null;

  const verifiedRuns = Math.min(completedRuns, Math.floor(nonNegative(effect.verifiedRuns)));
  const explorationRuns = completedRuns - verifiedRuns;
  const evidenceLabel = verifiedRuns > 0
    ? `${verifiedRuns} 次已验证掌握证据${explorationRuns > 0 ? `，${explorationRuns} 次探索活动` : ''}`
    : `${completedRuns} 次探索活动，尚无已验证掌握证据`;
  const labNames: Record<string, string> = {
    'cpu-scheduling': 'CPU 调度算法实验',
    'page-replacement': '页面置换算法实验',
  };
  const weakLab = effect.byLab
    .filter((item) => labNames[item.labId] && nonNegative(item.completedRuns) > 0 && nonNegative(item.bestScore) < 80)
    .sort((left, right) => nonNegative(left.bestScore) - nonNegative(right.bestScore))[0];
  const commonSignal = effect.commonReviewSignals
    .filter((item) => Number.isInteger(item.stepIndex) && item.stepIndex >= 0 && nonNegative(item.count) > 0)
    .sort((left, right) => nonNegative(right.count) - nonNegative(left.count) || left.stepIndex - right.stepIndex)[0];

  return {
    title: '算法实验学习证据',
    conclusion: `你完成了 ${completedRuns} 次算法实验，其中 ${verifiedRuns} 次使用标准案例，可作为掌握证据。`,
    evidenceLabel,
    metrics: [
      { label: '完成实验', value: `${completedRuns} 次` },
      { label: '预测准确率', value: `${boundedPercentage(effect.predictionAccuracy).toFixed(1)}%` },
      { label: '检查题正确率', value: `${boundedPercentage(effect.checkpointAccuracy).toFixed(1)}%` },
      { label: '复查步骤', value: `${Math.floor(nonNegative(effect.reviewedStepCount))} 个` },
    ],
    reviewSignal: commonSignal
      ? `第 ${commonSignal.stepIndex} 步复查 ${Math.floor(nonNegative(commonSignal.count))} 次`
      : null,
    action: weakLab
      ? { label: `复练 ${labNames[weakLab.labId]}`, href: `/a3/labs/${weakLab.labId}` }
      : { label: effect.nextAction.label.trim() || '继续交互实验', href: '/a3/labs' },
  };
}

function normalizePeriodKey(key: LearningReport['period']['key']): '7d' | '30d' | 'term' {
  return key === '7d' || key === '30d' ? key : 'term';
}

function periodLabel(key: '7d' | '30d' | 'term'): string {
  if (key === '7d') return '近 7 天';
  if (key === '30d') return '近 30 天';
  return '本学期';
}

function safeStudentText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || INTERNAL_LABELS.some((label) => normalized.includes(label))) return fallback;
  return normalized;
}

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

function boundedPercentage(value: number | null | undefined): number {
  return Math.min(100, nonNegative(value));
}

function normalizeAction(
  action: Partial<ReportAction> | undefined,
  fallback: ReportAction,
): ReportAction {
  const href = action?.href?.trim() ?? '';
  const label = safeStudentText(action?.label, fallback.label);
  const expectedOutcome = safeStudentText(action?.expectedOutcome, fallback.expectedOutcome);
  const estimatedMinutes = nonNegative(action?.estimatedMinutes);
  if (!href.startsWith('/a3/') || !label || !expectedOutcome || estimatedMinutes <= 0) return fallback;
  return { label, href, estimatedMinutes, expectedOutcome };
}

function fallbackHeadline(answered: number, activeWrong: number): string {
  if (answered === 0) return '先完成一次测评，建立第一份学习证据';
  if (activeWrong > 0) return '本周期已有学习记录，下一步先巩固错题';
  return '本周期学习状态较稳定，继续按计划推进';
}

function fallbackSummary(report: LearningReport): string {
  const answered = nonNegative(report.metrics.answeredQuestions);
  if (answered === 0) return '当前还没有可用于判断掌握情况的作答记录。';
  return `本周期完成 ${answered} 次作答，当前有 ${nonNegative(report.metrics.activeWrongQuestions)} 道错题待巩固。`;
}

function fallbackProgressSignal(report: LearningReport): string {
  const answered = nonNegative(report.metrics.answeredQuestions);
  if (answered === 0) return '暂无可比较的作答记录';
  const comparison = report.comparisons?.accuracy;
  if (!comparison?.comparable || comparison.percentagePointChange === null) {
    return `本周期已完成 ${answered} 次作答，趋势样本仍需积累`;
  }
  const delta = comparison.percentagePointChange;
  if (delta === 0) return '正确率与上一等长周期持平';
  return `正确率较上一等长周期${delta > 0 ? '提升' : '下降'} ${Math.abs(delta).toFixed(1)} 个百分点`;
}

function fallbackRisk(report: LearningReport): string {
  const activeWrong = nonNegative(report.metrics.activeWrongQuestions);
  if (activeWrong > 0) return `${activeWrong} 道错题尚未巩固`;
  if (nonNegative(report.metrics.answeredQuestions) < 3) return '作答样本不足，暂时无法定位稳定薄弱点';
  return '当前没有待巩固错题，需要用新题继续验证掌握情况';
}

function buildFallbackAction(input: {
  answered: number;
  activeWrong: number;
  savedPlanAction: ReportAction | null;
}): ReportAction {
  if (input.activeWrong > 0) {
    return {
      label: `复盘 ${input.activeWrong} 道错题`,
      href: '/a3/wrong-notebook',
      estimatedMinutes: Math.min(20, Math.max(8, input.activeWrong * 4)),
      expectedOutcome: '完成复盘后重新作答，更新掌握状态。',
    };
  }
  if (input.savedPlanAction) return input.savedPlanAction;
  if (input.answered < 3) {
    return {
      label: '完成一次阶段测评',
      href: '/a3/assessment',
      estimatedMinutes: 10,
      expectedOutcome: '新增真实作答记录后，报告会更新薄弱点和趋势。',
    };
  }
  return {
    label: '继续今日任务',
    href: '/a3/today',
    estimatedMinutes: 10,
    expectedOutcome: '完成任务后更新学习进度和计划完成度。',
  };
}

function buildChanges(report: LearningReport): ReportChange[] {
  const changes: ReportChange[] = [];
  const answered = nonNegative(report.metrics.answeredQuestions);
  const accuracy = report.comparisons?.accuracy;
  if (answered === 0) {
    changes.push({
      kind: 'insufficient',
      title: '答题表现',
      value: '暂无作答',
      comparison: '缺少比较基线',
      explanation: '完成一次测评后，才能判断正确率变化。',
    });
  } else if (accuracy?.comparable && accuracy.currentValue !== null && accuracy.percentagePointChange !== null) {
    const delta = accuracy.percentagePointChange;
    changes.push({
      kind: delta > 0 ? 'progress' : delta < 0 ? 'risk' : 'stable',
      title: '答题正确率',
      value: `${accuracy.currentValue.toFixed(1)}%`,
      comparison: delta === 0 ? '与上一等长周期持平' : `较上一等长周期${delta > 0 ? '提升' : '下降'} ${Math.abs(delta).toFixed(1)} 个百分点`,
      explanation: accuracy.reason,
    });
  } else {
    changes.push({
      kind: 'insufficient',
      title: '答题正确率',
      value: `${report.metrics.accuracy.toFixed(1)}%`,
      comparison: '比较样本不足',
      explanation: accuracy?.reason || '当前周期和上一周期都至少完成 3 次作答后再判断变化。',
    });
  }

  const weekly = report.weeklySummary;
  if (weekly && weekly.totalTasks > 0) {
    changes.push({
      kind: weekly.planCompletion >= 80 ? 'progress' : weekly.planCompletion >= 50 ? 'stable' : 'risk',
      title: '计划执行',
      value: `${weekly.completedTasks}/${weekly.totalTasks} 项`,
      comparison: `完成率 ${weekly.planCompletion.toFixed(0)}%`,
      explanation: weekly.recommendation || '按计划完成任务后，学习路径进度会同步更新。',
    });
  } else if (report.metrics.totalKnowledgePoints > 0) {
    changes.push({
      kind: report.metrics.pathProgress >= 60 ? 'progress' : 'stable',
      title: '学习路径',
      value: `${nonNegative(report.metrics.masteredKnowledgePoints)}/${nonNegative(report.metrics.totalKnowledgePoints)} 个知识点`,
      comparison: `路径进度 ${nonNegative(report.metrics.pathProgress).toFixed(0)}%`,
      explanation: '该进度来自当前学习路径中的已完成知识点。',
    });
  }

  if (report.metrics.studyDays > 0) {
    changes.push({
      kind: report.metrics.studyDays >= 5 ? 'progress' : 'stable',
      title: '学习节奏',
      value: `${nonNegative(report.metrics.studyDays)} 天`,
      comparison: `累计学习 ${nonNegative(report.metrics.studyMinutes)} 分钟`,
      explanation: `统计范围为${periodLabel(normalizePeriodKey(report.period.key))}。`,
    });
  }
  return changes.slice(0, 3);
}

function mapKnowledgePointInsight(insight: KnowledgePointInsight): WeakKnowledgePointInsight {
  const statusMap: Record<KnowledgePointInsight['status'], WeakKnowledgePointInsight['status']> = {
    needs_review: '待巩固',
    improving: '改善中',
    stable: '较稳定',
    insufficient_evidence: '证据不足',
  };
  const evidenceParts = [`作答 ${nonNegative(insight.answeredCount)} 次`, `错误 ${nonNegative(insight.wrongCount)} 次`];
  if (insight.latestResult === 'correct') evidenceParts.push('最近一次正确');
  if (insight.latestResult === 'incorrect') evidenceParts.push('最近一次错误');
  if (insight.activeWrongQuestions > 0) evidenceParts.push(`${insight.activeWrongQuestions} 道错题待巩固`);
  return {
    knowledgePoint: safeStudentText(insight.knowledgePoint, '未命名知识点'),
    evidence: evidenceParts.join(' · '),
    status: statusMap[insight.status] ?? '证据不足',
    reason: safeStudentText(insight.reason, '需要更多作答记录后再判断。'),
    action: normalizeAction(
      { ...insight.action, expectedOutcome: '完成后更新该知识点的掌握判断。' },
      {
        label: '完成专项测评',
        href: '/a3/assessment',
        estimatedMinutes: 10,
        expectedOutcome: '新增作答记录后更新该知识点的掌握判断。',
      },
    ),
  };
}

function buildSevenDayPlan(report: LearningReport, studyPlan: StudyPlan | null): SevenDayReportPlan {
  const pendingTasks = pendingPlanTasks(studyPlan).slice(0, 3);
  const actions = pendingTasks.map(({ task }, index) => mapPlanTask(task, index));
  if (actions.length === 0) {
    actions.push({
      id: 'create-study-plan',
      order: 1,
      label: studyPlan ? '安排下一项今日任务' : '生成个性化学习计划',
      href: studyPlan ? '/a3/today' : '/a3/study-plan',
      estimatedMinutes: 5,
      expectedOutcome: '形成可执行的后续学习安排。',
      completionCriteria: studyPlan ? '今日任务中出现下一项可执行内容' : '生成包含每日任务的学习计划',
      feedback: '计划生成或调整后会同步到今日任务和学习报告。',
    });
  }

  const adjustment = [...(studyPlan?.adjustmentTimeline ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    title: '从今天开始的 7 天行动',
    goal: safeStudentText(
      report.weeklyPrescription?.weeklyTarget.label,
      studyPlan?.coachTip || '完成当前第一步，并用作答结果更新后续安排。',
    ),
    actions,
    latestAdjustment: adjustment
      ? {
          title: safeStudentText(adjustment.title, '学习计划已调整'),
          reason: safeStudentText(adjustment.reason, '根据最近学习记录调整任务顺序。'),
        }
      : null,
  };
}

function pendingPlanTasks(studyPlan: StudyPlan | null): Array<{ task: StudyPlanTask; dayIndex: number }> {
  if (!studyPlan?.days?.length) return [];
  return [...studyPlan.days]
    .sort((a, b) => a.dayIndex - b.dayIndex)
    .flatMap((day) => day.tasks.filter((task) => task.status !== 'completed').map((task) => ({ task, dayIndex: day.dayIndex })));
}

function firstPendingPlanTask(studyPlan: StudyPlan | null): ReportAction | null {
  const first = pendingPlanTasks(studyPlan)[0]?.task;
  if (!first) return null;
  return {
    label: safeStudentText(first.title, '继续学习计划'),
    href: first.href.startsWith('/a3/') ? first.href : '/a3/today',
    estimatedMinutes: Math.max(1, nonNegative(first.estimatedMinutes)),
    expectedOutcome: safeStudentText(first.subtitle, '完成后更新学习计划进度。'),
  };
}

function mapPlanTask(task: StudyPlanTask, index: number): SevenDayReportAction {
  const action = firstPendingPlanTask({ days: [{ dayIndex: 1, tasks: [task] }] } as StudyPlan)!;
  return {
    ...action,
    id: task.id || `report-action-${index + 1}`,
    order: index + 1,
    completionCriteria: safeStudentText(task.subtitle, '完成任务并记录学习结果。'),
    feedback: feedbackForTask(task.type),
  };
}

function feedbackForTask(type: StudyPlanTask['type']): string {
  if (type === 'review') return '复盘结果会更新错题掌握状态和薄弱点。';
  if (type === 'practice') return '作答结果会更新正确率、错题本和后续推荐。';
  if (type === 'resource_pack') return '资源完成记录会进入学习效果评估。';
  return '完成状态会更新学习计划和路径进度。';
}

function buildEffectiveMethods(
  report: LearningReport,
  effectReport: LearningEffectReport | null,
): LearningMethodEffect[] {
  if (!effectReport) return [insufficientMethodEffect()];
  const methods: LearningMethodEffect[] = [];
  const strongestPoint = [...(effectReport.knowledgePoints ?? [])]
    .filter((point) => point.attemptCount > 0 && Number.isFinite(point.learningGain))
    .sort((a, b) => b.learningGain - a.learningGain)[0];
  if (strongestPoint) {
    const enoughEvidence = strongestPoint.attemptCount >= 3;
    methods.push({
      title: `围绕“${safeStudentText(strongestPoint.name, '当前知识点')}”的专项练习`,
      conclusion: enoughEvidence
        ? `练习后得分较练习前${strongestPoint.learningGain >= 0 ? '提高' : '下降'} ${Math.abs(strongestPoint.learningGain).toFixed(1)} 分。`
        : '已有练习记录，但还需要更多作答才能判断是否稳定有效。',
      evidence: [
        `共完成 ${nonNegative(strongestPoint.attemptCount)} 次作答`,
        `练习前 ${nonNegative(strongestPoint.preScore).toFixed(1)} 分，练习后 ${nonNegative(strongestPoint.postScore).toFixed(1)} 分`,
      ],
      evidenceState: enoughEvidence ? 'ready' : 'partial',
      action: {
        label: '继续专项练习',
        href: '/a3/assessment',
        estimatedMinutes: 10,
        expectedOutcome: '用新题验证当前提升是否稳定。',
      },
    });
  }

  const opened = nonNegative(effectReport.resourceUsage?.opened);
  const completed = nonNegative(effectReport.resourceUsage?.completed);
  if (opened > 0) {
    methods.push({
      title: '推荐资源学习',
      conclusion: completed > 0 ? `已完成 ${completed}/${opened} 份打开过的资源。` : '已有资源浏览记录，但还没有完成记录。',
      evidence: [`打开 ${opened} 份`, `完成 ${completed} 份`],
      evidenceState: completed > 0 ? 'partial' : 'insufficient',
      action: {
        label: completed > 0 ? '查看下一份推荐' : '继续完成推荐资源',
        href: '/a3/recommendations',
        estimatedMinutes: 15,
        expectedOutcome: '完成资源学习后，通过专项测评验证效果。',
      },
    });
  }

  if (methods.length === 0 && report.resourcePackEffect?.totalRuns) {
    methods.push({
      title: '个性化资源包',
      conclusion: report.resourcePackEffect.practiceStartedCount > 0
        ? '已经从资源学习进入专项练习，还需要测评结果才能判断掌握提升。'
        : '已经生成学习资源，但还缺少练习结果来判断效果。',
      evidence: [
        `完成 ${report.resourcePackEffect.totalRuns} 次资源包学习`,
        `进入 ${report.resourcePackEffect.practiceStartedCount} 次专项练习`,
      ],
      evidenceState: 'partial',
      action: normalizeAction(
        { ...report.resourcePackEffect.nextAction, estimatedMinutes: 10, expectedOutcome: report.resourcePackEffect.nextAction.reason },
        {
          label: '进入推荐资源',
          href: '/a3/recommendations',
          estimatedMinutes: 15,
          expectedOutcome: '完成资源和测评后补充效果证据。',
        },
      ),
    });
  }
  return methods.length > 0 ? methods.slice(0, 3) : [insufficientMethodEffect()];
}

function insufficientMethodEffect(): LearningMethodEffect {
  return {
    title: '学习方式效果待验证',
    conclusion: '还需要完成一次推荐资源学习和后续测评，才能判断哪种方式更适合你。',
    evidence: ['当前没有形成“学习前、学习过程、学习后测评”的完整证据链。'],
    evidenceState: 'insufficient',
    action: {
      label: '选择一份推荐资源',
      href: '/a3/recommendations',
      estimatedMinutes: 15,
      expectedOutcome: '完成资源学习和测评后，报告会补充效果判断。',
    },
  };
}

function deriveEvidenceState(report: LearningReport): 'ready' | 'partial' | 'insufficient' {
  if (report.metrics.answeredQuestions >= 3 && report.knowledgePointInsights?.length) return 'partial';
  if (report.metrics.answeredQuestions > 0 || report.knowledgePointInsights?.length) return 'partial';
  return 'insufficient';
}
