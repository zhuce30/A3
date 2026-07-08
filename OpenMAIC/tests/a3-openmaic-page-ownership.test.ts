import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  A3_OPENMAIC_PAGE_OWNERSHIP,
  buildOpenMAICPageOwnershipMetrics,
} from '@/lib/a3/openmaic-page-ownership';
import { buildOpenMAICHandoffSyncSummary } from '@/lib/a3/openmaic-handoff-sync';

describe('A3 OpenMAIC page ownership map', () => {
  it('assigns OpenMAIC integration responsibilities to concrete A3 pages', () => {
    const pages = A3_OPENMAIC_PAGE_OWNERSHIP.map((item) => item.a3Page);

    expect(pages).toContain('/a3/recommendations');
    expect(pages).toContain('/a3/resources/[packId]');
    expect(pages).toContain('/a3/classroom');
    expect(pages).toContain('/a3/teacher');
    expect(pages).toContain('/a3/capabilities');
    expect(pages).toContain('/a3/knowledge-base');
  });

  it('keeps every page assignment verifiable through APIs, evidence, and tests', () => {
    for (const item of A3_OPENMAIC_PAGE_OWNERSHIP) {
      expect(item.owner).toMatch(/Agent|Bridge|Workbench|KnowledgeBase|Capability/);
      expect(item.primaryOpenMAICCapability.length).toBeGreaterThan(0);
      expect(item.a3Apis.length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.verification.length).toBeGreaterThan(0);
    }
  });

  it('keeps A3 pages as the product shell and OpenMAIC as a capability substrate', () => {
    for (const item of A3_OPENMAIC_PAGE_OWNERSHIP) {
      expect(item.a3Page).toMatch(/^\/a3\//);
      expect(item.handoffRule).toContain('A3');
      expect(item.handoffRule).not.toContain('原产品页');
    }

    const recommendations = A3_OPENMAIC_PAGE_OWNERSHIP.find((item) => item.a3Page === '/a3/recommendations');
    const resourceDetail = A3_OPENMAIC_PAGE_OWNERSHIP.find((item) => item.a3Page === '/a3/resources/[packId]');
    const classroom = A3_OPENMAIC_PAGE_OWNERSHIP.find((item) => item.a3Page === '/a3/classroom');

    expect(recommendations?.responsibility).toContain('resourcePack.multimodalArtifacts');
    expect(resourceDetail?.responsibility).toContain('历史');
    expect(classroom?.handoffRule).toContain('PPTX');
  });

  it('reports page ownership coverage for the capabilities page', () => {
    const metrics = buildOpenMAICPageOwnershipMetrics(A3_OPENMAIC_PAGE_OWNERSHIP);

    expect(metrics.totalPages).toBeGreaterThanOrEqual(6);
    expect(metrics.pagesWithBridgeApis).toBe(metrics.totalPages);
    expect(metrics.pagesWithVerification).toBe(metrics.totalPages);
    expect(metrics.ready).toBe(true);
  });

  it('keeps real smoke reports out of version control', () => {
    const gitignore = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');

    expect(gitignore).toMatch(/^tmp\/$/m);
  });

  it('keeps the handoff document synchronized with page ownership code', () => {
    const documentText = fs.readFileSync(
      path.resolve(process.cwd(), '../docs/A3_OpenMAIC页面分工与接入边界.md'),
      'utf8',
    );
    const sync = buildOpenMAICHandoffSyncSummary(A3_OPENMAIC_PAGE_OWNERSHIP, documentText);

    expect(sync.status, `missing handoff tokens: ${sync.missingTokens.join(', ')}`).toBe('ready');
    expect(sync.coverage).toBe(100);
    expect(sync.expectedTokens).toBeGreaterThan(20);
  });
});
