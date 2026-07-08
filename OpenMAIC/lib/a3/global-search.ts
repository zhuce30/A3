export type A3GlobalSearchResultType = 'route' | 'knowledge';

export type A3GlobalSearchRoute = {
  title: string;
  description: string;
  href: string;
  keywords: string[];
};

export type A3GlobalSearchResult = {
  id: string;
  type: A3GlobalSearchResultType;
  title: string;
  description: string;
  href: string;
  sourceLabel: string;
  score?: number | null;
};

export type A3KnowledgeSearchResult = {
  score: number | null;
  text: string;
  resourceName?: string;
  metadata?: Record<string, unknown>;
};

export const A3_GLOBAL_SEARCH_ROUTES: A3GlobalSearchRoute[] = [
  {
    title: '今日学习',
    description: '查看今天该完成的任务、进度写回和下一步行动。',
    href: '/a3/today',
    keywords: ['今日', '任务', '学习', '进度', '提醒'],
  },
  {
    title: '学习首页',
    description: '查看学习状态、计划、推荐和报告概览。',
    href: '/a3/dashboard',
    keywords: ['首页', '概览', '看板', '数据'],
  },
  {
    title: '通知消息',
    description: '查看教师推送、复习提醒和任务通知。',
    href: '/a3/notifications',
    keywords: ['通知', '提醒', '消息', '教师推送'],
  },
  {
    title: '学习规划',
    description: '查看 7/14/30 天计划、重排理由和今日任务绑定。',
    href: '/a3/study-plan',
    keywords: ['计划', '规划', '排程', '7天', '14天', '30天'],
  },
  {
    title: '入学诊断',
    description: '重新识别基础水平、薄弱点和适合的学习起点。',
    href: '/a3/admission-diagnostic',
    keywords: ['诊断', '入学', '测评', '水平', '薄弱点'],
  },
  {
    title: '学习画像',
    description: '调整专业方向、学习目标、每日时间和资源偏好。',
    href: '/a3/profile-setup',
    keywords: ['画像', '专业', '目标', '偏好', '每日时间'],
  },
  {
    title: '学习路径',
    description: '查看知识点顺序、先修关系、当前节点和路径进度。',
    href: '/a3/learning-path',
    keywords: ['路径', '知识点', '先修', '节点', '进度'],
  },
  {
    title: '课程学习',
    description: '按当前路径进入课程章节内容。',
    href: '/a3/courses',
    keywords: ['课程', '章节', '学习内容', '教材'],
  },
  {
    title: '练习复盘',
    description: '进入题库练习，作答后写回错题、画像和计划。',
    href: '/a3/assessment',
    keywords: ['练习', '题库', '测评', '答题', '考试'],
  },
  {
    title: '错题本',
    description: '查看错因、解析、重练和间隔复习队列。',
    href: '/a3/wrong-notebook',
    keywords: ['错题', '复习', '错因', '重练', '间隔复习'],
  },
  {
    title: 'AI 学习',
    description: '进入 AI 课堂，围绕当前目标追问和查看引用来源。',
    href: '/a3/classroom',
    keywords: ['ai', '课堂', '问答', '讲解', '引用'],
  },
  {
    title: '面对面辅导',
    description: '使用多模态辅导、语音或图像问题进入实时讲解。',
    href: '/a3/coaching',
    keywords: ['辅导', '面对面', '语音', '拍照', '多模态'],
  },
  {
    title: '资源包生成',
    description: '根据画像、薄弱点和知识库生成个性化学习资源。',
    href: '/a3/recommendations',
    keywords: ['资源', '推荐', '资源包', '文档', '题目', '视频', '代码实验'],
  },
  {
    title: '我的收藏',
    description: '管理收藏的资源、课堂内容和复习材料。',
    href: '/a3/favorites',
    keywords: ['收藏', '资源收藏', '笔记'],
  },
  {
    title: '知识库',
    description: '上传资料、查看索引状态并检索真实来源。',
    href: '/a3/knowledge-base',
    keywords: ['知识库', '上传', '资料', '检索', 'rag', '来源'],
  },
  {
    title: '本地知识图谱',
    description: '查看上传资料抽取出的实体、关系和图谱证据。',
    href: '/a3/knowledge-graph',
    keywords: ['知识图谱', '图谱', '实体', '关系', '资料图谱'],
  },
  {
    title: '学习报告',
    description: '查看计划完成度、薄弱趋势、行动建议和阶段报告。',
    href: '/a3/report',
    keywords: ['报告', '周报', '趋势', '建议', '成长分析'],
  },
];

export function buildA3GlobalSearchResults(query: string, limit = 6): A3GlobalSearchResult[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];

  return A3_GLOBAL_SEARCH_ROUTES.map((route) => ({
    route,
    score: scoreRoute(route, normalized),
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ route }) => ({
      id: `route:${route.href}`,
      type: 'route',
      title: route.title,
      description: route.description,
      href: route.href,
      sourceLabel: '功能入口',
    }));
}

export function mapA3KnowledgeSearchResults(
  query: string,
  results: A3KnowledgeSearchResult[],
  limit = 5,
): A3GlobalSearchResult[] {
  const href = `/a3/knowledge-base?query=${encodeURIComponent(query.trim())}`;
  return results.slice(0, limit).map((result, index) => {
    const title = result.resourceName?.trim() || `知识库片段 ${index + 1}`;
    return {
      id: `knowledge:${title}:${index}`,
      type: 'knowledge',
      title,
      description: result.text.trim() || '检索到知识库来源，打开知识库查看完整上下文。',
      href,
      sourceLabel: '知识库来源',
      score: result.score,
    };
  });
}

function scoreRoute(route: A3GlobalSearchRoute, normalizedQuery: string) {
  const searchable = normalizeSearchText([route.title, route.description, ...route.keywords].join(' '));
  if (searchable.includes(normalizedQuery)) return 100 + normalizedQuery.length;

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  return tokens.reduce((score, token) => {
    if (normalizeSearchText(route.title).includes(token)) return score + 30;
    if (searchable.includes(token)) return score + 10;
    return score;
  }, 0);
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
