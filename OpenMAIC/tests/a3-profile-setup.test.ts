import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  createEmptyLearningProfile,
  getMissingLearningProfileFields,
  mergeInterviewProfile,
  mergeProfileInterviewResponseState,
  normalizeLearningProfileForOptions,
  transitionProfileInterviewUiState,
} from '@/lib/a3/profile-setup';
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

type InterviewResponseState = {
  success: boolean;
  error?: string;
  profileCommitted?: boolean;
  interviewSession?: { id: string; messages?: Array<{ role: string; content: string }> };
  missingDimensions?: Array<{ field: string; label: string }>;
  profileReadiness?: { status: string; missingDimensions?: Array<{ field: string; label: string }> };
  askFields?: Array<{ field: string; label: string }>;
  nextQuestion?: string;
  profile?: { grade: string };
};

describe('mergeInterviewProfile', () => {
  it('wires the profile page to empty form and interview state', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx'),
      'utf8',
    );

    expect(source).toContain('useState<A3LearningProfile>(() => createEmptyLearningProfile())');
    expect(source).toContain("const [interviewText, setInterviewText] = useState('')");
    expect(source).not.toContain('const defaultProfile');
    expect(source).not.toContain('firstOption(');
  });

  it('starts a new learner profile without invented answers', () => {
    expect(createEmptyLearningProfile()).toEqual({
      majorDirection: '',
      grade: '',
      foundationLevel: '',
      learningGoals: [],
      learningPreferences: [],
      dailyStudyTime: '',
      weakPoints: [],
      expectedResources: [],
      pace: '',
    });
  });

  it('keeps unanswered fields empty after profile options load', () => {
    expect(normalizeLearningProfileForOptions(createEmptyLearningProfile(), options)).toEqual(
      createEmptyLearningProfile(),
    );
  });

  it('reports every unanswered field instead of accepting defaults', () => {
    expect(getMissingLearningProfileFields(createEmptyLearningProfile())).toEqual([
      '专业方向',
      '年级',
      '基础水平',
      '学习目标',
      '学习偏好',
      '每日时间',
      '薄弱知识点',
      '资源类型',
      '学习节奏',
    ]);
  });

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

describe('mergeProfileInterviewResponseState', () => {
  const previous: InterviewResponseState = {
    success: true,
    profileCommitted: true,
    interviewSession: {
      id: 'session-old',
      messages: [{ role: 'agent', content: '请继续回答' }],
    },
    missingDimensions: [{ field: 'grade', label: '年级' }],
    profileReadiness: {
      status: 'partial',
      missingDimensions: [{ field: 'grade', label: '年级' }],
    },
    askFields: [{ field: 'grade', label: '年级' }],
    nextQuestion: '你目前是哪个年级？',
    profile: { grade: '待确认' },
  };

  it('preserves prior interview state when an incomplete response omits it', () => {
    const incoming: InterviewResponseState = { success: true, profileCommitted: false };

    expect(mergeProfileInterviewResponseState(previous, incoming)).toEqual({
      ...incoming,
      interviewSession: previous.interviewSession,
      missingDimensions: previous.missingDimensions,
      profileReadiness: previous.profileReadiness,
      askFields: previous.askFields,
      nextQuestion: previous.nextQuestion,
      profile: previous.profile,
    });
  });

  it('uses explicitly returned interview state instead of the prior values', () => {
    const incoming: InterviewResponseState = {
      success: false,
      error: '仍需补充',
      profileCommitted: false,
      interviewSession: { id: 'session-new', messages: [] },
      missingDimensions: [],
      profileReadiness: { status: 'ready', missingDimensions: [] },
      askFields: [],
      nextQuestion: '',
      profile: { grade: '大二' },
    };

    expect(mergeProfileInterviewResponseState(previous, incoming)).toEqual(incoming);
  });
});

describe('transitionProfileInterviewUiState', () => {
  const previousResult: InterviewResponseState = {
    success: true,
    profileCommitted: true,
    interviewSession: {
      id: 'session-old',
      messages: [{ role: 'agent', content: '请继续回答' }],
    },
    missingDimensions: [{ field: 'grade', label: '年级' }],
    profile: { grade: '待确认' },
  };
  const previousMissingDimensions = ['年级'];
  const previousMessages = [{ role: 'agent', content: '请继续回答' }];

  it('preserves prior UI state when the incomplete response omits replacement data', () => {
    const incomingResult: InterviewResponseState = {
      success: true,
      error: '还需要补充一项信息',
      profileCommitted: false,
    };

    expect(transitionProfileInterviewUiState({
      previousResult,
      previousMissingDimensions,
      previousMessages,
      incomingResult,
      incomingMessages: [],
    })).toEqual({
      result: {
        ...incomingResult,
        interviewSession: previousResult.interviewSession,
        missingDimensions: previousResult.missingDimensions,
        profile: previousResult.profile,
      },
      missingDimensions: previousMissingDimensions,
      messages: previousMessages,
    });
  });

  it('replaces explicit session, empty missing state, and non-empty messages', () => {
    const incomingResult: InterviewResponseState = {
      success: true,
      profileCommitted: false,
      interviewSession: { id: 'session-new', messages: [{ role: 'agent', content: '新问题' }] },
      missingDimensions: [],
    };
    const incomingMessages = [{ role: 'agent', content: '新问题' }];

    expect(transitionProfileInterviewUiState({
      previousResult,
      previousMissingDimensions,
      previousMessages,
      incomingResult,
      incomingMissingDimensions: [],
      incomingMessages,
    })).toEqual({
      result: {
        ...incomingResult,
        profile: previousResult.profile,
      },
      missingDimensions: [],
      messages: incomingMessages,
    });
  });
});
