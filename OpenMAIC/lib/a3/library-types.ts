export type A3SystemResourceType = 'lecture_doc' | 'code_lab' | 'video';
export type A3SystemResourceDifficulty = 'foundation' | 'intermediate' | 'advanced';

export type A3SystemResource = {
  resourceCode: string;
  title: string;
  resourceType: A3SystemResourceType;
  resourceTypeLabel: string;
  deliveryMode: 'internal_document' | 'external_link';
  deliveryModeLabel: string;
  summary: string;
  provider: string;
  course: { code: string; title: string };
  difficulty: A3SystemResourceDifficulty;
  difficultyLabel: string;
  estimatedMinutes: number;
  keySegment: string;
  knowledgePoints: Array<{ id: string; code: string; title: string }>;
  prerequisites: string[];
  learnerProfiles: string[];
  learningObjectives: string[];
  completionCriteria: string[];
  isFree: boolean;
  personalization: {
    score: number;
    reason: string;
    matchedKnowledgePoints: string[];
    matchedTriggers: string[];
    rankingBasis: Array<{ label: string; value: unknown }>;
  };
  action: {
    label: string;
    href: string;
    external: boolean;
  };
  verification: {
    status: string;
    catalogVerified: boolean;
    citationEligible: boolean;
    note: string;
    verifiedAt: string | null;
  };
  contentPreview?: Array<{
    modality: string;
    markdown: string;
    confidence: number;
  }>;
};

export type A3SystemLibraryResponse = {
  success: boolean;
  error?: string;
  recommended: A3SystemResource[];
  resources: A3SystemResource[];
  summary: { total: number; documents: number; videos: number };
  filters: { type: string; difficulty: string; query: string };
};

export type A3SystemResourceDetailResponse = {
  success: boolean;
  error?: string;
  resource?: A3SystemResource;
};
