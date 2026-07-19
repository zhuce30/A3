import { describe, expect, it } from 'vitest';
import {
  formatProfileValue,
  pendingProfileUpdateCount,
  profileDimensionLabel,
  profileSourceLabel,
  profileStatusLabel,
  summarizeProfileTimelineEntry,
  summarizeProfileUpdateEvidence,
} from '../lib/a3/profile-timeline';

describe('profile timeline helpers', () => {
  it('formats profile update entries for real learner pages', () => {
    const entry = {
      id: 'puc_001',
      changedDimensions: ['motivationRisk'],
      previousValue: '低',
      nextValue: '连续两天任务未完成',
      source: 'learning_event_stream',
      status: 'pending',
      conflictType: 'behavior_conflict',
      conflictExplanation: '用户自报动力稳定，但最近任务完成率下降。',
      evidenceSummary: '学习事件：task_skip；观察窗口 7 天',
      impactSummary: '确认后会影响今日任务、学习计划和推荐排序。',
    };

    expect(profileDimensionLabel('motivationRisk')).toBe('动机风险');
    expect(profileSourceLabel(entry.source)).toBe('学习事件');
    expect(profileStatusLabel(entry.status)).toBe('待确认');
    expect(summarizeProfileTimelineEntry(entry)).toBe('动机风险从“低”调整为“连续两天任务未完成”');
    expect(summarizeProfileUpdateEvidence(entry)).toContain('行为和自报不一致');
    expect(summarizeProfileUpdateEvidence(entry)).toContain('学习事件：task_skip；观察窗口 7 天');
    expect(summarizeProfileUpdateEvidence(entry)).toContain('确认后会影响今日任务、学习计划和推荐排序。');
  });

  it('handles arrays, objects, empty values, versions and pending counts', () => {
    expect(formatProfileValue(['根轨迹', '频率响应'])).toBe('根轨迹、频率响应');
    expect(formatProfileValue({ reason: '低正确率', point: '根轨迹' })).toBe('低正确率、根轨迹');
    expect(formatProfileValue('')).toBe('空');
    expect(summarizeProfileUpdateEvidence({
      id: 'pv_001',
      versionId: 'pv_001',
      versionNumber: 3,
      changedDimensions: ['weakPoints'],
      status: 'confirmed',
      source: 'assessment',
    })).toContain('画像版本 v3');
    expect(pendingProfileUpdateCount({
      success: true,
      confirmationQueue: [
        { id: '1', changedDimensions: ['weakPoints'], status: 'pending' },
        { id: '2', changedDimensions: ['pace'], status: 'confirmed' },
      ],
    })).toBe(1);
  });
});
