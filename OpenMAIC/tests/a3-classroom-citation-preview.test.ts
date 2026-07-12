import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = path.resolve(process.cwd(), 'app/a3/classroom/page.tsx');
const redesignPath = path.resolve(process.cwd(), 'components/a3/features/classroom-view-redesign.tsx');

describe('A3 classroom citation previews', () => {
  it('checks the routed redesigned classroom instead of the inactive legacy view', () => {
    const page = fs.readFileSync(pagePath, 'utf8');
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(page).toContain('ClassroomViewRedesign');
    expect(page).toContain('classroom-view-redesign');
    expect(source).toContain('export function ClassroomViewRedesign');
    expect(source).toContain('groupClaimsByCitation');
    expect(source).toContain('function EvidenceGallery');
  });

  it('renders mapped PPT evidence with previews, thumbnails, claims, and fallbacks', () => {
    const source = fs.readFileSync(redesignPath, 'utf8');

    expect(source).toContain('data-testid="a3-classroom-claim-citation-map"');
    expect(source).toContain('data-testid="a3-classroom-evidence-thumbnail"');
    expect(source).toContain('data-testid="a3-classroom-citation-preview"');
    expect(source).toContain('data-testid="a3-classroom-citation-preview-link"');
    expect(source).toContain('resolveA3Endpoint(previewUrl)');
    expect(source).toContain('object-contain');
    expect(source).toContain('previewAvailable');
    expect(source).toContain('activeGroup.citation.previewUrl ? (');
    expect(source).toContain('claimsWithMapping.length > 0');
    expect(source).toContain('citations.length > 0 && claimsWithMapping.length === 0');
    expect(source).toContain('aria-pressed={selected}');
  });
});
