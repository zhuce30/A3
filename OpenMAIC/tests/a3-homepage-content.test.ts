import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { metadata } from '@/app/a3/page';
import {
  A3_HOMEPAGE_EVIDENCE,
  A3_HOMEPAGE_FOOTER,
  A3_HOMEPAGE_HERO_MEDIA,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_RESOURCE_TYPES,
  A3_HOMEPAGE_STORY,
} from '@/components/a3/marketing/a3-homepage-content';
import { A3HomepageHero } from '@/components/a3/marketing/a3-homepage-hero';
import * as storyModule from '@/components/a3/marketing/a3-homepage-story';
import * as teacherModule from '@/components/a3/marketing/a3-homepage-teacher-stage';
import { A3ProductHomepage } from '@/components/a3/marketing/a3-product-homepage';

const assetDir = path.resolve(process.cwd(), 'public/a3/assets/homepage');
const expectedAssets = [
  'today-plan.webp',
  'profile.webp',
  'diagnostic.webp',
  'knowledge-base.webp',
  'multimodal-resources.webp',
  'classroom.webp',
  'assessment-review.webp',
  'progress-refresh.webp',
  'teacher-workbench.webp',
  'teacher-fallback.webp',
];

const marketingDir = path.resolve(process.cwd(), 'components/a3/marketing');
const homepageSource = fs.readFileSync(path.join(marketingDir, 'a3-product-homepage.tsx'), 'utf8');
const storySource = fs.readFileSync(path.join(marketingDir, 'a3-homepage-story.tsx'), 'utf8');
const mobileNavSource = fs.readFileSync(
  path.join(marketingDir, 'a3-homepage-mobile-nav.tsx'),
  'utf8',
);
const classroomIslandSource = fs.readFileSync(
  path.join(marketingDir, 'a3-homepage-classroom-island.tsx'),
  'utf8',
);
const resourceShowcaseSource = fs.readFileSync(
  path.join(marketingDir, 'a3-homepage-resource-showcase.tsx'),
  'utf8',
);
const teacherSource = fs.readFileSync(
  path.join(marketingDir, 'a3-homepage-teacher-stage.tsx'),
  'utf8',
);
const homepageCss = fs.readFileSync(
  path.join(marketingDir, 'a3-product-homepage.module.css'),
  'utf8',
);
const captureSource = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/capture-a3-homepage-assets.mjs'),
  'utf8',
);
const teacherWorkbenchSource = fs.readFileSync(
  path.resolve(process.cwd(), 'components/a3/features/teacher-workbench-view.tsx'),
  'utf8',
);

const teacherApi = teacherModule as typeof teacherModule & {
  A3_HOMEPAGE_TEACHER_ROOT_MARGIN?: string;
  A3_HOMEPAGE_TEACHER_STABILITY_MS?: number;
  A3_HOMEPAGE_TEACHER_DEMO_PROPS?: {
    state: string;
    mode: string;
    audioLevel: number;
    assistantSpeaking: boolean;
  };
  shouldActivateTeacherStage?: (
    entry: Pick<IntersectionObserverEntry, 'isIntersecting'>,
  ) => boolean;
  isTerminalTeacherRenderer?: (renderer: string | null) => boolean;
  shouldDismissTeacherFallback?: (
    rendererReady: boolean,
    trigger: 'transition_end' | 'transition_cancel' | 'timeout',
  ) => boolean;
  deriveTeacherHandoffState?: (renderer: string | null) => {
    fallbackRequired: boolean;
    rendererReady: boolean;
  };
};

