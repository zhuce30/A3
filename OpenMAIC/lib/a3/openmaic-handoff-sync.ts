import type { A3OpenMAICPageOwnership } from './openmaic-page-ownership';

export type A3OpenMAICHandoffSyncSummary = {
  schemaVersion: 'a3.openmaic-handoff-sync.v1';
  documentPath: string;
  proofCommand: string;
  expectedTokens: number;
  coveredTokens: number;
  coverage: number;
  status: 'ready' | 'warning';
  missingTokens: string[];
  detail: string;
};

export const A3_OPENMAIC_HANDOFF_DOCUMENT_PATH = '../docs/A3_OpenMAIC页面分工与接入边界.md';

export const A3_OPENMAIC_HANDOFF_SYNC_COMMAND =
  'pnpm vitest run tests/a3-openmaic-page-ownership.test.ts tests/a3-openmaic-text-quality.test.ts';

export function buildOpenMAICHandoffSyncSummary(
  items: A3OpenMAICPageOwnership[],
  documentText?: string,
): A3OpenMAICHandoffSyncSummary {
  const expectedTokens = collectHandoffTokens(items);
  const coveredTokens = documentText == null
    ? expectedTokens
    : expectedTokens.filter((token) => documentText.includes(token));
  const missingTokens = expectedTokens.filter((token) => !coveredTokens.includes(token));
  const coverage = expectedTokens.length
    ? Math.round((coveredTokens.length * 100) / expectedTokens.length)
    : 0;
  const status = missingTokens.length === 0 ? 'ready' : 'warning';

  return {
    schemaVersion: 'a3.openmaic-handoff-sync.v1',
    documentPath: A3_OPENMAIC_HANDOFF_DOCUMENT_PATH,
    proofCommand: A3_OPENMAIC_HANDOFF_SYNC_COMMAND,
    expectedTokens: expectedTokens.length,
    coveredTokens: coveredTokens.length,
    coverage,
    status,
    missingTokens,
    detail: status === 'ready'
      ? '页面分工代码、交接文档和文本质量扫描已由同一组测试约束。'
      : `交接文档缺少 ${missingTokens.length} 个页面/API/证据 token，需要先补文档再继续开发。`,
  };
}

function collectHandoffTokens(items: A3OpenMAICPageOwnership[]) {
  return Array.from(new Set(
    items.flatMap((item) => [
      item.a3Page.replace('[packId]', '<packId>'),
      ...item.a3Apis,
      ...item.evidence,
    ]),
  )).filter((token) => token.trim());
}
