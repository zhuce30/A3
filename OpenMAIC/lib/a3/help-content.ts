import type { A3Locale } from './i18n';

type Localized<T> = Record<A3Locale, T>;

export type A3HelpCategoryId =
  | 'quick-start'
  | 'account-profile'
  | 'today-plan'
  | 'ai-learning'
  | 'resources-favorites'
  | 'assessment-review'
  | 'report-notifications'
  | 'teacher'
  | 'knowledge-base'
  | 'troubleshooting';

export type A3HelpAudience = 'student' | 'teacher' | 'admin';

export type A3HelpScreenshot = {
  src: string;
  alt: Localized<string>;
  markers?: Array<{ label: string; x: number; y: number }>;
};

export type A3HelpArticleSection = {
  id: string;
  title: Localized<string>;
  paragraphs?: Localized<string[]>;
  steps?: Localized<string[]>;
  screenshot?: A3HelpScreenshot;
  tone?: 'default' | 'warning' | 'success';
};

export type A3HelpArticle = {
  id: string;
  categoryId: A3HelpCategoryId;
  title: Localized<string>;
  summary: Localized<string>;
  audience: A3HelpAudience[];
  keywords: string[];
  estimatedMinutes: number;
  updatedAt: string;
  prerequisites: Localized<string[]>;
  sections: A3HelpArticleSection[];
  action?: { label: Localized<string>; href: string };
  tourId?: string;
  // Compatibility fields for the existing help dropdown during the page migration.
  category: A3HelpCategoryId;
  steps: Localized<string[]>;
  href: string;
};

export const a3HelpCategories: Array<{
  id: A3HelpCategoryId;
  label: Localized<string>;
  description: Localized<string>;
}> = [
  { id: 'quick-start', label: { 'zh-CN': '快速开始', 'en-US': 'Quick start' }, description: { 'zh-CN': '第一次进入和完整学习流程', 'en-US': 'First visit and the full learning flow' } },
  { id: 'account-profile', label: { 'zh-CN': '账号、隐私与学习画像', 'en-US': 'Account, privacy, and profile' }, description: { 'zh-CN': '登录、授权和个性化基础信息', 'en-US': 'Sign-in, consent, and personalization basics' } },
  { id: 'today-plan', label: { 'zh-CN': '今日任务与学习计划', 'en-US': 'Today and study plan' }, description: { 'zh-CN': '今天学什么以及周期安排', 'en-US': 'What to learn today and the longer plan' } },
  { id: 'ai-learning', label: { 'zh-CN': 'AI 课堂与面对面辅导', 'en-US': 'AI classroom and coaching' }, description: { 'zh-CN': '课堂、追问、语音和图片问题', 'en-US': 'Classroom, follow-ups, voice, and images' } },
  { id: 'resources-favorites', label: { 'zh-CN': '资源推荐、系统资料与收藏', 'en-US': 'Resources and favorites' }, description: { 'zh-CN': '生成资料、查看记录和收藏', 'en-US': 'Generate, review, and save resources' } },
  { id: 'assessment-review', label: { 'zh-CN': '测评、错题本与复习', 'en-US': 'Assessment and review' }, description: { 'zh-CN': '判分、错因和间隔复习', 'en-US': 'Scoring, causes, and spaced review' } },
  { id: 'report-notifications', label: { 'zh-CN': '学习报告与通知', 'en-US': 'Reports and notifications' }, description: { 'zh-CN': '看懂变化、风险和下一步', 'en-US': 'Understand changes, risks, and next actions' } },
  { id: 'teacher', label: { 'zh-CN': '教师工作台', 'en-US': 'Teacher workspace' }, description: { 'zh-CN': '查看学情并下发真实干预', 'en-US': 'Review learning status and send interventions' } },
  { id: 'knowledge-base', label: { 'zh-CN': '知识库管理', 'en-US': 'Knowledge base' }, description: { 'zh-CN': '上传、解析、检索和引用', 'en-US': 'Upload, index, search, and cite' } },
  { id: 'troubleshooting', label: { 'zh-CN': '常见问题与故障排查', 'en-US': 'Troubleshooting' }, description: { 'zh-CN': '任务卡住、失败和权限问题', 'en-US': 'Stuck tasks, failures, and access issues' } },
];

type ArticleInput = Omit<A3HelpArticle, 'category' | 'steps' | 'href'>;

