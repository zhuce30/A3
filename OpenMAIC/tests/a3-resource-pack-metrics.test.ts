import { describe, expect, it } from 'vitest';
import { buildResourcePackMetricCards, type ResourcePackMetrics } from '@/lib/a3/resource-pack-metrics';

describe('buildResourcePackMetricCards', () => {
  it('builds ready metric cards for converted resource packs', () => {
    const metrics: ResourcePackMetrics = {
      schemaVersion: 'a3.resource-pack-metrics.v1',
      totalRuns: 2,
      verifiedSourceCount: 5,
      practiceStartedCount: 2,
      conversionRate: 100,
      converted: true,
      latestGoal: 'root locus',
      latestAt: '2026-06-30T09:00:00+08:00',
      message: '已完成 2 个资源包。',
      readiness: 'ready',
      artifactAudit: {
        schemaVersion: 'a3.openmaic-artifact-audit.v1',
        total: 2,
        classroom: 1,
        classroomSucceeded: 1,
        video: 1,
        videoSucceeded: 1,
        videoDegraded: 0,
        latestArtifacts: [{ type: 'openmaic_video', status: 'succeeded', provider: 'happyhorse' }],
      },
      nextAction: {
        label: '继续专项练习',
        href: '/a3/assessment?practice=root%20locus',
        reason: '继续验证资源包效果。',
      },
    };

    const cards = buildResourcePackMetricCards(metrics);

    expect(cards.map((card) => card.label)).toEqual(['闭环率', '完成资源包', '专项练习', '验证来源']);
    expect(cards[0]).toMatchObject({ value: '100%', tone: 'green' });
    expect(cards[1].value).toBe('2');
    expect(cards[2].value).toBe('2');
    expect(cards[3].value).toBe('5');
    expect(metrics.artifactAudit?.videoSucceeded).toBe(1);
  });

  it('marks resource pack metrics as watch when no pack has converted', () => {
    const cards = buildResourcePackMetricCards({
      schemaVersion: 'a3.resource-pack-metrics.v1',
      totalRuns: 0,
      verifiedSourceCount: 0,
      practiceStartedCount: 0,
      conversionRate: 0,
      converted: false,
      latestGoal: '',
      latestAt: '',
      message: '暂无资源包学习记录。',
      readiness: 'watch',
      nextAction: {
        label: '获取推荐资源包',
        href: '/a3/recommendations',
        reason: '先从推荐页加入一个资源包。',
      },
    });

    expect(cards[0]).toMatchObject({ value: '0%', tone: 'orange' });
    expect(cards.every((card) => card.detail.length > 0)).toBe(true);
  });
});
