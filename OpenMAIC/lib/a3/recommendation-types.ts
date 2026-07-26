import type { ClassroomSource } from './classroom-types';

export type RecommendationProfileSignal = {
  label: string;
  value: string;
  tone: 'blue' | 'green' | 'violet' | 'orange' | 'red' | 'slate';
};

export type A3Recommendation = {
  id: string;
  rank: number;
  title: string;
  type: string;
  score: number;
  reason: string;
  href: string;
  citation: ClassroomSource | null;
  evidence: {
    profileMatch: {
      matched: boolean;
      signals: string[];
      reason: string;
    };
    rankingBasis: Array<{ label: string; value: string | number | boolean | null }>;
    sourceEvidence: ClassroomSource | null;
    fallback: boolean;
    resourceEffect?: {
      resourceType: string;
      historicalEffectiveness: number;
      effectConfidence: 'high' | 'medium' | 'low' | string;
      explorationRecommended: boolean;
      opened?: number;
      completed?: number;
      skipped?: number;
      favorited?: number;
      completionRate?: number;
      skipRate?: number;
      favoriteRate?: number;
      practiceConversionRate?: number;
      postAssessmentGain?: number;
    };
    curatedResource?: {
      resourceCode: string;
      resourceType: string;
      deliveryMode: string;
      difficulty: string;
      estimatedMinutes: number;
      knowledgePoints: string[];
      catalogVerified: boolean;
      citationEligible: boolean;
    };
  };
};

export type RecommendationRationale = {
  strategy: string;
  profileInputs?: {
    foundationLevel: string;
    dailyMinutes: number;
    learningGoals: string[];
    weakPoints: string[];
    expectedResources: string[];
    pace: string;
  };
  weights: Array<{ label: string; value: number }>;
  fallbackUsed: boolean;
  retrievalMode: 'fast' | 'deep';
  resourceEffectAttribution?: {
    schemaVersion?: string;
    summary?: {
      resourceEventCount?: number;
      assessmentEventCount?: number;
      highConfidenceCount?: number;
      explorationCount?: number;
    };
  };
};

export type A3ResourcePack = {
  schemaVersion: 'a3.resource-pack.v1';
  title: string;
  learningGoal: string;
  target: RecommendationResponse['target'];
  estimatedMinutes: number;
  resources: Array<{
    recommendationId: string;
    rank: number;
    title: string;
    type: string;
    score: number;
    reason: string;
    source: ClassroomSource | null;
    action: {
      label: string;
      href: string;
    };
  }>;
  practice: {
    title: string;
    href: string;
    reason: string;
    recommendedAfterMinutes: number;
  };
  reviewQueue: Array<{
    title: string;
    href: string;
    reason: string;
  }>;
  evidence: {
    verifiedSourceCount: number;
    sourceCount: number;
    fallbackUsed: boolean;
    confidence: 'high' | 'medium' | 'low';
    retrievalMode: 'fast' | 'deep';
  };
  nextAction: {
    label: string;
    href: string;
    reason: string;
  };
};

export type A3ResourcePackV2ResourceType =
  | 'lecture_doc'
  | 'knowledge_card'
  | 'mind_map'
  | 'practice_set'
  | 'case_study'
  | 'code_lab'
  | 'micro_video_script';

export type A3ResourcePackV2Citation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  sourceTypeLabel?: string;
  sourceOrigin?: string;
  sourceScope?: string;
  score?: number | null;
  snippet?: string;
};

export type A3ResourcePackV2Resource = {
  type: A3ResourcePackV2ResourceType;
  title: string;
  content: Record<string, unknown>;
  citations: A3ResourcePackV2Citation[];
  verified: boolean;
  personalizationReason: string;
  estimatedMinutes: number;
};

export type A3OpenMAICClassroomArtifact = {
  schemaVersion?: 'a3.openmaic-classroom-artifact.v1';
  type: 'openmaic_classroom';
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  classroomId: string;
  classroomUrl: string;
  resourcePackId?: string;
  packId?: string;
  scenesCount: number;
  pptxExportable: boolean;
  provider: string;
  elapsedMs: number;
  degradedReason?: string;
  createdAt?: string;
  tutorPersona?: import('./tutor-persona-types').A3TutorPersona;
  fallbackUsed?: boolean;
};

