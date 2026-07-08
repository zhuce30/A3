import { describe, expect, it } from 'vitest';
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import {
  answerNextActions,
  buildCoachingWelcomeMessage,
  buildSessionSummaryText,
  coachingUiStateLabel,
  deriveCoachingUiState,
  formatCoachingSessionMeta,
  getCoachingControlState,
} from '@/lib/a3/coaching-state';

const classroom = {
  target: {
    title: '反馈控制结构',
    progress: 35,
    chapter: { order: 1, title: '控制系统基础' },
  },
} as ClassroomContext;

describe('coaching-state helpers', () => {
  it('returns readable Chinese labels for each interaction state', () => {
    expect(coachingUiStateLabel('restoring')).toBe('正在恢复辅导记录');
    expect(coachingUiStateLabel('recording')).toBe('正在录音');
    expect(coachingUiStateLabel('transcribing')).toBe('正在识别语音');
    expect(coachingUiStateLabel('answering')).toBe('AI 正在组织回答');
    expect(coachingUiStateLabel('speaking')).toBe('正在语音播报');
    expect(coachingUiStateLabel('saving')).toBe('正在保存记录');
    expect(coachingUiStateLabel('ended')).toBe('本次辅导已结束');
    expect(coachingUiStateLabel('error')).toBe('需要处理异常');
    expect(coachingUiStateLabel('idle')).toBe('等待提问');
  });

  it('builds a welcome message tied to the current learning target', () => {
    const message = buildCoachingWelcomeMessage(classroom);

    expect(message.role).toBe('assistant');
    expect(message.content).toContain('反馈控制结构');
    expect(message.content).toContain('学习路径');
    expect(message.content).toContain('知识库');
  });

  it('builds an auditable session summary from recent user questions', () => {
    const summary = buildSessionSummaryText('反馈控制结构', [
      { id: 'welcome', role: 'assistant', content: '欢迎', createdAt: '2026-07-04T10:00:00+08:00' },
      { id: 'q1', role: 'user', content: '反馈控制是什么？', createdAt: '2026-07-04T10:01:00+08:00' },
      { id: 'a1', role: 'assistant', content: '回答', verified: true, createdAt: '2026-07-04T10:02:00+08:00' },
    ]);

    expect(summary).toBe('反馈控制结构：已完成 1 次有效提问，1 条回答完成引用验证。最近问题：反馈控制是什么？');
  });

  it('disables conflicting controls while answering', () => {
    expect(getCoachingControlState('answering')).toMatchObject({
      canRecord: false,
      canAskText: false,
      canAskWithCamera: false,
      canEnd: true,
    });
    expect(getCoachingControlState('idle')).toMatchObject({
      canRecord: true,
      canAskText: true,
      canAskWithCamera: true,
      canEnd: true,
    });
  });

  it('formats session list metadata for compact history rows', () => {
    expect(formatCoachingSessionMeta({
      id: 's1',
      status: 'ended',
      topicTitle: '反馈控制结构',
      summary: '完成 2 次提问',
      questionCount: 2,
      verifiedReplyCount: 1,
      citationCount: 3,
      startedAt: '2026-07-04T09:00:00+08:00',
      endedAt: '2026-07-04T09:30:00+08:00',
      updatedAt: '2026-07-04T09:30:00+08:00',
    })).toBe('2 次提问 / 1 条已验证 / 3 个引用');
  });

  it('derives state from recorder and request flags', () => {
    expect(deriveCoachingUiState({ loadingSession: true })).toBe('restoring');
    expect(deriveCoachingUiState({ recorderIsRecording: true })).toBe('recording');
    expect(deriveCoachingUiState({ recorderIsProcessing: true })).toBe('transcribing');
    expect(deriveCoachingUiState({ asking: true })).toBe('answering');
    expect(deriveCoachingUiState({ saving: true })).toBe('saving');
    expect(deriveCoachingUiState({ ended: true })).toBe('ended');
    expect(deriveCoachingUiState({ error: '失败' })).toBe('error');
    expect(deriveCoachingUiState({})).toBe('idle');
  });

  it('exposes only real next actions for verified assistant messages', () => {
    const actions = answerNextActions({
      id: 'a1',
      role: 'assistant',
      content: '回答',
      verified: true,
      citations: [{ title: '控制系统基础' }],
    });

    expect(actions.map((action) => action.label)).toEqual(['继续追问', '生成练习', '加入复习', '保存笔记']);
    expect(actions.find((action) => action.label === '生成练习')?.href).toBe('/a3/assessment');
    expect(actions.find((action) => action.label === '加入复习')?.href).toBe('/a3/wrong-notebook');
  });

  it('guides unverified answers toward knowledge base improvement', () => {
    const actions = answerNextActions({
      id: 'a1',
      role: 'assistant',
      content: '回答',
      verified: false,
      citations: [],
    });

    expect(actions.map((action) => action.label)).toEqual(['继续追问', '补充资料', '保存笔记']);
  });
});
