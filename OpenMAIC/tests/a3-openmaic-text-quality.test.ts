import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const OPENMAIC_A3_TEXT_SURFACES = [
  '../AGENTS.md',
  '../docs/A3_OpenMAIC页面分工与接入边界.md',
  'components/a3/features/teacher-workbench-view.tsx',
  'components/a3/features/resource-pack-detail-view.tsx',
  'components/a3/features/classroom-view.tsx',
  'components/a3/features/capabilities-view.tsx',
  'e2e/tests/a3-demo-flow.spec.ts',
  'lib/a3/openmaic-evidence-summary.ts',
  'lib/a3/openmaic-handoff-sync.ts',
  'lib/a3/openmaic-page-ownership.ts',
  'lib/a3/openmaic-acceptance.ts',
  'lib/a3/openmaic-demo-flow.ts',
  'lib/a3/openmaic-video-smoke-report.ts',
  'scripts/a3-real-video-smoke.mjs',
];

const MOJIBAKE_PATTERNS = [
  /璇惧/,
  /瑙嗛/,
  /璧勬/,
  /鏆傛/,
  /鍥炲/,
  /鐢熸/,
  /鎺ㄨ/,
  /瀛︿/,
  /闄嶇/,
  /鍙/,
  /涓/,
  /鍦烘/,
  /鏉ヨ/,
  /鏈/,
  /歿/,
  /\ufffd/,
];

describe('A3 OpenMAIC text quality', () => {
  it('keeps OpenMAIC bridge surfaces free of mojibake and local absolute paths', () => {
    for (const file of OPENMAIC_A3_TEXT_SURFACES) {
      const absolutePath = path.resolve(process.cwd(), file);
      const text = fs.readFileSync(absolutePath, 'utf8');
      const badPattern = MOJIBAKE_PATTERNS.find((pattern) => pattern.test(text));

      expect(badPattern?.source, `${file} contains mojibake-like text`).toBeUndefined();
      expect(text, `${file} must not expose local Windows paths`).not.toMatch(/[A-Za-z]:\\[^'"\s)]+/);
    }
  });
});
