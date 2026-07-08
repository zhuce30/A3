export type KnowledgePoint = {
  id: string;
  code: string;
  order: number;
  title: string;
  description: string;
  difficulty: number;
  estimatedMinutes: number;
};

export type CourseChapter = {
  id: string;
  order: number;
  title: string;
  description: string;
  estimatedMinutes: number;
  knowledgePoints: KnowledgePoint[];
};

export type Course = {
  id: string;
  code: string;
  title: string;
  description: string;
  edition: string;
  cover: string;
  enrolled: boolean;
  progress: number;
  chapters?: CourseChapter[];
};

export type CourseMaterial = {
  id: string;
  name: string;
  type: string;
  size: number;
  status: string;
  scope: string;
  chapterOrder: number | null;
  role: 'courseware' | 'textbook' | string;
  source: string;
  downloadUrl: string;
  parseUrl: string;
  isIndexed: boolean;
  isParsed: boolean;
  updatedAt: string;
};

export type CourseMaterials = {
  schemaVersion: 'a3.course-materials.v1' | string;
  course: { id: string; code: string; title: string };
  summary: { total: number; chapterBound: number; courseWide: number };
  chapters: Array<{ id: string; order: number; title: string; materials: CourseMaterial[] }>;
  courseWideMaterials: CourseMaterial[];
  evidence: { source: string; courseKey: string; mapping: string };
};

export type PathItem = {
  id: string;
  order: number;
  status: 'locked' | 'current' | 'completed';
  progress: number;
  reason: string;
  estimatedMinutes: number;
  completedAt: string | null;
  knowledgePoint: KnowledgePoint & { chapter: { order: number; title: string } };
};

export type LearningPath = {
  id: string;
  version: number;
  status: 'active' | 'archived';
  title: string;
  rationale: {
    foundationLevel?: string;
    pace?: string;
    dailyStudyTime?: number;
    weakPoints?: string[];
    learningGoals?: string[];
    strategy?: string;
  };
  course: Course;
  progress: number;
  items: PathItem[];
  createdAt: string;
  updatedAt: string;
};

export type MotivationSummary = {
  streakDays: number;
  todayRemainingMinutes: number;
  todayCompletedTasks: number;
  todayTotalTasks: number;
  weeklyCompletedTasks?: number;
  weeklyTarget: { label: string; current: number; target: number; progress: number };
  badges: { id: string; title: string; detail: string; earned: boolean }[];
  nudge: string;
  primaryAction?: { label: string; href: string; reason: string };
  newReminders?: number;
};

export type A3ApiResponse<T> = { success: boolean; error?: string } & T;

export type LearningLoopEvidence = {
  schemaVersion: 'a3.learning-loop-evidence.v1' | string;
  trigger: 'admission_diagnostic' | 'today_task_complete' | 'assessment_submit' | 'wrong_retry' | 'teacher_task' | string;
  subject: Record<string, string | number | boolean | null | undefined>;
  writeBacks: Array<{
    target: string;
    status: 'updated' | 'created' | 'checked' | 'derived' | 'not_applicable' | string;
    id?: string;
    summary: string;
    metrics?: Record<string, string | number | boolean | null | undefined>;
  }>;
  nextAction: { label: string; href: string; reason?: string };
  generatedAt: string;
};

export type KnowledgeGraphNodeStatus = 'mastered' | 'learning' | 'weak' | 'locked' | 'unstarted';

export type KnowledgeGraphNode = {
  id: string;
  code: string;
  title: string;
  description: string;
  chapter: { order: number; title: string };
  difficulty: number;
  estimatedMinutes: number;
  status: KnowledgeGraphNodeStatus;
  progress: number;
  wrongCount: number;
  pathOrder: number | null;
  reason: string;
  pathBinding?: {
    pathItemId: string | null;
    pathOrder: number | null;
    status: 'locked' | 'current' | 'completed' | 'unbound' | string;
    reason: string;
  };
  evidence?: {
    source: 'course_knowledge_point' | string;
    knowledgePointId: string;
    chapter: string;
    wrongCount: number;
    progress: number;
  };
};

export type KnowledgeGraphEdge = {
  from: string;
  to: string;
  type?: 'prerequisite' | string;
  label?: string;
};

export type KnowledgeGraphSummary = {
  total: number;
  mastered: number;
  learning: number;
  weak: number;
  locked: number;
  unstarted: number;
  masteryRate: number;
  nextCount: number;
};

