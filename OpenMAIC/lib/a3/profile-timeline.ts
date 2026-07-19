import type { A3ProfileSnapshot } from '@/lib/a3/auth-types';
import type { DynamicProfileInsight } from '@/components/a3/profile/dynamic-profile-insight-panel';

export type ProfileUpdateStatus = 'pending' | 'confirmed' | 'rejected' | string;

export type ProfileTimelineEntry = {
  id: string;
  versionId?: string;
  versionNumber?: number | null;
  schemaVersion?: string;
  changedDimensions: string[];
  previousValue?: unknown;
  nextValue?: unknown;
  source?: string;
  evidence?: Record<string, unknown>;
  evidenceSummary?: string;
  confidence?: number;
  conflictType?: string;
  conflictExplanation?: string;
  impactSummary?: string;
  status: ProfileUpdateStatus;
  rejectionReason?: string;
  createdAt?: string;
  resolvedAt?: string;
};

export type DynamicProfileFeedResponse = {
  success: boolean;
  error?: string;
  schemaVersion?: 'a3.dynamic-profile-feed.v1' | string;
  dynamicProfile?: DynamicProfileInsight;
  profileSnapshot?: A3ProfileSnapshot;
  confirmationQueue?: ProfileTimelineEntry[];
  timeline?: ProfileTimelineEntry[];
};

export function profileDimensionLabel(dimension: string) {
  const labels: Record<string, string> = {
    grade: '年级',
    majorDirection: '专业方向',
    foundationLevel: '基础水平',
    dailyStudyTime: '每日时间',
    pace: '学习节奏',
    learningGoals: '学习目标',
    weakPoints: '薄弱点',
    resourcePreferences: '资源偏好',
    cognitiveStyle: '认知风格',
    learningHistory: '学习历史',
    motivationRisk: '动机风险',
    mistakePatterns: '错因模式',
  };
  return labels[dimension] || dimension || '画像维度';
}

export function profileSourceLabel(source?: string) {
  const labels: Record<string, string> = {
    profile_interview: '画像访谈',
    learning_event_stream: '学习事件',
    admission_diagnostic: '入学诊断',
    assessment: '测评判分',
    assessment_agent: '测评判分',
    assessment_wrong_answer: '错题复盘',
    wrong_question_added: '错题复盘',
    wrong_question_reviewed: '错题复盘',
    recommend_agent: '推荐反馈',
    resource_feedback: '资源反馈',
    classroom: 'AI 课堂',
    classroom_qa: 'AI 课堂',
    coaching_qa: '面对面辅导',
    profile_manual_edit: '手动校准',
  };
  return source ? labels[source] || source : '画像引擎';
}

export function profileStatusLabel(status?: ProfileUpdateStatus) {
  if (status === 'pending') return '待确认';
  if (status === 'confirmed') return '已更新';
  if (status === 'rejected') return '已忽略';
  return status || '待确认';
}

export function profileStatusTone(status?: ProfileUpdateStatus): 'blue' | 'green' | 'orange' | 'red' | 'slate' {
  if (status === 'pending') return 'orange';
  if (status === 'confirmed') return 'green';
  if (status === 'rejected') return 'slate';
  return 'blue';
}

export function profileConflictLabel(conflictType?: string) {
  if (conflictType === 'behavior_conflict') return '行为和自报不一致';
  if (conflictType === 'profile_drift') return '画像发生漂移';
  if (conflictType === 'manual_conflict') return '与既有画像不一致';
  return '';
}

export function formatProfileValue(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join('、') || '空';
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map((item) => String(item)).filter(Boolean).slice(0, 3).join('、') || '已记录';
  }
  if (value === null || value === undefined || value === '') return '空';
  return String(value);
}

export function summarizeProfileTimelineEntry(entry: ProfileTimelineEntry) {
  const dimension = profileDimensionLabel(entry.changedDimensions?.[0] || '');
  const before = trimProfileValuePunctuation(formatProfileValue(entry.previousValue));
  const after = trimProfileValuePunctuation(formatProfileValue(entry.nextValue));
  return `${dimension}从“${before}”调整为“${after}”`;
}

function trimProfileValuePunctuation(value: string) {
  return value.trim().replace(/[\s。；;，,：:]+$/u, '');
}

export function summarizeProfileUpdateEvidence(entry: ProfileTimelineEntry) {
  const parts = [
    entry.versionNumber ? `画像版本 v${entry.versionNumber}` : '',
    profileConflictLabel(entry.conflictType),
    entry.conflictExplanation || '',
    entry.evidenceSummary || '',
    entry.impactSummary || '',
  ].filter(Boolean);
  return parts.join('；') || `${profileSourceLabel(entry.source)}提供了一条画像变化证据。`;
}

export function pendingProfileUpdateCount(feed?: DynamicProfileFeedResponse | null) {
  return (feed?.confirmationQueue ?? []).filter((item) => item.status === 'pending').length;
}
