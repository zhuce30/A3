export type QuestionOption = { key: string; text: string };

export type AssessmentQuestion = {
  id: string;
  stem: string;
  options: QuestionOption[];
  difficulty: number;
  knowledgePoint: { id: string; title: string; chapter: string };
  personalization?: {
    questionKind: string;
    variantIndex: number;
    variantContext: {
      scenario?: string;
      parameter?: number;
      distractorOffset?: number;
      evidenceBlockId?: string;
    };
    generationMode: string;
    reasoningForm: string;
    llm: {
      provider?: string;
      model?: string;
      fallback?: boolean;
    };
    generationReason: string;
    foundationLevel: string;
    profileSignals: {
      foundationLevel?: string;
      weakPoints?: string[];
      learningGoals?: string[];
      expectedResources?: string[];
      recentErrorCauses?: string[];
      targetKnowledgePoint?: string;
    };
    sourceEvidence: Array<{
      resourceId: string;
      resourceTitle: string;
      blockId: string;
      pageNumber: number | null;
      quote: string;
      modality: string;
      score: number;
    }>;
  };
  source?: {
    type: string;
    reviewStatus: string;
    scope: string;
    qualityScore: number;
    resourceId: string;
    resourceTitle: string;
  };
  evidence?: Array<{
    resourceId: string;
    resourceTitle: string;
    blockId: string;
    pageNumber: number | null;
    previewUrl: string;
    quote: string;
    modality: string;
    score: number;
  }>;
};

export type AssessmentSession = {
  id: string;
  mode?: 'assessment' | 'practice';
  focus?: { knowledgePoint?: string } | null;
  status: 'in_progress' | 'completed';
  currentIndex: number;
  answeredCount: number;
  totalQuestions: number;
  score: number;
  startedAt: string;
  completedAt: string | null;
  currentQuestion: AssessmentQuestion | null;
  selection?: {
    strategy: string;
    reason: string;
    sourceCounts?: Record<string, number>;
  } | null;
};

export type PracticeSuggestion = {
  knowledgePoint: string;
  reason: string;
  wrongCount: number;
  priority: number;
  href: string;
};

export type AnswerFeedback = {
  isCorrect: boolean;
  selectedAnswer: string;
  correctAnswer: string;
  explanation: string;
  errorCause: string;
  session: AssessmentSession;
  profileUpdate?: {
    weakPoints: string[];
    extraProfile?: Record<string, unknown>;
  } | null;
  studyPlan?: import('./learning-types').StudyPlan | null;
  report?: LearningReport | null;
  nextAction?: { label: string; href: string; reason: string } | null;
  loopEvidence?: import('./learning-types').LearningLoopEvidence;
};

export type WrongQuestion = {
  id: string;
  wrongCount: number;
  consecutiveCorrect: number;
  mastered: boolean;
  lastWrongAnswer: string;
  lastWrongAt: string;
  reviewAfter: string | null;
  question: AssessmentQuestion;
  errorCause: string;
};

export type WrongReviewSummary = {
  activeCount: number;
  masteredCount: number;
  overdueCount: number;
  todayCount: number;
  upcomingCount: number;
  nextAction: { label: string; href: string; reason: string };
};

export type WrongRetryFeedback = {
  studyPlan?: import('./learning-types').StudyPlan;
  report?: LearningReport;
  nextAction?: { label: string; href: string; reason: string };
  loopEvidence?: import('./learning-types').LearningLoopEvidence;
  retryFeedback?: {
    masteryStatus: 'mastered' | 'needs_review';
    headline: string;
    knowledgePoint: string;
    nextReviewAt: string | null;
    reviewPlan: string;
    errorCauseChange: string;
    reward: { label: string; value: string; earned: boolean };
    nextAction?: { label: string; href: string; reason: string };
    motivators: Array<{
      label: string;
      detail: string;
      tone: 'blue' | 'green' | 'orange' | 'violet' | 'slate';
    }>;
  };
};

export type StudentReportEvidenceState = 'ready' | 'partial' | 'insufficient';
export type StudentReportComparisonAvailability = 'available' | 'insufficient_sample' | 'unavailable';

export type StudentReportAction = {
  label: string;
  href: string;
  estimatedMinutes: number;
  expectedOutcome: string;
};

export type StudentReportSummary = {
  schemaVersion: string;
  headline: string;
  summary: string;
  progressSignal: string;
  primaryRisk: string;
  primaryAction: StudentReportAction;
  evidence: Array<{ label: string; value: string; source: 'assessment' | 'wrong_notebook' | 'study_plan' }>;
};

export type StudentReportComparisonWindow = {
  start: string;
  end: string;
  answeredCount: number;
  correctCount: number;
  accuracy: number | null;
};

export type StudentReportComparisons = {
  periodKey: '7d' | '30d' | 'term';
  currentWindow: StudentReportComparisonWindow;
  previousWindow: StudentReportComparisonWindow | null;
  accuracy: {
    availability: StudentReportComparisonAvailability;
    comparable: boolean;
    currentValue: number | null;
    previousValue: number | null;
    percentagePointChange: number | null;
    reason: string;
  };
};

