'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Pencil,
  ExternalLink,
  History,
  Image as ImageIcon,
  Layers3,
  Library,
  ListChecks,
  Loader2,
  Mic,
  MicOff,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  RefreshCw,
  Route,
  Search,
  Send,
  Sparkles,
  Star,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ProfileUpdateCandidatePanel } from '@/components/a3/profile/profile-update-candidate-panel';
import { a3GetJson, a3PostJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { AnswerFeedback, AssessmentSession } from '@/lib/a3/assessment-types';
import { buildPracticeSyncEvidence, buildPracticeWritebackPayload, findPracticePlanTaskForRecommendation } from '@/lib/a3/classroom-practice';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import type { A3ApiResponse, StudyPlan, StudyPlanTaskFeedback } from '@/lib/a3/learning-types';
import { useA3Locale, type A3Locale } from '@/lib/a3/i18n';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import type { A3OpenMAICClassroomArtifact, A3ResourcePacksResponse, A3ResourcePackV2, A3ResourcePackV2ResourceType } from '@/lib/a3/recommendation-types';
import { useResourceGeneration } from '@/lib/a3/use-resource-generation';
import { classifyIntent } from '@/lib/a3/intent-router';
import { ResourceInlineBody } from './resource-standalone-view';
import { normalizeASRUploadAudio } from '@/lib/audio/wav-utils';
import { cn } from '@/lib/utils';
import { A3Pill } from '../ui/a3-card';
import { A3Markdown } from '../ui/a3-markdown';
import { A3SpeechControls } from '../ui/a3-speech-controls';
import { TutorPersonaSelector } from './tutor-persona/tutor-persona-selector';
import { useTutorPersona } from './tutor-persona/use-tutor-persona';
import {
  ClassroomContextShell,
  ClassroomStickyContextBar,
  useClassroomContextVisibility,
} from './classroom/classroom-context-shell';

type ClassroomResponse = { success: boolean; error?: string; classroom: ClassroomContext };
type FavoriteResponse = { success: boolean; error?: string };
type Citation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  sourceTypeLabel?: string;
  sourceOrigin?: string;
  sourceScope?: string;
  score?: number | null;
  snippet?: string;
  previewUrl?: string;
};
type Claim = { id: string; text: string; verified: boolean; overlap?: number; citation?: Citation | null };
type SafetyStatus = { safe: boolean; category: string; reason: string };
type FollowUpSuggestion = { label: string; question: string; type: string; reason?: string };
type ClassroomRetrievalMode = 'fast' | 'deep';
type ClassroomRetrievalScope = 'all' | 'personal' | 'teacher' | 'class' | 'global';
type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  // kind 区分普通文本回答与对话内生成的资源卡片；缺省视为 'text'。
  kind?: 'text' | 'resource';
  resourcePack?: A3ResourcePackV2;
  resourceType?: A3ResourcePackV2ResourceType;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus;
  refusalReason?: string;
  degraded?: boolean;
  retrievalMode?: string;
  traceId?: string;
  followUps?: FollowUpSuggestion[];
  createdAt?: string;
};
type CoachingResponse = {
  success: boolean;
  reply?: string;
  error?: string;
  verified?: boolean;
  citations?: Citation[];
  claims?: Claim[];
  safety?: SafetyStatus;
  refusalReason?: string;
  degraded?: boolean;
  retrievalMode?: string;
  traceId?: string;
  followUps?: FollowUpSuggestion[];
};
type ClassroomHistorySession = {
  id: string;
  title: string;
  summary?: string;
  messageCount?: number;
  messages: ChatMessage[];
  updatedAt?: string;
};
type ClassroomHistoryResponse = {
  success: boolean;
  error?: string;
  messages: ChatMessage[];
  sessions?: ClassroomHistorySession[];
  activeSessionId?: string;
};
type StudyPlanResponse = A3ApiResponse<{ plan: StudyPlan; feedback?: StudyPlanTaskFeedback }>;
type AssessmentStartResponse = A3ApiResponse<{ session: AssessmentSession }>;
type AssessmentGradeResponse = A3ApiResponse<AnswerFeedback>;
type EmbeddedPracticeState = {
  key: string;
  href: string;
  session: AssessmentSession;
  selectedAnswer: string;
  feedback: AnswerFeedback | null;
  planFeedback: StudyPlanTaskFeedback | null;
  error: string;
  starting: boolean;
  submitting: boolean;
};
type ClassroomImageAttachment = {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
};
type TranscriptionResponse = { success?: boolean; text?: string; error?: string; details?: string };
type DrawerTab = 'practice' | 'actions' | 'history';

const MAX_CLASSROOM_IMAGE_BYTES = 6 * 1024 * 1024;
const CLASSROOM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const CLASSROOM_ASR_PROVIDER_ID = 'qwen-asr';
const CLASSROOM_ASR_MODEL_ID = 'qwen3-asr-flash';
const CLASSROOM_OUTLINE_BUTTON_CLASS = 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-950 dark:border-slate-200 dark:bg-white dark:text-slate-700 dark:hover:bg-slate-50 dark:hover:text-slate-950 dark:disabled:border-slate-200 dark:disabled:bg-slate-100 dark:disabled:text-slate-500 dark:disabled:opacity-100';

const CLASSROOM_RESOURCE_LABELS: Record<A3ResourcePackV2ResourceType, string> = {
  lecture_doc: '讲解文档',
  knowledge_card: '速记卡片',
  mind_map: '思维导图',
  practice_set: '专项练习',
  case_study: '实践案例',
  code_lab: '代码实验',
  micro_video_script: '视频脚本',
};

function classroomResourceLabel(resourceType: A3ResourcePackV2ResourceType): string {
  return CLASSROOM_RESOURCE_LABELS[resourceType] ?? '学习资源';
}

