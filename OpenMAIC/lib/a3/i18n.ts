'use client';

import { useCallback, useEffect, useState } from 'react';

export type A3Locale = 'zh-CN' | 'en-US';

export const A3_LOCALE_STORAGE_KEY = 'a3-language';
export const A3_LOCALE_CHANGE_EVENT = 'a3-locale-change';

export const a3Messages = {
  'zh-CN': {
    appName: '智学引擎',
    appNameEn: 'AI Learning',
    navAdmissionDiagnostic: '入学诊断',
    navProfileSetup: '学习画像',
    navToday: '今日学习',
    navTodayTasks: '今日任务',
    searchPlaceholder: '搜索课程、知识点、资源',
    notifications: '通知消息',
    markAllRead: '全部已读',
    viewAllNotifications: '查看全部通知',
    helpCenter: '帮助中心',
    onboarding: '新手引导',
    learningPathGuide: '学习路径说明',
    knowledgeBaseGuide: '知识库使用',
    systemSettings: '系统设置',
    viewAllHelp: '全部帮助',
    helpSearchPlaceholder: '搜索帮助内容',
    noHelpResults: '没有匹配的帮助内容',
    languageSettings: '语言设置',
    languageName: '简体中文',
    languageShort: '中',
    languageChinese: '简体中文',
    languageEnglish: 'English',
    themeToggle: '切换明暗主题',
    helpSearchHint: '可搜索常见问题，点击条目直接进入对应功能页面。',
    openNotifications: '打开通知消息',
    switchLanguage: '切换语言',
    openUserMenu: '打开用户菜单',
    profile: '个人资料',
    accountSettings: '账号设置',
    switchAccount: '切换账号',
    logout: '退出登录',
    unnamedUser: '未命名用户',
    defaultStudyGroup: '操作系统学习组',
    studyGroupSuffix: '学习组',
    reportTitle: '学习报告与成长分析',
    classroomTitle: 'AI 多智能体课堂',
    coachingTitle: '多模态面对面辅导',
    navDashboard: '首页',
    navDemoFlow: '演示闭环',
    navCapabilities: '能力总览',
    navStudyPlan: '学习规划',
    navPlanOverview: '计划总览',
    navLearningPath: '学习路径',
    navCourses: '课程学习',
    navKnowledgeGraph: '知识图谱',
    navRecommendations: '资源推荐',
    navSystemLibrary: '系统资料',
    navResourceRecords: '资源记录',
    navAssessment: '练习复盘',
    navPracticeCenter: '练习中心',
    navWrongNotebook: '错题本',
    navReport: '学习报告',
    navClassroom: 'AI 学习',
    navAiClassroom: 'AI 课堂',
    navCoaching: '面对面辅导',
    navFavorites: '我的收藏',
    navNotifications: '通知消息',
    navTeacher: '教师工作台',
    navKnowledgeBase: '知识库',
    navKnowledgeBaseHome: '知识库首页',
    navSettings: '系统设置',
  },
  'en-US': {
    appName: 'AI Learning',
    appNameEn: 'AI Learning',
    navAdmissionDiagnostic: 'Admission Diagnostic',
    navProfileSetup: 'Learning Profile',
    navToday: 'Today',
    navTodayTasks: 'Today Tasks',
    searchPlaceholder: 'Search courses, knowledge points, resources',
    notifications: 'Notifications',
    markAllRead: 'Mark all read',
    viewAllNotifications: 'View all notifications',
    helpCenter: 'Help Center',
    onboarding: 'Onboarding',
    learningPathGuide: 'Learning Path Guide',
    knowledgeBaseGuide: 'Knowledge Base Guide',
    systemSettings: 'System Settings',
    viewAllHelp: 'All help',
    helpSearchPlaceholder: 'Search help',
    noHelpResults: 'No matching help articles',
    languageSettings: 'Language Settings',
    languageName: 'English',
    languageShort: 'EN',
    languageChinese: '简体中文',
    languageEnglish: 'English',
    themeToggle: 'Toggle theme',
    helpSearchHint: 'Search common questions and open the related workflow directly.',
    openNotifications: 'Open notifications',
    switchLanguage: 'Switch language',
    openUserMenu: 'Open user menu',
    profile: 'Profile',
    accountSettings: 'Account settings',
    switchAccount: 'Switch account',
    logout: 'Log out',
    unnamedUser: 'Unnamed user',
    defaultStudyGroup: 'Automatic Control Study Group',
    studyGroupSuffix: ' Study Group',
    reportTitle: 'Learning Report and Growth Analysis',
    classroomTitle: 'AI Multi-Agent Classroom',
    coachingTitle: 'Multimodal Face-to-Face Coaching',
    navDashboard: 'Home',
    navDemoFlow: 'Demo Flow',
    navCapabilities: 'Capabilities',
    navStudyPlan: 'Learning Plan',
    navPlanOverview: 'Plan Overview',
    navLearningPath: 'Learning Path',
    navCourses: 'Courses',
    navKnowledgeGraph: 'Knowledge Graph',
    navRecommendations: 'Recommendations',
    navSystemLibrary: 'System Library',
    navResourceRecords: 'Resource Records',
    navAssessment: 'Practice Review',
    navPracticeCenter: 'Practice Center',
    navWrongNotebook: 'Mistake Notebook',
    navReport: 'Learning Report',
    navClassroom: 'AI Learning',
    navAiClassroom: 'AI Classroom',
    navCoaching: 'Face-to-Face Coaching',
    navFavorites: 'Favorites',
    navNotifications: 'Notifications',
    navTeacher: 'Teacher Workspace',
    navKnowledgeBase: 'Knowledge Base',
    navKnowledgeBaseHome: 'Knowledge Base Home',
    navSettings: 'System Settings',
  },
} as const;

export type A3Messages = (typeof a3Messages)[A3Locale];

function normalizeA3Locale(value: string | null | undefined): A3Locale {
  return value === 'en-US' ? 'en-US' : 'zh-CN';
}

export function getA3LocaleLabel(locale: A3Locale) {
  return a3Messages[locale].languageName;
}

export function persistA3Locale(locale: A3Locale) {
  if (typeof window === 'undefined') return;
  document.documentElement.lang = locale;
  window.localStorage.setItem(A3_LOCALE_STORAGE_KEY, locale);
  window.dispatchEvent(new CustomEvent<A3Locale>(A3_LOCALE_CHANGE_EVENT, { detail: locale }));
}

export function useA3Locale() {
  const [locale, setLocaleState] = useState<A3Locale>(() => {
    if (typeof window === 'undefined') return 'zh-CN';
    return normalizeA3Locale(window.localStorage.getItem(A3_LOCALE_STORAGE_KEY));
  });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    function handleLocaleChange(event: Event) {
      setLocaleState(normalizeA3Locale((event as CustomEvent<A3Locale>).detail));
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === A3_LOCALE_STORAGE_KEY) {
        setLocaleState(normalizeA3Locale(event.newValue));
      }
    }

    window.addEventListener(A3_LOCALE_CHANGE_EVENT, handleLocaleChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(A3_LOCALE_CHANGE_EVENT, handleLocaleChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const setLocale = useCallback((nextLocale: A3Locale) => {
    setLocaleState(nextLocale);
    persistA3Locale(nextLocale);
  }, []);

  return {
    locale,
    messages: a3Messages[locale],
    setLocale,
  };
}