export type KnowledgeGraph = {
  schemaVersion?: 'a3.knowledge-graph.v1' | string;
  course: Pick<Course, 'id' | 'code' | 'title' | 'edition'> | null;
  pathId: string | null;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  summary: KnowledgeGraphSummary;
  evidence?: {
    source: 'learning_graph_service' | string;
    courseId: string | null;
    knowledgePointCount: number;
    prerequisiteEdgeCount: number;
    activePathId: string | null;
  };
};

export type StudyPlanTask = {
  id: string;
  type: 'learn' | 'practice' | 'review' | 'summary' | 'resource_pack';
  title: string;
  subtitle: string;
  href: string;
  estimatedMinutes: number;
  knowledgePointId: string;
  status: 'pending' | 'completed';
  completedAt?: string;
  rolledOverFrom?: { dayIndex: number; date: string };
  source?: string;
  sourceResourceId?: string;
  sourceResourceName?: string;
  sourceScope?: string;
  reason?: string;
};

export type StudyPlanDay = {
  dayIndex: number;
  date: string;
  title: string;
  focus: string;
  estimatedMinutes: number;
  status: 'today' | 'pending' | 'in_progress' | 'completed' | 'rolled_over';
  progress: number;
  tasks: StudyPlanTask[];
};

export type StudyPlanMastery = {
  knowledgePointId: string;
  title: string;
  chapter: string;
  score: number;
  wrongCount: number;
  status: 'mastered' | 'learning' | 'weak';
};

export type StudyPlanReviewItem = {
  id: string;
  wrongQuestionId?: string;
  title: string;
  knowledgePoint?: string;
  wrongCount: number;
  reviewAfter: string;
  status?: 'due' | 'scheduled' | 'mastered';
  href: string;
};

export type StudyPlanAdjustment = {
  id: string;
  type: 'policy' | 'mastery' | 'review' | 'rollover' | 'resource_pack' | 'resource_feedback' | 'learning_effect';
  title: string;
  detail?: string;
  reason: string;
  impact?: string;
  createdAt: string;
};

export type StudyPlanResourceFeedbackAdjustment = {
  strategy: 'increase_practice' | 'reduce_load' | 'keep_current_pace' | string;
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
  taskId?: string;
  appliedAt?: string;
};

export type StudyPlanLearningEffectAdjustment = {
  schemaVersion?: 'a3.plan-adjustment.v2' | string;
  strategy: 'add_remedial_practice' | 'add_spaced_review' | 'reduce_new_content' | 'increase_challenge' | 'recommend_coaching' | string;
  action?: {
    type?: 'add_task' | 'reduce_load' | string;
    taskType?: StudyPlanTask['type'] | string;
    title?: string;
    knowledgePointId?: string;
    estimatedMinutes?: number;
  };
  reason?: string;
  evidence?: {
    effectScore?: number;
    confidence?: 'high' | 'medium' | 'low' | string;
    riskLevel?: 'low' | 'medium' | 'high' | string;
    targetKnowledgePointId?: string;
  };
  expectedImpact?: string;
  risk?: string;
  expiresAt?: string;
  rollbackCondition?: string;
  taskId?: string;
  applied?: boolean;
  appliedAt?: string;
};

export type StudyPlanContext = {
  schemaVersion: 'a3.study-plan-context.v1';
  relationship: {
    path: string;
    plan: string;
    today: string;
    writeback: string;
  };
  learningPath: {
    source: 'active_learning_path' | 'missing_active_learning_path' | string;
    id: string;
    version: number;
    progress: number;
    totalItems: number;
    completedItems: number;
    currentItem: {
      pathItemId: string;
      knowledgePointId: string;
      title: string;
      chapter: string;
      order: number;
      status: PathItem['status'];
      progress: number;
      estimatedMinutes: number;
      reason: string;
    } | null;
  };
  todayBindings: Array<{
    taskId: string;
    taskType: StudyPlanTask['type'] | string;
    title: string;
    knowledgePointId: string;
    pathItemId: string;
    pathStatus: PathItem['status'] | 'unbound' | string;
    pathProgress: number;
    pathOrder?: number;
    chapter?: string;
    writeback: string;
  }>;
  durationOptions: Array<{
    days: number;
    selected: boolean;
    targetDate: string;
    estimatedDailyMinutes: number;
    load: string;
    reason: string;
  }>;
  agentRoles: Array<{
    name: string;
    role: string;
    input: string;
    output: string;
  }>;
};