describe('A3 product homepage learning story modules', () => {
  it('provides dedicated story and lazy teacher-stage modules', () => {
    expect(fs.existsSync(path.join(marketingDir, 'a3-homepage-story.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(marketingDir, 'a3-homepage-teacher-stage.tsx'))).toBe(true);
  });

  it('renders the approved story sequence, anchors and real routes in the homepage', () => {
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));
    const orderedIds = [
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
      'evidence',
    ];
    const positions = orderedIds.map((id) => markup.indexOf(`data-testid="a3-homepage-${id}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const anchor of [
      'capabilities',
      'daily-learning',
      'learning-loop',
      'product-evidence',
      'evidence',
      'teacher',
      'contact',
    ]) {
      expect(markup).toContain(`id="${anchor}"`);
    }
    expect(markup).toContain('href="/a3/coaching"');
    expect(markup).toContain('href="/a3/teacher"');
    expect(markup).toContain('href="/a3/register"');
  });

  it('keeps product screenshots complete and the page horizontally contained', () => {
    expect(homepageCss).toMatch(/\.fullProductFrame\s*\{[^}]*aspect-ratio:/);
    expect(homepageCss).toMatch(/\.fullProductFrame img\s*\{[^}]*object-fit:\s*contain/);
    expect(homepageCss).toMatch(/\.page\s*\{[^}]*overflow-x:\s*clip/);
    expect(homepageCss).not.toMatch(/font-size:\s*[^;]*(vw|cqw)/);
  });

  it('defines scoped responsive and reduced-motion resilience contracts', () => {
    const mobileCss = homepageCss
      .split('@media (max-width: 767px)')[1]
      ?.split('@media (max-width: 390px)')[0];

    expect(mobileCss).toBeDefined();
    expect(homepageCss).not.toContain('112vw');
    expect(homepageCss).toMatch(/@media \(max-width: 767px\)/);
    expect(homepageCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(homepageCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.page\s*\{[\s\S]*?scroll-behavior:\s*auto/,
    );
    expect(homepageCss).not.toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\*::?(?:before|after)?\s*\{/,
    );
    expect(homepageCss).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.fullProductFrame\s*\{[\s\S]*?aspect-ratio:\s*4\s*\/\s*3/,
    );
    expect(mobileCss).not.toMatch(/translateX|translate3d/);
    expect(homepageCss).toMatch(/\.page a:focus-visible/);
    expect(homepageCss).toMatch(/\.page button:focus-visible/);
    expect(homepageCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.page \.heroScreen\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*translate3d\(0, -50%, 0\)/,
    );
  });

  it('shows the knowledge base as the source-to-learning visual center', () => {
    const Story = storyModule.A3HomepageStory;
    const markup = renderToStaticMarkup(createElement(Story));

    expect(markup).toContain('aria-label="知识库学习依据流向"');
    for (const label of [
      '操作系统课本',
      '课程 PPT',
      '知识总结',
      '本地知识库',
      '课堂',
      '引用',
      '学习计划',
    ]) {
      expect(markup).toContain(label);
    }
    expect(storySource).not.toContain('<svg');
  });

  it('renders the seven real resource types between knowledge and classroom', () => {
    const markup = renderToStaticMarkup(createElement(storyModule.A3HomepageStory));
    const resourcesStart = markup.indexOf('data-testid="a3-homepage-resources"');
    const classroomStart = markup.indexOf('data-testid="a3-homepage-classroom"');

    expect(resourcesStart).toBeGreaterThan(-1);
    expect(classroomStart).toBeGreaterThan(resourcesStart);
    expect(markup).toContain('aria-label="多模态资源类型"');
    expect(markup).toContain('alt="个性化多模态资源包界面"');
    expect(markup).toContain('href="/a3/recommendations"');
    for (const resource of A3_HOMEPAGE_RESOURCE_TYPES) {
      expect(markup).toContain(resource.label);
      expect(markup).toContain(resource.use);
    }
    expect(resourceShowcaseSource).not.toContain('/api/resources/generate/');
    expect(resourceShowcaseSource).not.toContain('a3PostJson');
  });

  it('changes the read-only classroom presentation without calling a product API', () => {
    expect(classroomIslandSource).toContain("useState<ClassroomMode>('lesson')");
    expect(classroomIslandSource).toContain("setMode('citations')");
    expect(classroomIslandSource).toContain("aria-pressed={mode === 'lesson'}");
    expect(classroomIslandSource).toContain('操作系统 / 第 3 章 / 课程 PPT');
    expect(classroomIslandSource).toContain('进程调度 / 知识总结');
    expect(classroomIslandSource).not.toContain('a3PostJson');
    expect(classroomIslandSource).not.toContain('/api/resources/generate/');
    expect(storySource).not.toContain('a3PostJson');
    expect(storySource).not.toContain('/api/resources/generate/');
  });

  it('activates the silent local teacher only when the stage approaches the viewport', () => {
    expect(teacherApi.A3_HOMEPAGE_TEACHER_ROOT_MARGIN).toBe('160px');
    expect(teacherApi.shouldActivateTeacherStage).toBeTypeOf('function');
    expect(teacherApi.shouldActivateTeacherStage?.({ isIntersecting: false })).toBe(false);
    expect(teacherApi.shouldActivateTeacherStage?.({ isIntersecting: true })).toBe(true);
    expect(teacherApi.A3_HOMEPAGE_TEACHER_DEMO_PROPS).toMatchObject({
      state: 'listening',
      mode: 'local_vrm',
      audioLevel: 0,
      assistantSpeaking: false,
    });
    expect(teacherSource).toContain('IntersectionObserver');
    expect(teacherSource).not.toContain("from 'next/dynamic'");
    expect(teacherSource).toContain(
      "import { DigitalHumanAvatar } from '@/components/a3/features/coaching/digital-human-avatar'",
    );
  });

  it('keeps the real teacher fallback above loading until a terminal renderer is ready', () => {
    expect(teacherApi.isTerminalTeacherRenderer).toBeTypeOf('function');
    for (const renderer of ['vrm', 'vrm_idle_animation', 'primitive', 'static_fallback']) {
      expect(teacherApi.isTerminalTeacherRenderer?.(renderer), renderer).toBe(true);
    }
    expect(teacherApi.isTerminalTeacherRenderer?.('loading')).toBe(false);
    expect(teacherApi.isTerminalTeacherRenderer?.(null)).toBe(false);
    expect(teacherSource).toContain('MutationObserver');
    expect(teacherSource).toContain('mutationObserver.disconnect()');
    expect(teacherSource).toContain('data-testid="a3-homepage-teacher-fallback"');
  });

  it('removes a hidden fallback on transition cancel or the safety timeout', () => {
    expect(teacherApi.shouldDismissTeacherFallback).toBeTypeOf('function');
    expect(teacherApi.shouldDismissTeacherFallback?.(false, 'transition_cancel')).toBe(false);
    expect(teacherApi.shouldDismissTeacherFallback?.(true, 'transition_cancel')).toBe(true);
    expect(teacherApi.shouldDismissTeacherFallback?.(true, 'timeout')).toBe(true);
    expect(teacherSource).toContain('onTransitionCancel');
    expect(teacherSource).toContain('window.setTimeout');
    expect(teacherSource).toContain('350');
    expect(teacherSource).toContain('window.clearTimeout(timeoutId)');
    expect(teacherSource).toContain('aria-hidden={rendererReady && !preserveFallback}');
    expect(homepageCss).toMatch(/\.teacherFallbackHidden\s*\{[^}]*pointer-events:\s*none/);
    expect(homepageCss).toMatch(
      /\.teacherFallbackHidden\s*\{[^}]*transition:\s*opacity 220ms ease/,
    );
  });

  it('restores the fallback if a renderer returns to loading during handoff', () => {
    expect(teacherApi.A3_HOMEPAGE_TEACHER_STABILITY_MS).toBe(120);
    expect(teacherApi.deriveTeacherHandoffState).toBeTypeOf('function');
    expect(teacherApi.deriveTeacherHandoffState?.('primitive')).toEqual({
      fallbackRequired: true,
      rendererReady: true,
    });
    expect(teacherApi.deriveTeacherHandoffState?.('loading')).toEqual({
      fallbackRequired: true,
      rendererReady: false,
    });
    expect(teacherApi.deriveTeacherHandoffState?.(null)).toEqual({
      fallbackRequired: true,
      rendererReady: false,
    });
  });

  it('server-renders a useful teacher fallback before the lazy renderer activates', () => {
    const markup = renderToStaticMarkup(createElement(teacherModule.A3HomepageTeacherStage));

    expect(markup).toContain('%2Fa3%2Fassets%2Fhomepage%2Fteacher-fallback.webp');
    expect(markup).not.toContain('<link rel="preload" as="image"');
    expect(markup).toContain('loading="lazy"');
    expect(teacherSource).not.toMatch(/teacher-fallback\.webp[\s\S]{0,240}\bpriority\b/);
    expect(markup).toContain('正在倾听：进程调度为什么会发生饥饿？');
    expect(markup).toContain('href="/a3/coaching"');
    expect(markup).toContain('data-testid="a3-homepage-teacher-stage"');
    expect(markup).toContain('data-demo-phase="static"');
  });

  it('captures a real anonymous teacher intervention region for homepage evidence', () => {
    expect(teacherWorkbenchSource).toContain('data-testid="a3-teacher-homepage-evidence"');
    expect(teacherWorkbenchSource).toContain('data-testid="a3-teacher-weak-point-row"');
    expect(teacherWorkbenchSource).toContain('data-testid="a3-teacher-task-row"');
    expect(teacherWorkbenchSource).toContain('data-testid="a3-teacher-weak-points-empty"');
    expect(teacherWorkbenchSource).toContain('data-testid="a3-teacher-tasks-empty"');
    expect(captureSource).toContain("testId: 'a3-teacher-homepage-evidence'");
    expect(captureSource).toContain("getByTestId('a3-teacher-weak-point-row')");
    expect(captureSource).toContain("getByTestId('a3-teacher-task-row')");
    expect(captureSource).toContain('validateTeacherEvidenceText');
    expect(captureSource).not.toContain("focusHeading: '班级学情概览'");
  });

  it('captures a real resource-pack result through the read-only homepage pipeline', () => {
    expect(captureSource).toContain("filename: 'multimodal-resources.webp'");
    expect(captureSource).toContain("route: '/a3/resources/latest'");
    expect(captureSource).toContain("testId: 'a3-resource-pack-detail'");
    expect(captureSource).toContain("focusTestId: 'a3-resource-pack-detail-resource'");
    expect(captureSource).toContain("getByTestId('a3-resource-pack-detail-resource')");
    expect(captureSource).toContain("'multimodal-resources.webp'");
  });

  it('validates the current login form before capture instead of a removed preview marker', () => {
    expect(captureSource).toContain("getByLabel('账号')");
    expect(captureSource).toContain('input[autocomplete="current-password"]');
    expect(captureSource).not.toContain('a3-login-learning-preview');
  });

  it('uses dated reproducible evidence and keeps product details in the footer', () => {
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));
    const footerStart = markup.indexOf('<footer');

    expect(storySource).toContain('A3_HOMEPAGE_EVIDENCE.map');
    expect(markup).toContain('2026-07-14 的工程回归快照');
    for (const value of A3_HOMEPAGE_EVIDENCE.map((item) => item.value)) {
      expect(markup.match(new RegExp(value, 'g'))).toHaveLength(1);
    }
    expect(markup.indexOf(A3_HOMEPAGE_FOOTER.product, footerStart)).toBeGreaterThan(footerStart);
    expect(markup.indexOf(A3_HOMEPAGE_FOOTER.copyright)).toBeGreaterThan(footerStart);
    expect(markup).toContain('href="/a3/help"');
    expect(markup).not.toMatch(/评审体验|比赛：|qq\.com/i);
  });

  it('keeps private implementation details and capture APIs out of the public story', () => {
    const combined = `${homepageSource}\n${storySource}\n${resourceShowcaseSource}\n${teacherSource}`;

    expect(combined).not.toContain('OpenMAIC');
    expect(combined).not.toMatch(/[A-Z]:\\\\/);
    expect(combined).not.toContain('signedUrl');
    expect(combined).not.toMatch(
      /getUserMedia|mediaDevices|AudioContext|webkitAudioContext|new Audio\(|<audio/i,
    );
  });

  it('keeps below-fold story media non-priority and offsets anchor targets below the header', () => {
    expect(storySource).not.toContain('priority');
    expect(homepageCss).toMatch(/scroll-margin-top:\s*88px/);
    expect(homepageCss).toMatch(/scroll-margin-top:\s*76px/);
  });

  it('contains the portrait fallback on a stable neutral stage', () => {
    expect(homepageCss).toMatch(/\.teacherFallback img\s*\{[^}]*object-fit:\s*contain/);
    expect(homepageCss).toMatch(/\.teacherVisual\s*\{[^}]*background:\s*#151a1d/);
  });
});

describe('A3 product homepage assets', () => {
  it('ships every real product image used by the homepage', () => {
    for (const filename of expectedAssets) {
      const file = path.join(assetDir, filename);
      expect(fs.existsSync(file), filename).toBe(true);
      expect(fs.statSync(file).size, filename).toBeGreaterThan(10_000);
    }
  });

  it('ships decodable, reasonably sized, nonblank WebP images', async () => {
    for (const filename of expectedAssets) {
      const file = path.join(assetDir, filename);
      expect(fs.existsSync(file), filename).toBe(true);
      if (!fs.existsSync(file)) continue;

      const image = sharp(file);
      const metadata = await image.metadata();
      const stats = await image.stats();

      expect(metadata.format, filename).toBe('webp');
      expect(metadata.width, filename).toBeGreaterThanOrEqual(640);
      expect(metadata.height, filename).toBeGreaterThanOrEqual(360);
      expect(
        stats.channels.some((channel) => channel.max - channel.min > 24),
        filename,
      ).toBe(true);
    }
  });

  it('does not publish source documents or local path metadata', () => {
    expect(fs.existsSync(assetDir)).toBe(true);
    if (!fs.existsSync(assetDir)) return;

    const published = fs.readdirSync(assetDir);
    expect(published.some((name) => /\.(pdf|pptx?|json|txt)$/i.test(name))).toBe(false);
  });
});

describe('A3 product homepage content contract', () => {
  it('publishes every canonical multimodal resource type in backend order', () => {
    expect(A3_HOMEPAGE_RESOURCE_TYPES.map((item) => item.type)).toEqual([
      'lecture_doc',
      'knowledge_card',
      'mind_map',
      'practice_set',
      'case_study',
      'code_lab',
      'micro_video_script',
    ]);
    expect(A3_HOMEPAGE_RESOURCE_TYPES.map((item) => item.label)).toEqual([
      '课程讲解文档',
      '知识点速记卡',
      '知识点思维导图',
      '专项练习题',
      '工程实践案例',
      '代码类实操案例',
      '短视频/动画脚本',
    ]);
  });

  it('uses the exact approved navigation labels and anchors', () => {
    expect(A3_HOMEPAGE_NAV).toEqual([
      { label: '学习闭环', href: '#daily-learning' },
      { label: '真实产品', href: '#product-evidence' },
      { label: '可信依据', href: '#evidence' },
      { label: '教师端', href: '#teacher' },
    ]);
  });

  it('uses the four approved real product screens in the hero', () => {
    expect(A3_HOMEPAGE_HERO_MEDIA).toEqual([
      { src: '/a3/assets/homepage/today-plan.webp', alt: '今日任务与学习计划界面' },
      { src: '/a3/assets/homepage/diagnostic.webp', alt: '入学诊断界面' },
      { src: '/a3/assets/homepage/assessment-review.webp', alt: '测评与错题复习界面' },
      { src: '/a3/assets/homepage/progress-refresh.webp', alt: '学习报告与计划刷新界面' },
    ]);
  });

  it('keeps the complete learning loop in order', () => {
    expect(A3_HOMEPAGE_STORY.map((item) => item.id)).toEqual([
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
    expect(A3_HOMEPAGE_STORY.every((item) => item.media.endsWith('.webp'))).toBe(true);
  });

  it('uses dated and scoped reproducible evidence', () => {
    expect(A3_HOMEPAGE_EVIDENCE.map((item) => item.value)).toEqual([
      '53 条用例',
      '18 条流程',
      '六类资源',
    ]);
    expect(A3_HOMEPAGE_EVIDENCE.every((item) => item.detail.length > 12)).toBe(true);
  });

  it('keeps formal product and help details in the footer model', () => {
    expect(A3_HOMEPAGE_FOOTER).toEqual({
      product: '智学引擎',
      contactLabel: '产品帮助中心',
      copyright: '智学引擎产品团队',
    });
  });

  it('keeps competition and platform implementation names out of the hero and story', () => {
    const heroMarkup = renderToStaticMarkup(createElement(A3HomepageHero));
    const publicStory = JSON.stringify(A3_HOMEPAGE_STORY);

    for (const privateCopy of ['评审体验', '比赛：', 'OpenMAIC', 'qq.com']) {
      expect(heroMarkup).not.toContain(privateCopy);
      expect(publicStory).not.toContain(privateCopy);
    }
  });
});

describe('A3 product homepage hero and navigation', () => {
  it('renders the launch-ready hero message and two clear journey actions', () => {
    const markup = renderToStaticMarkup(createElement(A3HomepageHero));

    expect(markup).toContain('<span>智学引擎</span>');
    expect(markup).toContain('<span>把每一次学习，接到下一步。</span>');
    expect(markup).toContain('从诊断、今日计划到课堂、测评和错题复习');
    expect(markup).toContain('href="/a3/register"');
    expect(markup).toContain('href="#daily-learning"');
    expect(markup.match(/开始体验/g)).toHaveLength(1);
  });

  it('requests a contained image width for the mobile hero composition', () => {
    const markup = renderToStaticMarkup(createElement(A3HomepageHero));

    expect(markup).toContain(
      'sizes="(max-width: 767px) calc(100vw - 62px), (min-width: 1600px) 920px, 68vw"',
    );
    expect(markup).not.toContain('112vw');
  });

  it('renders stable login, workspace and registration routes without an auth fetch', () => {
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));

    expect(markup).toContain('data-testid="a3-product-homepage"');
    expect(markup).toContain('href="/a3/login"');
    expect(markup).toContain('href="/a3/dashboard"');
    expect(markup).toContain('href="/a3/register"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('进入学习区');
    expect(markup).not.toContain('评审体验');
  });

  it('binds mobile navigation focus, escape and background-scroll behavior in its island', () => {
    expect(mobileNavSource).toContain('aria-expanded={open}');
    expect(mobileNavSource).toContain("aria-label={open ? '关闭导航' : '打开导航'}");
    expect(mobileNavSource).toContain("event.key !== 'Escape'");
    expect(mobileNavSource).toContain("document.body.style.overflow = 'hidden'");
    expect(mobileNavSource).toContain("querySelector<HTMLElement>('a')?.focus()");
    expect(mobileNavSource).toContain(
      "querySelector<HTMLElement>('[data-homepage-brand]')?.focus()",
    );
  });

  it('cancels the pending mobile-menu focus frame on cleanup', () => {
    expect(mobileNavSource).toContain('window.cancelAnimationFrame(frame)');
    expect(mobileNavSource).toContain("window.removeEventListener('keydown', handleKeyDown)");
    expect(mobileNavSource).toContain('document.body.style.overflow = previousOverflow');
  });

  it('publishes the approved page metadata', () => {
    expect(metadata).toMatchObject({
      title: '智学引擎',
      alternates: { canonical: '/a3' },
      openGraph: { type: 'website', url: '/a3' },
      twitter: { card: 'summary_large_image' },
    });
  });
});
