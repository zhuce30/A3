import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('A3 profile kernel snapshot types', () => {
  const source = readFileSync(join(process.cwd(), 'lib/a3/auth-types.ts'), 'utf8');

  it('exports profile snapshot evidence fields for profile API payloads', () => {
    expect(source).toContain('export type A3ProfileSnapshot');
    expect(source).toContain("schemaVersion: 'a3.profile-snapshot.v1' | string");
    expect(source).toContain('missingDimensions?: Array<string | { field: string; label: string }>');
    expect(source).toContain('profileSnapshot?: A3ProfileSnapshot');
  });

  it('surfaces profile snapshot evidence in profile setup and insight UI sources', () => {
    const authSource = readFileSync(join(process.cwd(), 'components/a3/auth/a3-auth-pages.tsx'), 'utf8');
    const insightSource = readFileSync(join(process.cwd(), 'components/a3/profile/dynamic-profile-insight-panel.tsx'), 'utf8');

    expect(authSource).toContain('profileSnapshot');
    expect(authSource).toContain('summarizeProfileUpdateEvidence');
    expect(insightSource).toContain('signalSummary');
    expect(insightSource).toContain('置信度');
  });

  it('uses a compact dynamic profile summary layout for narrow side panels', () => {
    const insightSource = readFileSync(join(process.cwd(), 'components/a3/profile/dynamic-profile-insight-panel.tsx'), 'utf8');

    expect(insightSource).toContain('compact ? (');
    expect(insightSource).toContain('<CompactProfileSummary');
    expect(insightSource).toContain('<CompactProfileEvidence');
    expect(insightSource).toContain('<CompactProfileDetails');
    expect(insightSource).toContain('画像完整度');
    expect(insightSource).toContain('查看画像细节');
    expect(insightSource).toContain('grid grid-cols-2 gap-2');
    expect(insightSource).toContain('max-w-full rounded-full');
  });
});
