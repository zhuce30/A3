import type { StudyPlan, StudyPlanDay, StudyPlanLearningEffectAdjustment, StudyPlanTask } from './learning-types';
import { profileDimensionLabel, profileSourceLabel, summarizeProfileTimelineEntry, type DynamicProfileFeedResponse } from './profile-timeline';
import type { A3Recommendation } from './recommendation-types';

export type LearningFlowInsight = {
  title: string;
  detail: string;
  href: string;
  tone: 'blue' | 'green' | 'orange' | 'violet' | 'slate';
  meta?: string;
};

export type RecommendationEffectInsight = {
  label: string;
  detail: string;
  tone: LearningFlowInsight['tone'];
};

export type ClassroomContextInsight = {
  title: string;
  detail: string;
  evidence: string;
  href: string;
};

export type ProfileRationale = {
  label: string;
  detail: string;
  href: string;
  confidence: number;
};

export function buildProfileChangeInsight(feed: DynamicProfileFeedResponse | null): LearningFlowInsight | null {
  const pending = feed?.confirmationQueue ?? [];
  const timeline = feed?.timeline ?? [];
  const current = pending[0] ?? timeline[0];
  if (!current) return null;
  const dimension = profileDimensionLabel(current.changedDimensions?.[0] || '');
  if (pending.length > 0) {
    return {
      title: `画像有 ${pending.length} 条变化待确认`,
      detail: `${profileSourceLabel(current.source)}建议更新画像：${summarizeProfileTimelineEntry(current)}。确认后会影响今日任务、计划节奏和推荐排序。`,
      href: '/a3/profile-setup',
      tone: 'orange',
      meta: `${Math.round((current.confidence ?? 0) * 100)}% 置信度`,
    };
  }
  return {
    title: `画像最近更新了${dimension}`,
    detail: `${profileSourceLabel(current.source)}已写入画像时间线：${summarizeProfileTimelineEntry(current)}。当前安排会优先参考这条变化。`,
    href: '/a3/report',
    tone: 'blue',
    meta: current.status ? '画像时间线' : undefined,
  };
}

export function buildTodayFlowInsights({ plan, today }: { plan: StudyPlan | null; today: StudyPlanDay | null }): LearningFlowInsight[] {
  if (!plan) return [];

  const insights: LearningFlowInsight[] = [];
  const learningEffect = plan.lastLearningEffectAdjustment;
  if (learningEffect) insights.push(buildLearningEffectInsight(learningEffect));

  const activeTask = today?.tasks.find((task) => task.status !== 'completed') ?? today?.tasks[0] ?? null;
  if (activeTask) {
    const currentNode = plan.planContext?.learningPath.currentItem?.title;
    insights.push({
      title: `先做「${activeTask.title}」`,
      detail: activeTask.reason || activeTask.subtitle || (currentNode ? `它对应当前路径节点「${currentNode}」，完成后会更新路径进度。` : '完成后会写回今日进度、学习计划和报告。'),
      href: activeTask.href || '/a3/study-plan',
      tone: activeTask.type === 'review' ? 'orange' : activeTask.type === 'practice' ? 'blue' : 'green',
      meta: `${activeTask.estimatedMinutes} 分钟`,
    });
  }

  const binding = plan.planContext?.todayBindings?.[0];
  if (binding && insights.length < 3) {
    insights.push({
      title: '完成后会更新学习路径',
      detail: binding.writeback || `这项任务绑定到路径节点，当前进度 ${binding.pathProgress ?? 0}%。`,
      href: '/a3/learning-path',
      tone: 'violet',
      meta: binding.chapter || '路径进度',
    });
  }

  return insights.slice(0, 3);
}