const classroomCopy = {
  'zh-CN': {
    aiClassroom: 'AI 课堂',
    closedLoopReady: '可闭环',
    needsEvidence: '待补齐',
    waitingTarget: '等待学习路径目标',
    targetFallback: '围绕当前知识点进行讲解、追问、引用验证和练习推荐。',
    learningPath: '学习路径',
    refreshContext: '刷新上下文',
    sidePanel: '侧面板',
    classroomInfo: '课堂信息',
    collapseClassroomInfo: '收起课堂信息',
    expandClassroomInfo: '展开课堂信息',
    jumpLatest: '回到最新消息',
    viewingHistoryCompact: '正在查看历史对话',
    loadingContext: '正在加载课堂信息',
    tutorUnavailable: '导师方式加载失败',
    retryTutor: '重试导师方式',
    chooseTargetFirst: '请先选择学习目标，再开始提问',
    tutorPending: '辅导方式待选择',
    moreActions: '更多操作',
    collapseHistory: '收起历史侧栏',
    expandHistory: '展开历史侧栏',
    openmaicClassroom: 'OpenMAIC 资源课堂',
    notGenerated: '未生成',
    scenesUnit: '个场景',
    pptxHint: 'PPTX 导出仍在 OpenMAIC 课堂内完成；A3 负责资源包、任务状态和学习证据回写。',
    openClassroom: '打开课堂',
    generateResourceClassroom: '生成资源课堂',
    classroomConversations: '课堂对话',
    newDialogue: '新建对话',
    shortNewDialogue: '新对话',
    searchHistory: '搜索历史',
    noHistoryDetailed: '暂无历史对话。完成一次提问后，新建对话会把旧内容保留在这里。',
    noHistory: '暂无历史对话。',
    messagesUnit: '条消息',
    lessonStart: '从这里开始本节课堂',
    lessonRunway: (sourceCount: number, exerciseCount: number) => `已读取 ${sourceCount} 条资料来源和 ${exerciseCount} 项练习推荐。你可以直接提问，系统会按当前检索模式返回可验证回答。`,
    targetSynced: '目标已同步',
    targetPending: '等待目标',
    explainConcept: '讲清概念',
    generatePractice: '生成练习',
    analyzeMistakes: '错因拆解',
    explainConceptPrompt: (title: string) => `请用学生能听懂的方式讲清楚：${title}`,
    generatePracticePrompt: (title: string) => `围绕 ${title} 生成一道课堂练习，并给出解析。`,
    analyzeMistakesPrompt: (title: string) => `分析 ${title} 常见错误原因，并给出规避方法。`,
    currentKnowledgePoint: '当前知识点',
    imagePrompt: '请解答图片里的题目，并说明关键步骤。',
    thinking: '正在结合学习目标、知识库引用和错题记录回答',
    practiceTab: '练习',
    actionsTab: '行动',
    historyTab: '历史',
    drawerTitle: '课堂侧面板',
    drawerSubtitle: '练习、行动和历史都收在这里',
    closeDrawer: '关闭侧面板',
    practiceTitle: '课堂内练习',
    itemUnit: '项',
    noPractice: '暂无推荐练习。完成诊断或生成学习路径后，系统会按薄弱点推荐练习。',
    enterAssessment: '进入测评',
    classroomAnswer: '课堂内答题',
    openAssessment: '打开测评页',
    answeredCorrect: '回答正确',
    answeredWrong: (answer: string) => `回答错误，正确答案 ${answer}`,
    errorCause: '错因',
    classroomAssessment: '课堂内测评',
    difficulty: '难度',
    submitAndAutoSync: '提交并自动回写',
    noQuestion: '未拿到可用题目，请打开测评页继续练习。',
    completedStatus: '已回写',
    taskCompletedTitle: '该计划任务已完成',
    writebackTitle: '完成后回写今日任务和学习计划',
    unmatchedTaskTitle: '未匹配到今日计划任务，请先进入测评',
    completed: '已完成',
    completeAndSync: '完成并回写',
    progressTitle: '本节进度',
    progressDetail: '目标、引用和练习构成本节课堂闭环。',
    progressLabel: '完成度',
    citationMetric: '引用',
    practiceMetric: '练习',
    weakMetric: '薄弱',
    profileTitle: '本次课堂问答让画像发生了变化',
    profileSubtitle: '确认后会影响后续课堂讲解和资源推荐。',
    sourcesTitle: '知识库来源',
    citationsUnit: '条引用',
    saveSource: '收藏来源',
    noSources: '暂无可引用来源。可以先到知识库补充资料。',
    addMaterials: '补充资料',
    nextActions: '下一步行动',
    aiLearningEntry: 'AI 学习入口',
    faceToFaceCoaching: '面对面辅导',
    resourcePackGeneration: '资源包生成',
    myFavorites: '我的收藏',
    todayTasks: '回到今日任务',
    viewReport: '查看学习报告',
    teacherAgent: '主讲教师 Agent',
    you: '你',
    visionDegraded: '视觉模型未完成真实识别，已降级为文本学习指导。',
    saveNote: '存为笔记',
    verified: 'VerifierAgent 已验证',
    partiallyVerified: '部分待核验',
    missingEvidence: '未验证 · 缺少证据',
    citationCount: (citations: number, verifiedClaims: number, claims: number) => `引用 ${citations} 条 / 句级验证 ${verifiedClaims}/${claims || verifiedClaims}`,
    safetyRefused: 'SafetyAgent 已拦截',
    safetyAlternative: '合规替代：可以讲解相关考点、生成练习题、分析错因或制定复习步骤。',
    reason: '原因',
    citationPreview: '引用预览',
    evidenceGalleryTitle: '证据画廊',
    evidenceGalleryGuide: '先看课件页，再看它支撑了哪些结论。',
    evidenceSourceCount: (count: number) => `${count} 个来源`,
    evidenceThumbnailLabel: '课件证据缩略图',
    evidenceNumber: (index: number) => `证据 ${index}`,
    supportedClaims: (count: number) => `${count} 句`,
    supportingPoints: '支撑要点',
    moreClaims: (count: number) => `展开其余 ${count} 条句级证据`,
    missingPreview: '该证据没有可预览图片，已显示文字来源。',
    previewUnavailable: '预览不可用',
    openPreview: '打开预览',
    openFavorites: '去我的收藏',
    sourcePersonal: '我的资料',
    sourceTeacher: '教师资料',
    sourceClass: '班级资料',
    sourceGlobal: '全局库',
    sourceSearch: '知识库检索',
    localMaterial: '本地资料',
    sourceFallback: '知识库来源',
    deepRetrieval: '深度检索',
    visualEvidence: '视觉证据',
    timeoutFallback: '超时降级',
    fastAnswer: '快速回答',
    currentSources: (count: number) => `当前 ${count} 条来源`,
    send: '发送',
    attachImage: '上传本地图片题目',
    voiceInput: '语音输入',
    finishVoice: '结束录音并识别',
    recording: '正在录音，再点一次麦克风结束并识别。',
    transcribing: '正在识别语音。',
    voiceUnsupported: '当前浏览器不支持录音上传，请改用键盘输入。',
    placeholder: (title: string) => `围绕“${title}”提问，回答会进行引用验证`,
    placeholderNoTarget: '请先生成学习路径后再开始课堂提问',
    transcribingDraft: '正在调用语音识别...',
    voiceApiFailed: '语音识别接口调用失败',
    noVoiceDetected: '没有识别到有效语音，请靠近麦克风后重试。',
    voiceRecognized: '已识别语音，可继续编辑后发送。',
    voiceFailed: '语音识别失败，请重试或改用键盘输入。',
    micUnsupportedDetailed: '当前浏览器不支持录音上传，请使用 Chrome 或 Edge，或改用键盘输入。',
    recordingFailed: '录音失败，请检查麦克风设备后重试。',
    noRecording: '没有录到声音，请重试。',
    micPermissionDenied: '浏览器没有麦克风权限，请允许麦克风后再试。',
    recordingStartFailed: '录音启动失败，请检查麦克风权限和设备。',
    newDialogueSuccess: '已新建课堂对话，之前的内容会保留在历史对话中。',
    newDialogueFailed: '新建对话失败，请稍后重试',
    viewingHistory: '正在回看历史对话；如需继续提问，请新建对话。',
    noteSaved: '已保存为课堂笔记，可在“我的收藏”中查看。',
    noteSaveFailed: '课堂笔记保存失败',
    sourceSaved: '已收藏知识库来源，可在“我的收藏”中查看。',
    sourceSaveFailed: '知识库来源收藏失败',
    practiceWritebackFailed: '课堂练习回写失败，请到学习计划页确认任务状态。',
    practiceCompletedMessage: '推荐练习已完成，进度已回写到今日任务、学习计划和学习报告。',
    practiceStartFailed: '课堂内练习启动失败，请进入测评页完成。',
    practiceGradeFailed: '课堂内练习判分失败',
    copyMessage: '复制',
    editMessage: '重新编辑',
    copiedMessage: '已复制这条提问。',
    copyFailed: '复制失败，请手动选择文本。',
    editingMessage: '已回填原提问，可修改后重新发送。',
  },
  'en-US': {
    aiClassroom: 'AI Classroom',
    closedLoopReady: 'Loop ready',
    needsEvidence: 'Needs evidence',
    waitingTarget: 'Waiting for learning path target',
    targetFallback: 'Explain, follow up, verify citations, and recommend practice around the current knowledge point.',
    learningPath: 'Learning path',
    refreshContext: 'Refresh context',
    sidePanel: 'Side panel',
    classroomInfo: 'Classroom info',
    collapseClassroomInfo: 'Collapse classroom info',
    expandClassroomInfo: 'Expand classroom info',
    jumpLatest: 'Jump to latest',
    viewingHistoryCompact: 'Viewing chat history',
    loadingContext: 'Loading classroom context',
    tutorUnavailable: 'Tutor preference unavailable',
    retryTutor: 'Retry tutor preference',
    chooseTargetFirst: 'Choose a learning target before asking a question',
    tutorPending: 'Tutor preference pending',
    moreActions: 'More actions',
    collapseHistory: 'Collapse history sidebar',
    expandHistory: 'Expand history sidebar',
    openmaicClassroom: 'OpenMAIC resource classroom',
    notGenerated: 'Not generated',
    scenesUnit: 'scenes',
    pptxHint: 'PPTX export still happens inside the OpenMAIC classroom; A3 keeps the resource pack, task status, and learning evidence in sync.',
    openClassroom: 'Open classroom',
    generateResourceClassroom: 'Generate resource classroom',
    classroomConversations: 'Classroom conversations',
    newDialogue: 'New chat',
    shortNewDialogue: 'New chat',
    searchHistory: 'Search history',
    noHistoryDetailed: 'No chat history yet. After one question, starting a new chat keeps the previous content here.',
    noHistory: 'No chat history yet.',
    messagesUnit: 'messages',
    lessonStart: 'Start this lesson here',
    lessonRunway: (sourceCount: number, exerciseCount: number) => `${sourceCount} source(s) and ${exerciseCount} practice recommendation(s) are loaded. Ask directly and the system will return a verifiable answer using the current retrieval mode.`,
    targetSynced: 'Target synced',
    targetPending: 'Waiting for target',
    explainConcept: 'Explain concept',
    generatePractice: 'Generate practice',
    analyzeMistakes: 'Analyze mistakes',
    explainConceptPrompt: (title: string) => `Explain this in a student-friendly way: ${title}`,
    generatePracticePrompt: (title: string) => `Create one classroom practice question about ${title}, with an explanation.`,
    analyzeMistakesPrompt: (title: string) => `Analyze common mistakes for ${title} and how to avoid them.`,
    currentKnowledgePoint: 'current knowledge point',
    imagePrompt: 'Solve the problem in the image and explain the key steps.',
    thinking: 'Answering with learning goals, knowledge-base citations, and mistake history',
    practiceTab: 'Practice',
    actionsTab: 'Actions',
    historyTab: 'History',
    drawerTitle: 'Classroom side panel',
    drawerSubtitle: 'Practice, actions, and history are kept here',
    closeDrawer: 'Close side panel',
    practiceTitle: 'Classroom practice',
    itemUnit: 'items',
    noPractice: 'No recommended practice yet. Complete the diagnostic or generate a learning path, then the system will recommend practice by weak point.',
    enterAssessment: 'Open assessment',
    classroomAnswer: 'Answer in classroom',
    openAssessment: 'Open assessment',
    answeredCorrect: 'Correct',
    answeredWrong: (answer: string) => `Incorrect. Correct answer: ${answer}`,
    errorCause: 'Error cause',
    classroomAssessment: 'Classroom assessment',
    difficulty: 'Difficulty',
    submitAndAutoSync: 'Submit and auto-sync',
    noQuestion: 'No available question was returned. Open the assessment page to continue practice.',
    completedStatus: 'Synced',
    taskCompletedTitle: 'This plan task is complete',
    writebackTitle: 'Completes and writes back to today tasks and the learning plan',
    unmatchedTaskTitle: 'No matching plan task. Open assessment first.',
    completed: 'Completed',
    completeAndSync: 'Complete and sync',
    progressTitle: 'Lesson progress',
    progressDetail: 'Target, citations, and practice form this classroom loop.',
    progressLabel: 'Progress',
    citationMetric: 'Citations',
    practiceMetric: 'Practice',
    weakMetric: 'Weak',
    profileTitle: 'This classroom Q&A changed the learning profile',
    profileSubtitle: 'Confirming it will affect later classroom explanations and resource recommendations.',
    sourcesTitle: 'Knowledge-base sources',
    citationsUnit: 'citations',
    saveSource: 'Save source',
    noSources: 'No citable sources yet. Add materials in the knowledge base first.',
    addMaterials: 'Add materials',
    nextActions: 'Next actions',
    aiLearningEntry: 'AI learning entry',
    faceToFaceCoaching: 'Face-to-face coaching',
    resourcePackGeneration: 'Generate resource pack',
    myFavorites: 'Favorites',
    todayTasks: 'Back to today',
    viewReport: 'View report',
    teacherAgent: 'Lead Teacher Agent',
    you: 'You',
    visionDegraded: 'The vision model did not complete real recognition, so this was downgraded to text learning guidance.',
    saveNote: 'Save as note',
    verified: 'VerifierAgent verified',
    partiallyVerified: 'Partially pending',
    missingEvidence: 'Unverified · Missing evidence',
    citationCount: (citations: number, verifiedClaims: number, claims: number) => `${citations} citation(s) / sentence checks ${verifiedClaims}/${claims || verifiedClaims}`,
    safetyRefused: 'SafetyAgent refused',
    safetyAlternative: 'Safe alternative: explain the concept, generate practice, analyze mistakes, or build a review plan.',
    reason: 'Reason',
    citationPreview: 'Citation preview',
    evidenceGalleryTitle: 'Evidence gallery',
    evidenceGalleryGuide: 'Review the slide first, then inspect the claims it supports.',
    evidenceSourceCount: (count: number) => `${count} source(s)`,
    evidenceThumbnailLabel: 'Slide evidence thumbnails',
    evidenceNumber: (index: number) => `Evidence ${index}`,
    supportedClaims: (count: number) => `${count} claim(s)`,
    supportingPoints: 'Supported points',
    moreClaims: (count: number) => `Show ${count} more sentence-level claim(s)`,
    missingPreview: 'This evidence has no preview image. Its text source is shown instead.',
    previewUnavailable: 'Preview unavailable',
    openPreview: 'Open preview',
    openFavorites: 'Open favorites',
    sourcePersonal: 'My materials',
    sourceTeacher: 'Teacher materials',
    sourceClass: 'Class materials',
    sourceGlobal: 'Global library',
    sourceSearch: 'Knowledge-base retrieval',
    localMaterial: 'Local material',
    sourceFallback: 'Knowledge-base source',
    deepRetrieval: 'Deep retrieval',
    visualEvidence: 'Visual evidence',
    timeoutFallback: 'Timeout fallback',
    fastAnswer: 'Fast answer',
    currentSources: (count: number) => `Current sources: ${count}`,
    send: 'Send',
    attachImage: 'Upload local image question',
    voiceInput: 'Voice input',
    finishVoice: 'Finish recording and transcribe',
    recording: 'Recording. Tap the microphone again to finish and transcribe.',
    transcribing: 'Transcribing voice.',
    voiceUnsupported: 'This browser does not support recording upload. Use keyboard input instead.',
    placeholder: (title: string) => `Ask about "${title}". Answers will include citation verification.`,
    placeholderNoTarget: 'Generate a learning path before asking in classroom.',
    transcribingDraft: 'Calling speech recognition...',
    voiceApiFailed: 'Speech recognition API call failed',
    noVoiceDetected: 'No valid speech was detected. Move closer to the microphone and try again.',
    voiceRecognized: 'Voice recognized. You can edit and send it.',
    voiceFailed: 'Speech recognition failed. Try again or use keyboard input.',
    micUnsupportedDetailed: 'This browser does not support recording upload. Use Chrome or Edge, or switch to keyboard input.',
    recordingFailed: 'Recording failed. Check the microphone device and try again.',
    noRecording: 'No audio was recorded. Try again.',
    micPermissionDenied: 'Microphone permission is blocked. Allow microphone access and try again.',
    recordingStartFailed: 'Recording failed to start. Check microphone permission and device.',
    newDialogueSuccess: 'New classroom chat created. The previous content is kept in history.',
    newDialogueFailed: 'Failed to create a new chat. Try again later',
    viewingHistory: 'Viewing chat history. Start a new chat if you want to ask another question.',
    noteSaved: 'Saved as a classroom note. You can find it in Favorites.',
    noteSaveFailed: 'Failed to save classroom note',
    sourceSaved: 'Saved the knowledge-base source. You can find it in Favorites.',
    sourceSaveFailed: 'Failed to save knowledge-base source',
    practiceWritebackFailed: 'Classroom practice writeback failed. Check the task status on the learning plan page.',
    practiceCompletedMessage: 'Recommended practice completed. Progress was written back to today tasks, the learning plan, and the report.',
    practiceStartFailed: 'Failed to start classroom practice. Open the assessment page to continue.',
    practiceGradeFailed: 'Classroom practice grading failed',
    copyMessage: 'Copy',
    editMessage: 'Edit and resend',
    copiedMessage: 'Copied this question.',
    copyFailed: 'Copy failed. Select the text manually.',
    editingMessage: 'Original question restored. Edit it and send again.',
  },
} as const;

type ClassroomCopy = (typeof classroomCopy)[A3Locale];

const classroomScopeOptions: Record<A3Locale, Array<{ value: ClassroomRetrievalScope; label: string; detail: string }>> = {
  'zh-CN': [
    { value: 'all', label: '全部资料', detail: '个人、教师、班级和全局库' },
    { value: 'personal', label: '我的资料', detail: '只检索个人上传资料' },
    { value: 'teacher', label: '教师资料', detail: '只检索教师下发资料' },
    { value: 'class', label: '班级资料', detail: '只检索班级共享资料' },
    { value: 'global', label: '全局库', detail: '只检索公共知识库' },
  ],
  'en-US': [
    { value: 'all', label: 'All materials', detail: 'Personal, teacher, class, and global library' },
    { value: 'personal', label: 'My materials', detail: 'Search only personal uploads' },
    { value: 'teacher', label: 'Teacher materials', detail: 'Search only teacher-assigned materials' },
    { value: 'class', label: 'Class materials', detail: 'Search only class-shared materials' },
    { value: 'global', label: 'Global library', detail: 'Search only the public knowledge base' },
  ],
};

function useClassroomCopy() {
  const { locale } = useA3Locale();
  return { copy: classroomCopy[locale], locale };
}

function appendVoiceTranscript(current: string, transcript: string) {
  const normalized = transcript.trim();
  if (!normalized) return current;
  const trimmed = current.trim();
  const separator = trimmed ? (/[，。！？,.!?]$/.test(trimmed) ? ' ' : '，') : '';
  return `${trimmed}${separator}${normalized}`;
}

function buildClassroomWelcomeMessage(target: ClassroomContext['target'] | null | undefined): ChatMessage {
  return {
    id: 'welcome',
    role: 'assistant',
    content: target
      ? `我们现在学习《${target.title}》。你可以直接追问概念、例题、错因或让系统生成一题课堂练习；回答会结合本地知识库并标注引用验证状态。`
      : '请先生成学习路径，系统会根据当前节点创建 AI 课堂。',
  };
}

function resolveClassroomContentWidthClass(historyOpen: boolean, drawerOpen: boolean) {
  if (historyOpen && drawerOpen) return 'max-w-4xl';
  if (historyOpen || drawerOpen) return 'max-w-6xl';
  return 'max-w-[min(1320px,calc(100vw-120px))]';
}

function resolveClassroomBubbleWidthClass(historyOpen: boolean, drawerOpen: boolean) {
  if (historyOpen && drawerOpen) return 'max-w-[min(760px,88%)]';
  if (historyOpen || drawerOpen) return 'max-w-[min(900px,90%)]';
  return 'max-w-[min(1040px,92%)]';
}