export type A3OpenMAICVideoArtifact = {
  schemaVersion?: 'a3.openmaic-video-artifact.v1';
  type: 'openmaic_video';
  jobId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  provider: string;
  resourceType: string;
  videoUrl: string;
  duration: number;
  width: number;
  height: number;
  segments?: Array<{
    index: number;
    title: string;
    visual?: string;
    narration?: string;
    sourceIds?: string[];
    narrationEstimatedMs?: number;
    narrationFits?: boolean;
    status: 'succeeded' | 'failed' | string;
    videoUrl: string;
    duration: number;
    width: number;
    height: number;
    degradedReason?: string;
    playbackStatus?: 'available' | 'remote' | 'missing' | 'unavailable' | string;
  }>;
  elapsedMs: number;
  degradedReason?: string;
  createdAt?: string;
};

export type A3OpenMAICPPTXExportArtifact = {
  schemaVersion?: 'a3.openmaic-pptx-export-artifact.v1';
  type: 'openmaic_pptx_export';
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  provider: string;
  classroomId: string;
  classroomUrl: string;
  fileName: string;
  slidesCount: number;
  elapsedMs: number;
  degradedReason?: string;
  createdAt?: string;
};

export type A3MultimodalArtifact = A3OpenMAICClassroomArtifact | A3OpenMAICVideoArtifact | A3OpenMAICPPTXExportArtifact;

export type A3ResourcePackV2 = {
  schemaVersion: 'a3.resource-pack.v2';
  resourcePackId: string;
  generationMode?: 'full' | 'single' | string;
  requestedResourceType?: A3ResourcePackV2ResourceType | '' | string;
  goal: string;
  learnerProfileSnapshot: Record<string, unknown>;
  resources: A3ResourcePackV2Resource[];
  multimodalArtifacts?: A3MultimodalArtifact[];
  nextActions: Array<{ label: string; href: string; reason?: string }>;
  traceId: string;
  createdAt?: string;
};

export type A3ResourceGenerateResponse = {
  success: boolean;
  error?: string;
  traceId?: string;
  resourcePack?: A3ResourcePackV2;
};

export type A3ResourcePacksResponse = {
  success: boolean;
  error?: string;
  resourcePacks: A3ResourcePackV2[];
};

export type A3ResourceFeedbackAction = 'opened' | 'completed' | 'skipped' | 'favorited';

export type A3ResourceFeedbackResponse = {
  success: boolean;
  error?: string;
  traceId?: string;
  feedback?: {
    packId: string;
    goal: string;
    action: A3ResourceFeedbackAction;
    resourceType: string;
    score: number;
    createdAt: string;
  };
  effectReport?: {
    schemaVersion?: string;
    resourceUsage?: {
      opened?: number;
      completed?: number;
      skipped?: number;
      totalFeedback?: number;
    };
    resourceEffectiveness?: number;
    planAdjustment?: {
      strategy?: string;
      reason?: string;
      evidence?: {
        opened?: number;
        completed?: number;
        skipped?: number;
        favorited?: number;
        averageFeedbackScore?: number;
        planCompletionRate?: number;
        latestGoal?: string;
      };
      nextAction?: { label: string; href: string; reason?: string };
    };
  };
};

export type RecommendationResponse = {
  success: boolean;
  error?: string;
  profile: unknown;
  target: {
    id: string;
    title: string;
    description: string;
    chapter: { order: number; title: string };
    progress: number;
    status: string;
    estimatedMinutes: number;
    reason: string;
    wrongCount: number;
  } | null;
  query: string;
  profileSignals: RecommendationProfileSignal[];
  recommendations: A3Recommendation[];
  sources: ClassroomSource[];
  resourcePack?: A3ResourcePack;
  rationale: RecommendationRationale;
};
