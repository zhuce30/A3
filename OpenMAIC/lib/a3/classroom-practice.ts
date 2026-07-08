import type { ClassroomRecommendation } from './classroom-types';
import type { StudyPlan, StudyPlanTask } from './learning-types';

export type PracticePlanTaskMatch = {
  dayIndex: number;
  taskId: string;
  completed: boolean;
};

export type PracticeWritebackPayload = {
  dayIndex: number;
  taskId: string;
};

export type PracticeSyncEvidence = {
  weakPoints: string[];
  wrongNotebookText: string;
  reportMetrics: Array<{ label: string; value: string; available: boolean }>;
  planText: string;
};

export function findPracticePlanTaskForRecommendation(
  recommendation: ClassroomRecommendation,
  plan: StudyPlan | null,
): PracticePlanTaskMatch | null {
  if (recommendation.planTask?.taskId) {
    return {
      dayIndex: recommendation.planTask.dayIndex,
      taskId: recommendation.planTask.taskId,
      completed: recommendation.planTask.completed,
    };
  }
  if (!plan) return null;
  const recommendationHref = normalizePracticeHref(recommendation.href);
  const recommendationTitle = normalizeText(recommendation.title);

  for (const day of plan.days ?? []) {
    const task = (day.tasks ?? []).find((item) => isMatchingPracticeTask(item, recommendationHref, recommendationTitle));
    if (task) {
      return {
        dayIndex: day.dayIndex,
        taskId: task.id,
        completed: task.status === 'completed',
      };
    }
  }
  return null;
}

export function buildPracticeWritebackPayload({
  recommendation,
  plan,
  graded,
}: {
  recommendation: ClassroomRecommendation;
  plan: StudyPlan | null;
  graded: boolean;
}): PracticeWritebackPayload | null {
  if (!graded) return null;
  const match = findPracticePlanTaskForRecommendation(recommendation, plan);
  if (!match || match.completed) return null;
  return { dayIndex: match.dayIndex, taskId: match.taskId };
}

export function buildPracticeSyncEvidence({
  feedback,
  planFeedback,
}: {
  feedback: {
    isCorrect?: boolean;
    profileUpdate?: { weakPoints?: string[] } | null;
    report?: { metrics?: { accuracy?: number; activeWrongQuestions?: number; pathProgress?: number } } | null;
  } | null;
  planFeedback?: { headline?: string } | null;
}): PracticeSyncEvidence {
  const metrics = feedback?.report?.metrics;
  const formatPercent = (value: number | undefined) => (typeof value === 'number' ? `${value}%` : '未返回');
  const formatCount = (value: number | undefined) => (typeof value === 'number' ? `${value}` : '未返回');
  return {
    weakPoints: feedback?.profileUpdate?.weakPoints ?? [],
    wrongNotebookText: feedback?.isCorrect === false ? '已进入错题本或复习队列' : '正确作答，错题本无新增',
    reportMetrics: [
      { label: '正确率', value: formatPercent(metrics?.accuracy), available: typeof metrics?.accuracy === 'number' },
      { label: '活跃错题', value: formatCount(metrics?.activeWrongQuestions), available: typeof metrics?.activeWrongQuestions === 'number' },
      { label: '路径进度', value: formatPercent(metrics?.pathProgress), available: typeof metrics?.pathProgress === 'number' },
    ],
    planText: planFeedback?.headline || '判分已完成，等待计划任务匹配',
  };
}

function isMatchingPracticeTask(task: StudyPlanTask, recommendationHref: string, recommendationTitle: string) {
  if (task.type !== 'practice' && task.type !== 'review') return false;
  if (normalizePracticeHref(task.href) === recommendationHref) return true;
  return normalizeText(task.title).includes(recommendationTitle) || recommendationTitle.includes(normalizeText(task.title));
}

function normalizePracticeHref(value: string) {
  return decodeURIComponent(String(value || '')).trim().toLowerCase();
}

function normalizeText(value: string) {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}
