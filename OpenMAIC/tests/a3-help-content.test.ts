import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  a3HelpArticles,
  a3HelpCategories,
  getA3HelpArticle,
  getA3HelpArticleHref,
  searchA3HelpArticles,
} from '@/lib/a3/help-content';

describe('A3 help content contract', () => {
  it('covers the ten approved user-manual categories', () => {
    expect(a3HelpCategories.map((category) => category.id)).toEqual([
      'quick-start',
      'account-profile',
      'today-plan',
      'ai-learning',
      'resources-favorites',
      'assessment-review',
      'report-notifications',
      'teacher',
      'knowledge-base',
      'troubleshooting',
    ]);
  });

  it('publishes structured articles with safe real workflow actions', () => {
    expect(a3HelpArticles.length).toBeGreaterThanOrEqual(12);
    for (const article of a3HelpArticles) {
      expect(article.sections.length, article.id).toBeGreaterThan(0);
      expect(article.estimatedMinutes, article.id).toBeGreaterThan(0);
      expect(article.updatedAt, article.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.audience.length, article.id).toBeGreaterThan(0);
      expect(article.action?.href ?? '/a3/help').toMatch(/^\/a3\//);
      expect(JSON.stringify(article), article.id).not.toMatch(/[A-Z]:\\/);
    }
  });

  it('finds articles by id and creates stable article routes', () => {
    expect(getA3HelpArticle('generate-personal-resources')?.tourId).toBe('resource-generation');
    expect(getA3HelpArticleHref('generate-personal-resources')).toBe(
      '/a3/help/generate-personal-resources',
    );
    expect(getA3HelpArticle('missing-article')).toBeNull();
  });

  it('searches titles, steps, keywords, and failure symptoms', () => {
    expect(searchA3HelpArticles('一直解析中', 'zh-CN').map((item) => item.id)).toContain(
      'knowledge-base-indexing',
    );
    expect(searchA3HelpArticles('生成个性化资源', 'zh-CN').map((item) => item.id)).toContain(
      'generate-personal-resources',
    );
    expect(searchA3HelpArticles('wrong notebook', 'en-US').map((item) => item.id)).toContain(
      'assessment-wrong-review',
    );
  });

  it('links the five approved first-use workflows to tours', () => {
    expect(
      a3HelpArticles.filter((article) => article.tourId).map((article) => article.tourId),
    ).toEqual(
      expect.arrayContaining([
        'profile-setup',
        'admission-diagnostic',
        'today-plan',
        'resource-generation',
        'knowledge-base-indexing',
      ]),
    );
  });
});

describe('A3 help center page boundary', () => {
  const viewSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/features/help-center-view.tsx'),
    'utf8',
  );
  const shellSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/layout/a3-shell.tsx'),
    'utf8',
  );
  const topActionsSource = fs.readFileSync(
    path.resolve(process.cwd(), 'components/a3/layout/a3-top-actions.tsx'),
    'utf8',
  );

  it('uses a task-first landing instead of dumping full article steps', () => {
    expect(viewSource).toContain('data-testid="a3-help-search"');
    expect(viewSource).toContain('data-testid="a3-help-quick-start"');
    expect(viewSource).toContain('getA3HelpArticleHref(article.id)');
    expect(viewSource).not.toContain('article.steps[locale].map');
  });

  it('offers a useful reset action when search has no results', () => {
    expect(viewSource).toContain('没有找到相关答案');
    expect(viewSource).toContain('查看全部帮助');
    expect(viewSource).toContain("setQuery('')");
  });

  it('keeps stable article entry points in the learning shell and top help search', () => {
    expect(shellSource).toContain('data-testid="a3-sidebar-help-link"');
    expect(shellSource).toContain('href="/a3/help"');
    expect(topActionsSource).toContain('getA3HelpArticleHref(article.id)');
  });
});
