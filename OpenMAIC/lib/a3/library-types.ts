export type A3SystemResourceType = 'lecture_doc' | 'code_lab' | 'video';
export type A3SystemResourceDifficulty = 'foundation' | 'intermediate' | 'advanced';

export type A3SystemDocumentAction = {
  external: false;
  preview: {
    available: boolean;
    href: string;
    label: string;
  };
  download: {
    href: string;
    label: string;
  };
};

export type A3SystemExternalAction = {
  external: true;
  label: string;
  href: string;
};

type A3SystemLegacyInternalAction = {
  external: false;
  label: string;
  href: string;
};

export function normalizeA3SystemResource<
  T extends {
    resourceCode: string;
    deliveryMode: string;
    action: A3SystemDocumentAction | A3SystemExternalAction | A3SystemLegacyInternalAction;
  },
>(resource: T): Omit<T, 'action'> & { action: A3SystemDocumentAction | A3SystemExternalAction } {
  if (
    resource.deliveryMode !== 'internal_document'
    || resource.action.external
    || 'preview' in resource.action
  ) {
    return resource as Omit<T, 'action'> & { action: A3SystemDocumentAction | A3SystemExternalAction };
  }
  return {
    ...resource,
    action: {
      external: false,
      preview: {
        available: true,
        href: `/api/kb/library/${encodeURIComponent(resource.resourceCode)}/preview/`,
        label: '在线预览',
      },
      download: {
        href: `/api/kb/library/${encodeURIComponent(resource.resourceCode)}/content/`,
        label: '下载原文档',
      },
    },
  };
}

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
  action: A3SystemDocumentAction | A3SystemExternalAction;
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