export function buildStudyPlanFlowInsights({ plan }: { plan: StudyPlan | null }): LearningFlowInsight[] {
  if (!plan) return [];

  const insights: LearningFlowInsight[] = [];
  const resourceAdjustment = plan.lastResourceFeedbackAdjustment;
  if (resourceAdjustment) {
    const averageScore = resourceAdjustment.evidence?.averageFeedbackScore;
    const latestGoal = resourceAdjustment.evidence?.latestGoal;
    const resourceDetail = resourceAdjustment.reason || '你的资源学习记录已进入后续排程。';
    insights.push({
      title: '计划参考了你的资源反馈',
      detail: latestGoal ? `围绕「${latestGoal}」：${resourceDetail}` : resourceDetail,
      href: resourceAdjustment.nextAction?.href || '/a3/recommendations',
      tone: resourceAdjustment.strategy === 'reduce_load' ? 'orange' : 'green',
      meta: [latestGoal, typeof averageScore === 'number' ? `评分 ${formatNumber(averageScore)}` : '', resourceAdjustment.evidence?.completed ? `完成 ${resourceAdjustment.evidence.completed} 次` : ''].filter(Boolean).join(' · '),
    });
  }

  if (plan.lastLearningEffectAdjustment) insights.push(buildLearningEffectInsight(plan.lastLearningEffectAdjustment));

  const currentChange = plan.explanation?.currentChange ?? plan.adjustmentTimeline?.[0];
  if (currentChange && insights.length < 3) {
    insights.push({
      title: currentChange.title,
      detail: currentChange.impact || currentChange.detail || currentChange.reason,
      href: '/a3/study-plan',
      tone: currentChange.type === 'review' || currentChange.type === 'learning_effect' ? 'orange' : 'blue',
      meta: formatAdjustmentType(currentChange.type),
    });
  }

  return insights.slice(0, 3);
}

export function buildTaskProfileRationale(task: StudyPlanTask, feed: DynamicProfileFeedResponse | null): ProfileRationale {
  const pending = feed?.confirmationQueue ?? [];
  const timeline = feed?.timeline ?? [];
  const current = pending[0] ?? timeline[0] ?? null;
  const taskReason = task.reason || task.subtitle;

  if (!current) {
    return {
      label: '画像依据',
      detail: taskReason || '这项任务根据当前学习画像、路径节点、错题复习队列和可用时间安排。',
      href: '/a3/profile-setup',
      confidence: 0,
    };
  }

  const dimension = profileDimensionLabel(current.changedDimensions?.[0] || '');
  const source = profileSourceLabel(current.source);
  const summary = summarizeProfileTimelineEntry(current);
  const confidence = Math.round((current.confidence ?? 0) * 100);
  const prefix = pending.length ? `${source}提出${dimension}更新候选` : `${source}更新了${dimension}`;

  return {
    label: pending.length ? '待确认画像影响' : '画像已影响安排',
    detail: `${prefix}：${summary}。${taskReason || '本条任务会参考这条变化调整顺序、时长和练习类型。'}`,
    href: '/a3/profile-setup',
    confidence,
  };
}

export function buildRecommendationProfileRationale(recommendation: A3Recommendation, feed: DynamicProfileFeedResponse | null): ProfileRationale {
  const pending = feed?.confirmationQueue ?? [];
  const timeline = feed?.timeline ?? [];
  const current = pending[0] ?? timeline[0] ?? null;
  const profileReason = recommendation.evidence?.profileMatch?.reason || recommendation.reason;

  if (!current) {
    return {
      label: '画像排序依据',
      detail: profileReason || '推荐排序会读取当前画像、路径节点、错题和知识库证据。',
      href: '/a3/profile-setup',
      confidence: 0,
    };
  }

  const dimension = profileDimensionLabel(current.changedDimensions?.[0] || '');
  const source = profileSourceLabel(current.source);
  const summary = summarizeProfileTimelineEntry(current);
  const confidence = Math.round((current.confidence ?? 0) * 100);

  return {
    label: pending.length ? '画像确认后会刷新排序' : '画像参与了本次排序',
    detail: `${source}给出${dimension}证据：${summary}。${profileReason}`,
    href: '/a3/profile-setup',
    confidence,
  };
}

export function buildRecommendationEffectInsight(recommendation: A3Recommendation): RecommendationEffectInsight {
  const effect = recommendation.evidence?.resourceEffect;
  if (!effect) {
    return {
      label: '探索推荐',
      detail: '当前资源会用画像、路径节点和知识库证据排序，使用结果会继续回流到后续推荐。',
      tone: 'violet',
    };
  }

  if (effect.explorationRecommended) {
    return {
      label: '探索推荐',
      detail: `这类资源历史样本还不多，系统会保留少量探索位。${confidenceLabel(effect.effectConfidence)}。`,
      tone: 'violet',
    };
  }

  const effectiveness = Math.round(normalizeRatio(effect.historicalEffectiveness) * 100);
  const gain = typeof effect.postAssessmentGain === 'number' ? `，近 7 天测评增益 ${Math.round(normalizeRatio(effect.postAssessmentGain) * 100)}%` : '';
  return {
    label: '历史有效性',
    detail: `同类资源对你过去学习的有效性约 ${effectiveness}%${gain}，${confidenceLabel(effect.effectConfidence)}。`,
    tone: effectiveness >= 70 ? 'green' : effectiveness >= 45 ? 'blue' : 'orange',
  };
}