export function ClassroomViewRedesign() {
  const { copy } = useClassroomCopy();
  const tutorPersona = useTutorPersona();
  const resourceGen = useResourceGeneration();
  const router = useRouter();
  const [classroom, setClassroom] = useState<ClassroomContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [input, setInput] = useState('');
  const [asking, setAsking] = useState(false);
  const [savingNoteId, setSavingNoteId] = useState('');
  const [savingSourceId, setSavingSourceId] = useState('');
  const [sourceFavoriteMessage, setSourceFavoriteMessage] = useState('');
  const [sourceFavoriteSuccess, setSourceFavoriteSuccess] = useState(false);
  const [openmaicClassroomArtifact, setOpenmaicClassroomArtifact] = useState<A3OpenMAICClassroomArtifact | null>(null);
  const [studyPlan, setStudyPlan] = useState<StudyPlan | null>(null);
  const [savingPracticeId, setSavingPracticeId] = useState('');
  const [practiceFeedback, setPracticeFeedback] = useState<StudyPlanTaskFeedback | null>(null);
  const [embeddedPractice, setEmbeddedPractice] = useState<EmbeddedPracticeState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [classroomSessions, setClassroomSessions] = useState<ClassroomHistorySession[]>([]);
  const [viewingHistoryId, setViewingHistoryId] = useState('');
  const [imageAttachment, setImageAttachment] = useState<ClassroomImageAttachment | null>(null);
  const [imageAttachmentError, setImageAttachmentError] = useState('');
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceTranscribing, setVoiceTranscribing] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [retrievalMode, setRetrievalMode] = useState<ClassroomRetrievalMode>('fast');
  const [retrievalScope, setRetrievalScope] = useState<ClassroomRetrievalScope>('all');
  const [profileFeed, setProfileFeed] = useState<DynamicProfileFeedResponse | null>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('practice');
  const [historyQuery, setHistoryQuery] = useState('');
  const chatRef = useRef(chat);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);

  const target = classroom?.target ?? null;
  const { scrollRef, contentRef } = useStickToBottom({
    initial: false,
    resize: { damping: 0.78, stiffness: 0.08, mass: 1 },
  });
  const contextLayout = useClassroomContextVisibility({
    storageKey: target?.id || target?.title || 'waiting-target',
    scrollRootRef: scrollRef,
  });
  const sourceCount = classroom?.sources.length ?? 0;
  const exerciseCount = classroom?.recommended.length ?? 0;
  const completedReadiness = [Boolean(target), sourceCount > 0, exerciseCount > 0].filter(Boolean).length;
  const selectedTutorLabel = tutorPersona.error
    ? copy.tutorUnavailable
    : tutorPersona.selectedPersona?.name || copy.tutorPending;
  const openmaicStatusLabel = openmaicClassroomArtifact?.status === 'succeeded'
    ? `${openmaicClassroomArtifact.scenesCount ?? 0} ${copy.scenesUnit}`
    : openmaicClassroomArtifact?.status ?? copy.notGenerated;
  const contextSummary = {
    title: target?.title ?? copy.waitingTarget,
    tutorLabel: selectedTutorLabel,
    statusLabel: !target
      ? copy.chooseTargetFirst
      : viewingHistoryId
        ? copy.viewingHistoryCompact
        : openmaicStatusLabel,
    statusTone: tutorPersona.error ? 'warning' as const : 'neutral' as const,
  };
  const showLessonRunway = !viewingHistoryId && !chat.some((item) => item.role === 'user');
  const filteredSessions = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();
    if (!query) return classroomSessions;
    return classroomSessions.filter((session) => (
      session.title.toLowerCase().includes(query)
      || (session.summary ?? '').toLowerCase().includes(query)
    ));
  }, [classroomSessions, historyQuery]);

  useEffect(() => {
    const desktopViewport = window.matchMedia('(min-width: 1280px)');
    const previousHtmlOverflowY = document.documentElement.style.overflowY;
    const previousBodyOverflowY = document.body.style.overflowY;
    let locked = false;

    const restorePageScroll = () => {
      if (!locked) return;
      document.documentElement.style.overflowY = previousHtmlOverflowY;
      document.body.style.overflowY = previousBodyOverflowY;
      locked = false;
    };
    const syncPageScroll = () => {
      if (!desktopViewport.matches) {
        restorePageScroll();
        return;
      }
      if (locked) return;
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.documentElement.style.overflowY = 'hidden';
      document.body.style.overflowY = 'hidden';
      locked = true;
    };

    syncPageScroll();
    desktopViewport.addEventListener('change', syncPageScroll);
    return () => {
      desktopViewport.removeEventListener('change', syncPageScroll);
      restorePageScroll();
    };
  }, []);

  useEffect(() => {
    chatRef.current = chat;
  }, [chat]);

  useEffect(() => {
    setVoiceSupported(Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined');
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
      voiceStreamRef.current = null;
    };
  }, []);

  const loadClassroom = useCallback(async () => {
    setLoading(true);
    const [result, packsResult, historyResult, planResult, profileFeedResult] = await Promise.all([
      a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
      a3GetJson<A3ResourcePacksResponse>('/api/resources/packs/'),
      a3GetJson<ClassroomHistoryResponse>('/api/learning/classroom/history/'),
      a3GetJson<StudyPlanResponse>('/api/learning/study-plan/?auto=1'),
      a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/'),
    ]);
    setLoading(false);
    if (!result.success) {
      setMessage(result.error ?? '课堂上下文加载失败');
      return;
    }
    if (packsResult.success) {
      setOpenmaicClassroomArtifact(findLatestOpenMAICClassroomArtifact(packsResult.resourcePacks));
    }
    if (planResult.success) setStudyPlan(planResult.plan);
    if (profileFeedResult.success) setProfileFeed(profileFeedResult);
    setClassroom(result.classroom);
    setMessage('');
    const restoredMessages = historyResult.success ? normalizeClassroomMessages(historyResult.messages) : [];
    setClassroomSessions(historyResult.success ? normalizeClassroomSessions(historyResult.sessions ?? []) : []);
    setViewingHistoryId('');
    setChat((current) => current.length ? current : (restoredMessages.length ? restoredMessages : [buildClassroomWelcomeMessage(result.classroom.target)]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadClassroom();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadClassroom]);

  // 课堂内直接生成资源（A：显式 chip / B：对话触发共用）。生成结果作为一条 resource 消息进对话流。
  async function generateResourceInClassroom(resourceType: A3ResourcePackV2ResourceType, goalOverride?: string) {
    if (asking || resourceGen.generating) return;
    const goal = (goalOverride || target?.title || '').trim();
    if (!goal) {
      setMessage('请先确定课堂学习目标再生成资源。');
      return;
    }
    setInput('');
    setAsking(true);
    setMessage('');
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: `生成${classroomResourceLabel(resourceType)}：${goal}`,
      createdAt: new Date().toISOString(),
    };
    setChat((current) => [...current, userMessage]);
    try {
      const pack = await resourceGen.generate(resourceType, goal);
      if (!pack) {
        setChat((current) => [...current, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: resourceGen.error || '资源生成失败，请稍后重试，或到资源推荐页生成。',
          createdAt: new Date().toISOString(),
        }]);
        return;
      }
      const generated = pack.resources.find((item) => item.type === resourceType) ?? pack.resources[0];
      setChat((current) => [...current, {
        id: crypto.randomUUID(),
        role: 'assistant',
        kind: 'resource',
        content: `已生成${classroomResourceLabel(resourceType)}`,
        resourcePack: pack,
        resourceType: generated?.type as A3ResourcePackV2ResourceType,
        verified: Boolean(generated?.verified),
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setAsking(false);
    }
  }

  async function askQuestion(question = input) {
    const normalized = question.trim() || (imageAttachment ? '请解答图片里的题目，并说明关键步骤。' : '');
    if (!normalized || asking) return;
    // B：先过意图识别。generate_resource / navigate 走各自分支，其余（含 explain/兜底）继续问答。
    if (!imageAttachment) {
      const intent = await classifyIntent(normalized, { goal: target?.title ?? '', surface: 'classroom' });
      if (intent.intent === 'generate_resource' && intent.params.resourceType) {
        await generateResourceInClassroom(intent.params.resourceType, intent.params.goal || target?.title || '');
        return;
      }
      if (intent.intent === 'navigate' && intent.params.route) {
        setInput('');
        router.push(intent.params.route);
        return;
      }
    }
    const attachmentForRequest = imageAttachment;
    setInput('');
    setAsking(true);
    setMessage('');
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: attachmentForRequest ? `${normalized}\n\n[图片附件：${attachmentForRequest.name}]` : normalized,
      createdAt: new Date().toISOString(),
    };
    setChat((current) => [...current, userMessage]);
    try {
      const response = await fetch('/api/a3/coaching/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: normalized,
          personaId: tutorPersona.selectedPersonaId,
          history: chatRef.current.map(({ role, content }) => ({ role, content })),
          mode: retrievalMode,
          scope: retrievalScope,
          attachments: imageAttachment ? [{
            type: 'image',
            name: imageAttachment.name,
            mediaType: imageAttachment.mediaType,
            dataUrl: imageAttachment.dataUrl,
          }] : undefined,
        }),
      });
      const result = await response.json() as CoachingResponse;
      if (!response.ok || !result.success || !result.reply) throw new Error(result.error || 'AI 课堂回复失败');
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.reply,
        verified: Boolean(result.verified),
        citations: result.citations ?? [],
        claims: result.claims ?? [],
        safety: result.safety,
        refusalReason: result.refusalReason ?? '',
        degraded: Boolean(result.degraded),
        retrievalMode: result.retrievalMode ?? '',
        traceId: result.traceId ?? '',
        followUps: Array.isArray(result.followUps) ? result.followUps : [],
        createdAt: new Date().toISOString(),
      };
      setChat((current) => [...current, assistantMessage]);
      void a3PostJson('/api/learning/classroom/history/', { messages: [userMessage, assistantMessage] });
      const feedResponse = await a3GetJson<DynamicProfileFeedResponse>('/api/profiles/dynamic-profile/');
      if (feedResponse.success) setProfileFeed(feedResponse);
      setImageAttachment(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'AI 课堂服务暂时不可用');
    } finally {
      setAsking(false);
    }
  }

  function stopVoiceInput() {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
      return;
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
    voiceStreamRef.current = null;
    setVoiceListening(false);
    setVoiceDraft('');
  }

  async function transcribeClassroomAudio(audioBlob: Blob) {
    setVoiceTranscribing(true);
    setVoiceError('');
    setVoiceDraft(copy.transcribingDraft);
    try {
      const uploadAudio = await normalizeASRUploadAudio(CLASSROOM_ASR_PROVIDER_ID, audioBlob);
      const formData = new FormData();
      formData.append('audio', uploadAudio.blob, uploadAudio.fileName);
      formData.append('providerId', CLASSROOM_ASR_PROVIDER_ID);
      formData.append('modelId', CLASSROOM_ASR_MODEL_ID);
      formData.append('language', 'zh');
      const response = await fetch('/api/transcription', { method: 'POST', body: formData });
      const result = await response.json().catch(() => ({})) as TranscriptionResponse;
      if (!response.ok || result.success === false) throw new Error(result.details || result.error || copy.voiceApiFailed);
      const text = result.text?.trim();
      if (!text) {
        setVoiceError(copy.noVoiceDetected);
        return;
      }
      setInput((current) => appendVoiceTranscript(current, text));
      setMessage(copy.voiceRecognized);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : copy.voiceFailed);
    } finally {
      setVoiceTranscribing(false);
      setVoiceDraft('');
    }
  }

  async function toggleVoiceInput() {
    if (voiceListening) {
      stopVoiceInput();
      return;
    }
    if (asking || voiceTranscribing || !target || viewingHistoryId) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceSupported(false);
      setVoiceError(copy.micUnsupportedDetailed);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceChunksRef.current = [];
      voiceStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setVoiceError(copy.recordingFailed);
        setVoiceListening(false);
      };
      recorder.onstop = () => {
        const chunks = voiceChunksRef.current;
        voiceChunksRef.current = [];
        stream.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        mediaRecorderRef.current = null;
        setVoiceListening(false);
        if (!chunks.length) {
          setVoiceError(copy.noRecording);
          setVoiceDraft('');
          return;
        }
        void transcribeClassroomAudio(new Blob(chunks, { type: mimeType || 'audio/webm' }));
      };
      recorder.start();
      setVoiceListening(true);
      setVoiceDraft(copy.recording);
      setVoiceError('');
      setMessage('');
    } catch (error) {
      setVoiceListening(false);
      setVoiceDraft('');
      setVoiceError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? copy.micPermissionDenied
        : copy.recordingStartFailed);
    }
  }

  async function handleImageUpload(file?: File) {
    setImageAttachmentError('');
    if (!file) return;
    try {
      const attachment = await readImageAttachment(file);
      setImageAttachment(attachment);
    } catch (error) {
      setImageAttachment(null);
      setImageAttachmentError(error instanceof Error ? error.message : '图片读取失败，请重新选择。');
    }
  }

  function readImageAttachment(file: File): Promise<ClassroomImageAttachment> {
    if (!CLASSROOM_IMAGE_TYPES.has(file.type)) return Promise.reject(new Error('仅支持 PNG、JPG、JPEG 或 WebP 图片。'));
    if (file.size > MAX_CLASSROOM_IMAGE_BYTES) return Promise.reject(new Error('图片不能超过 6MB，请压缩后再上传。'));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl.startsWith('data:image/')) {
          reject(new Error('图片格式不正确，请重新选择。'));
          return;
        }
        resolve({ type: 'image', name: file.name, mediaType: file.type, dataUrl, size: file.size });
      };
      reader.readAsDataURL(file);
    });
  }

  async function startNewClassroomDialogue() {
    if (asking) return;
    stopVoiceInput();
    window.speechSynthesis?.cancel();
    setChat([buildClassroomWelcomeMessage(classroom?.target)]);
    setViewingHistoryId('');
    setInput('');
    setImageAttachment(null);
    setImageAttachmentError('');
    if (imageInputRef.current) imageInputRef.current.value = '';
    const result = await a3PostJson<ClassroomHistoryResponse>('/api/learning/classroom/history/', { startNew: true });
    if (result.success) setClassroomSessions(normalizeClassroomSessions(result.sessions ?? []));
    setMessage(result.success ? copy.newDialogueSuccess : result.error ?? copy.newDialogueFailed);
  }

  function viewClassroomHistory(session: ClassroomHistorySession) {
    stopVoiceInput();
    window.speechSynthesis?.cancel();
    setViewingHistoryId(session.id);
    setChat(normalizeClassroomMessages(session.messages));
    setInput('');
    setMessage(copy.viewingHistory);
  }

  async function copyUserMessage(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setMessage(copy.copiedMessage);
    } catch {
      setMessage(copy.copyFailed);
    }
  }

  function editUserMessage(content: string) {
    stopVoiceInput();
    setViewingHistoryId('');
    setInput(content);
    setImageAttachment(null);
    setImageAttachmentError('');
    if (imageInputRef.current) imageInputRef.current.value = '';
    setMessage(copy.editingMessage);
  }

  async function saveAsNote(item: ChatMessage) {
    if (item.role !== 'assistant') return;
    setSavingNoteId(item.id);
    setMessage('');
    const result = await a3PostJson<FavoriteResponse>('/api/engagement/favorites/create/', {
      type: 'note',
      title: `课堂笔记：${target?.title ?? 'AI 课堂回答'}`,
      source: item.verified ? 'AI 课堂 / VerifierAgent 已验证' : 'AI 课堂 / 未验证回答',
      url: '/a3/classroom',
      group: 'AI 课堂笔记',
      metadata: {
        content: item.content,
        target,
        verified: item.verified,
        citations: item.citations ?? [],
        claims: item.claims ?? [],
      },
    });
    setSavingNoteId('');
    setMessage(result.success ? copy.noteSaved : result.error ?? copy.noteSaveFailed);
  }

  async function saveSourceFavorite(source: Citation) {
    const sourceId = source.id || source.title || source.location || 'source';
    setSavingSourceId(sourceId);
    setSourceFavoriteMessage('');
    setSourceFavoriteSuccess(false);
    const result = await a3PostJson<FavoriteResponse>('/api/engagement/favorites/create/', {
      type: 'knowledge_card',
      title: source.title || '知识库来源',
      source: [source.sourceOrigin || '知识库检索', source.sourceTypeLabel || source.type, source.location].filter(Boolean).join(' / ') || '知识库',
      url: '/a3/classroom',
      group: '知识库来源',
      metadata: { ...source, target },
    });
    setSavingSourceId('');
    setSourceFavoriteSuccess(result.success);
    setSourceFavoriteMessage(result.success ? copy.sourceSaved : result.error ?? copy.sourceSaveFailed);
  }

  async function completePracticeRecommendation(resource: ClassroomContext['recommended'][number]) {
    const match = findPracticePlanTaskForRecommendation(resource, studyPlan);
    if (!match || match.completed) return;
    setSavingPracticeId(resource.href);
    setMessage('');
    const response = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', {
      dayIndex: match.dayIndex,
      taskId: match.taskId,
    });
    setSavingPracticeId('');
    if (!response.success) {
      setMessage(response.error ?? copy.practiceWritebackFailed);
      return;
    }
    setStudyPlan(response.plan);
    setPracticeFeedback(response.feedback ?? response.plan.lastTaskFeedback ?? null);
    setMessage(copy.practiceCompletedMessage);
  }

  async function startEmbeddedPractice(resource: ClassroomContext['recommended'][number]) {
    const key = classroomPracticeKey(resource);
    setEmbeddedPractice((current) => current?.key === key ? { ...current, starting: true, error: '' } : null);
    setMessage('');
    const result = await a3PostJson<AssessmentStartResponse>('/api/assessments/start/', {
      mode: 'practice',
      knowledgePoint: resource.title,
      limit: 1,
    });
    if (!result.success) {
      setEmbeddedPractice({
        key,
        href: resource.href,
        session: emptyAssessmentSession(resource.title),
        selectedAnswer: '',
        feedback: null,
        planFeedback: null,
        error: result.error ?? copy.practiceStartFailed,
        starting: false,
        submitting: false,
      });
      return;
    }
    setEmbeddedPractice({
      key,
      href: resource.href,
      session: result.session,
      selectedAnswer: '',
      feedback: null,
      planFeedback: null,
      error: '',
      starting: false,
      submitting: false,
    });
  }

  function selectEmbeddedPracticeAnswer(answer: string) {
    setEmbeddedPractice((current) => current ? { ...current, selectedAnswer: answer } : current);
  }

  async function submitEmbeddedPractice(resource: ClassroomContext['recommended'][number]) {
    if (!embeddedPractice?.session || !embeddedPractice.selectedAnswer) return;
    setEmbeddedPractice((current) => current ? { ...current, submitting: true, error: '' } : current);
    const grade = await a3PostJson<AssessmentGradeResponse>('/api/assess/grade/', {
      sessionId: embeddedPractice.session.id,
      selectedAnswer: embeddedPractice.selectedAnswer,
    });
    if (!grade.success) {
      setEmbeddedPractice((current) => current ? { ...current, submitting: false, error: grade.error ?? copy.practiceGradeFailed } : current);
      return;
    }

    let planFeedback: StudyPlanTaskFeedback | null = null;
    const writeback = buildPracticeWritebackPayload({ recommendation: resource, plan: studyPlan, graded: true });
    if (writeback) {
      const planResponse = await a3PostJson<StudyPlanResponse>('/api/learning/study-plan/tasks/complete/', writeback);
      if (planResponse.success) {
        setStudyPlan(planResponse.plan);
        planFeedback = planResponse.feedback ?? planResponse.plan.lastTaskFeedback ?? null;
        setPracticeFeedback(planFeedback);
      }
    }

    setEmbeddedPractice((current) => current ? {
      ...current,
      submitting: false,
      feedback: grade,
      planFeedback,
      session: grade.session,
      error: writeback || planFeedback ? '' : '已完成判分并同步错题/画像；未匹配到今日计划任务，未回写学习计划。',
    } : current);
  }

  const contentWidthClass = resolveClassroomContentWidthClass(historyOpen, drawerOpen);
  const bubbleWidthClass = resolveClassroomBubbleWidthClass(historyOpen, drawerOpen);

  return (
    <div
      className={cn(
        'grid h-[calc(100dvh-104px)] min-h-[640px] gap-4 overflow-hidden',
        historyOpen && drawerOpen
          ? 'xl:grid-cols-[280px_minmax(0,1fr)_360px]'
          : historyOpen
            ? 'xl:grid-cols-[280px_minmax(0,1fr)]'
            : drawerOpen
              ? 'xl:grid-cols-[minmax(0,1fr)_360px]'
              : 'xl:grid-cols-1',
      )}
      data-testid="a3-classroom-view"
    >
      {historyOpen && (
        <HistorySidebar
          copy={copy}
          sessions={filteredSessions}
          activeId={viewingHistoryId}
          query={historyQuery}
          asking={asking}
          onQueryChange={setHistoryQuery}
          onOpen={viewClassroomHistory}
          onNew={() => void startNewClassroomDialogue()}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] border border-slate-200 bg-white text-slate-950 shadow-sm" data-testid="a3-classroom-workspace">
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
            data-testid="a3-classroom-dialogue"
          >
            <div ref={contentRef} data-testid="a3-classroom-dialogue-content">
              <ClassroomContextShell
                regionRef={contextLayout.regionRef}
                regionId={contextLayout.regionId}
                expanded={contextLayout.expanded}
                summary={contextSummary}
                summaryAction={tutorPersona.error ? (
                  <button
                    type="button"
                    className="inline-flex size-11 items-center justify-center rounded-lg text-amber-700 transition hover:bg-amber-50"
                    aria-label={copy.retryTutor}
                    title={copy.retryTutor}
                    onClick={() => void tutorPersona.reload()}
                  >
                    <RefreshCw className="size-4" aria-hidden="true" />
                  </button>
                ) : undefined}
                collapseLabel={copy.collapseClassroomInfo}
                expandLabel={copy.expandClassroomInfo}
                onCollapse={contextLayout.collapse}
                onExpand={contextLayout.expand}
              >
                {loading && !classroom ? (
                  <div
                    data-testid="a3-classroom-context-loading"
                    role="status"
                    aria-live="polite"
                    className="flex min-h-28 items-center gap-3 px-4 py-6 text-sm text-slate-600 md:px-6"
                  >
                    <Loader2 className="size-5 animate-spin text-blue-600" aria-hidden="true" />
                    {copy.loadingContext}
                  </div>
                ) : (
                  <>
                    <WorkspaceHeader
                      copy={copy}
                      classroom={classroom}
                      target={target}
                      loading={loading}
                      historyOpen={historyOpen}
                      drawerOpen={drawerOpen}
                      readiness={completedReadiness}
                      onRefresh={() => void loadClassroom()}
                      onToggleHistory={() => setHistoryOpen((value) => !value)}
                      onToggleDrawer={() => setDrawerOpen((value) => !value)}
                    />
                    <div className="border-b border-slate-200 bg-[#fbfaf5] px-4 py-2 md:px-6">
                      <TutorPersonaSelector
                        compact
                        personas={tutorPersona.personas}
                        selectedPersonaId={tutorPersona.selectedPersonaId}
                        recommendedPersonaId={tutorPersona.recommendedPersonaId}
                        loading={tutorPersona.loading}
                        saving={tutorPersona.saving}
                        error={tutorPersona.error}
                        onSelect={tutorPersona.selectPersona}
                        onRetry={tutorPersona.reload}
                      />
                    </div>
                    <OpenMAICInlineBar copy={copy} artifact={openmaicClassroomArtifact} />
                  </>
                )}
              </ClassroomContextShell>

              <div className={cn('mx-auto flex w-full flex-col gap-5 px-4 py-5 md:px-7 transition-[max-width] duration-200 ease-out', contentWidthClass)}>
                <ClassroomResourceChips
                  disabled={asking || resourceGen.generating}
                  activeType={resourceGen.activeType}
                  hasTarget={Boolean(target?.title)}
                  onGenerate={(resourceType) => void generateResourceInClassroom(resourceType)}
                />
                {showLessonRunway && (
                  <LessonRunway
                    copy={copy}
                    target={target}
                    sourceCount={sourceCount}
                    exerciseCount={exerciseCount}
                    asking={asking}
                    onAsk={askQuestion}
                  />
                )}
                {chat.map((item) => (
                  <ChatBubble
                    key={item.id}
                    item={item}
                    widthClassName={bubbleWidthClass}
                    savingNoteId={savingNoteId}
                    onSaveNote={saveAsNote}
                    onFollowUp={(question) => void askQuestion(question)}
                    onCopyUserMessage={(content) => void copyUserMessage(content)}
                    onEditUserMessage={editUserMessage}
                  />
                ))}
                {asking && (
                  <div className="flex w-fit items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800" data-testid="a3-classroom-asking">
                    <Loader2 className="size-4 animate-spin" />
                    正在结合学习目标、知识库引用和错题记录回答
                  </div>
                )}
              </div>
            </div>
          </div>

          <Composer
            copy={copy}
            contentWidthClass={contentWidthClass}
            target={target}
            asking={asking}
            input={input}
            message={message}
            retrievalMode={retrievalMode}
            retrievalScope={retrievalScope}
            sources={classroom?.sources ?? []}
            viewingHistoryId={viewingHistoryId}
            imageAttachment={imageAttachment}
            imageAttachmentError={imageAttachmentError}
            voiceSupported={voiceSupported}
            voiceListening={voiceListening}
            voiceTranscribing={voiceTranscribing}
            voiceDraft={voiceDraft}
            voiceError={voiceError}
            imageInputRef={imageInputRef}
            onInputChange={setInput}
            onModeChange={setRetrievalMode}
            onScopeChange={setRetrievalScope}
            onAsk={askQuestion}
            onImageUpload={handleImageUpload}
            onRemoveImage={() => {
              setImageAttachment(null);
              setImageAttachmentError('');
              if (imageInputRef.current) imageInputRef.current.value = '';
            }}
            onToggleVoice={() => void toggleVoiceInput()}
            onNewDialogue={() => void startNewClassroomDialogue()}
            onOpenDrawer={(tab) => {
              setDrawerTab(tab);
              setDrawerOpen(true);
            }}
          />
        </div>

        <ClassroomStickyContextBar
          visible={!contextLayout.contextInView}
          regionId={contextLayout.regionId}
          summary={contextSummary}
          actions={(
            <ClassroomStickyActions
              copy={copy}
              loading={loading}
              tutorError={Boolean(tutorPersona.error)}
              historyOpen={historyOpen}
              drawerOpen={drawerOpen}
              onOpenHistory={() => setHistoryOpen(true)}
              onRetryTutor={() => void tutorPersona.reload()}
              onRefresh={() => void loadClassroom()}
              onToggleDrawer={() => setDrawerOpen((value) => !value)}
            />
          )}
          mobileActions={(
            <ClassroomStickyActions
              copy={copy}
              loading={loading}
              tutorError={Boolean(tutorPersona.error)}
              historyOpen={historyOpen}
              drawerOpen={drawerOpen}
              onOpenHistory={() => setHistoryOpen(true)}
              onRetryTutor={() => void tutorPersona.reload()}
              onRefresh={() => void loadClassroom()}
              onToggleDrawer={() => setDrawerOpen((value) => !value)}
            />
          )}
          onOpen={contextLayout.openFromSticky}
          openLabel={copy.expandClassroomInfo}
        />
      </section>

      {drawerOpen && (
        <LearningDrawer
          copy={copy}
          tab={drawerTab}
          onTabChange={setDrawerTab}
          onClose={() => setDrawerOpen(false)}
          classroom={classroom}
          studyPlan={studyPlan}
          sessions={classroomSessions}
          activeHistoryId={viewingHistoryId}
          profileFeed={profileFeed}
          savingSourceId={savingSourceId}
          sourceFavoriteMessage={sourceFavoriteMessage}
          sourceFavoriteSuccess={sourceFavoriteSuccess}
          savingPracticeId={savingPracticeId}
          practiceFeedback={practiceFeedback}
          embeddedPractice={embeddedPractice}
          onOpenHistory={viewClassroomHistory}
          onSaveSource={saveSourceFavorite}
          onCompletePractice={completePracticeRecommendation}
          onStartEmbeddedPractice={startEmbeddedPractice}
          onSelectEmbeddedPracticeAnswer={selectEmbeddedPracticeAnswer}
          onSubmitEmbeddedPractice={submitEmbeddedPractice}
        />
      )}
    </div>
  );
}

