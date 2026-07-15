import type { A3LearningProfile, LearningProfileOptions } from '@/lib/a3/auth-types';

type InterviewProfile = {
  grade?: string;
  majorDirection?: string;
  foundationLevel?: string;
  dailyMinutes?: number;
  learningGoals?: string[];
  weakPoints?: string[];
  resourcePreferences?: string[];
};

type ProfileInterviewResponseState = {
  success: boolean;
  error?: string;
  profileCommitted?: boolean;
  interviewSession?: unknown;
  missingDimensions?: unknown;
  profileReadiness?: unknown;
  askFields?: unknown;
  nextQuestion?: string;
  profile?: unknown;
};

const PRESERVED_INTERVIEW_STATE_KEYS = [
  'interviewSession',
  'missingDimensions',
  'profileReadiness',
  'askFields',
  'nextQuestion',
  'profile',
] as const satisfies ReadonlyArray<keyof ProfileInterviewResponseState>;

export function mergeProfileInterviewResponseState<T extends ProfileInterviewResponseState>(
  previous: T | null,
  incoming: T,
): T {
  if (!previous) return incoming;

  const merged = { ...incoming } as T & ProfileInterviewResponseState;
  for (const key of PRESERVED_INTERVIEW_STATE_KEYS) {
    if (
      !Object.prototype.hasOwnProperty.call(incoming, key)
      && Object.prototype.hasOwnProperty.call(previous, key)
    ) {
      Object.assign(merged, { [key]: previous[key] });
    }
  }
  return merged;
}

export function createEmptyLearningProfile(): A3LearningProfile {
  return {
    majorDirection: '',
    grade: '',
    foundationLevel: '',
    learningGoals: [],
    learningPreferences: [],
    dailyStudyTime: '',
    weakPoints: [],
    expectedResources: [],
    pace: '',
  };
}

function pickAllowed(items: string[] | undefined, allowedItems: string[]) {
  if (!items?.length) return [];
  const allowed = new Set(allowedItems);
  return items.filter((item, index) => allowed.has(item) && items.indexOf(item) === index);
}

export function normalizeLearningProfileForOptions(
  profile: A3LearningProfile,
  options: LearningProfileOptions,
): A3LearningProfile {
  const weakPointValues = options.weakPoints.map((item) => item.value);
  const paceValues = options.paces.map((item) => item.value);

  return {
    ...profile,
    majorDirection: options.majorDirections.includes(profile.majorDirection) ? profile.majorDirection : '',
    grade: options.grades.includes(profile.grade) ? profile.grade : '',
    foundationLevel: options.foundationLevels.includes(profile.foundationLevel) ? profile.foundationLevel : '',
    learningGoals: pickAllowed(profile.learningGoals, options.learningGoals),
    learningPreferences: pickAllowed(profile.learningPreferences, options.learningPreferences),
    weakPoints: pickAllowed(profile.weakPoints, weakPointValues),
    expectedResources: pickAllowed(profile.expectedResources, options.expectedResources),
    pace: paceValues.includes(profile.pace) ? profile.pace : '',
  };
}

export function getMissingLearningProfileFields(profile: A3LearningProfile): string[] {
  const checks: Array<[string, boolean]> = [
    ['专业方向', Boolean(profile.majorDirection)],
    ['年级', Boolean(profile.grade)],
    ['基础水平', Boolean(profile.foundationLevel)],
    ['学习目标', profile.learningGoals.length > 0],
    ['学习偏好', profile.learningPreferences.length > 0],
    ['每日时间', Boolean(profile.dailyStudyTime)],
    ['薄弱知识点', profile.weakPoints.length > 0],
    ['资源类型', profile.expectedResources.length > 0],
    ['学习节奏', Boolean(profile.pace)],
  ];
  return checks.filter(([, ready]) => !ready).map(([label]) => label);
}

export function mergeInterviewProfile(
  current: A3LearningProfile,
  extracted: InterviewProfile,
  options: LearningProfileOptions,
): A3LearningProfile {
  const preferenceCandidates = extracted.resourcePreferences ?? [];
  const learningPreferences = pickAllowed(preferenceCandidates, options.learningPreferences);
  const expectedResources = pickAllowed(preferenceCandidates, options.expectedResources);

  return normalizeLearningProfileForOptions(
    {
      ...current,
      grade: extracted.grade || current.grade,
      majorDirection: extracted.majorDirection || current.majorDirection,
      foundationLevel: extracted.foundationLevel || current.foundationLevel,
      dailyStudyTime: extracted.dailyMinutes ? String(extracted.dailyMinutes) : current.dailyStudyTime,
      learningGoals: extracted.learningGoals?.length ? extracted.learningGoals : current.learningGoals,
      weakPoints: extracted.weakPoints?.length ? extracted.weakPoints : current.weakPoints,
      learningPreferences: learningPreferences.length ? learningPreferences : current.learningPreferences,
      expectedResources: expectedResources.length ? expectedResources : current.expectedResources,
    },
    options,
  );
}
