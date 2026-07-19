import type { A3UserRole } from './auth-types';
import type { A3Locale } from './i18n';

export type A3TourId =
  | 'profile-setup'
  | 'admission-diagnostic'
  | 'today-plan'
  | 'resource-generation'
  | 'knowledge-base-indexing';

export type A3TourPlacement = 'top' | 'right' | 'bottom' | 'left';

export type A3TourStep = {
  id: string;
  target: string;
  title: Record<A3Locale, string>;
  description: Record<A3Locale, string>;
  placement: A3TourPlacement;
};

export type A3GuidedTour = {
  id: A3TourId;
  version: number;
  routes: string[];
  audience: A3UserRole[];
  steps: A3TourStep[];
};

export type A3TourState = {
  status: 'completed' | 'dismissed';
  updatedAt: string;
};

const text = (zh: string, en: string): Record<A3Locale, string> => ({
  'zh-CN': zh,
  'en-US': en,
});

export const a3GuidedTours: A3GuidedTour[] = [
  {
    id: 'profile-setup',
    version: 1,
    routes: ['/a3/profile-setup'],
    audience: ['student'],
    steps: [
      { id: 'purpose', target: '[data-tour-id="profile-intro"]', title: text('先了解画像用途', 'Understand the profile'), description: text('画像用于调整路径、计划和资源，不会替你填写未确认的信息。', 'The profile adjusts paths, plans, and resources without inventing answers.'), placement: 'bottom' },
      { id: 'interview', target: '[data-tour-id="profile-interview"]', title: text('用自然语言说明情况', 'Describe your situation'), description: text('可以先说目标、基础、每天可用时间和最困难的知识点。', 'Start with goals, level, available time, and difficult topics.'), placement: 'right' },
      { id: 'manual', target: '[data-tour-id="profile-manual"]', title: text('手动补充或修改', 'Review manually'), description: text('下方表单用于确认对话结果，也可以直接修正任何字段。', 'Use the form to confirm or correct interview results.'), placement: 'left' },
      { id: 'save', target: '[data-tour-id="profile-save"]', title: text('确认后再继续', 'Confirm and continue'), description: text('只在信息正确时保存，下一步会进入入学诊断。', 'Save only confirmed details, then continue to the diagnostic.'), placement: 'top' },
    ],
  },
  {
    id: 'admission-diagnostic',
    version: 1,
    routes: ['/a3/admission-diagnostic'],
    audience: ['student'],
    steps: [
      { id: 'overview', target: '[data-tour-id="diagnostic-overview"]', title: text('诊断会改变后续安排', 'The diagnostic updates your plan'), description: text('它不仅给分数，还会识别薄弱点并刷新路径。', 'It identifies weak points and refreshes the path.'), placement: 'bottom' },
      { id: 'question', target: '[data-tour-id="diagnostic-question"]', title: text('逐题完成', 'Answer each question'), description: text('不确定时选择最接近的答案，系统需要完整作答才能判断。', 'Choose the closest answer when unsure so the system can assess the full set.'), placement: 'right' },
      { id: 'progress', target: '[data-tour-id="diagnostic-progress"]', title: text('随时确认进度', 'Track progress'), description: text('这里显示已完成数量和剩余题目。', 'This shows completed and remaining questions.'), placement: 'left' },
      { id: 'submit', target: '[data-tour-id="diagnostic-submit"]', title: text('提交并查看回流', 'Submit and review'), description: text('提交后查看水平、薄弱点和刷新后的今日任务。', 'Review level, weak points, and refreshed Today tasks after submission.'), placement: 'top' },
    ],
  },
  {
    id: 'today-plan',
    version: 1,
    routes: ['/a3/today', '/a3/study-plan'],
    audience: ['student'],
    steps: [
      { id: 'prescription', target: '[data-tour-id="today-prescription"]', title: text('先看今日处方', 'Start with today'), description: text('这里汇总今天的任务量、预计时长和优先目标。', 'Review workload, duration, and priority.'), placement: 'bottom' },
      { id: 'next', target: '[data-tour-id="today-next-action"]', title: text('从下一步开始', 'Take the next action'), description: text('系统根据当前路径和复习队列给出最优先入口。', 'The system prioritizes an action from your path and review queue.'), placement: 'bottom' },
      { id: 'relationship', target: '[data-tour-id="today-plan-relationship"]', title: text('理解为什么这样安排', 'Understand the plan'), description: text('这一区域解释今日任务与周期计划、错题复习的关系。', 'This explains how Today connects to the period plan and review.'), placement: 'top' },
      { id: 'tasks', target: '[data-tour-id="today-task-list"]', title: text('完成后会自动回流', 'Completion flows back'), description: text('完成任务后，进度、画像、报告和下一步会随之更新。', 'Completion updates progress, profile, reports, and next actions.'), placement: 'top' },
    ],
  },
  {
    id: 'resource-generation',
    version: 1,
    routes: ['/a3/recommendations'],
    audience: ['student'],
    steps: [
      { id: 'context', target: '[data-tour-id="resource-generation-context"]', title: text('先确认生成依据', 'Confirm the context'), description: text('当前课程、路径节点和薄弱点会决定资源内容。', 'Course, path node, and weak points shape the resource.'), placement: 'left' },
      { id: 'need', target: '[data-tour-id="resource-generation-need"]', title: text('说明你卡在哪里', 'Describe the problem'), description: text('越具体的困难描述，越容易得到适合的讲解和练习。', 'Specific difficulty descriptions produce better explanations and practice.'), placement: 'bottom' },
      { id: 'types', target: '[data-tour-id="resource-generation-types"]', title: text('选择合适的资源类型', 'Choose resource types'), description: text('可以生成文档、PPT、导图、练习、案例、代码或视频。', 'Choose documents, PPT, maps, practice, cases, code, or video.'), placement: 'top' },
      { id: 'actions', target: '[data-tour-id="resource-generation-actions"]', title: text('生成后到记录中查看', 'Track generated work'), description: text('任务会持久化；失败内容可以单独重试。', 'Tasks persist and failed content can be retried separately.'), placement: 'top' },
    ],
  },
  {
    id: 'knowledge-base-indexing',
    version: 1,
    routes: ['/a3/knowledge-base'],
    audience: ['teacher', 'admin'],
    steps: [
      { id: 'upload', target: '[data-tour-id="knowledge-base-upload"]', title: text('上传受支持的资料', 'Upload supported files'), description: text('支持 PDF、DOCX、PPTX 等格式；旧版 PPT 需要先转换。', 'Use PDF, DOCX, PPTX, and convert legacy PPT first.'), placement: 'bottom' },
      { id: 'status', target: '[data-tour-id="knowledge-base-status"]', title: text('观察解析状态', 'Watch indexing'), description: text('任务中心和资源状态会显示真实进度与失败原因。', 'Task and resource status show real progress and failure causes.'), placement: 'bottom' },
      { id: 'resources', target: '[data-tour-id="knowledge-base-resources"]', title: text('只重试失败资源', 'Retry only failures'), description: text('成功资源保持可用，失败资源可以单独重新解析。', 'Successful resources remain usable while failed ones can be retried.'), placement: 'left' },
      { id: 'search', target: '[data-tour-id="knowledge-base-search"]', title: text('用检索验证结果', 'Verify by search'), description: text('解析完成后搜索关键词，确认课堂和资源生成能够引用。', 'Search after indexing to verify classroom and resource citations.'), placement: 'top' },
    ],
  },
];

export function getA3TourForRoute(pathname: string, role?: A3UserRole | null) {
  return a3GuidedTours.find((tour) => tour.routes.includes(pathname) && (!role || tour.audience.includes(role))) ?? null;
}

export function getA3TourById(id?: string | null) {
  return a3GuidedTours.find((tour) => tour.id === id) ?? null;
}

export function buildA3TourStorageKey(userId: string, tourId: A3TourId, version: number) {
  return `a3-tour:${userId}:${tourId}:${version}`;
}

export function parseA3TourState(value: string | null): A3TourState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<A3TourState>;
    if ((parsed.status !== 'completed' && parsed.status !== 'dismissed') || typeof parsed.updatedAt !== 'string') return null;
    return { status: parsed.status, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function resolveA3TourSteps(
  steps: A3TourStep[],
  targetExists: (selector: string) => boolean,
) {
  return steps.filter((step) => targetExists(step.target));
}

export function shouldAutoStartA3Tour({
  state,
  hasVisibleTarget,
  blockingActivity,
}: {
  state: A3TourState | null;
  hasVisibleTarget: boolean;
  blockingActivity: boolean;
}) {
  return !state && hasVisibleTarget && !blockingActivity;
}
