import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildGeneratedResourceFavorite,
  buildSystemResourceFavorite,
  saveResourceFavorite,
} from '@/lib/a3/resource-favorites';
import type { A3SystemResource } from '@/lib/a3/library-types';
import type { A3ResourcePackV2, A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';

const generatedResource: A3ResourcePackV2Resource = {
  type: 'practice_set',
  title: '进程同步专项练习',
  content: {},
  citations: [],
  verified: true,
  personalizationReason: '针对同步薄弱点',
  estimatedMinutes: 20,
};

const resourcePack: A3ResourcePackV2 = {
  schemaVersion: 'a3.resource-pack.v2',
  resourcePackId: 'pack-123',
  goal: '掌握进程同步',
  learnerProfileSnapshot: {},
  resources: [generatedResource],
  nextActions: [],
  traceId: 'trace-123',
};

const systemResource = {
  resourceCode: 'os-video-01',
  title: '操作系统进程基础',
  resourceType: 'video',
  resourceTypeLabel: '视频',
  deliveryMode: 'external_link',
  deliveryModeLabel: '外部链接',
  summary: '进程基础讲解',
  provider: '哔哩哔哩',
  course: { code: 'OS', title: '操作系统' },
  difficulty: 'foundation',
  difficultyLabel: '基础',
  estimatedMinutes: 15,
  keySegment: '',
  knowledgePoints: [{ id: 'kp-1', code: 'process', title: '进程' }],
  prerequisites: [],
  learnerProfiles: [],
  learningObjectives: [],
  completionCriteria: [],
  isFree: true,
  personalization: {
    score: 90,
    reason: '匹配当前学习目标',
    matchedKnowledgePoints: ['进程'],
    matchedTriggers: [],
    rankingBasis: [],
  },
  action: { external: true, label: '观看视频', href: 'https://www.bilibili.com/video/BV-test' },
  verification: {
    status: 'verified',
    catalogVerified: true,
    citationEligible: false,
    note: '目录已核验',
    verifiedAt: null,
  },
} satisfies A3SystemResource;

describe('A3 resource favorites', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('builds a reopenable favorite for a generated personalized resource', () => {
    expect(buildGeneratedResourceFavorite(resourcePack, generatedResource, 'practice')).toMatchObject({
      title: '进程同步专项练习',
      type: 'exercise',
      source: '个性资源包',
      group: '个性资源',
      url: '/a3/resources/pack-123/practice',
      metadata: {
        targetType: 'resource_pack',
        targetId: 'pack-123',
        resourceType: 'practice_set',
        traceId: 'trace-123',
      },
    });
  });

  it('builds a reopenable favorite for a curated system resource', () => {
    expect(buildSystemResourceFavorite(systemResource)).toMatchObject({
      title: '操作系统进程基础',
      type: 'video',
      source: '系统资料 · 哔哩哔哩',
      group: '系统资料',
      url: '/a3/library/os-video-01',
      metadata: {
        targetType: 'curated_resource',
        targetId: 'os-video-01',
        resourceType: 'video',
        courseCode: 'OS',
      },
    });
  });

  it('persists the favorite through the engagement API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, created: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveResourceFavorite(buildGeneratedResourceFavorite(resourcePack, generatedResource, 'practice'));

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith('http://localhost:8000/api/engagement/favorites/create/', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'X-CSRFToken': 'csrf-test' }),
      body: expect.stringContaining('进程同步专项练习'),
    }));
  });

  it('connects generated resource favorite actions to the real favorites API', () => {
    const source = readFileSync(join(process.cwd(), 'components/a3/features/resource-standalone-view.tsx'), 'utf8');

    expect(source).toContain('saveResourceFavorite(buildGeneratedResourceFavorite(pack, resource, config.slug))');
    expect(source).toContain('已加入“我的收藏”');
  });
});