export function buildClassroomContextInsight({ plan }: { plan: StudyPlan | null }): ClassroomContextInsight {
  const currentNode = plan?.planContext?.learningPath.currentItem;
  const today = plan?.days.find((day) => day.status === 'today' || day.dayIndex === 1) ?? null;
  const activeTask = today?.tasks.find((task) => task.status !== 'completed') ?? today?.tasks[0] ?? null;
  const nodeTitle = currentNode?.title || activeTask?.title || '当前学习目标';

  return {
    title: `课堂会围绕${nodeTitle}展开`,
    detail: activeTask ? `先讲清「${activeTask.title}」需要的概念，再根据你的提问补充例题和引用来源。` : '课堂会读取当前路径、薄弱点和知识库来源，回答后可继续进入练习。',
    evidence: [currentNode ? '当前路径节点' : '', activeTask ? '今日任务' : '', plan?.lastLearningEffectAdjustment ? '最近学习效果' : '', plan?.reviewQueue?.length ? '错题复习队列' : ''].filter(Boolean).join(' · ') || '学习计划',
    href: activeTask?.href || '/a3/today',
  };
}

function buildLearningEffectInsight(adjustment: StudyPlanLearningEffectAdjustment): LearningFlowInsight {
  const strategy = adjustment.strategy;
  const confidence = adjustment.evidence?.confidence ? ` · ${confidenceLabel(adjustment.evidence.confidence)}` : '';
  const meta = [adjustment.action?.estimatedMinutes ? `${adjustment.action.estimatedMinutes} 分钟` : '', adjustment.evidence?.riskLevel ? `风险 ${riskLabel(adjustment.evidence.riskLevel)}` : '', confidence.replace(/^ · /, '')].filter(Boolean).join(' · ');
  const detail = adjustment.reason || adjustment.expectedImpact || '系统根据最近任务、练习和资源反馈调整了后续安排。';

  if (strategy === 'add_spaced_review') {
    return { title: '今天加了一次复习', detail, href: '/a3/wrong-notebook', tone: 'orange', meta };
  }
  if (strategy === 'add_remedial_practice') {
    return { title: '今天补一组专项练习', detail, href: '/a3/assessment', tone: 'blue', meta };
  }
  if (strategy === 'reduce_new_content') {
    return { title: '今天减少新内容', detail, href: '/a3/study-plan', tone: 'orange', meta };
  }
  if (strategy === 'increase_challenge') {
    return { title: '今天提高一点挑战度', detail, href: '/a3/assessment', tone: 'green', meta };
  }
  if (strategy === 'recommend_coaching') {
    return { title: '建议先问 AI 课堂', detail, href: '/a3/classroom', tone: 'violet', meta };
  }
  return { title: '计划已根据学习效果调整', detail, href: '/a3/study-plan', tone: 'blue', meta };
}

function confidenceLabel(confidence: string) {
  if (confidence === 'high') return '高置信度';
  if (confidence === 'medium') return '中等置信度';
  if (confidence === 'low') return '低置信度';
  return `${confidence} 置信度`;
}

function riskLabel(risk: string) {
  if (risk === 'high') return '高';
  if (risk === 'medium') return '中';
  if (risk === 'low') return '低';
  return risk;
}

function normalizeRatio(value: number) {
  if (!Number.isFinite(value)) return 0;
  return value > 1 ? Math.min(value / 100, 1) : Math.max(value, 0);
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatAdjustmentType(type: string) {
  if (type === 'resource_feedback') return '资源反馈';
  if (type === 'learning_effect') return '学习效果';
  if (type === 'review') return '复习';
  if (type === 'mastery') return '掌握度';
  if (type === 'rollover') return '任务顺延';
  return '计划调整';
}
