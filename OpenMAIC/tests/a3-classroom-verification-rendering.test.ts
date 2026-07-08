import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');

describe('A3 classroom verification rendering', () => {
  it('renders claim citation snippets through A3Markdown so tables stay structured', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('<A3Markdown className="text-xs leading-6">{claim.text}</A3Markdown>');
    expect(source).not.toContain('<div className="line-clamp-2 text-emerald-900">{claim.text}</div>');
  });

  it('labels claim_not_supported with citations as partial verification', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("'部分待核验'");
    expect(source).toContain("refusalReason === 'claim_not_supported'");
  });
});
