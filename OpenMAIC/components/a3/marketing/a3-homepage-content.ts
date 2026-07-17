import type { Metadata } from 'next';

export const A3_HOMEPAGE_BRAND = '智学引擎';

export const A3_HOMEPAGE_NAV = [
  { label: '学习闭环', href: '#daily-learning' },
  { label: '真实产品', href: '#product-evidence' },
  { label: '可信依据', href: '#evidence' },
  { label: '教师端', href: '#teacher' },
] as const;

export const A3_HOMEPAGE_ROUTES = {
  register: '/a3/register',
  login: '/a3/login',
  workspace: '/a3/dashboard',
} as const;

export const A3_HOMEPAGE_ACTIONS = {
  login: '登录',
  workspace: '进入学习区',
  registerShort: '开始体验',
} as const;

export const A3_HOMEPAGE_METADATA = {
  title: '智学引擎',
  description:
    '面向大学生的个性化学习产品，把诊断、今日计划、本地资料、多模态资源、AI 辅导、测评复习和学习报告连成一条可验证的学习闭环。',
  alternates: { canonical: '/a3' },
  openGraph: {
    title: '智学引擎',
    description: '从诊断到复习，让每天的学习任务有依据、有反馈、有下一步。',
    type: 'website',
    url: '/a3',
    siteName: '智学引擎',
    locale: 'zh_CN',
    images: [
      {
        url: '/a3/assets/homepage/today-plan.webp',
        width: 1129,
        height: 900,
        alt: '智学引擎今日学习计划界面',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: '智学引擎',
    description: '从诊断到复习，让每天的学习任务有依据、有反馈、有下一步。',
    images: ['/a3/assets/homepage/today-plan.webp'],
  },
} satisfies Metadata;

export const A3_HOMEPAGE_HERO = {
  titleLines: ['智学引擎', '把每一次学习，接到下一步。'],
  support: '从诊断、今日计划到课堂、测评和错题复习，每一次结果都会更新后续安排。',
  cta: '开始体验',
  secondaryCta: { href: '#daily-learning', label: '查看完整学习闭环' },
} as const;

export const A3_HOMEPAGE_HERO_MEDIA = [
  { src: '/a3/assets/homepage/today-plan.webp', alt: '今日任务与学习计划界面' },
  { src: '/a3/assets/homepage/diagnostic.webp', alt: '入学诊断界面' },
  { src: '/a3/assets/homepage/assessment-review.webp', alt: '测评与错题复习界面' },
  { src: '/a3/assets/homepage/progress-refresh.webp', alt: '学习报告与计划刷新界面' },
] as const;

export const A3_HOMEPAGE_RESOURCE_TYPES = [
  {
    type: 'lecture_doc',
    label: '课程讲解文档',
    use: '把概念、例子和引用整理成可直接阅读的讲义',
  },
  {
    type: 'knowledge_card',
    label: '知识点速记卡',
    use: '提炼定义、易错点和复习提示',
  },
  {
    type: 'mind_map',
    label: '知识点思维导图',
    use: '连接知识点、先修关系和薄弱环节',
  },
  {
    type: 'practice_set',
    label: '专项练习题',
    use: '围绕薄弱点生成题目、答案和解析',
  },
  {
    type: 'case_study',
    label: '工程实践案例',
    use: '把知识放进真实问题场景中分析',
  },
  {
    type: 'code_lab',
    label: '代码类实操案例',
    use: '提供目标、步骤、起始代码和检查点',
  },
  {
    type: 'micro_video_script',
    label: '短视频/动画脚本',
    use: '为可播放视频准备分镜和讲解脚本',
  },
] as const;

export const A3_HOMEPAGE_STORY = [
  {
    id: 'today',
    index: '01 / TODAY',
    title: '打开产品，就知道今天学什么。',
    summary: '今日任务承接学习路径、周期计划和复习队列，给出预计时长与明确下一步。',
    media: '/a3/assets/homepage/today-plan.webp',
    alt: '智学引擎今日任务与学习计划界面',
  },
  {
    id: 'profile',
    index: '02 / PROFILE',
    title: '计划先从认识你开始。',
    summary: '目标、基础、可用时间、薄弱点和资源偏好，共同决定学习节奏。',
    media: '/a3/assets/homepage/profile.webp',
    alt: '学习画像设置界面',
  },
  {
    id: 'diagnostic',
    index: '03 / DIAGNOSTIC',
    title: '诊断不只给分数，还决定下一步。',
    summary: '题目定位当前水平和薄弱知识点，并刷新路径顺序和每日计划。',
    media: '/a3/assets/homepage/diagnostic.webp',
    alt: '操作系统入学诊断界面',
  },
  {
    id: 'knowledge',
    index: '04 / KNOWLEDGE',
    title: '你的资料，是每次讲解的依据。',
    summary: '课本、课程 PPT 和知识总结经过索引后，成为可检索、可引用的学习证据。',
    media: '/a3/assets/homepage/knowledge-base.webp',
    alt: '操作系统本地知识库界面',
  },
  {
    id: 'resources',
    index: '05 / RESOURCES',
    title: '同一个目标，用适合你的方式学。',
    summary: '讲义、卡片、导图、练习、案例、代码和视频脚本，围绕当前薄弱点组织。',
    media: '/a3/assets/homepage/multimodal-resources.webp',
    alt: '个性化多模态资源包界面',
  },
  {
    id: 'classroom',
    index: '06 / CLASSROOM',
    title: '课堂讲当前难点，也交代资料来源。',
    summary: '讲解承接今日目标和知识库证据，引用不足时不会把不确定内容标成可信。',
    media: '/a3/assets/homepage/classroom.webp',
    alt: '个性化 AI 课堂界面',
  },
  {
    id: 'coaching',
    index: '07 / COACHING',
    title: '卡住时，继续追问到真正理解。',
    summary: '实时辅导围绕当前任务和资料来源展开，支持文字、语音和视觉问题。',
    media: '/a3/assets/homepage/teacher-fallback.webp',
    alt: '数字教师实时辅导界面',
  },
  {
    id: 'assessment-review',
    index: '08 / ASSESS & REVIEW',
    title: '学完之后，要确认是否真的掌握。',
    summary: '测评给出判分、解释和错因，错题进入间隔复习，连续掌握后再退出队列。',
    media: '/a3/assets/homepage/assessment-review.webp',
    alt: '智学引擎测评与错题复习界面',
  },
  {
    id: 'progress-refresh',
    index: '09 / FEEDBACK',
    title: '每次完成，都会改变下一步。',
    summary: '掌握度、错题和学习行为回流到画像、路径、计划与报告，下一次安排随之更新。',
    media: '/a3/assets/homepage/progress-refresh.webp',
    alt: '智学引擎学习报告与计划刷新界面',
  },
  {
    id: 'teacher',
    index: '10 / TEACHER',
    title: '教师看见风险，也能及时介入。',
    summary: '班级进度、薄弱点和资源效果汇总到工作台，教师可以直接推送干预任务。',
    media: '/a3/assets/homepage/teacher-workbench.webp',
    alt: '教师工作台界面',
  },
] as const;

export const A3_HOMEPAGE_EVIDENCE = [
  {
    label: '检索与安全回归',
    value: '53 条用例',
    detail: '覆盖有依据回答、安全拒答与缺证拒答。',
  },
  {
    label: '可追踪工作流',
    value: '18 条流程',
    detail: '契约、执行 trace 与证据结构均可复查。',
  },
  {
    label: '资源生成链路',
    value: '六类资源',
    detail: '讲义、卡片、导图、练习、案例和视频脚本可回归验证。',
  },
] as const;

export const A3_HOMEPAGE_FOOTER = {
  product: '智学引擎',
  contactLabel: '产品帮助中心',
  copyright: '智学引擎产品团队',
} as const;