export type StudyPlan = {
  planId: string;
  title: string;
  course: { id: string; title: string };
  durationDays: number;
  dailyMinutes: number;
  level: { code: string; label: string; description: string; pathProgress: number; wrongPressure: number };
  adaptivePolicy?: {
    mode: 'reduced_load' | 'standard' | 'accelerated';
    dailyMinutes: number;
    maxTasksPerDay: number;
    rolloverEnabled: boolean;
    reason: string;
  };
  generatedAt: string;
  targetDate: string;
  overallProgress: number;
  mastery: StudyPlanMastery[];
  reviewQueue: StudyPlanReviewItem[];
  adjustmentTimeline?: StudyPlanAdjustment[];
  explanation?: {
    profileSignals: {
      foundationLevel: string;
      dailyStudyTime: number;
      pace: string;
      learningGoals: string[];
      weakPoints: string[];
      level: { code: string; label: string; description: string; pathProgress: number; wrongPressure: number };
    };
    loadPolicy: {
      mode: 'reduced_load' | 'standard' | 'accelerated';
      dailyMinutes: number;
      maxTasksPerDay: number;
      reason: string;
    };
    weakPointPolicy: {
      count: number;
      items: Array<{ title: string; score: number; wrongCount: number }>;
      reason: string;
    };
    reviewPolicy: {
      count: number;
      items: StudyPlanReviewItem[];
      reason: string;
    };
    adjustments: StudyPlanAdjustment[];
    currentChange?: StudyPlanAdjustment;
    nextAction?: { label: string; href: string; reason: string };
  };
  coachTip: string;
  planContext?: StudyPlanContext;
  lastTaskFeedback?: StudyPlanTaskFeedback;
  lastResourceFeedbackAdjustment?: StudyPlanResourceFeedbackAdjustment;
  lastLearningEffectAdjustment?: StudyPlanLearningEffectAdjustment;
  days: StudyPlanDay[];
};

export type StudyPlanTaskFeedback = {
  taskId: string;
  taskType: StudyPlanTask['type'];
  title: string;
  knowledgePoint: string;
  headline: string;
  masteryAfter: number;
  delta: string;
  dayProgress: number;
  completedTasks: number;
  totalTasks: number;
  remainingTasks: number;
  dailyClosed: boolean;
  nextAction: { label: string; href: string };
  nextStepReason: string;
  celebration: string;
  reward: { label: string; value: string; earned: boolean };
  motivators: { label: string; detail: string; tone: 'blue' | 'green' | 'orange' | 'violet' | 'slate' }[];
  resourcePack?: {
    learningGoal: string;
    verifiedSourceCount: number;
    confidence: 'high' | 'medium' | 'low' | string;
    practiceHref: string;
  };
  loopEvidence?: LearningLoopEvidence;
  generatedAt: string;
};

export type DailyReflection = {
  reflectionId: string;
  date: string;
  summary: string;
  confusion: string;
  confidence: number;
  planId: string;
  todayProgress: number;
  createdAt: string;
};

export type AdmissionDiagnosticQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: string[];
  knowledgePoint: string;
  difficulty?: 'foundation' | 'standard' | 'challenge' | string;
  reason?: string;
  profileSignals?: string[];
  source?: string;
};

export type AdmissionDiagnosticBlueprint = {
  schemaVersion: string;
  agent: string;
  workflow: string;
  profileInputs: {
    foundationLevel?: string;
    dailyStudyTime?: number;
    learningGoals?: string[];
    weakPoints?: string[];
    learningPreferences?: string[];
  };
  selectionPolicy: {
    primaryRule?: string;
    secondaryRule?: string;
    difficultyRule?: string;
  };
  coverage?: Array<{ knowledgePoint: string; difficulty?: string; reason?: string }>;
  degraded?: boolean;
  degradationReason?: string;
};

export type AdmissionDiagnosticResult = {
  diagnosticId: string;
  submittedAt: string;
  goal: string;
  examDate: string;
  durationDays: number;
  dailyMinutes: number;
  score: number;
  correctCount: number;
  totalCount: number;
  level: { code: string; label: string; foundationLevel: string; description: string };
  weakPoints: string[];
  nextAction: string;
  loopEvidence?: LearningLoopEvidence;
};
