import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  A3_GLOBAL_SEARCH_ROUTES,
  buildA3GlobalSearchResults,
  mapA3KnowledgeSearchResults,
} from '@/lib/a3/global-search';

const root = process.cwd();
const shellSource = readFileSync(join(root, 'components/a3/layout/a3-shell.tsx'), 'utf8');
const globalSearchSource = readFileSync(join(root, 'components/a3/layout/a3-global-search.tsx'), 'utf8');
const knowledgeBaseSource = readFileSync(join(root, 'components/a3/features/knowledge-base-view.tsx'), 'utf8');

describe('A3 global search', () => {
  it('exposes searchable product routes instead of a decorative header placeholder', () => {
    expect(A3_GLOBAL_SEARCH_ROUTES.map((item) => item.href)).toEqual(
      expect.arrayContaining([
        '/a3/today',
        '/a3/study-plan',
        '/a3/learning-path',
        '/a3/courses',
        '/a3/knowledge-base',
        '/a3/knowledge-graph',
        '/a3/recommendations',
        '/a3/classroom',
        '/a3/assessment',
        '/a3/wrong-notebook',
        '/a3/report',
      ]),
    );

    const results = buildA3GlobalSearchResults('错题 复习');
    expect(results.map((item) => item.href)).toContain('/a3/wrong-notebook');
    expect(results.every((item) => item.type === 'route')).toBe(true);
  });

  it('maps real knowledge-base search results into global search rows', () => {
    const rows = mapA3KnowledgeSearchResults('根轨迹', [
      {
        score: 0.88,
        text: '根轨迹用于分析闭环极点随增益变化的轨迹。',
        resourceName: '自动控制原理课件.pptx',
        metadata: { page: 12 },
      },
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        type: 'knowledge',
        title: '自动控制原理课件.pptx',
        href: '/a3/knowledge-base?query=%E6%A0%B9%E8%BD%A8%E8%BF%B9',
        sourceLabel: '知识库来源',
      }),
    ]);
    expect(rows[0].description).toContain('根轨迹用于分析闭环极点');
  });

  it('renders the shell search as an interactive component backed by the knowledge-base API', () => {
    expect(shellSource).toContain('A3GlobalSearch');
    expect(shellSource).not.toContain('{messages.searchPlaceholder}');

    expect(globalSearchSource).toContain('data-testid="a3-global-search-input"');
    expect(globalSearchSource).toContain('data-testid="a3-global-search-results"');
    expect(globalSearchSource).toContain('/api/kb/search/');
    expect(globalSearchSource).toContain('buildA3GlobalSearchResults');
  });

  it('lets knowledge-base result links replay the query on the knowledge-base page', () => {
    expect(knowledgeBaseSource).toContain('useSearchParams');
    expect(knowledgeBaseSource).toContain("searchParams.get('query')");
    expect(knowledgeBaseSource).toContain('searchKnowledge(initialSearchQuery)');
  });
});
