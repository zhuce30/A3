import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeA3SystemResource } from '@/lib/a3/library-types';

function source(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('A3 platform-managed system resource library', () => {
  it('normalizes the legacy internal action during a rolling backend deployment', () => {
    const normalized = normalizeA3SystemResource({
      resourceCode: 'OS-LAB-003',
      deliveryMode: 'internal_document',
      action: {
        external: false,
        label: '站内阅读文档',
        href: '/api/kb/library/OS-LAB-003/content/',
      },
    });

    expect(normalized.action.external).toBe(false);
    if (normalized.action.external) throw new Error('Expected a document action');
    expect(normalized.action.preview.href).toBe('/api/kb/library/OS-LAB-003/preview/');
    expect(normalized.action.download.href).toBe('/api/kb/library/OS-LAB-003/content/');
  });

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

  it('keeps URL initialization independent from mutable filter state', () => {
    const view = source('components/a3/features/system-library-view.tsx');

    expect(view).toContain('void loadLibrary(resourceType, difficulty, query)');
    expect(view).not.toContain('onClick={() => void loadLibrary()}');
    expect(view).not.toContain('event.preventDefault(); void loadLibrary();');
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

  it('persists favorites while tracking open skip and completion behaviors from the detail page', () => {
    const detail = source('components/a3/features/system-resource-detail-view.tsx');
    expect(detail).toContain("targetType: 'curated_resource'");
    expect(detail).toContain("eventType: 'resource_opened'");
    expect(detail).toContain('saveResourceFavorite(buildSystemResourceFavorite(resource))');
    expect(detail).toContain("eventType: 'resource_favorited'");
    expect(detail).toContain("record('resource_skipped'");
    expect(detail).toContain("record('resource_completed'");
    expect(detail).toContain('<A3Markdown');
    expect(detail).toContain('没有字幕或转写证据时，不作为回答引用');
  });

  it('previews protected DOCX resources as PDF while retaining download and Markdown fallback', () => {
    const detail = source('components/a3/features/system-resource-detail-view.tsx');
    const types = source('lib/a3/library-types.ts');

    expect(types).toContain('preview: {');
    expect(types).toContain('download: {');
    expect(detail).toContain('在线预览');
    expect(detail).toContain('下载原文档');
    expect(detail).toContain('fetch(resolveA3Endpoint(resource.action.preview.href)');
    expect(detail).toContain("credentials: 'include'");
    expect(detail).toContain("contentType.includes('application/pdf')");
    expect(detail).toContain('URL.createObjectURL');
    expect(detail).toContain('URL.revokeObjectURL');
    expect(detail).toContain('data-testid="a3-docx-preview-loading"');
    expect(detail).toContain('data-testid="a3-docx-preview-error"');
    expect(detail).toContain('data-testid="a3-docx-preview-frame"');
    expect(detail).toContain('data-testid="a3-docx-preview-mobile-open"');
    expect(detail).toContain('data-testid="a3-docx-markdown-fallback"');
    expect(detail).toContain("recordDocumentAction('preview')");
    expect(detail).toContain("recordDocumentAction('download')");
    expect(detail).toContain('metadata: { action,');
    expect(detail).toContain("resource.deliveryMode === 'internal_document' && !resource.action.external ? (");
  });

  it('surfaces personalized system resources on the existing recommendation page', () => {
    const recommendations = source('components/a3/features/recommendations-view.tsx');
    expect(recommendations).toContain("a3GetJson<A3SystemLibraryResponse>('/api/kb/library/?recommended=3')");
    expect(recommendations).toContain('data-testid="a3-curated-recommendations"');
    expect(recommendations).toContain('进入系统资料库');
  });
});