function defineArticle(input: ArticleInput): A3HelpArticle {
  const sectionSteps = (locale: A3Locale) => input.sections.flatMap((section) => section.steps?.[locale] ?? []);
  return {
    ...input,
    category: input.categoryId,
    steps: { 'zh-CN': sectionSteps('zh-CN'), 'en-US': sectionSteps('en-US') },
    href: input.action?.href ?? getA3HelpArticleHref(input.id),
  };
}

const article = (
  input: Omit<ArticleInput, 'updatedAt' | 'estimatedMinutes' | 'audience' | 'prerequisites'> &
    Partial<Pick<ArticleInput, 'updatedAt' | 'estimatedMinutes' | 'audience' | 'prerequisites'>>,
) => defineArticle({
  updatedAt: '2026-07-19',
  estimatedMinutes: 3,
  audience: ['student'],
  prerequisites: { 'zh-CN': [], 'en-US': [] },
  ...input,
});

export const a3HelpArticles: A3HelpArticle[] = [
  article({
    id: 'quick-start-overview',
    categoryId: 'quick-start',
    title: { 'zh-CN': '第一次使用，从哪里开始？', 'en-US': 'Where should I start?' },
    summary: { 'zh-CN': '按身份确认、隐私授权、学习画像、入学诊断和今日任务的顺序完成首次设置。', 'en-US': 'Complete role, privacy, profile, diagnostic, and today tasks in order.' },
    keywords: ['第一次', '新手', '注册', 'onboarding', 'quick start'],
    sections: [
      { id: 'flow', title: { 'zh-CN': '首次进入顺序', 'en-US': 'First-use order' }, steps: { 'zh-CN': ['注册并确认学生或教师身份。', '完成必要的隐私授权。', '填写学习画像并完成入学诊断。', '进入今日任务开始第一次学习。'], 'en-US': ['Register and confirm your role.', 'Complete required privacy consent.', 'Complete the profile and diagnostic.', 'Open Today to start learning.'] }, tone: 'success' },
    ],
    action: { label: { 'zh-CN': '开始设置学习画像', 'en-US': 'Set up profile' }, href: '/a3/profile-setup' },
  }),
  article({
    id: 'onboarding-profile',
    categoryId: 'account-profile',
    title: { 'zh-CN': '如何完成学习画像？', 'en-US': 'How do I complete my learning profile?' },
    summary: { 'zh-CN': '画像只记录你确认过的信息；对话采集和手动表单会合并，不会替你虚构年级或基础。', 'en-US': 'The profile stores only confirmed information from the interview and manual form.' },
    keywords: ['画像', '年级', '基础', '薄弱点', 'profile', 'grade'],
    prerequisites: { 'zh-CN': ['已登录并完成隐私授权。'], 'en-US': ['Signed in and accepted privacy consent.'] },
    tourId: 'profile-setup',
    sections: [
      { id: 'steps', title: { 'zh-CN': '填写步骤', 'en-US': 'Steps' }, steps: { 'zh-CN': ['先阅读页面上方说明，了解画像用途。', '在对话区说明目标、基础和可用时间。', '在手动表单中补充或修改未确认字段。', '确认信息后保存并进入入学诊断。'], 'en-US': ['Read how the profile is used.', 'Describe goals, level, and available time.', 'Complete or correct fields in the manual form.', 'Save and continue to the diagnostic.'] }, screenshot: { src: '/a3/help/profile-setup.webp', alt: { 'zh-CN': '学习画像页面', 'en-US': 'Learning profile page' }, markers: [{ label: '1', x: 28, y: 20 }, { label: '2', x: 35, y: 45 }, { label: '3', x: 68, y: 68 }] } },
      { id: 'result', title: { 'zh-CN': '完成后会发生什么', 'en-US': 'What happens next' }, paragraphs: { 'zh-CN': ['系统会基于已确认画像生成初始路径和计划；以后测评和错题会继续更新薄弱点。'], 'en-US': ['The confirmed profile creates the initial path and plan; assessments keep weak points current.'] }, tone: 'success' },
    ],
    action: { label: { 'zh-CN': '前往学习画像', 'en-US': 'Open profile setup' }, href: '/a3/profile-setup' },
  }),
  article({
    id: 'account-settings',
    categoryId: 'account-profile',
    title: { 'zh-CN': '如何修改资料、语言和主题？', 'en-US': 'How do I change profile, language, and theme?' },
    summary: { 'zh-CN': '账号设置集中管理个人资料、授权、语言、主题和退出登录。', 'en-US': 'Settings manages profile, consent, language, theme, and sign-out.' },
    keywords: ['设置', '语言', '主题', '退出', 'settings', 'theme'],
    sections: [{ id: 'steps', title: { 'zh-CN': '操作步骤', 'en-US': 'Steps' }, steps: { 'zh-CN': ['点击右上角头像打开用户菜单。', '进入账号设置修改资料和授权。', '使用顶部语言和主题按钮调整显示。'], 'en-US': ['Open the user menu.', 'Open settings to edit profile and consent.', 'Use language and theme controls in the header.'] } }],
    action: { label: { 'zh-CN': '前往账号设置', 'en-US': 'Open settings' }, href: '/a3/settings' },
  }),
  article({
    id: 'admission-diagnostic',
    categoryId: 'today-plan',
    title: { 'zh-CN': '入学诊断为什么会改变学习计划？', 'en-US': 'Why does the diagnostic change my plan?' },
    summary: { 'zh-CN': '诊断不仅给分数，还会识别薄弱知识点并刷新学习路径与今日任务。', 'en-US': 'The diagnostic identifies weak points and refreshes the learning path and today tasks.' },
    keywords: ['入学诊断', '分数', '薄弱点', 'diagnostic', 'score'],
    tourId: 'admission-diagnostic',
    sections: [
      { id: 'steps', title: { 'zh-CN': '完成诊断', 'en-US': 'Complete the diagnostic' }, steps: { 'zh-CN': ['确认诊断课程和预计题量。', '逐题作答，不确定时也要选择最接近的答案。', '提交后查看水平、薄弱点和下一步建议。', '返回今日任务查看刷新后的安排。'], 'en-US': ['Confirm course and question count.', 'Answer every question.', 'Review level, weak points, and next action.', 'Return to Today for the refreshed plan.'] }, screenshot: { src: '/a3/help/admission-diagnostic.webp', alt: { 'zh-CN': '入学诊断页面', 'en-US': 'Admission diagnostic page' }, markers: [{ label: '1', x: 30, y: 20 }, { label: '2', x: 50, y: 55 }, { label: '3', x: 82, y: 80 }] } },
    ],
    action: { label: { 'zh-CN': '前往入学诊断', 'en-US': 'Open diagnostic' }, href: '/a3/admission-diagnostic' },
  }),
  article({
    id: 'today-and-study-plan',
    categoryId: 'today-plan',
    title: { 'zh-CN': '今日任务和学习计划有什么关系？', 'en-US': 'How do Today and the study plan work together?' },
    summary: { 'zh-CN': '学习计划安排周期目标，今日任务只展示当前日期真正需要执行和复习的内容。', 'en-US': 'The plan sets the period; Today shows what must be learned and reviewed now.' },
    keywords: ['今日任务', '计划', '延期', '复习队列', 'today', 'study plan'],
    tourId: 'today-plan',
    sections: [
      { id: 'steps', title: { 'zh-CN': '今天如何开始', 'en-US': 'Start today' }, steps: { 'zh-CN': ['先看顶部处方和预计总时长。', '从“下一步”推荐动作进入当前任务。', '完成任务后回到今日页面确认进度回流。', '需要调整周期时再进入计划总览。'], 'en-US': ['Review today prescription and duration.', 'Open the recommended next action.', 'Return after completion to confirm progress.', 'Use plan overview for period adjustments.'] }, screenshot: { src: '/a3/help/today-plan.webp', alt: { 'zh-CN': '今日任务页面', 'en-US': 'Today tasks page' }, markers: [{ label: '1', x: 40, y: 18 }, { label: '2', x: 35, y: 45 }, { label: '3', x: 62, y: 70 }] } },
    ],
    action: { label: { 'zh-CN': '查看今日任务', 'en-US': 'Open Today' }, href: '/a3/today' },
  }),
  article({
    id: 'learning-path',
    categoryId: 'today-plan',
    title: { 'zh-CN': '学习路径如何生成和调整？', 'en-US': 'How is the learning path generated and adjusted?' },
    summary: { 'zh-CN': '路径基于先修关系、画像薄弱点、错题记录和当前掌握度排序。', 'en-US': 'The path uses prerequisites, weak points, mistakes, and mastery.' },
    keywords: ['路径', '先修', '知识点', '重新规划', 'path', 'prerequisite'],
    sections: [{ id: 'steps', title: { 'zh-CN': '查看路径', 'en-US': 'Review the path' }, steps: { 'zh-CN': ['进入学习路径确认当前节点。', '查看节点的先修关系和掌握状态。', '完成任务或测评后刷新路径。'], 'en-US': ['Open the path and current node.', 'Review prerequisites and mastery.', 'Refresh after tasks or assessments.'] } }],
    action: { label: { 'zh-CN': '查看学习路径', 'en-US': 'Open learning path' }, href: '/a3/learning-path' },
  }),
  article({
    id: 'face-coaching',
    categoryId: 'ai-learning',
    title: { 'zh-CN': '面对面辅导可以做什么？', 'en-US': 'What can face-to-face coaching do?' },
    summary: { 'zh-CN': '支持语音、图片和当前课堂上下文提问，并把随堂练习写回测评记录。', 'en-US': 'Ask by voice or image using classroom context, with quizzes written to assessment records.' },
    keywords: ['摄像头', '语音', '拍照', '辅导', 'camera', 'voice', 'coaching'],
    sections: [{ id: 'steps', title: { 'zh-CN': '开始辅导', 'en-US': 'Start coaching' }, steps: { 'zh-CN': ['允许需要的摄像头或麦克风权限。', '选择文字、语音或拍照方式提问。', '检查回答中的资料来源和未验证提示。'], 'en-US': ['Grant camera or microphone permission.', 'Ask by text, voice, or photo.', 'Review citations and unverified notices.'] } }],
    action: { label: { 'zh-CN': '进入面对面辅导', 'en-US': 'Open coaching' }, href: '/a3/coaching' },
  }),
  article({
    id: 'generate-personal-resources',
    categoryId: 'resources-favorites',
    title: { 'zh-CN': '如何生成一套适合自己的学习资料？', 'en-US': 'How do I generate personalized learning resources?' },
    summary: { 'zh-CN': '系统结合课程、路径节点、薄弱点和授权资料生成文档、PPT、导图、练习、案例、代码或视频。', 'en-US': 'Generate documents, PPT, maps, exercises, cases, labs, or video from your learning context.' },
    keywords: ['生成个性化资源', '资源包', 'PPT', '导图', '视频', 'generate resources'],
    tourId: 'resource-generation',
    sections: [
      { id: 'steps', title: { 'zh-CN': '生成步骤', 'en-US': 'Generation steps' }, steps: { 'zh-CN': ['确认右侧当前课程、路径节点和重点补强内容。', '描述现在卡住的问题。', '选择需要的资源类型，或直接生成完整资源包。', '到资源记录查看进度、失败原因和已完成内容。'], 'en-US': ['Confirm course, path node, and focus.', 'Describe where you are stuck.', 'Choose resource types or a complete pack.', 'Review progress and failures in resource records.'] }, screenshot: { src: '/a3/help/resource-generation.webp', alt: { 'zh-CN': '资源推荐与生成页面', 'en-US': 'Resource recommendation and generation page' }, markers: [{ label: '1', x: 78, y: 20 }, { label: '2', x: 45, y: 27 }, { label: '3', x: 34, y: 55 }] } },
      { id: 'failure', title: { 'zh-CN': '生成很久仍没有结果', 'en-US': 'Generation is taking too long' }, paragraphs: { 'zh-CN': ['先进入资源记录确认任务状态。失败任务可以单独重试，不需要重新生成已经成功的内容。'], 'en-US': ['Check resource records first. Retry only failed work instead of regenerating successful content.'] }, tone: 'warning' },
    ],
    action: { label: { 'zh-CN': '前往资源推荐', 'en-US': 'Open resource recommendations' }, href: '/a3/recommendations' },
  }),
  article({
    id: 'library-and-favorites',
    categoryId: 'resources-favorites',
    title: { 'zh-CN': '系统资料和我的收藏在哪里？', 'en-US': 'Where are system resources and favorites?' },
    summary: { 'zh-CN': '系统资料是平台提供的已入库内容；收藏同时汇总系统资料和生成的个性资源。', 'en-US': 'The library contains platform resources; Favorites combines library and generated resources.' },
    keywords: ['系统资料', '收藏', '个性资源', 'library', 'favorites'],
    sections: [{ id: 'steps', title: { 'zh-CN': '查找和收藏', 'en-US': 'Find and save' }, steps: { 'zh-CN': ['进入系统资料按知识点或类型筛选。', '打开资源后点击收藏。', '进入我的收藏统一查看和取消收藏。'], 'en-US': ['Filter the system library.', 'Open a resource and save it.', 'Manage all saved items in Favorites.'] } }],
    action: { label: { 'zh-CN': '查看我的收藏', 'en-US': 'Open favorites' }, href: '/a3/favorites' },
  }),
  article({
    id: 'assessment-wrong-review',
    categoryId: 'assessment-review',
    title: { 'zh-CN': '测评、错题本和复习如何联动？', 'en-US': 'How do assessment, wrong notebook, and review connect?' },
    summary: { 'zh-CN': '错误题目进入错题本并安排复习，正确率和掌握状态会回流到报告和计划。', 'en-US': 'Wrong answers enter the wrong notebook and spaced review, updating reports and plans.' },
    keywords: ['题库', '错题本', '复习', 'wrong notebook', 'assessment', 'review'],
    sections: [{ id: 'steps', title: { 'zh-CN': '完成一次复习闭环', 'en-US': 'Complete a review loop' }, steps: { 'zh-CN': ['在练习中心完成题目并提交。', '查看正确性、解析和错因。', '进入错题本重练到掌握。', '返回报告查看变化。'], 'en-US': ['Complete and submit an exercise.', 'Review correctness, explanation, and cause.', 'Retry in the wrong notebook.', 'Review the change in Reports.'] } }],
    action: { label: { 'zh-CN': '查看错题本', 'en-US': 'Open wrong notebook' }, href: '/a3/wrong-notebook' },
  }),
  article({
    id: 'report-and-notifications',
    categoryId: 'report-notifications',
    title: { 'zh-CN': '如何看懂学习报告和通知？', 'en-US': 'How do I understand reports and notifications?' },
    summary: { 'zh-CN': '报告解释近期表现、证据强弱和优先行动；通知把复习和教师任务带回对应页面。', 'en-US': 'Reports explain evidence and priorities; notifications return you to review and teacher tasks.' },
    keywords: ['报告', '通知', '趋势', '提醒', 'report', 'notification'],
    sections: [{ id: 'steps', title: { 'zh-CN': '从结论进入行动', 'en-US': 'Turn insight into action' }, steps: { 'zh-CN': ['先阅读顶部阶段结论。', '查看优先掌握知识点和证据状态。', '点击建议行动回到今日任务、测评或错题复习。'], 'en-US': ['Read the stage conclusion.', 'Review priority points and evidence.', 'Use the action to return to Today or review.'] } }],
    action: { label: { 'zh-CN': '查看学习报告', 'en-US': 'Open report' }, href: '/a3/report' },
  }),
  article({
    id: 'teacher-intervention',
    categoryId: 'teacher',
    title: { 'zh-CN': '教师如何查看学情并推送任务？', 'en-US': 'How does a teacher review progress and send tasks?' },
    summary: { 'zh-CN': '教师工作台汇总进度、薄弱点、资源效果和待干预学生，并把任务写入学生通知。', 'en-US': 'The teacher workspace combines progress, weak points, resource effects, and interventions.' },
    audience: ['teacher', 'admin'],
    keywords: ['教师', '干预', '推送任务', 'teacher', 'intervention'],
    sections: [{ id: 'steps', title: { 'zh-CN': '执行干预', 'en-US': 'Send an intervention' }, steps: { 'zh-CN': ['查看待干预学生和风险原因。', '选择错题复习、测评或资源任务。', '确认目标学生后下发。', '在资源效果区跟踪完成情况。'], 'en-US': ['Review at-risk students and reasons.', 'Choose review, assessment, or resource task.', 'Confirm recipients and send.', 'Track completion in resource effects.'] } }],
    action: { label: { 'zh-CN': '进入教师工作台', 'en-US': 'Open teacher workspace' }, href: '/a3/teacher' },
  }),
  article({
    id: 'knowledge-base-indexing',
    categoryId: 'knowledge-base',
    title: { 'zh-CN': '如何上传资料并完成知识库解析？', 'en-US': 'How do I upload and index knowledge-base files?' },
    summary: { 'zh-CN': '教师或管理员上传 PDF、DOCX、PPTX 后，等待解析完成再用于检索、课堂和引用。', 'en-US': 'Teachers and admins upload PDF, DOCX, or PPTX and wait for indexing before retrieval.' },
    audience: ['teacher', 'admin'],
    prerequisites: { 'zh-CN': ['使用教师或管理员账号。', '旧版 PPT 已转换为 PPTX。'], 'en-US': ['Use a teacher or admin account.', 'Convert legacy PPT files to PPTX.'] },
    keywords: ['知识库', '上传', '解析', '一直解析中', '索引', 'RAG', 'indexing stuck'],
    tourId: 'knowledge-base-indexing',
    sections: [
      { id: 'steps', title: { 'zh-CN': '上传与解析', 'en-US': 'Upload and index' }, steps: { 'zh-CN': ['选择受支持文件并确认课程。', '上传后在资源列表查看解析进度。', '状态变为可用后执行检索验证。', '失败时查看原因并只重试失败资源。'], 'en-US': ['Choose a supported file and course.', 'Watch indexing progress in the resource list.', 'Search after the status becomes ready.', 'Review the cause and retry only failed resources.'] }, screenshot: { src: '/a3/help/knowledge-base.webp', alt: { 'zh-CN': '知识库资源管理页面', 'en-US': 'Knowledge-base resource page' }, markers: [{ label: '1', x: 35, y: 22 }, { label: '2', x: 50, y: 50 }, { label: '3', x: 70, y: 72 }] } },
      { id: 'stuck', title: { 'zh-CN': '为什么一直显示解析中？', 'en-US': 'Why does indexing stay in progress?' }, paragraphs: { 'zh-CN': ['先查看顶部任务中心是否仍有进度。如果任务已经失败，资源卡片应显示可读原因和重试入口；不要重复上传同一文件。'], 'en-US': ['Check task progress first. Failed resources should show a readable cause and retry action; do not upload duplicates.'] }, tone: 'warning' },
    ],
    action: { label: { 'zh-CN': '进入知识库', 'en-US': 'Open knowledge base' }, href: '/a3/knowledge-base' },
  }),
  article({
    id: 'task-stuck-or-failed',
    categoryId: 'troubleshooting',
    title: { 'zh-CN': '生成任务卡住或失败怎么办？', 'en-US': 'What should I do when a task is stuck or failed?' },
    summary: { 'zh-CN': '先确认任务中心状态、失败原因和服务器连接，再决定重试当前任务或继续等待。', 'en-US': 'Check task status, failure cause, and server connection before retrying or waiting.' },
    keywords: ['卡住', '失败', '后端断开', '超时', 'stuck', 'failed', 'timeout'],
    sections: [
      { id: 'checks', title: { 'zh-CN': '按顺序检查', 'en-US': 'Check in order' }, steps: { 'zh-CN': ['打开顶部任务中心查看任务是否仍在运行。', '刷新页面确认任务能否从服务器恢复。', '失败时记录可读原因，只重试失败部分。', '全站同时不可用时再检查服务器状态。'], 'en-US': ['Open the task center.', 'Refresh and confirm server recovery.', 'Retry only failed parts using the visible cause.', 'Check server status only if the whole site is unavailable.'] } },
    ],
    action: { label: { 'zh-CN': '查看任务中心', 'en-US': 'Open resource records' }, href: '/a3/resources' },
  }),
];

export function getA3HelpArticle(id: string) {
  return a3HelpArticles.find((item) => item.id === id) ?? null;
}

export function getA3HelpArticleHref(id: string) {
  return `/a3/help/${encodeURIComponent(id)}`;
}

export function searchA3HelpArticles(query: string, locale: A3Locale) {
  const normalized = query.trim().toLocaleLowerCase(locale);
  if (!normalized) return a3HelpArticles;

  return a3HelpArticles.filter((item) => {
    const sectionText = item.sections.flatMap((section) => [
      section.title[locale],
      ...(section.paragraphs?.[locale] ?? []),
      ...(section.steps?.[locale] ?? []),
    ]);
    const haystack = [
      item.title[locale],
      item.summary[locale],
      ...item.prerequisites[locale],
      ...sectionText,
      ...item.keywords,
    ].join(' ').toLocaleLowerCase(locale);
    return haystack.includes(normalized);
  });
}
