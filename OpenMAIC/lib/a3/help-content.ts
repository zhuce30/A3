import type { A3Locale } from './i18n';

export type A3HelpArticle = {
  id: string;
  category: string;
  title: Record<A3Locale, string>;
  summary: Record<A3Locale, string>;
  steps: Record<A3Locale, string[]>;
  href: string;
  keywords: string[];
};

export const a3HelpArticles: A3HelpArticle[] = [
  {
    id: 'onboarding-profile',
    category: 'account',
    title: { 'zh-CN': '首次进入如何完成学习画像？', 'en-US': 'How do I complete the first-time learning profile?' },
    summary: {
      'zh-CN': '按欢迎页、隐私授权、画像采集的顺序完成，系统会生成初始学习路径。',
      'en-US': 'Complete welcome, privacy consent, and profile setup to generate the first learning path.',
    },
    steps: {
      'zh-CN': ['注册并登录学生账号。', '阅读隐私授权说明并选择可选授权。', '填写姓名、年级、基础水平、薄弱知识点和每日学习时间。', '生成专属学习路径。'],
      'en-US': ['Register and sign in as a student.', 'Review privacy consent and choose optional permissions.', 'Fill in name, grade, foundation, weak points, and study time.', 'Generate the personalized learning path.'],
    },
    href: '/a3/profile-setup',
    keywords: ['画像', '注册', '隐私', 'onboarding', 'profile'],
  },
  {
    id: 'learning-path',
    category: 'learning',
    title: { 'zh-CN': '学习路径如何生成和调整？', 'en-US': 'How is the learning path generated and adjusted?' },
    summary: {
      'zh-CN': '路径基于课程先修关系、画像薄弱点、错题记录和当前进度生成。',
      'en-US': 'The path is generated from prerequisites, profile weak points, mistakes, and progress.',
    },
    steps: {
      'zh-CN': ['进入学习路径页面。', '确认当前课程为操作系统。', '点击重新规划，可基于最新画像和错题刷新路径。', '完成当前节点后会解锁下一知识点。'],
      'en-US': ['Open Learning Path.', 'Confirm the Operating Systems course.', 'Replan to refresh using latest profile and mistakes.', 'Complete the current node to unlock the next one.'],
    },
    href: '/a3/learning-path',
    keywords: ['路径', '规划', '先修', '知识点', 'path'],
  },
  {
    id: 'knowledge-base',
    category: 'resources',
    title: { 'zh-CN': '本地知识库如何上传和检索？', 'en-US': 'How do I upload and search the local knowledge base?' },
    summary: {
      'zh-CN': '教师账号可上传课件、教材和资料，系统会索引后用于课堂溯源和 RAG 检索。',
      'en-US': 'Teacher accounts can upload materials. They are indexed for source tracing and RAG retrieval.',
    },
    steps: {
      'zh-CN': ['使用教师或管理员账号登录。', '进入本地知识库页面上传 PDF、DOCX、PPTX 等文件。', '旧版 PPT 需要先转换为 PPTX。', '索引完成后可在课堂和知识库检索中使用。'],
      'en-US': ['Sign in as teacher or admin.', 'Upload PDF, DOCX, PPTX and other files.', 'Legacy PPT files must be converted to PPTX first.', 'Use indexed resources in classroom and KB search.'],
    },
    href: '/a3/knowledge-base',
    keywords: ['知识库', 'RAG', '上传', '课件', 'PPTX', 'kb'],
  },
  {
    id: 'face-coaching',
    category: 'coaching',
    title: { 'zh-CN': '面对面辅导可以做什么？', 'en-US': 'What can face-to-face coaching do?' },
    summary: {
      'zh-CN': '支持摄像头预览、语音识别、拍照提问、课堂上下文问答和随堂测验。',
      'en-US': 'It supports camera preview, ASR, photo questions, context-aware Q&A, and live quizzes.',
    },
    steps: {
      'zh-CN': ['进入面对面辅导页面并授权摄像头和麦克风。', '点击开始说话进行语音提问。', '点击拍照提问让视觉模型分析当前画面。', '右侧随堂测验会写入真实测评和错题记录。'],
      'en-US': ['Open coaching and grant camera and microphone permissions.', 'Use Start speaking for voice questions.', 'Use Photo question for visual analysis.', 'Live quizzes are written to assessments and mistakes.'],
    },
    href: '/a3/coaching',
    keywords: ['摄像头', '语音', '拍照', '多模态', '辅导', 'vision', 'asr'],
  },
  {
    id: 'assessment-report',
    category: 'assessment',
    title: { 'zh-CN': '题库、错题本和学习报告如何联动？', 'en-US': 'How do practice, mistakes, and reports connect?' },
    summary: {
      'zh-CN': '测评答题会更新正确率，错误题目进入错题本，学习报告按真实答题记录聚合。',
      'en-US': 'Answers update accuracy, wrong answers enter the notebook, and reports aggregate real records.',
    },
    steps: {
      'zh-CN': ['进入题库练习或随堂测验答题。', '提交后查看解析和易错原因。', '错误题自动进入错题本。', '学习报告会同步更新正确率、错题数和建议。'],
      'en-US': ['Answer in Practice Bank or live quiz.', 'Review explanation and error cause.', 'Wrong answers enter the notebook.', 'Reports update accuracy, mistakes, and suggestions.'],
    },
    href: '/a3/assessment',
    keywords: ['题库', '错题', '报告', '测评', 'assessment', 'report'],
  },
  {
    id: 'account-settings',
    category: 'account',
    title: { 'zh-CN': '如何修改资料、语言、主题和退出登录？', 'en-US': 'How do I change profile, language, theme, or log out?' },
    summary: {
      'zh-CN': '系统设置支持资料保存、授权管理、语言切换、明暗主题、退出登录和切换账号。',
      'en-US': 'Settings supports profile updates, consent management, language, theme, logout, and account switching.',
    },
    steps: {
      'zh-CN': ['点击右上角头像打开用户菜单。', '进入账号设置修改资料和授权。', '使用语言按钮切换中英文。', '使用主题开关切换明暗模式。'],
      'en-US': ['Open the user menu from the avatar.', 'Go to Account settings for profile and consent.', 'Use the language control for Chinese or English.', 'Use the theme switch for light or dark mode.'],
    },
    href: '/a3/settings',
    keywords: ['设置', '语言', '主题', '退出', '账号', 'settings'],
  },
];

export function searchA3HelpArticles(query: string, locale: A3Locale) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return a3HelpArticles;
  return a3HelpArticles.filter((article) => {
    const haystack = [
      article.title[locale],
      article.summary[locale],
      ...article.steps[locale],
      ...article.keywords,
    ].join(' ').toLowerCase();
    return haystack.includes(normalized);
  });
}
