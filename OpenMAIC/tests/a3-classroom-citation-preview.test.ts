import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const viewPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');

describe('A3 classroom citation previews', () => {
  it('renders previewUrl thumbnails for visual knowledge-base citations', () => {
    const source = fs.readFileSync(viewPath, 'utf8');

    expect(source).toContain('previewUrl?: string');
    expect(source).toContain('data-testid="a3-classroom-citation-preview"');
    expect(source).toContain("className={cn('block shrink-0', size === 'compact' ? '' : 'w-full')}");
    expect(source).toContain('resolveA3Endpoint(previewUrl)');
    expect(source).toContain('src={previewUrl}');
    expect(source).toContain('alt={citation.title ||');
    expect(source).toContain('object-contain');
    expect(source).toContain("activeGroup.citation.previewUrl ? (");
    expect(source).toContain('该证据没有可预览图片，已显示文字来源。');
  });
});