function ClassroomStickyActions({
  copy,
  loading,
  tutorError,
  historyOpen,
  drawerOpen,
  onOpenHistory,
  onRetryTutor,
  onRefresh,
  onToggleDrawer,
}: {
  copy: ClassroomCopy;
  loading: boolean;
  tutorError: boolean;
  historyOpen: boolean;
  drawerOpen: boolean;
  onOpenHistory: () => void;
  onRetryTutor: () => void;
  onRefresh: () => void;
  onToggleDrawer: () => void;
}) {
  const actionClassName = 'inline-flex size-11 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-blue-700 disabled:cursor-wait disabled:opacity-50';

  return (
    <div className="flex items-center gap-1" role="group" aria-label={copy.moreActions}>
      {!historyOpen && (
        <button
          type="button"
          className={actionClassName}
          aria-label={copy.expandHistory}
          title={copy.expandHistory}
          onClick={onOpenHistory}
        >
          <PanelLeftOpen className="size-4" aria-hidden="true" />
        </button>
      )}
      {tutorError && (
        <button
          type="button"
          className={actionClassName}
          aria-label={copy.retryTutor}
          title={copy.retryTutor}
          onClick={onRetryTutor}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className={actionClassName}
        aria-label={copy.refreshContext}
        title={copy.refreshContext}
        disabled={loading}
        onClick={onRefresh}
      >
        {loading
          ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          : <RefreshCw className="size-4" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={actionClassName}
        aria-label={copy.sidePanel}
        title={copy.sidePanel}
        aria-pressed={drawerOpen}
        onClick={onToggleDrawer}
      >
        {drawerOpen
          ? <PanelRightClose className="size-4" aria-hidden="true" />
          : <PanelRightOpen className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

function WorkspaceHeader({
  copy,
  classroom,
  target,
  loading,
  historyOpen,
  drawerOpen,
  readiness,
  onRefresh,
  onToggleHistory,
  onToggleDrawer,
}: {
  copy: ClassroomCopy;
  classroom: ClassroomContext | null;
  target: ClassroomContext['target'];
  loading: boolean;
  historyOpen: boolean;
  drawerOpen: boolean;
  readiness: number;
  onRefresh: () => void;
  onToggleHistory: () => void;
  onToggleDrawer: () => void;
}) {
  return (
    <header aria-label={copy.classroomInfo} className="border-b border-slate-200 px-4 py-3 md:px-6">
      <div className="flex min-w-0 flex-col gap-3 pr-32 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {!historyOpen && (
              <button
                type="button"
                onClick={onToggleHistory}
                className="inline-flex size-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
                aria-label={historyOpen ? copy.collapseHistory : copy.expandHistory}
              >
                <PanelLeftOpen className="size-4" />
              </button>
            )}
            <A3Pill tone="blue">{copy.aiClassroom}</A3Pill>
            {classroom?.course && <A3Pill tone="slate">{classroom.course.title}</A3Pill>}
            <A3Pill tone={readiness >= 3 ? 'green' : 'orange'}>{readiness >= 3 ? copy.closedLoopReady : copy.needsEvidence}</A3Pill>
          </div>
          <h1 className="mt-2 truncate text-xl font-semibold tracking-normal text-slate-950 md:text-2xl">
            {target?.title ?? copy.waitingTarget}
          </h1>
          <p className="mt-1 line-clamp-1 max-w-3xl text-sm leading-6 text-slate-600">
            {target?.reason || target?.description || copy.targetFallback}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" className={CLASSROOM_OUTLINE_BUTTON_CLASS}>
            <Link href="/a3/learning-path">
              <Route className="size-4" />
              {copy.learningPath}
            </Link>
          </Button>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className={CLASSROOM_OUTLINE_BUTTON_CLASS}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {copy.refreshContext}
          </Button>
          <Button size="sm" variant="outline" onClick={onToggleDrawer} className={CLASSROOM_OUTLINE_BUTTON_CLASS}>
            {drawerOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            {copy.sidePanel}
          </Button>
        </div>
      </div>
    </header>
  );
}
function OpenMAICInlineBar({ copy, artifact }: { copy: ClassroomCopy; artifact: A3OpenMAICClassroomArtifact | null }) {
  return (
    <div className="min-h-12 border-b border-slate-200 bg-slate-50/80 px-4 py-2 md:px-6" data-testid="a3-classroom-openmaic-entry">
      <div className="flex min-w-0 min-h-8 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Layers3 className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-semibold text-slate-950">{copy.openmaicClassroom}</h2>
            <span className="shrink-0">
              <A3Pill tone={artifact?.status === 'succeeded' ? 'green' : artifact ? 'orange' : 'slate'}>
                {artifact?.status ?? copy.notGenerated}
              </A3Pill>
            </span>
            {artifact?.scenesCount ? (
              <span className="hidden shrink-0 xl:inline">
                <A3Pill tone="blue">{artifact.scenesCount} {copy.scenesUnit}</A3Pill>
              </span>
            ) : null}
            <p
              className="hidden min-w-0 flex-1 truncate text-xs text-slate-600 lg:block"
              data-testid="a3-classroom-openmaic-pptx-hint"
              title={copy.pptxHint}
            >
              {copy.pptxHint}
            </p>
          </div>
        </div>
        <div className="shrink-0">
          {artifact?.classroomUrl ? (
            <Button asChild size="sm" className="shrink-0 bg-blue-600 text-white hover:bg-blue-700" data-testid="a3-classroom-openmaic-open">
              <Link href={artifact.classroomUrl}>
                <ExternalLink className="size-4" />
                {copy.openClassroom}
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className={cn('shrink-0', CLASSROOM_OUTLINE_BUTTON_CLASS)}>
              <Link href="/a3/recommendations">
                <UploadCloud className="size-4" />
                {copy.generateResourceClassroom}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
function HistorySidebar({
  copy,
  sessions,
  activeId,
  query,
  asking,
  onQueryChange,
  onOpen,
  onNew,
  onClose,
}: {
  copy: ClassroomCopy;
  sessions: ClassroomHistorySession[];
  activeId: string;
  query: string;
  asking: boolean;
  onQueryChange: (value: string) => void;
  onOpen: (session: ClassroomHistorySession) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="min-h-[420px] overflow-hidden rounded-[18px] border border-slate-200 bg-white text-slate-950 shadow-sm" data-testid="a3-classroom-history-panel">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-slate-200 bg-slate-50/80 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex size-8 items-center justify-center rounded-xl bg-blue-600 text-white">
                <Bot className="size-4" />
              </span>
              {copy.classroomConversations}
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:border-blue-200 hover:text-blue-700" aria-label={copy.collapseHistory}>
              <PanelLeftClose className="size-4" />
            </button>
          </div>
          <Button
            type="button"
            size="sm"
            className="mt-3 w-full justify-start bg-blue-600 text-white hover:bg-blue-700"
            disabled={asking}
            data-testid="a3-classroom-new-dialogue"
            onClick={onNew}
          >
            <Plus className="size-4" />
            {copy.newDialogue}
          </Button>
          <label className="mt-3 flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-500 focus-within:border-blue-300 focus-within:ring-2 focus-within:ring-blue-100">
            <Search className="size-4" />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={copy.searchHistory}
              className="min-w-0 flex-1 bg-transparent text-slate-950 outline-none placeholder:text-slate-400"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {sessions.length ? sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              data-testid="a3-classroom-history-session"
              onClick={() => onOpen(session)}
              className={cn(
                'w-full rounded-xl border px-3 py-3 text-left transition',
                activeId === session.id ? 'border-blue-200 bg-blue-50 text-blue-950' : 'border-transparent text-slate-700 hover:border-slate-200 hover:bg-slate-50',
              )}
            >
              <div className="line-clamp-1 text-sm font-medium">{session.title || copy.classroomConversations}</div>
              <div className={cn('mt-1 line-clamp-2 text-xs leading-5', activeId === session.id ? 'text-blue-700' : 'text-slate-500')}>
                {session.summary || `${session.messageCount ?? session.messages.length} ${copy.messagesUnit}`}
              </div>
            </button>
          )) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              {copy.noHistoryDetailed}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
function LessonRunway({
  copy,
  target,
  sourceCount,
  exerciseCount,
  asking,
  onAsk,
}: {
  copy: ClassroomCopy;
  target: ClassroomContext['target'];
  sourceCount: number;
  exerciseCount: number;
  asking: boolean;
  onAsk: (question: string) => void;
}) {
  const title = target?.title ?? copy.currentKnowledgePoint;
  const prompts = [
    { label: copy.explainConcept, prompt: copy.explainConceptPrompt(title) },
    { label: copy.generatePractice, prompt: copy.generatePracticePrompt(title) },
    { label: copy.analyzeMistakes, prompt: copy.analyzeMistakesPrompt(title) },
  ];
  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-blue-950">
            <Sparkles className="size-4" />
            {copy.lessonStart}
          </div>
          <p className="mt-2 text-sm leading-6 text-blue-900">
            {copy.lessonRunway(sourceCount, exerciseCount)}
          </p>
        </div>
        <A3Pill tone={target ? 'green' : 'orange'}>{target ? copy.targetSynced : copy.targetPending}</A3Pill>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {prompts.map((item) => (
          <Button key={item.label} size="sm" variant="outline" className={CLASSROOM_OUTLINE_BUTTON_CLASS} disabled={asking || !target} onClick={() => onAsk(item.prompt)}>
            {item.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
function Composer({
  copy,
  contentWidthClass,
  target,
  asking,
  input,
  message,
  retrievalMode,
  retrievalScope,
  sources,
  viewingHistoryId,
  imageAttachment,
  imageAttachmentError,
  voiceSupported,
  voiceListening,
  voiceTranscribing,
  voiceDraft,
  voiceError,
  imageInputRef,
  onInputChange,
  onModeChange,
  onScopeChange,
  onAsk,
  onImageUpload,
  onRemoveImage,
  onToggleVoice,
  onNewDialogue,
  onOpenDrawer,
}: {
  copy: ClassroomCopy;
  contentWidthClass: string;
  target: ClassroomContext['target'];
  asking: boolean;
  input: string;
  message: string;
  retrievalMode: ClassroomRetrievalMode;
  retrievalScope: ClassroomRetrievalScope;
  sources: Citation[];
  viewingHistoryId: string;
  imageAttachment: ClassroomImageAttachment | null;
  imageAttachmentError: string;
  voiceSupported: boolean;
  voiceListening: boolean;
  voiceTranscribing: boolean;
  voiceDraft: string;
  voiceError: string;
  imageInputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onModeChange: (value: ClassroomRetrievalMode) => void;
  onScopeChange: (value: ClassroomRetrievalScope) => void;
  onAsk: (question?: string) => void;
  onImageUpload: (file?: File) => void;
  onRemoveImage: () => void;
  onToggleVoice: () => void;
  onNewDialogue: () => void;
  onOpenDrawer: (tab: DrawerTab) => void;
}) {
  const disabled = asking || Boolean(viewingHistoryId);
  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3 md:px-6">
      <div className={cn('mx-auto w-full transition-[max-width] duration-200 ease-out', contentWidthClass)}>
        {message && <ClassroomMessage message={message} />}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <RetrievalControls
            copy={copy}
            mode={retrievalMode}
            scope={retrievalScope}
            sources={sources}
            disabled={disabled}
            onModeChange={onModeChange}
            onScopeChange={onScopeChange}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" className={CLASSROOM_OUTLINE_BUTTON_CLASS} disabled={asking} onClick={onNewDialogue}>
              <Plus className="size-4" />
              {copy.shortNewDialogue}
            </Button>
            <Button type="button" size="sm" variant="outline" className={CLASSROOM_OUTLINE_BUTTON_CLASS} onClick={() => onOpenDrawer('practice')}>
              <ClipboardCheck className="size-4" />
              {copy.practiceTab}
            </Button>
            <Button type="button" size="sm" variant="outline" className={CLASSROOM_OUTLINE_BUTTON_CLASS} onClick={() => onOpenDrawer('actions')}>
              <ListChecks className="size-4" />
              {copy.actionsTab}
            </Button>
          </div>
        </div>

        {imageAttachment && (
          <div data-testid="a3-classroom-image-preview" className="mb-3 flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-2 text-xs text-blue-800">
            <div className="size-12 shrink-0 rounded-lg bg-cover bg-center" style={{ backgroundImage: `url(${imageAttachment.dataUrl})` }} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{imageAttachment.name}</div>
              <div>{Math.max(1, Math.round(imageAttachment.size / 1024))} KB</div>
            </div>
            <Button type="button" size="sm" variant="outline" data-testid="a3-classroom-image-remove" onClick={onRemoveImage}>
              <X className="size-4" />
            </Button>
          </div>
        )}
        {imageAttachmentError && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{imageAttachmentError}</div>}
        {(voiceListening || voiceTranscribing || voiceDraft || voiceError || !voiceSupported) && (
          <div className={cn('mb-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm', voiceError || !voiceSupported ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-800')} data-testid="a3-classroom-voice-status">
            {voiceTranscribing ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" /> : voiceListening ? <Mic className="mt-0.5 size-4 shrink-0" /> : <MicOff className="mt-0.5 size-4 shrink-0" />}
            <div className="min-w-0">
              {voiceError || (!voiceSupported ? copy.voiceUnsupported : '')}
              {!voiceError && voiceSupported && voiceListening && !voiceDraft && copy.recording}
              {!voiceError && voiceTranscribing && !voiceDraft && copy.transcribing}
              {!voiceError && voiceDraft && <span>{voiceDraft}</span>}
            </div>
          </div>
        )}

        <form onSubmit={(event) => { event.preventDefault(); onAsk(); }} className="rounded-2xl border border-slate-200 bg-slate-50 p-2 focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-50">
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="a3-classroom-image-upload"
            onChange={(event) => onImageUpload(event.target.files?.[0])}
          />
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            data-testid="a3-classroom-input"
            rows={2}
            className="max-h-32 min-h-14 w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-slate-950 outline-none placeholder:text-slate-400"
            placeholder={target ? copy.placeholder(target.title) : copy.placeholderNoTarget}
            disabled={!target || Boolean(viewingHistoryId)}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={asking || !target} className={cn('size-10 rounded-xl p-0', CLASSROOM_OUTLINE_BUTTON_CLASS)} title={copy.attachImage} onClick={() => imageInputRef.current?.click()}>
                <ImageIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={asking || voiceTranscribing || !target || Boolean(viewingHistoryId)}
                aria-pressed={voiceListening}
                data-testid="a3-classroom-voice-input"
                className={cn('size-10 rounded-xl p-0 transition', CLASSROOM_OUTLINE_BUTTON_CLASS, voiceListening && 'border-blue-300 bg-blue-50 text-blue-700')}
                title={voiceListening ? copy.finishVoice : copy.voiceInput}
                onClick={onToggleVoice}
              >
                {voiceTranscribing ? <Loader2 className="size-4 animate-spin" /> : voiceListening ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </Button>
            </div>
            <Button data-testid="a3-classroom-submit" type="submit" disabled={asking || !target || Boolean(viewingHistoryId) || (!input.trim() && !imageAttachment)} className="h-10 rounded-xl bg-blue-600 px-4 hover:bg-blue-700">
              {asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {copy.send}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
function RetrievalControls({
  copy,
  mode,
  scope,
  sources,
  disabled,
  onModeChange,
  onScopeChange,
}: {
  copy: ClassroomCopy;
  mode: ClassroomRetrievalMode;
  scope: ClassroomRetrievalScope;
  sources: Citation[];
  disabled: boolean;
  onModeChange: (value: ClassroomRetrievalMode) => void;
  onScopeChange: (value: ClassroomRetrievalScope) => void;
}) {
  const { locale } = useA3Locale();
  const localizedScopeOptions = classroomScopeOptions[locale];
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="a3-classroom-retrieval-controls">
      <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
        {([
          { value: 'fast' as const, label: copy.fastAnswer },
          { value: 'deep' as const, label: copy.deepRetrieval },
        ]).map((item) => (
          <button
            key={item.value}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(item.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
              mode === item.value ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <select
        value={scope}
        disabled={disabled}
        onChange={(event) => onScopeChange(event.target.value as ClassroomRetrievalScope)}
        className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
        title={localizedScopeOptions.find((item) => item.value === scope)?.detail}
      >
        {localizedScopeOptions.map((item) => (
          <option key={item.value} value={item.value}>{item.label}</option>
        ))}
      </select>
      <span className="text-xs text-slate-500">{copy.currentSources(sources.length)}</span>
    </div>
  );
}
function LearningDrawer({
  copy,
  tab,
  onTabChange,
  onClose,
  classroom,
  studyPlan,
  sessions,
  activeHistoryId,
  profileFeed,
  savingSourceId,
  sourceFavoriteMessage,
  sourceFavoriteSuccess,
  savingPracticeId,
  practiceFeedback,
  embeddedPractice,
  onOpenHistory,
  onSaveSource,
  onCompletePractice,
  onStartEmbeddedPractice,
  onSelectEmbeddedPracticeAnswer,
  onSubmitEmbeddedPractice,
}: {
  copy: ClassroomCopy;
  tab: DrawerTab;
  onTabChange: (tab: DrawerTab) => void;
  onClose: () => void;
  classroom: ClassroomContext | null;
  studyPlan: StudyPlan | null;
  sessions: ClassroomHistorySession[];
  activeHistoryId: string;
  profileFeed: DynamicProfileFeedResponse | null;
  savingSourceId: string;
  sourceFavoriteMessage: string;
  sourceFavoriteSuccess: boolean;
  savingPracticeId: string;
  practiceFeedback: StudyPlanTaskFeedback | null;
  embeddedPractice: EmbeddedPracticeState | null;
  onOpenHistory: (session: ClassroomHistorySession) => void;
  onSaveSource: (source: Citation) => void;
  onCompletePractice: (resource: ClassroomContext['recommended'][number]) => void;
  onStartEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
  onSelectEmbeddedPracticeAnswer: (answer: string) => void;
  onSubmitEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
}) {
  return (
    <aside className="min-h-[420px] overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-sm">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-slate-200 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-950">{copy.drawerTitle}</h2>
              <p className="mt-1 text-xs text-slate-500">{copy.drawerSubtitle}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:border-blue-200 hover:text-blue-700" aria-label={copy.closeDrawer}>
              <PanelRightClose className="size-4" />
            </button>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
            {([
              { value: 'practice' as const, label: copy.practiceTab, icon: ClipboardCheck },
              { value: 'actions' as const, label: copy.actionsTab, icon: ListChecks },
              { value: 'history' as const, label: copy.historyTab, icon: History },
            ]).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.value}
                  type="button"
                  data-testid={`a3-classroom-drawer-tab-${item.value}`}
                  onClick={() => onTabChange(item.value)}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-lg px-2 py-2 text-xs font-semibold transition',
                    tab === item.value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-950',
                  )}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'practice' && (
            <PracticePanel
              copy={copy}
              classroom={classroom}
              studyPlan={studyPlan}
              savingPracticeId={savingPracticeId}
              practiceFeedback={practiceFeedback}
              embeddedPractice={embeddedPractice}
              onCompletePractice={onCompletePractice}
              onStartEmbeddedPractice={onStartEmbeddedPractice}
              onSelectEmbeddedPracticeAnswer={onSelectEmbeddedPracticeAnswer}
              onSubmitEmbeddedPractice={onSubmitEmbeddedPractice}
            />
          )}
          {tab === 'actions' && (
            <ActionsPanel
              copy={copy}
              classroom={classroom}
              profileFeed={profileFeed}
              savingSourceId={savingSourceId}
              sourceFavoriteMessage={sourceFavoriteMessage}
              sourceFavoriteSuccess={sourceFavoriteSuccess}
              onSaveSource={onSaveSource}
            />
          )}
          {tab === 'history' && (
            <HistoryPanel copy={copy} sessions={sessions} activeId={activeHistoryId} onOpen={onOpenHistory} />
          )}
        </div>
      </div>
    </aside>
  );
}
function PracticePanel({
  copy,
  classroom,
  studyPlan,
  savingPracticeId,
  practiceFeedback,
  embeddedPractice,
  onCompletePractice,
  onStartEmbeddedPractice,
  onSelectEmbeddedPracticeAnswer,
  onSubmitEmbeddedPractice,
}: {
  copy: ClassroomCopy;
  classroom: ClassroomContext | null;
  studyPlan: StudyPlan | null;
  savingPracticeId: string;
  practiceFeedback: StudyPlanTaskFeedback | null;
  embeddedPractice: EmbeddedPracticeState | null;
  onCompletePractice: (resource: ClassroomContext['recommended'][number]) => void;
  onStartEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
  onSelectEmbeddedPracticeAnswer: (answer: string) => void;
  onSubmitEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
}) {
  const recommendations = classroom?.recommended ?? [];
  return (
    <div className="space-y-4">
      <ProgressCard copy={copy} classroom={classroom} />
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-950">{copy.practiceTitle}</h3>
          <A3Pill tone="blue">{recommendations.length} {copy.itemUnit}</A3Pill>
        </div>
        <div className="space-y-3">
          {recommendations.map((resource, index) => (
            <PracticeItem
              key={`${resource.title}-${index}`}
              copy={copy}
              resource={resource}
              index={index}
              studyPlan={studyPlan}
              savingPracticeId={savingPracticeId}
              embeddedPractice={embeddedPractice}
              onCompletePractice={onCompletePractice}
              onStartEmbeddedPractice={onStartEmbeddedPractice}
              onSelectEmbeddedPracticeAnswer={onSelectEmbeddedPracticeAnswer}
              onSubmitEmbeddedPractice={onSubmitEmbeddedPractice}
            />
          ))}
          {!recommendations.length && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              {copy.noPractice}
              <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
                <Link href="/a3/assessment">{copy.enterAssessment}</Link>
              </Button>
            </div>
          )}
        </div>
      </div>
      {practiceFeedback && (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-sm leading-6 text-emerald-800" data-testid="a3-classroom-practice-feedback">
          <div className="font-semibold text-emerald-950">{practiceFeedback.headline}</div>
          <p className="mt-1">{practiceFeedback.celebration}</p>
          <Button asChild size="sm" className="mt-3 bg-emerald-600 hover:bg-emerald-700">
            <Link href={practiceFeedback.nextAction.href}>{practiceFeedback.nextAction.label}</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

function PracticeItem({
  copy,
  resource,
  index,
  studyPlan,
  savingPracticeId,
  embeddedPractice,
  onCompletePractice,
  onStartEmbeddedPractice,
  onSelectEmbeddedPracticeAnswer,
  onSubmitEmbeddedPractice,
}: {
  copy: ClassroomCopy;
  resource: ClassroomContext['recommended'][number];
  index: number;
  studyPlan: StudyPlan | null;
  savingPracticeId: string;
  embeddedPractice: EmbeddedPracticeState | null;
  onCompletePractice: (resource: ClassroomContext['recommended'][number]) => void;
  onStartEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
  onSelectEmbeddedPracticeAnswer: (answer: string) => void;
  onSubmitEmbeddedPractice: (resource: ClassroomContext['recommended'][number]) => void;
}) {
  const match = findPracticePlanTaskForRecommendation(resource, studyPlan);
  const completed = Boolean(match?.completed);
  const canWriteBack = Boolean(match && !completed);
  const activePractice = embeddedPractice?.key === classroomPracticeKey(resource) ? embeddedPractice : null;
  const question = activePractice?.session.currentQuestion;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3" data-testid="a3-classroom-practice-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">{index + 1}. {resource.title}</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">{resource.meta}</div>
        </div>
        <A3Pill tone={completed ? 'green' : resource.progress > 80 ? 'green' : 'orange'}>{completed ? copy.completedStatus : `${resource.progress}%`}</A3Pill>
      </div>
      <div className="mt-3 grid gap-2">
        <Button size="sm" variant="outline" className="bg-white" data-testid="a3-classroom-practice-start" disabled={activePractice?.starting || activePractice?.submitting} onClick={() => onStartEmbeddedPractice(resource)}>
          {activePractice?.starting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
          {copy.classroomAnswer}
        </Button>
        <Button asChild size="sm" variant="outline" className="bg-white">
          <Link href={resource.href} data-testid="a3-classroom-practice-open-assessment">
            <ExternalLink className="size-4" />
            {copy.openAssessment}
          </Link>
        </Button>
      </div>
      {activePractice && (
        <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50 p-3" data-testid="a3-classroom-embedded-practice">
          {activePractice.feedback ? (
            <div className={cn('rounded-lg p-3 text-xs leading-5', activePractice.feedback.isCorrect ? 'bg-emerald-50 text-emerald-800' : 'bg-orange-50 text-orange-800')} data-testid="a3-classroom-embedded-feedback">
              <div className="font-semibold">{activePractice.feedback.isCorrect ? copy.answeredCorrect : copy.answeredWrong(activePractice.feedback.correctAnswer)}</div>
              <p className="mt-1">{activePractice.feedback.explanation}</p>
              {activePractice.feedback.errorCause && <p className="mt-1">{copy.errorCause}: {activePractice.feedback.errorCause}</p>}
              {activePractice.planFeedback && <p className="mt-2 font-semibold">已回写学习计划：{activePractice.planFeedback.headline}</p>}
              <PracticeSyncEvidencePanel feedback={activePractice.feedback} planFeedback={activePractice.planFeedback} />
            </div>
          ) : question ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <A3Pill tone="blue">{copy.classroomAssessment}</A3Pill>
                <span className="text-xs text-blue-700">{question.knowledgePoint.chapter} / {copy.difficulty} {question.difficulty}</span>
              </div>
              <div className="mt-3 text-sm font-semibold leading-6 text-blue-950" data-testid="a3-classroom-embedded-question">{question.stem}</div>
              <div className="mt-3 grid gap-2">
                {question.options.map((option) => {
                  const selected = activePractice.selectedAnswer === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      data-testid="a3-classroom-embedded-option"
                      disabled={Boolean(activePractice.feedback) || activePractice.submitting}
                      onClick={() => onSelectEmbeddedPracticeAnswer(option.key)}
                      className={cn('rounded-lg border bg-white px-3 py-2 text-left text-xs leading-5 transition', selected ? 'border-blue-500 text-blue-800' : 'border-blue-100 text-slate-800 hover:border-blue-300')}
                    >
                      <span className="mr-2 font-semibold">{option.key}.</span>
                      {option.text}
                    </button>
                  );
                })}
              </div>
              <Button size="sm" className="mt-3 w-full bg-blue-600 hover:bg-blue-700" data-testid="a3-classroom-embedded-submit" disabled={!activePractice.selectedAnswer || activePractice.submitting} onClick={() => onSubmitEmbeddedPractice(resource)}>
                {activePractice.submitting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                {copy.submitAndAutoSync}
              </Button>
            </>
          ) : (
            <div className="text-xs leading-5 text-blue-800">{activePractice.error || copy.noQuestion}</div>
          )}
          {activePractice.error && question && (
            <div className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-orange-700" data-testid="a3-classroom-embedded-error">
              {activePractice.error}
            </div>
          )}
        </div>
      )}
      <Button
        size="sm"
        className="mt-3 w-full bg-blue-600 hover:bg-blue-700"
        data-testid="a3-classroom-practice-complete"
        disabled={!canWriteBack || savingPracticeId === resource.href}
        title={match ? completed ? copy.taskCompletedTitle : copy.writebackTitle : copy.unmatchedTaskTitle}
        onClick={() => onCompletePractice(resource)}
      >
        {savingPracticeId === resource.href ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
        {completed ? copy.completed : copy.completeAndSync}
      </Button>
    </div>
  );
}

function PracticeSyncEvidencePanel({ feedback, planFeedback }: { feedback: AnswerFeedback; planFeedback: StudyPlanTaskFeedback | null }) {
  const evidence = buildPracticeSyncEvidence({ feedback, planFeedback });
  return (
    <div className="mt-3 space-y-2" data-testid="a3-classroom-practice-sync-evidence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-emerald-950">本次判分同步证据</div>
        <div className="text-[11px] text-emerald-700">错题本 / 画像 / 报告已按接口返回更新</div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-profile-sync">
          <div className="text-[11px] font-semibold text-emerald-950">画像：weakPoints</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {evidence.weakPoints.length ? evidence.weakPoints.slice(0, 4).map((item) => (
              <span key={item} className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">{item}</span>
            )) : <span className="text-[11px] text-emerald-700">无新增薄弱点</span>}
          </div>
        </div>
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-wrong-sync">
          <div className="text-[11px] font-semibold text-emerald-950">错题本：复习队列</div>
          <div className="mt-1 text-[11px] leading-4 text-emerald-700">{evidence.wrongNotebookText}</div>
          <Link href="/a3/wrong-notebook" className="mt-1 inline-flex text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">查看错题本</Link>
        </div>
        <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-plan-sync">
          <div className="text-[11px] font-semibold text-emerald-950">计划回写</div>
          <div className="mt-1 text-[11px] leading-4 text-emerald-700">{evidence.planText}</div>
          <Link href="/a3/study-plan" className="mt-1 inline-flex text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">查看计划</Link>
        </div>
      </div>
      <div className="rounded-lg bg-white/80 p-2" data-testid="a3-classroom-report-sync">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] font-semibold text-emerald-950">报告：report.metrics</div>
          <Link href="/a3/report" className="text-[11px] font-semibold text-emerald-800 hover:text-emerald-950">打开报告</Link>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {evidence.reportMetrics.map((item) => (
            <div key={item.label} className={cn('rounded px-2 py-1', item.available ? 'bg-emerald-50' : 'bg-slate-50')}>
              <div className={cn('text-[10px]', item.available ? 'text-emerald-700' : 'text-slate-500')}>{item.label}</div>
              <div className={cn('mt-0.5 text-xs font-semibold', item.available ? 'text-emerald-950' : 'text-slate-600')}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProgressCard({ copy, classroom }: { copy: ClassroomCopy; classroom: ClassroomContext | null }) {
  const sourceCount = classroom?.sources.length ?? 0;
  const exerciseCount = classroom?.recommended.length ?? 0;
  const weakCount = classroom?.graphSummary.weak ?? 0;
  const progress = Math.round(([Boolean(classroom?.target), sourceCount > 0, exerciseCount > 0].filter(Boolean).length / 3) * 100);
  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-blue-950">{copy.progressTitle}</div>
          <p className="mt-1 text-xs leading-5 text-blue-800">{copy.progressDetail}</p>
        </div>
        <div className="rounded-lg bg-white px-3 py-2 text-right shadow-sm">
          <div className="text-base font-semibold text-blue-700">{progress}%</div>
          <div className="text-[11px] text-blue-600">{copy.progressLabel}</div>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
        <div className="h-full rounded-full bg-blue-600 transition-[width] duration-200" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <MiniSignal label={copy.citationMetric} value={sourceCount} tone={sourceCount ? 'blue' : 'slate'} />
        <MiniSignal label={copy.practiceMetric} value={exerciseCount} tone={exerciseCount ? 'green' : 'slate'} />
        <MiniSignal label={copy.weakMetric} value={weakCount} tone={weakCount ? 'orange' : 'green'} />
      </div>
    </div>
  );
}

function ActionsPanel({
  copy,
  classroom,
  profileFeed,
  savingSourceId,
  sourceFavoriteMessage,
  sourceFavoriteSuccess,
  onSaveSource,
}: {
  copy: ClassroomCopy;
  classroom: ClassroomContext | null;
  profileFeed: DynamicProfileFeedResponse | null;
  savingSourceId: string;
  sourceFavoriteMessage: string;
  sourceFavoriteSuccess: boolean;
  onSaveSource: (source: Citation) => void;
}) {
  return (
    <div className="space-y-4">
      <div data-testid="a3-flow-profile-candidates">
        <ProfileUpdateCandidatePanel
          feed={profileFeed}
          profileHref="/a3/profile-setup"
          testId="a3-profile-update-candidate-panel"
          title={copy.profileTitle}
          subtitle={copy.profileSubtitle}
        />
      </div>
      <SourcesPanel
        copy={copy}
        classroom={classroom}
        savingSourceId={savingSourceId}
        sourceFavoriteMessage={sourceFavoriteMessage}
        sourceFavoriteSuccess={sourceFavoriteSuccess}
        onSaveSource={onSaveSource}
      />
      <NextActionsPanel copy={copy} classroom={classroom} />
    </div>
  );
}

function SourcesPanel({
  copy,
  classroom,
  savingSourceId,
  sourceFavoriteMessage,
  sourceFavoriteSuccess,
  onSaveSource,
}: {
  copy: ClassroomCopy;
  classroom: ClassroomContext | null;
  savingSourceId: string;
  sourceFavoriteMessage: string;
  sourceFavoriteSuccess: boolean;
  onSaveSource: (source: Citation) => void;
}) {
  const sources = classroom?.sources ?? [];
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-950">{copy.sourcesTitle}</h3>
        <A3Pill tone="blue">{sources.length} {copy.citationsUnit}</A3Pill>
      </div>
      <div className="space-y-3">
        {sources.map((source, index) => (
          <div key={source.id || `${source.title}-${index}`} className="rounded-xl border border-slate-200 p-3" data-testid="a3-classroom-source">
            <div className="flex items-start gap-3">
              <div className="text-sm font-semibold text-blue-700">[{index + 1}]</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-950" data-testid="a3-source-title">{source.title}</div>
                <div className="mt-1 text-xs text-slate-500">{source.location}</div>
                {source.snippet && <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600">{source.snippet}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <CitationScopePill citation={source} />
                  {source.score !== null && source.score !== undefined ? <span className="text-xs text-slate-500">score {source.score}</span> : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 bg-white"
                  disabled={savingSourceId === (source.id || source.title || source.location || 'source')}
                  onClick={() => onSaveSource(source)}
                >
                  {savingSourceId === (source.id || source.title || source.location || 'source') ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}
                  {copy.saveSource}
                </Button>
              </div>
            </div>
          </div>
        ))}
        {!sources.length && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
            {copy.noSources}
            <Button asChild size="sm" variant="outline" className="mt-3 w-full bg-white">
              <Link href="/a3/knowledge-base"><Library className="size-4" />{copy.addMaterials}</Link>
            </Button>
          </div>
        )}
        {sourceFavoriteMessage && (
          <div className={cn('rounded-lg px-3 py-2 text-sm', sourceFavoriteSuccess ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
            {sourceFavoriteMessage}
          </div>
        )}
      </div>
    </section>
  );
}

function NextActionsPanel({ copy, classroom }: { copy: ClassroomCopy; classroom: ClassroomContext | null }) {
  const builtInActions = [
    { title: copy.faceToFaceCoaching, href: '/a3/coaching' },
    { title: copy.resourcePackGeneration, href: '/a3/recommendations' },
    { title: copy.myFavorites, href: '/a3/favorites' },
  ];
  const actions = classroom?.actions?.length ? classroom.actions : [
    { title: copy.todayTasks, href: '/a3/today', type: 'path' as const },
    { title: copy.viewReport, href: '/a3/report', type: 'path' as const },
  ];
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-950">{copy.nextActions}</h3>
      </div>
      <div className="space-y-3">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
          <div className="text-xs font-semibold text-blue-950">{copy.aiLearningEntry}</div>
          <div className="mt-3 grid gap-2">
            {builtInActions.map((item) => (
              <Link key={item.href} href={item.href} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm font-medium text-blue-900 hover:bg-blue-100">
                {item.title}
                <ChevronRight className="size-4 text-blue-600" />
              </Link>
            ))}
          </div>
        </div>
        {actions.map((item) => (
          <Link key={item.title} href={item.href} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 text-left text-sm font-medium text-slate-950 hover:border-blue-300 hover:bg-blue-50">
            {item.title}
            <ChevronRight className="size-4 text-blue-600" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function HistoryPanel({
  copy,
  sessions,
  activeId,
  onOpen,
}: {
  copy: ClassroomCopy;
  sessions: ClassroomHistorySession[];
  activeId: string;
  onOpen: (session: ClassroomHistorySession) => void;
}) {
  return (
    <div className="space-y-2">
      {sessions.length ? sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          data-testid="a3-classroom-history-session"
          onClick={() => onOpen(session)}
          className={cn('w-full rounded-xl border p-3 text-left text-sm transition', activeId === session.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50')}
        >
          <div className="line-clamp-1 font-semibold text-slate-950">{session.title || copy.classroomConversations}</div>
          <div className="mt-1 text-xs leading-5 text-slate-500">{session.summary || `${session.messageCount ?? session.messages.length} ${copy.messagesUnit}`}</div>
        </button>
      )) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
          {copy.noHistory}
        </div>
      )}
    </div>
  );
}

function ClassroomResourceChips({
  disabled,
  activeType,
  hasTarget,
  onGenerate,
}: {
  disabled: boolean;
  activeType: A3ResourcePackV2ResourceType | null;
  hasTarget: boolean;
  onGenerate: (resourceType: A3ResourcePackV2ResourceType) => void;
}) {
  const types: A3ResourcePackV2ResourceType[] = ['lecture_doc', 'knowledge_card', 'mind_map', 'practice_set', 'case_study', 'code_lab', 'micro_video_script'];
  return (
    <div className="rounded-xl border border-slate-200 bg-[#fbfaf5] p-3" data-testid="a3-classroom-resource-chips">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500">
        <Sparkles className="size-3.5 text-blue-600" />
        围绕当前目标一键生成资源，结果直接展示在下方对话里
      </div>
      <div className="flex flex-wrap gap-2">
        {types.map((resourceType) => {
          const isActive = activeType === resourceType;
          return (
            <button
              key={resourceType}
              type="button"
              disabled={disabled || !hasTarget}
              onClick={() => onGenerate(resourceType)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {isActive ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {classroomResourceLabel(resourceType)}
            </button>
          );
        })}
      </div>
      {!hasTarget && <p className="mt-2 text-xs text-slate-400">待课堂目标加载后可用。</p>}
    </div>
  );
}

function ChatBubble({
  item,
  widthClassName,
  savingNoteId,
  onSaveNote,
  onFollowUp,
  onCopyUserMessage,
  onEditUserMessage,
}: {
  item: ChatMessage;
  widthClassName: string;
  savingNoteId: string;
  onSaveNote: (item: ChatMessage) => void;
  onFollowUp: (question: string) => void;
  onCopyUserMessage: (content: string) => void;
  onEditUserMessage: (content: string) => void;
}) {
  const { copy } = useClassroomCopy();
  const assistant = item.role === 'assistant';
  // 对话内生成的资源：用内联渲染组件展示（讲义/卡片/导图直接看，练习/代码/视频给打开完整页入口）。
  if (assistant && item.kind === 'resource' && item.resourcePack) {
    const resource = item.resourcePack.resources.find((res) => res.type === item.resourceType) ?? item.resourcePack.resources[0];
    return (
      <div className="flex gap-3" data-testid="a3-classroom-message-resource">
        <Avatar />
        <div className={cn('flex flex-col', widthClassName)}>
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-500">
              <Sparkles className="size-3.5 text-blue-600" />
              {item.content}
              {item.verified && <A3Pill tone="green">已验证</A3Pill>}
            </div>
            {resource ? (
              <ResourceInlineBody resource={resource} pack={item.resourcePack} />
            ) : (
              <p className="text-sm text-slate-500">资源已生成，但内容为空，请到资源推荐页查看。</p>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn('flex gap-3', !assistant && 'justify-end')} data-testid={`a3-classroom-message-${item.role}`}>
      {assistant && <Avatar />}
      <div className={cn('flex flex-col', widthClassName, !assistant && 'items-end')}>
        <div className={cn('rounded-2xl px-4 py-3 text-sm leading-7', assistant ? 'bg-slate-100 text-slate-950' : 'bg-blue-600 text-white')}>
          <div className="mb-1 text-xs font-semibold opacity-75">{assistant ? copy.teacherAgent : copy.you}</div>
          {assistant ? <A3Markdown>{item.content}</A3Markdown> : <p className="whitespace-pre-wrap">{item.content}</p>}
          {assistant && item.degraded && (
            <div data-testid="a3-classroom-vision-degraded" className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800">
              {copy.visionDegraded}
            </div>
          )}
          {assistant && item.verified !== undefined && (
            <VerificationBadge verified={item.verified} citations={item.citations ?? []} claims={item.claims ?? []} safety={item.safety} refusalReason={item.refusalReason} />
          )}
          {assistant && (item.retrievalMode || item.traceId) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500" data-testid="a3-classroom-retrieval-status">
              {item.retrievalMode && <A3Pill tone={item.retrievalMode.includes('deep') ? 'blue' : 'slate'}>{formatRetrievalModeLabel(item.retrievalMode, copy)}</A3Pill>}
              {item.traceId && <span>trace {item.traceId.slice(0, 8)}</span>}
            </div>
          )}
          {assistant && item.followUps?.length ? (
            <div data-testid="a3-classroom-followups" className="mt-3 flex flex-wrap gap-2">
              {item.followUps.slice(0, 3).map((followUp) => (
                <button
                  key={`${item.id}-${followUp.type}-${followUp.question}`}
                  type="button"
                  onClick={() => onFollowUp(followUp.question)}
                  className="rounded-full border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold leading-5 text-blue-700 transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  title={followUp.reason || followUp.question}
                >
                  {followUp.label}
                </button>
              ))}
            </div>
          ) : null}
          {assistant && <A3SpeechControls id={item.id} text={item.content} />}
          {assistant && item.id !== 'welcome' && (
            <Button data-testid="a3-classroom-save-note" size="sm" variant="outline" className="mt-3 bg-white" disabled={savingNoteId === item.id} onClick={() => onSaveNote(item)}>
              {savingNoteId === item.id ? <Loader2 className="size-4 animate-spin" /> : <Star className="size-4" />}
              {copy.saveNote}
            </Button>
          )}
        </div>
        {!assistant && (
          <div className="mt-1.5 flex items-center gap-1 pr-1 text-slate-500">
            <button
              type="button"
              data-testid="a3-classroom-user-copy"
              onClick={() => onCopyUserMessage(item.content)}
              className="inline-flex size-8 items-center justify-center rounded-lg transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={copy.copyMessage}
              title={copy.copyMessage}
            >
              <Copy className="size-4" />
            </button>
            <button
              type="button"
              data-testid="a3-classroom-user-edit"
              onClick={() => onEditUserMessage(item.content)}
              className="inline-flex size-8 items-center justify-center rounded-lg transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              aria-label={copy.editMessage}
              title={copy.editMessage}
            >
              <Pencil className="size-4" />
            </button>
          </div>
        )}
      </div>
      {!assistant && (
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700">
          <UserRound className="size-5" />
        </div>
      )}
    </div>
  );
}

function VerificationBadge({
  verified,
  citations,
  claims,
  safety,
  refusalReason,
}: {
  verified: boolean;
  citations: Citation[];
  claims: Claim[];
  safety?: SafetyStatus;
  refusalReason?: string;
}) {
  const { copy } = useClassroomCopy();
  const blocked = safety?.safe === false;
  const verifiedClaims = claims.filter((claim) => claim.verified).length;
  const claimsWithMapping = claims.filter((claim): claim is MappedClaim => Boolean(claim.citation));
  const groupedClaimCitations = groupClaimsByCitation(claimsWithMapping);
  const statusLabel = verified ? copy.verified : citations.length ? copy.partiallyVerified : copy.missingEvidence;
  return (
    <div className="mt-3 rounded-lg border border-white/70 bg-white/80 p-3 text-xs leading-5 text-slate-600" data-testid="a3-classroom-verification">
      <div className="flex flex-wrap items-center gap-2">
        <A3Pill tone={verified ? 'green' : 'orange'}>{statusLabel}</A3Pill>
        <span>{copy.citationCount(citations.length, verifiedClaims, claims.length)}</span>
      </div>
      {blocked && (
        <div data-testid="a3-classroom-safety-status" className="mt-3 rounded-lg bg-orange-50 p-3 text-orange-800">
          <div className="font-semibold">{copy.safetyRefused} · {safety.category}</div>
          <div className="mt-1">{safety.reason}</div>
          <div className="mt-1 font-semibold">{copy.safetyAlternative}</div>
        </div>
      )}
      {claimsWithMapping.length > 0 && (
        <EvidenceGallery groups={groupedClaimCitations} />
      )}
      {citations.length > 0 && claimsWithMapping.length === 0 && (
        <div className="mt-3 grid gap-2">
          {citations.slice(0, 2).map((citation, index) => (
            <div key={`${citation.title}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <CitationPreview citation={citation} />
              <div className="mt-2 text-xs leading-5 text-slate-500">
                [{index + 1}] {formatCitationLabel(citation, copy)}
              </div>
            </div>
          ))}
        </div>
      )}
      {!verified && !citations.length && refusalReason && <div className="mt-2 text-orange-700">{copy.reason}: {refusalReason}</div>}
    </div>
  );
}

type CitationPreviewSize = 'compact' | 'thumb' | 'large' | 'hero';
type MappedClaim = Claim & { citation: Citation };
type EvidenceGroup = { key: string; citation: Citation; claims: MappedClaim[] };

function CitationPreview({ citation, size = 'compact' }: { citation: Citation; size?: CitationPreviewSize }) {
  const { copy } = useClassroomCopy();
  const [previewAvailable, setPreviewAvailable] = useState(true);
  if (!citation.previewUrl) return null;
  const image = (
    <CitationImage
      citation={citation}
      size={size}
      previewAvailable={previewAvailable}
      unavailableLabel={copy.previewUnavailable}
      openLabel={copy.openPreview}
      onUnavailable={() => setPreviewAvailable(false)}
    />
  );
  if (!previewAvailable) {
    return <div className={cn('block shrink-0', size === 'compact' ? '' : 'w-full')}>{image}</div>;
  }
  return (
    <a
      href={resolveCitationPreviewUrl(citation.previewUrl)}
      target="_blank"
      rel="noreferrer"
      className={cn('block shrink-0', size === 'compact' ? '' : 'w-full')}
      data-testid="a3-classroom-citation-preview-link"
    >
      {image}
    </a>
  );
}

function CitationImage({
  citation,
  size,
  previewAvailable,
  unavailableLabel,
  openLabel,
  onUnavailable,
}: {
  citation: Citation;
  size: CitationPreviewSize;
  previewAvailable: boolean;
  unavailableLabel: string;
  openLabel: string;
  onUnavailable: () => void;
}) {
  if (!citation.previewUrl) return null;
  const frameClassName = cn(
    'group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50',
    size === 'hero'
      ? 'aspect-[16/9] max-h-[360px] min-h-[180px] w-full'
      : size === 'large'
        ? 'h-[168px] w-full md:w-[260px]'
        : size === 'thumb'
          ? 'h-[72px] w-full'
          : 'h-24 w-full',
  );
  if (!previewAvailable) {
    return (
      <div className={frameClassName} data-testid="a3-classroom-citation-preview">
        <span className="flex h-full w-full items-center justify-center px-3 text-center text-xs text-slate-500">
          {unavailableLabel}
        </span>
      </div>
    );
  }
  return (
    <div className={frameClassName} data-testid="a3-classroom-citation-preview">
      <img
        src={resolveCitationPreviewUrl(citation.previewUrl)}
        alt={citation.title || openLabel}
        className="h-full w-full object-contain"
        loading="lazy"
        onError={onUnavailable}
      />
    </div>
  );
}

function EvidenceGallery({ groups }: { groups: EvidenceGroup[] }) {
  const { copy } = useClassroomCopy();
  const [activeIndex, setActiveIndex] = useState(0);
  const activeGroup = groups[Math.min(activeIndex, Math.max(groups.length - 1, 0))];
  if (!activeGroup) return null;
  const visibleClaims = activeGroup.claims.slice(0, 3);
  const hiddenClaims = activeGroup.claims.slice(3);

  return (
    <div className="mt-3 min-w-0 border-t border-slate-200 pt-3" data-testid="a3-classroom-claim-citation-map">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-950">{copy.evidenceGalleryTitle}</div>
          <p className="mt-0.5 text-[11px] leading-5 text-slate-500">{copy.evidenceGalleryGuide}</p>
        </div>
        <A3Pill tone="green">{copy.evidenceSourceCount(groups.length)}</A3Pill>
      </div>

      <div className="mt-3 min-w-0">
        {activeGroup.citation.previewUrl ? (
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950 p-2">
            <CitationPreview citation={activeGroup.citation} size="hero" />
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm leading-6 text-slate-700">
            {activeGroup.citation.snippet || activeGroup.citation.location || copy.missingPreview}
          </div>
        )}
        <div className="mt-3 min-w-0">
          <div className="truncate text-sm font-semibold leading-5 text-slate-950">
            {activeGroup.citation.title || copy.sourceFallback}
          </div>
          <div className="mt-1 text-[11px] leading-5 text-slate-500">
            {[formatCitationOrigin(activeGroup.citation, copy), activeGroup.citation.sourceTypeLabel || activeGroup.citation.type, activeGroup.citation.location].filter(Boolean).join(' · ')}
            {activeGroup.citation.score !== null && activeGroup.citation.score !== undefined ? ` · ${activeGroup.citation.score}` : ''}
          </div>
        </div>
      </div>

      {groups.length > 1 && (
        <div className="mt-3 min-w-0 border-y border-slate-100 bg-slate-50 py-3">
          <div className="flex max-w-full gap-2 overflow-x-auto px-1 pb-1" role="list" aria-label={copy.evidenceThumbnailLabel}>
            {groups.map((group, index) => {
              const selected = index === activeIndex;
              return (
                <button
                  key={group.key}
                  type="button"
                  data-testid="a3-classroom-evidence-thumbnail"
                  onClick={() => setActiveIndex(index)}
                  className={cn(
                    'w-[116px] shrink-0 rounded-lg border bg-white p-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                    selected ? 'border-blue-500 shadow-sm ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300',
                  )}
                  aria-pressed={selected}
                >
                  <CitationPreview citation={group.citation} size="thumb" />
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className={cn('text-[11px] font-semibold', selected ? 'text-blue-700' : 'text-slate-700')}>
                      {copy.evidenceNumber(index + 1)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {copy.supportedClaims(group.claims.length)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="text-xs font-semibold text-slate-900">{copy.supportingPoints}</div>
          <span className="text-[11px] text-slate-500">{copy.supportedClaims(activeGroup.claims.length)}</span>
        </div>
        <div className="space-y-2">
          {visibleClaims.map((claim, claimIndex) => (
            <div key={claim.id} className="flex gap-3 rounded-lg bg-emerald-50 px-3 py-2">
              <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-semibold text-emerald-700">
                {claimIndex + 1}
              </div>
              <A3Markdown className="min-w-0 text-sm leading-6 text-slate-950">{claim.text}</A3Markdown>
            </div>
          ))}
          {hiddenClaims.length > 0 && (
            <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-blue-700">{copy.moreClaims(hiddenClaims.length)}</summary>
              <div className="mt-2 space-y-2">
                {hiddenClaims.map((claim, claimIndex) => (
                  <div key={claim.id} className="rounded-md bg-white px-3 py-2">
                    <div className="text-[11px] font-semibold text-slate-500">
                      {copy.evidenceNumber(claimIndex + visibleClaims.length + 1)}
                    </div>
                    <A3Markdown className="mt-1 text-xs leading-6 text-slate-700">{claim.text}</A3Markdown>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function groupClaimsByCitation(claims: MappedClaim[]) {
  const groups = new Map<string, EvidenceGroup>();
  for (const claim of claims) {
    const key = [
      claim.citation.previewUrl,
      claim.citation.title,
      claim.citation.location,
      claim.citation.sourceTypeLabel || claim.citation.type,
    ].filter(Boolean).join('::') || claim.id;
    const existing = groups.get(key);
    if (existing) existing.claims.push(claim);
    else groups.set(key, { key, citation: claim.citation, claims: [claim] });
  }
  return Array.from(groups.values());
}

function ClassroomMessage({ message }: { message: string }) {
  const { copy } = useClassroomCopy();
  const saved = message.startsWith('已保存');
  return (
    <div data-testid="a3-classroom-message" className={cn('mb-3 flex flex-col gap-3 rounded-lg px-3 py-2 text-sm md:flex-row md:items-center md:justify-between', saved ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}>
      <span>{message}</span>
      {saved && (
        <Button asChild size="sm" variant="outline" className="border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100">
          <Link data-testid="a3-classroom-open-favorites" href="/a3/favorites">{copy.openFavorites}</Link>
        </Button>
      )}
    </div>
  );
}

function MiniSignal({ label, value, tone }: { label: string; value: number; tone: 'blue' | 'green' | 'orange' | 'slate' }) {
  const toneClass = {
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-emerald-100 text-emerald-700',
    orange: 'bg-orange-100 text-orange-700',
    slate: 'bg-slate-100 text-slate-600',
  }[tone];
  return (
    <div className={cn('rounded-lg px-2 py-2 text-center', toneClass)}>
      <div className="font-semibold">{value}</div>
      <div className="mt-0.5">{label}</div>
    </div>
  );
}

function CitationScopePill({ citation }: { citation: Citation }) {
  const { copy } = useClassroomCopy();
  const scope = citation.sourceScope;
  if (scope === 'personal') return <A3Pill tone="green">{copy.sourcePersonal}</A3Pill>;
  if (scope === 'teacher') return <A3Pill tone="blue">{copy.sourceTeacher}</A3Pill>;
  if (scope === 'class') return <A3Pill tone="blue">{copy.sourceClass}</A3Pill>;
  if (scope === 'global') return <A3Pill tone="slate">{copy.sourceGlobal}</A3Pill>;
  return <A3Pill tone="blue">{citation.sourceOrigin || copy.sourceSearch}</A3Pill>;
}

function Avatar() {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
      <Bot className="size-5" />
    </div>
  );
}

function formatCitationOrigin(citation: Citation, copy: ClassroomCopy) {
  if (citation.sourceScope === 'personal') return copy.sourcePersonal;
  if (citation.sourceScope === 'teacher') return copy.sourceTeacher;
  if (citation.sourceScope === 'class') return copy.sourceClass;
  if (citation.sourceScope === 'global') return copy.sourceGlobal;
  return citation.sourceOrigin || copy.sourceSearch;
}

function formatCitationLabel(citation: Citation, copy: ClassroomCopy) {
  return `${formatCitationOrigin(citation, copy)} / ${citation.sourceTypeLabel || citation.type || copy.localMaterial} / ${citation.title || copy.sourceFallback}${citation.location ? ` / ${citation.location}` : ''}`;
}

function resolveCitationPreviewUrl(previewUrl: string) {
  if (/^https?:\/\//i.test(previewUrl) || previewUrl.startsWith('data:image/')) return previewUrl;
  return resolveA3Endpoint(previewUrl);
}

function formatRetrievalModeLabel(mode: string, copy: ClassroomCopy) {
  if (mode.includes('deep')) return copy.deepRetrieval;
  if (mode.includes('visual')) return copy.visualEvidence;
  if (mode.includes('timeout')) return copy.timeoutFallback;
  return copy.fastAnswer;
}

function emptyAssessmentSession(knowledgePoint: string): AssessmentSession {
  return {
    id: 'classroom-practice-empty',
    mode: 'practice',
    focus: { knowledgePoint },
    status: 'in_progress',
    currentIndex: 0,
    answeredCount: 0,
    totalQuestions: 0,
    score: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    currentQuestion: null,
  };
}

function findLatestOpenMAICClassroomArtifact(resourcePacks: A3ResourcePacksResponse['resourcePacks']) {
  for (const pack of resourcePacks) {
    const artifact = pack.multimodalArtifacts?.find(
      (item): item is A3OpenMAICClassroomArtifact => item.type === 'openmaic_classroom',
    );
    if (artifact) return artifact;
  }
  return null;
}

function normalizeClassroomMessages(messages?: ChatMessage[]) {
  return (messages ?? [])
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && item.content?.trim())
    .map((item, index) => ({
      ...item,
      id: item.id || `classroom-history-${index}`,
      citations: Array.isArray(item.citations) ? item.citations : [],
      claims: Array.isArray(item.claims) ? item.claims : [],
      refusalReason: item.refusalReason ?? '',
      degraded: Boolean(item.degraded),
      retrievalMode: item.retrievalMode ?? '',
      traceId: item.traceId ?? '',
      followUps: Array.isArray(item.followUps) ? item.followUps : [],
    }));
}

function normalizeClassroomSessions(sessions?: ClassroomHistorySession[]) {
  return (sessions ?? [])
    .filter((session) => session && session.id && Array.isArray(session.messages))
    .map((session) => ({
      ...session,
      title: session.title || '课堂对话',
      summary: session.summary || `${session.messageCount ?? session.messages.length} 条消息`,
      messages: normalizeClassroomMessages(session.messages),
    }))
    .filter((session) => session.messages.length > 0);
}

function classroomPracticeKey(resource: ClassroomContext['recommended'][number]) {
  return `${resource.href}::${resource.title}`;
}
