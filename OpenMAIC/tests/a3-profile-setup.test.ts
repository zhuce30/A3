import { describe, expect, it } from 'vitest';

import { mergeInterviewProfile } from '@/lib/a3/profile-setup';
import type { A3LearningProfile, LearningProfileOptions } from '@/lib/a3/auth-types';

const options: LearningProfileOptions = {
  majorDirections: ['自动化专业'],
  grades: ['大二'],
  foundationLevels: ['基础一般'],
  learningGoals: ['掌握自动控制原理'],
  learningPreferences: ['课堂讲解', '例题推导', '动画演示', '工程案例'],
  expectedResources: ['视频课程', '课件讲义', '练习题库'],
  dailyStudyTimes: ['40', '60'],
  paces: [{ value: 'standard', label: '标准节奏' }],
  weakPoints: [
    { value: '根轨迹', label: '根轨迹' },
    { value: '频率响应', label: '频率响应' },
  ],
};

const current: A3LearningProfile = {
  majorDirection: '自动化专业',
  grade: '大二',
  foundationLevel: '基础一般',
  learningGoals: ['掌握自动控制原理'],
  learningPreferences: ['课堂讲解'],
  dailyStudyTime: '60',
  weakPoints: ['根轨迹'],
  expectedResources: ['视频课程'],
  pace: 'standard',
};

describe('mergeInterviewProfile', () => {
  it('keeps learning preferences out of expected resource payloads', () => {
    const merged = mergeInterviewProfile(
      current,
      {
        resourcePreferences: ['动画演示', '例题推导', '工程案例', '视频课程', '课件讲义'],
      },
      options,
    );

    expect(merged.learningPreferences).toEqual(['动画演示', '例题推导', '工程案例']);
    expect(merged.expectedResources).toEqual(['视频课程', '课件讲义']);
  });
});
