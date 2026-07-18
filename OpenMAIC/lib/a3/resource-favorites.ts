import { a3PostJson } from './api-client';
import type { A3Favorite, A3FavoriteType } from './engagement-types';
import type { A3SystemResource } from './library-types';
import type {
  A3ResourcePackV2,
  A3ResourcePackV2Resource,
  A3ResourcePackV2ResourceType,
} from './recommendation-types';

export type A3FavoriteInput = {
  title: string;
  type: A3FavoriteType;
  source: string;
  url: string;
  group: string;
  metadata: Record<string, unknown>;
};

export type A3CreateFavoriteResponse = {
  success: boolean;
  error?: string;
  created?: boolean;
  favorite?: A3Favorite;
};

const generatedFavoriteTypes: Record<A3ResourcePackV2ResourceType, A3FavoriteType> = {
  lecture_doc: 'courseware',
  knowledge_card: 'knowledge_card',
  mind_map: 'knowledge_card',
  practice_set: 'exercise',
  case_study: 'courseware',
  code_lab: 'exercise',
  micro_video_script: 'video',
};

export function buildGeneratedResourceFavorite(
  pack: A3ResourcePackV2,
  resource: A3ResourcePackV2Resource,
  resourceSlug: string,
): A3FavoriteInput {
  return {
    title: resource.title,
    type: generatedFavoriteTypes[resource.type],
    source: '个性资源包',
    url: `/a3/resources/${encodeURIComponent(pack.resourcePackId)}/${resourceSlug}`,
    group: '个性资源',
    metadata: {
      targetType: 'resource_pack',
      targetId: pack.resourcePackId,
      resourceType: resource.type,
      traceId: pack.traceId,
      goal: pack.goal,
      personalizationReason: resource.personalizationReason,
    },
  };
}

export function buildSystemResourceFavorite(resource: A3SystemResource): A3FavoriteInput {
  return {
    title: resource.title,
    type: systemFavoriteType(resource.resourceType),
    source: resource.provider ? `系统资料 · ${resource.provider}` : '系统资料',
    url: `/a3/library/${encodeURIComponent(resource.resourceCode)}`,
    group: '系统资料',
    metadata: {
      targetType: 'curated_resource',
      targetId: resource.resourceCode,
      resourceType: resource.resourceType,
      courseCode: resource.course.code,
      courseTitle: resource.course.title,
      knowledgePointIds: resource.knowledgePoints.map((item) => item.id),
    },
  };
}

export function saveResourceFavorite(input: A3FavoriteInput) {
  return a3PostJson<A3CreateFavoriteResponse>('/api/engagement/favorites/create/', input);
}

function systemFavoriteType(resourceType: A3SystemResource['resourceType']): A3FavoriteType {
  if (resourceType === 'video') return 'video';
  if (resourceType === 'code_lab') return 'exercise';
  return 'courseware';
}