export type KnowledgePointInsight = {
  knowledgePoint: string;
  answeredCount: number;
  wrongCount: number;
  latestResult: 'correct' | 'incorrect' | null;
  activeWrongQuestions: number;
  status: 'needs_review' | 'improving' | 'stable' | 'insufficient_evidence';
  reason: string;
  action: Omit<StudentReportAction, 'expectedOutcome'>;
};

export type StudentReportDataQuality = {
  evidenceState: StudentReportEvidenceState;
  answeredQuestions: number;
  knowledgePointCount: number;
  comparisonAvailable: boolean;
  missingReasons: string[];
  lastUpdatedAt: string;
};

export type AlgorithmLabEffect = {
  completedRuns: number;
  verifiedRuns: number;
  predictionAccuracy: number;
  checkpointAccuracy: number;
  reviewedStepCount: number;
  byLab: Array<{
    labId: string;
    completedRuns: number;
    bestScore: number;
  }>;
  commonReviewSignals: Array<{
    stepIndex: number;
    count: number;
  }>;
  nextAction: {
    label: string;
    href: string;
  };
};

export type LearningReport = {
  period: { key?: '7d' | '30d' | 'term'; label?: string; start: string; end: string };
  metrics: {
    studyMinutes: number;
    studyDays: number;
    masteredKnowledgePoints: number;
    totalKnowledgePoints: number;
    answeredQuestions: number;
    accuracy: number;
    activeWrongQuestions: number;
    masteredWrongQuestions: number;
    pathProgress: number;
  };
  trends: { label: string; questions: number; accuracy: number; start?: string; end?: string }[];
  capabilityAxes: { label: string; value: number }[];
  suggestions: { title: string; detail: string }[];
  wrongReviewInsight?: {
    schemaVersion: string;
    headline: string;
    summary: string;
    activeWrongQuestions: number;
    masteredWrongQuestions: number;
    recentKnowledgePoints: string[];
    nextAction: { label: string; href: string; reason: string };
  };
  actionLoop?: {
    schemaVersion: string;
    continuityMessage: string;
    primaryReason: string;
    primaryAction: {
      label: string;
      href: string;
      kind: 'today' | 'review' | 'plan' | 'assessment';
    };
    steps: Array<{
      kind: 'today' | 'review' | 'plan';
      title: string;
      href: string;
      reason: string;
      expectedFeedback: string;
    }>;
  };
  resourcePackEffect?: {
    schemaVersion: string;
    totalRuns: number;
    verifiedSourceCount: number;
    practiceStartedCount: number;
    conversionRate: number;
    latestRun: {
      schemaVersion?: string;
      runId?: string;
      taskId: string;
      taskTitle?: string;
      learningGoal: string;
      verifiedSourceCount: number;
      confidence: string;
      practiceHref: string;
      source?: string;
      completedAt: string;
      nextStepReason?: string;
    } | null;
    recentRuns: Array<{
      schemaVersion?: string;
      runId?: string;
      taskId: string;
      taskTitle?: string;
      learningGoal: string;
      verifiedSourceCount: number;
      confidence: string;
      practiceHref: string;
      source?: string;
      completedAt: string;
      nextStepReason?: string;
    }>;
    conversionMessage: string;
    nextAction: {
      label: string;
      href: string;
      reason: string;
    };
  };
  algorithmLabEffect?: AlgorithmLabEffect;
  weeklySummary?: {
    reflectionCount: number;
    averageConfidence: number;
    planCompletion: number;
    completedTasks: number;
    totalTasks: number;
    rolloverTasks: number;
    latestReflection: import('./learning-types').DailyReflection | null;
    lastTaskFeedback: import('./learning-types').StudyPlanTaskFeedback | null;
    planChange?: {
      schemaVersion: string;
      currentChange?: import('./learning-types').StudyPlanAdjustment;
      recentAdjustments: import('./learning-types').StudyPlanAdjustment[];
      nextAction: { label: string; href: string; reason: string };
      hasChange: boolean;
    };
    recommendation: string;
  };
  weeklyPrescription?: {
    weeklyTarget: {
      label: string;
      current: number;
      target: number;
      progress: number;
      reason: string;
    };
    diagnosis: {
      headline: string;
      summary: string;
      evidence: string[];
    };
    focusAreas: Array<{
      title: string;
      reason: string;
      href: string;
      priority: 'high' | 'medium' | 'low';
    }>;
    completionCriteria: Array<{
      label: string;
      target: string;
      check: string;
    }>;
    primaryAction: {
      label: string;
      href: string;
      reason: string;
    };
    nextWeekActions: Array<{
      title: string;
      detail: string;
      href: string;
      type: 'review' | 'plan' | 'assessment' | 'today';
    }>;
  };
  studentSummary?: StudentReportSummary;
  comparisons?: StudentReportComparisons;
  knowledgePointInsights?: KnowledgePointInsight[];
  dataQuality?: StudentReportDataQuality;
  updatedAt: string;
};
