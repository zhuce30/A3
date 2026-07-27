// 通用意图路由（前端侧）。
// 与后端 /api/intent/classify/ 配合：先跑本地轻量规则命中高频意图（0 延迟、0 成本），
// 命中不了再调后端 LLM 分类；任何不确定都兜底为 ask_question。
// surface 无关——课堂/语音/首页各自注入 handlers，本模块只负责"识别 + 分发"。
import { a3PostJson } from '@/lib/a3/api-client';
import type { A3ResourcePackV2ResourceType } from '@/lib/a3/recommendation-types';

export type IntentName =
  | 'ask_question'
  | 'generate_resource'
  | 'start_practice'
  | 'explain_concept'
  | 'navigate'
  | 'review_wrong';

export type IntentResult = {
  intent: IntentName;
  confidence: number;
  params: {
    resourceType?: A3ResourcePackV2ResourceType;
    goal?: string;
    topic?: string;
    concept?: string;
    route?: string;
    label?: string;
    [key: string]: unknown;
  };
  source: 'rule' | 'llm' | 'fallback';
};

export type IntentContext = {
  goal?: string;
  surface?: string;
  [key: string]: unknown;
};

const RESOURCE_TYPE_KEYWORDS: Array<[A3ResourcePackV2ResourceType, string[]]> = [
  ['micro_video_script', ['讲解视频', '短视频', '视频', '动画']],
  ['lecture_doc', ['讲解文档', '讲义', '课件', '文档']],
  ['knowledge_card', ['速记卡', '记忆卡', '知识卡', '卡片']],
  ['mind_map', ['思维导图', '脑图', '导图']],
  ['practice_set', ['练习题', '习题', '练习', '题目', '做题']],
  ['case_study', ['实践案例', '工程案例', '案例']],
  ['code_lab', ['代码实验', '代码', '编程', '实验']],
];

const GENERATE_VERBS = ['生成', '做一个', '做个', '来一个', '来个', '给我', '帮我做', '制作', '出一个', '出个', '创建', '画一个', '画个', '画张', '整理'];
const PRACTICE_HINTS = ['出题', '出几道', '做几道', '练习', '习题', '测一下', '考考我'];
const REVIEW_HINTS = ['错题', '复习错', '我做错'];
const NAVIGATE_HINTS = ['打开', '跳转', '进入', '去看', '带我去'];
const EXPLAIN_HINTS = ['讲讲', '详细讲', '解释', '什么是', '怎么理解', '深入讲'];

const NAVIGATE_ROUTES: Array<[string, string]> = [
  ['学习报告', '/a3/report'],
  ['报告', '/a3/report'],
  ['学习路径', '/a3/learning-path'],
  ['路径', '/a3/learning-path'],
  ['错题本', '/a3/wrong-notebook'],
  ['知识库', '/a3/knowledge-base'],
  ['今日任务', '/a3/today'],
  ['资源推荐', '/a3/recommendations'],
];

function matchResourceType(text: string): A3ResourcePackV2ResourceType | null {
  for (const [type, keywords] of RESOURCE_TYPE_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return type;
  }
  return null;
}

/** 本地规则快判。命中返回结果；命中不了返回 null（交给 LLM）。 */
export function ruleClassify(text: string, context: IntentContext = {}): IntentResult | null {
  const cleaned = text.trim();
  if (!cleaned) return { intent: 'ask_question', confidence: 0, params: {}, source: 'fallback' };
  const goal = (context.goal ?? '').trim();

  if (REVIEW_HINTS.some((hint) => cleaned.includes(hint))) {
    return { intent: 'review_wrong', confidence: 0.8, params: {}, source: 'rule' };
  }
  const resourceType = matchResourceType(cleaned);
  const hasGenerateVerb = GENERATE_VERBS.some((verb) => cleaned.includes(verb));
  if (resourceType && hasGenerateVerb) {
    return { intent: 'generate_resource', confidence: 0.9, params: { resourceType, goal }, source: 'rule' };
  }
  if (PRACTICE_HINTS.some((hint) => cleaned.includes(hint))) {
    return { intent: 'start_practice', confidence: 0.8, params: { topic: goal }, source: 'rule' };
  }
  if (NAVIGATE_HINTS.some((hint) => cleaned.includes(hint))) {
    for (const [keyword, route] of NAVIGATE_ROUTES) {
      if (cleaned.includes(keyword)) {
        return { intent: 'navigate', confidence: 0.85, params: { route, label: keyword }, source: 'rule' };
      }
    }
  }
  if (EXPLAIN_HINTS.some((hint) => cleaned.includes(hint))) {
    return { intent: 'explain_concept', confidence: 0.6, params: { concept: cleaned }, source: 'rule' };
  }
  return null;
}

/** 混合分类：先本地规则，命中不了再调后端 /api/intent/classify/；后端失败兜底问答。 */
export async function classifyIntent(text: string, context: IntentContext = {}): Promise<IntentResult> {
  const rule = ruleClassify(text, context);
  if (rule) return rule;
  try {
    const result = await a3PostJson<{ success: boolean } & IntentResult>('/api/intent/classify/', { text, context });
    if (result.success && result.intent) {
      return { intent: result.intent, confidence: result.confidence ?? 0.5, params: result.params ?? {}, source: result.source ?? 'llm' };
    }
  } catch {
    // 忽略：走兜底
  }
  return { intent: 'ask_question', confidence: 0.3, params: {}, source: 'fallback' };
}

/** 把意图分发到调用方注入的 handlers。未提供对应 handler 时回退到 onAskQuestion。 */
export type IntentHandlers = {
  onAskQuestion: (text: string) => void | Promise<void>;
  onGenerateResource?: (resourceType: A3ResourcePackV2ResourceType, goal: string) => void | Promise<void>;
  onStartPractice?: (topic: string) => void | Promise<void>;
  onExplainConcept?: (concept: string) => void | Promise<void>;
  onNavigate?: (route: string) => void | Promise<void>;
  onReviewWrong?: () => void | Promise<void>;
};

export async function dispatchIntent(text: string, result: IntentResult, handlers: IntentHandlers): Promise<void> {
  const { intent, params } = result;
  if (intent === 'generate_resource' && handlers.onGenerateResource && params.resourceType) {
    await handlers.onGenerateResource(params.resourceType, params.goal ?? '');
    return;
  }
  if (intent === 'start_practice' && handlers.onStartPractice) {
    await handlers.onStartPractice(params.topic ?? '');
    return;
  }
  if (intent === 'navigate' && handlers.onNavigate && params.route) {
    await handlers.onNavigate(params.route);
    return;
  }
  if (intent === 'review_wrong' && handlers.onReviewWrong) {
    await handlers.onReviewWrong();
    return;
  }
  // explain_concept 和所有兜底都走问答（explain 本质是更深入的提问）。
  await handlers.onAskQuestion(text);
}
