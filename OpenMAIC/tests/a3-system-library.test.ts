import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('A3 platform-managed system resource library', () => {
  it('owns independent list and detail routes under AI learning navigation', () => {
    expect(existsSync(join(process.cwd(), 'app/a3/library/page.tsx'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'app/a3/library/[resourceCode]/page.tsx'))).toBe(true);
    const navigation = source('lib/a3/navigation.ts');
    expect(navigation).toContain("href: '/a3/library'");
    expect(navigation).toContain("label: '系统资料'");
    expect(navigation).toContain("{ prefix: '/a3/library', owner: '/a3/classroom' }");
  });

  it('loads real library data with search and type and difficulty filters', () => {
    const view = source('components/a3/features/system-library-view.tsx');
    expect(view).toContain("a3GetJson<A3SystemLibraryResponse>");
    expect(view).toContain("'/api/kb/library/'");
    expect(view).toContain('data-testid="a3-system-library-view"');
    expect(view).toContain('data-testid="a3-system-library-filters"');
    expect(view).toContain('type');
    expect(view).toContain('difficulty');
    expect(view).toContain('当前筛选下没有可用资料');
    expect(view).toContain('资料加载失败');
  });

  it('shows explainable recommendation evidence and never renders storage paths', () => {
    const view = source('components/a3/features/system-library-view.tsx');
    expect(view).toContain('personalization.reason');
    expect(view).toContain('matchedKnowledgePoints');
    expect(view).toContain('estimatedMinutes');
    expect(view).toContain('completionCriteria');
    expect(view).not.toContain('storedPath');
    expect(view).not.toContain('stored_path');
  });

  it('tracks open favorite skip and completion behaviors from the detail page', () => {
    const detail = source('components/a3/features/system-resource-detail-view.tsx');
    expect(detail).toContain("targetType: 'curated_resource'");
    expect(detail).toContain("eventType: 'resource_opened'");
    expect(detail).toContain("record('resource_favorited'");
    expect(detail).toContain("record('resource_skipped'");
    expect(detail).toContain("record('resource_completed'");
    expect(detail).toContain('<A3Markdown');
    expect(detail).toContain('没有字幕或转写证据时，不作为回答引用');
  });

  it('surfaces personalized system resources on the existing recommendation page', () => {
    const recommendations = source('components/a3/features/recommendations-view.tsx');
    expect(recommendations).toContain("a3GetJson<A3SystemLibraryResponse>('/api/kb/library/?recommended=3')");
    expect(recommendations).toContain('data-testid="a3-curated-recommendations"');
    expect(recommendations).toContain('进入系统资料库');
  });
});
