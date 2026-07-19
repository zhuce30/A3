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
