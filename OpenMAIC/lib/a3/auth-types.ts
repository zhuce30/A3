export type A3UserRole = 'student' | 'teacher' | 'admin';

export type A3OnboardingStep =
  | 'role'
  | 'phone'
  | 'welcome'
  | 'privacy'
  | 'profile'
  | 'complete';

export interface A3LearningProfile {
  majorDirection: string;
  grade: string;
  foundationLevel: string;
  learningGoals: string[];
  learningPreferences: string[];
  dailyStudyTime: string;
  weakPoints: string[];
  expectedResources: string[];
  pace: string;
}

export type A3ProfileDimensionEvidence = {
  source: string;
  confidence: number;
  traceId?: string;
  observedAt?: string;
  evidence?: Record<string, unknown>;
};

export type A3ProfileSnapshotDimension<T = unknown> = {
  dimension: string;
  value: T;
  confidence: number;
  basis: string;
  missing: boolean;
  sources: A3ProfileDimensionEvidence[];
};

export type A3ProfileSnapshot = {
  schemaVersion: 'a3.profile-snapshot.v1' | string;
  dimensions: Record<string, A3ProfileSnapshotDimension>;
  readiness: {
    score: number;
    status: 'ready' | 'partial' | 'incomplete' | string;
    readyDimensions?: string[];
    missingDimensions?: Array<string | { field: string; label: string }>;
  };
  signalSummary?: {
    total: number;
    bySource: Record<string, number>;
    latestAt?: string;
  };
  updatedAt?: string;
};

export type A3LearningProfileExtraProfile = {
  profileSnapshot?: A3ProfileSnapshot;
  dynamicProfileV2?: A3ProfileSnapshot;
  [key: string]: unknown;
};

export interface ProfileOption {
  value: string;
  label: string;
  chapter?: string;
  difficulty?: number;
}

export interface LearningProfileOptions {
  majorDirections: string[];
  grades: string[];
  foundationLevels: string[];
  learningGoals: string[];
  learningPreferences: string[];
  expectedResources: string[];
  dailyStudyTimes: string[];
  paces: ProfileOption[];
  weakPoints: ProfileOption[];
}

export interface LearningProfileOptionsResponse {
  success: boolean;
  error?: string;
  course: { id: string; code: string; title: string } | null;
  options: LearningProfileOptions;
}

export interface A3PublicUser {
  id: string;
  role: A3UserRole;
  phone?: string;
  email?: string;
  studentId?: string;
  school?: string;
  displayName: string;
  phoneBound: boolean;
  privacyAccepted: boolean;
  profileCompleted: boolean;
  onboardingStep: A3OnboardingStep;
  learningProfile?: A3LearningProfile;
  extraProfile?: A3LearningProfileExtraProfile;
  createdAt: string;
  updatedAt: string;
}
