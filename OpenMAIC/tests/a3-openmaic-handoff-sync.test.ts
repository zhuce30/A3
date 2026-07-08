import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  A3_OPENMAIC_HANDOFF_DOCUMENT_PATH,
  A3_OPENMAIC_HANDOFF_SYNC_COMMAND,
  buildOpenMAICHandoffSyncSummary,
} from '@/lib/a3/openmaic-handoff-sync';
import { A3_OPENMAIC_PAGE_OWNERSHIP } from '@/lib/a3/openmaic-page-ownership';

describe('A3 OpenMAIC handoff document sync', () => {
  it('reports ready when the handoff document covers every page, API, and evidence token', () => {
    const documentText = fs.readFileSync(
      path.resolve(process.cwd(), A3_OPENMAIC_HANDOFF_DOCUMENT_PATH),
      'utf8',
    );
    const summary = buildOpenMAICHandoffSyncSummary(A3_OPENMAIC_PAGE_OWNERSHIP, documentText);

    expect(summary.schemaVersion).toBe('a3.openmaic-handoff-sync.v1');
    expect(summary.status).toBe('ready');
    expect(summary.coverage).toBe(100);
    expect(summary.missingTokens).toEqual([]);
    expect(summary.proofCommand).toBe(A3_OPENMAIC_HANDOFF_SYNC_COMMAND);
  });

  it('surfaces missing handoff tokens instead of silently claiming sync', () => {
    const summary = buildOpenMAICHandoffSyncSummary(A3_OPENMAIC_PAGE_OWNERSHIP, '/a3/recommendations');

    expect(summary.status).toBe('warning');
    expect(summary.coverage).toBeLessThan(100);
    expect(summary.missingTokens).toContain('POST /api/resources/generate/');
    expect(summary.detail).toContain('交接文档缺少');
  });
});
