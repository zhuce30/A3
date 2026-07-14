import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metadata } from '@/app/a3/page';
import {
  A3_HOMEPAGE_ACTIONS,
  A3_HOMEPAGE_FOOTER,
  A3_HOMEPAGE_HERO,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_STORY,
} from '@/components/a3/marketing/a3-homepage-content';

const root = process.cwd();
const marketingDir = path.join(root, 'components/a3/marketing');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const homepageSource = read('components/a3/marketing/a3-product-homepage.tsx');
const heroSource = read('components/a3/marketing/a3-homepage-hero.tsx');
const storySource = read('components/a3/marketing/a3-homepage-story.tsx');
const contentSource = read('components/a3/marketing/a3-homepage-content.ts');
const cssSource = read('components/a3/marketing/a3-product-homepage.module.css');
const rootLayoutSource = read('app/layout.tsx');
const authGateSource = read('components/a3/auth/a3-auth-gate.tsx');
const providerSource = read('components/server-providers-init.tsx');
const accessGuardSource = read('components/access-code-guard.tsx');

describe('A3 launch-ready homepage information architecture', () => {
  it('leads with the product name and a literal learning-loop promise', () => {
    expect(A3_HOMEPAGE_HERO.titleLines.join('')).toContain('智学引擎');
    expect(A3_HOMEPAGE_HERO.support).toContain('诊断');
    expect(A3_HOMEPAGE_HERO.support).toContain('复习');
    expect(A3_HOMEPAGE_HERO.cta).toBe('开始体验');
    expect(A3_HOMEPAGE_HERO.secondaryCta).toEqual({
      href: '#daily-learning',
      label: '查看完整学习闭环',
    });
  });

  it('moves through daily learning, evidence, practice, feedback and teacher intervention', () => {
    const ids = A3_HOMEPAGE_STORY.map((item) => item.id);

    expect(ids).toEqual([
      'today',
      'profile',
      'diagnostic',
      'knowledge',
      'resources',
      'classroom',
      'coaching',
      'assessment-review',
      'progress-refresh',
      'teacher',
    ]);
    expect(contentSource).toContain("media: '/a3/assets/homepage/today-plan.webp'");
    expect(contentSource).toContain("media: '/a3/assets/homepage/assessment-review.webp'");
    expect(contentSource).toContain("media: '/a3/assets/homepage/progress-refresh.webp'");
  });

  it('uses product language rather than competition or review language', () => {
    expect(A3_HOMEPAGE_NAV.map((item) => item.label)).toEqual([
      '学习闭环',
      '真实产品',
      '可信依据',
      '教师端',
    ]);
    expect(JSON.stringify(A3_HOMEPAGE_ACTIONS)).not.toMatch(/评审|比赛/);
    expect(JSON.stringify(A3_HOMEPAGE_FOOTER)).not.toMatch(/评审|比赛|qq\.com/i);
    expect(A3_HOMEPAGE_FOOTER).toEqual({
      product: '智学引擎',
      contactLabel: '产品帮助中心',
      copyright: '智学引擎产品团队',
    });
  });

  it('ships all three new anonymized real-interface images', () => {
    for (const filename of ['today-plan.webp', 'assessment-review.webp', 'progress-refresh.webp']) {
      const file = path.join(root, 'public/a3/assets/homepage', filename);
      expect(fs.existsSync(file), filename).toBe(true);
      if (fs.existsSync(file)) expect(fs.statSync(file).size, filename).toBeGreaterThan(10_000);
    }
  });
});

describe('A3 launch-ready homepage server and performance boundary', () => {
  it('keeps the homepage, hero and story as server components', () => {
    expect(homepageSource).not.toMatch(/^['"]use client['"]/);
    expect(heroSource).not.toMatch(/^['"]use client['"]/);
    expect(storySource).not.toMatch(/^['"]use client['"]/);
    expect(fs.existsSync(path.join(marketingDir, 'a3-homepage-mobile-nav.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(marketingDir, 'a3-homepage-classroom-island.tsx'))).toBe(true);
  });

  it('does not make the decorative hero stage a keyboard stop', () => {
    expect(heroSource).not.toContain('tabIndex={0}');
    expect(heroSource).not.toContain('motion.div');
  });

  it('disables prefetch for below-fold authenticated product routes', () => {
    expect(homepageSource).toMatch(
      /href=\{A3_HOMEPAGE_ROUTES\.workspace\}[\s\S]{0,100}prefetch=\{false\}/,
    );
    expect(storySource).toMatch(/href: '\/a3\/teacher'[\s\S]{0,100}prefetch: false/);
    expect(storySource).toMatch(/href="\/a3\/coaching"[\s\S]{0,100}prefetch=\{false\}/);
  });

  it('skips anonymous auth, provider and access-code requests on the public homepage', () => {
    expect(authGateSource).toMatch(/if \(isPublicPath\)[\s\S]{0,180}return/);
    expect(providerSource).toContain("pathname === '/a3'");
    expect(accessGuardSource).toContain("pathname === '/a3'");
  });

  it('keeps global font families available without preloading them on the public homepage', () => {
    expect(rootLayoutSource.match(/preload:\s*false/g)).toHaveLength(3);
    expect(rootLayoutSource).toContain("variable: '--font-sans'");
    expect(rootLayoutSource).toContain("variable: '--font-geist-sans'");
    expect(rootLayoutSource).toContain("variable: '--font-geist-mono'");
  });
});

describe('A3 launch-ready homepage SEO and accessibility boundary', () => {
  it('publishes complete share and canonical metadata', () => {
    expect(metadata).toMatchObject({
      title: expect.stringContaining('智学引擎'),
      alternates: { canonical: '/a3' },
      openGraph: {
        title: expect.stringContaining('智学引擎'),
        type: 'website',
        url: '/a3',
        images: [
          expect.objectContaining({
            url: '/a3/assets/homepage/today-plan.webp',
            width: 1129,
            height: 900,
          }),
        ],
      },
      twitter: { card: 'summary_large_image' },
    });
  });

  it('publishes Chinese HTML, robots, sitemap and a manifest', () => {
    expect(rootLayoutSource).toContain('<html lang="zh-CN"');
    for (const file of ['app/robots.ts', 'app/sitemap.ts', 'app/manifest.ts']) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it('provides a skip link, a stable main target and touch-sized controls', () => {
    expect(homepageSource).toContain('href="#main-content"');
    expect(homepageSource).toContain('id="main-content"');
    expect(cssSource).toMatch(/\.skipLink\s*\{/);
    expect(cssSource).toMatch(/\.menuButton\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
    expect(cssSource).toMatch(/\.headerCta\s*\{[^}]*min-height:\s*44px;/);
    expect(cssSource).toMatch(/\.segmentedControl button\s*\{[^}]*min-height:\s*44px;/);
  });

  it('outputs public-safe structured data without fake ratings or prices', () => {
    expect(homepageSource).toContain('application/ld+json');
    expect(homepageSource).toContain('SoftwareApplication');
    expect(homepageSource).not.toMatch(/aggregateRating|ratingValue|offers|price/);
  });
});
