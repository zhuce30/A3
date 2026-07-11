export const A3_HOMEPAGE_BRAND = '智学引擎';

export const A3_HOMEPAGE_NAV = [
  { label: '产品能力', href: '#capabilities' },
  { label: '学习闭环', href: '#learning-loop' },
  { label: '真实证据', href: '#evidence' },
  { label: '联系我们', href: '#contact' },
] as const;

export const A3_HOMEPAGE_ROUTES = {
  register: '/a3/register',
  login: '/a3/login',
  review: '/a3/login?mode=review',
  workspace: '/a3/dashboard',
} as const;

export const A3_HOMEPAGE_ACTIONS = {
  anonymousWorkspace: '登录',
  signedInWorkspace: '进入学习区',
  review: '评审体验',
  registerShort: '开启旅程',
} as const;

export const A3_HOMEPAGE_METADATA = {
  title: '智学引擎 | 每一步学习，都更懂你',
  description: '面向大学生的多智能体个性化学习平台。',
} as const;

export const A3_HOMEPAGE_HERO = {
  titleLines: ['每一步学习，', '都更懂你。'],
  support: '一群懂学习的智能体，陪你找到自己的节奏。',
  cta: '开启我的智学旅程',
} as const;

export const A3_HOMEPAGE_HERO_MEDIA = [
  { src: '/a3/assets/homepage/profile.webp', alt: '学习画像界面' },
  { src: '/a3/assets/homepage/diagnostic.webp', alt: '入学诊断界面' },
  { src: '/a3/assets/homepage/knowledge-base.webp', alt: '本地知识库界面' },
  { src: '/a3/assets/homepage/classroom.webp', alt: 'AI 课堂界面' },
] as const;

export const A3_HOMEPAGE_STORY = [
  {
    id: 'profile',
    index: '01 / PROFILE',
    title: '先认识你。',
    summary: '目标、基础、时间和偏好，组成你的学习画像。',
    media: '/a3/assets/homepage/profile.webp',
    alt: '学习画像设置界面',
  },
  {
    id: 'diagnostic',
    index: '02 / DIAGNOSTIC',
    title: '找到你的起点。',
    summary: '一次诊断，找出进程调度中真正需要补齐的部分。',
    media: '/a3/assets/homepage/diagnostic.webp',
    alt: '操作系统入学诊断界面',
  },
  {
    id: 'knowledge',
    index: '03 / KNOWLEDGE',
    title: '让资料真正为你所用。',
    summary: '课本、课程 PPT 和知识总结，变成随时可查的学习依据。',
    media: '/a3/assets/homepage/knowledge-base.webp',
    alt: '操作系统本地知识库界面',
  },
  {
    id: 'classroom',
    index: '04 / CLASSROOM',
    title: '走进为你生成的课堂。',
    summary: '讲解紧跟你的薄弱点，也保留每一条资料来源。',
    media: '/a3/assets/homepage/classroom.webp',
    alt: '个性化 AI 课堂界面',
  },
  {
    id: 'coaching',
    index: '05 / COACHING',
    title: '随时有人陪你学懂。',
    summary: '看见问题、听懂追问，再陪你把难点讲明白。',
    media: '/a3/assets/homepage/teacher-fallback.webp',
    alt: '数字教师实时辅导界面',
  },
  {
    id: 'evidence',
    index: '06 / EVIDENCE',
    title: '每一步，都有据可循。',
    summary: '从资料来源到学习进展，过程清清楚楚。',
    media: null,
    alt: '',
  },
  {
    id: 'teacher',
    index: '07 / TEACHER',
    title: '及时看见，也能及时介入。',
    summary: '教师看见进度和薄弱点，在需要的时候推送任务。',
    media: '/a3/assets/homepage/teacher-workbench.webp',
    alt: '教师工作台界面',
  },
] as const;

export const A3_HOMEPAGE_EVIDENCE = [
  { label: '知识库', value: '资料可检索' },
  { label: 'AI 回答', value: '来源可验证' },
  { label: '学习进展', value: '结果会写回' },
] as const;

export const A3_HOMEPAGE_FOOTER = {
  team: '这次不要意味何',
  competition: 'A3-基于大模型的个性化资源生成与学习多智能体系统开发',
  email: '3062221819@qq.com',
} as const;
