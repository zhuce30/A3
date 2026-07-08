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
    learningGoals: pickAllowed(profile.learningGoals, options.learningGoals),
    learningPreferences: pickAllowed(profile.learningPreferences, options.learningPreferences),
    weakPoints: pickAllowed(profile.weakPoints, weakPointValues),
    expectedResources: pickAllowed(profile.expectedResources, options.expectedResources),
    pace: paceValues.includes(profile.pace) ? profile.pace : 'standard',
  };
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
