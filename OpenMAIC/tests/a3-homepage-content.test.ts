import fs from 'node:fs';
import path from 'node:path';
import { Children, createElement } from 'react';
import type { ButtonHTMLAttributes, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { metadata } from '@/app/a3/page';
import {
  A3_HOMEPAGE_EVIDENCE,
  A3_HOMEPAGE_FOOTER,
  A3_HOMEPAGE_HERO_MEDIA,
  A3_HOMEPAGE_NAV,
  A3_HOMEPAGE_STORY,
} from '@/components/a3/marketing/a3-homepage-content';
import { A3HomepageHero } from '@/components/a3/marketing/a3-homepage-hero';
import * as storyModule from '@/components/a3/marketing/a3-homepage-story';
import * as teacherModule from '@/components/a3/marketing/a3-homepage-teacher-stage';
import {
  A3ProductHomepage,
  cancelA3HomepageFocusFrame,
  scheduleA3HomepageFocusFrame,
} from '@/components/a3/marketing/a3-product-homepage';
import type { A3PublicUser } from '@/lib/a3/auth-types';

const authState = vi.hoisted(() => ({ user: null as A3PublicUser | null }));

vi.mock('@/components/a3/auth/a3-auth-gate', () => ({
  useA3CurrentUser: () => authState.user,
}));

const assetDir = path.resolve(process.cwd(), 'public/a3/assets/homepage');
const expectedAssets = [
  'profile.webp',
  'diagnostic.webp',
  'knowledge-base.webp',
  'classroom.webp',
  'teacher-workbench.webp',
  'teacher-fallback.webp',
];

const marketingDir = path.resolve(process.cwd(), 'components/a3/marketing');
const homepageSource = fs.readFileSync(path.join(marketingDir, 'a3-product-homepage.tsx'), 'utf8');
const storySource = fs.readFileSync(path.join(marketingDir, 'a3-homepage-story.tsx'), 'utf8');
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

type ClassroomMode = 'lesson' | 'citations';
type ClassroomControlProps = {
  mode: ClassroomMode;
  onChange: (mode: ClassroomMode) => void;
};
type ClassroomControlElement = ReactElement<{
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>[];
}>;

const storyApi = storyModule as typeof storyModule & {
  A3ClassroomModeControl?: (props: ClassroomControlProps) => ClassroomControlElement;
  A3ClassroomModeDetails?: (props: { mode: ClassroomMode }) => ReactElement;
};
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
    authState.user = null;
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));
    const orderedIds = [
      'profile',
      'diagnostic',
      'knowledge',
      'classroom',
      'coaching',
      'evidence',
      'teacher',
    ];
    const positions = orderedIds.map((id) => markup.indexOf(`data-testid="a3-homepage-${id}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const anchor of ['capabilities', 'learning-loop', 'evidence', 'contact']) {
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

  it('changes the read-only classroom presentation without calling a product API', () => {
    expect(storyApi.A3ClassroomModeControl).toBeTypeOf('function');
    expect(storyApi.A3ClassroomModeDetails).toBeTypeOf('function');
    if (!storyApi.A3ClassroomModeControl || !storyApi.A3ClassroomModeDetails) return;

    const onChange = vi.fn();
    const control = storyApi.A3ClassroomModeControl({ mode: 'lesson', onChange });
    const buttons = Children.toArray(control.props.children) as ReactElement<
      ButtonHTMLAttributes<HTMLButtonElement>
    >[];

    expect(buttons.map((button) => button.props['aria-pressed'])).toEqual([true, false]);
    buttons[1]?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(onChange).toHaveBeenCalledWith('citations');

    const citationMarkup = renderToStaticMarkup(
      storyApi.A3ClassroomModeDetails({ mode: 'citations' }),
    );
    expect(citationMarkup).toContain('操作系统 / 第 3 章 / 课程 PPT');
    expect(citationMarkup).toContain('进程调度 / 知识总结');
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
    expect(captureSource).toContain("testId: 'a3-teacher-homepage-evidence'");
    expect(captureSource).not.toContain("focusHeading: '班级学情概览'");
  });

  it('uses only approved evidence and keeps team details in the footer', () => {
    authState.user = null;
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));
    const footerStart = markup.indexOf('<footer');

    expect(storySource).toContain('A3_HOMEPAGE_EVIDENCE.map');
    expect(markup).toContain('每一步，<br/>都有据可循。');
    for (const value of A3_HOMEPAGE_EVIDENCE.map((item) => item.value)) {
      expect(markup.match(new RegExp(value, 'g'))).toHaveLength(1);
    }
    expect(markup.indexOf(A3_HOMEPAGE_FOOTER.team)).toBeGreaterThan(footerStart);
    expect(markup.indexOf(A3_HOMEPAGE_FOOTER.competition)).toBeGreaterThan(footerStart);
    expect(markup).toContain(`href="mailto:${A3_HOMEPAGE_FOOTER.email}"`);
  });

  it('keeps private implementation details and capture APIs out of the public story', () => {
    const combined = `${homepageSource}\n${storySource}\n${teacherSource}`;

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
  it('uses the exact approved navigation labels and anchors', () => {
    expect(A3_HOMEPAGE_NAV).toEqual([
      { label: '产品能力', href: '#capabilities' },
      { label: '学习闭环', href: '#learning-loop' },
      { label: '真实证据', href: '#evidence' },
      { label: '联系我们', href: '#contact' },
    ]);
  });

  it('uses the four approved real product screens in the hero', () => {
    expect(A3_HOMEPAGE_HERO_MEDIA).toEqual([
      { src: '/a3/assets/homepage/profile.webp', alt: '学习画像界面' },
      { src: '/a3/assets/homepage/diagnostic.webp', alt: '入学诊断界面' },
      { src: '/a3/assets/homepage/knowledge-base.webp', alt: '本地知识库界面' },
      { src: '/a3/assets/homepage/classroom.webp', alt: 'AI 课堂界面' },
    ]);
  });

  it('keeps the approved operating-system learning story in order', () => {
    expect(A3_HOMEPAGE_STORY).toEqual([
      {
        id: 'profile',
        index: '01 / PROFILE',
        title: '先认识你。',
        summary: '目标、基础、时间和偏好，组成你的学习画像。',
        media: '/a3/assets/homepage/profile.webp',
        alt: '学习画像设置界面',
      },
      {
        id: 'diagnostic',
        index: '02 / DIAGNOSTIC',
        title: '找到你的起点。',
        summary: '一次诊断，找出进程调度中真正需要补齐的部分。',
        media: '/a3/assets/homepage/diagnostic.webp',
        alt: '操作系统入学诊断界面',
      },
      {
        id: 'knowledge',
        index: '03 / KNOWLEDGE',
        title: '让资料真正为你所用。',
        summary: '课本、课程 PPT 和知识总结，变成随时可查的学习依据。',
        media: '/a3/assets/homepage/knowledge-base.webp',
        alt: '操作系统本地知识库界面',
      },
      {
        id: 'classroom',
        index: '04 / CLASSROOM',
        title: '走进为你生成的课堂。',
        summary: '讲解紧跟你的薄弱点，也保留每一条资料来源。',
        media: '/a3/assets/homepage/classroom.webp',
        alt: '个性化 AI 课堂界面',
      },
      {
        id: 'coaching',
        index: '05 / COACHING',
        title: '随时有人陪你学懂。',
        summary: '看见问题、听懂追问，再陪你把难点讲明白。',
        media: '/a3/assets/homepage/teacher-fallback.webp',
        alt: '数字教师实时辅导界面',
      },
      {
        id: 'evidence',
        index: '06 / EVIDENCE',
        title: '每一步，都有据可循。',
        summary: '从资料来源到学习进展，过程清清楚楚。',
        media: null,
        alt: '',
      },
      {
        id: 'teacher',
        index: '07 / TEACHER',
        title: '及时看见，也能及时介入。',
        summary: '教师看见班级薄弱点和课堂任务队列，在需要时及时介入。',
        media: '/a3/assets/homepage/teacher-workbench.webp',
        alt: '教师工作台界面',
      },
    ]);
  });

  it('uses only the three approved evidence claims', () => {
    expect(A3_HOMEPAGE_EVIDENCE).toEqual([
      { label: '知识库', value: '资料可检索' },
      { label: 'AI 回答', value: '来源可验证' },
      { label: '学习进展', value: '结果会写回' },
    ]);
  });

  it('keeps the approved team, competition and contact details in the footer model', () => {
    expect(A3_HOMEPAGE_FOOTER).toEqual({
      team: '这次不要意味何',
      competition: 'A3-基于大模型的个性化资源生成与学习多智能体系统开发',
      email: '3062221819@qq.com',
    });
  });

  it('keeps team, competition and platform implementation names out of the hero and story', () => {
    const heroMarkup = renderToStaticMarkup(createElement(A3HomepageHero));
    const publicStory = JSON.stringify(A3_HOMEPAGE_STORY);

    for (const privateCopy of [
      A3_HOMEPAGE_FOOTER.team,
      A3_HOMEPAGE_FOOTER.competition,
      'OpenMAIC',
    ]) {
      expect(heroMarkup).not.toContain(privateCopy);
      expect(publicStory).not.toContain(privateCopy);
    }
  });
});

describe('A3 product homepage hero and navigation', () => {
  it('renders only the approved hero message and one primary journey CTA', () => {
    const markup = renderToStaticMarkup(createElement(A3HomepageHero));

    expect(markup).toContain('每一步学习，<br/>都更懂你。');
    expect(markup).toContain('一群懂学习的智能体，陪你找到自己的节奏。');
    expect(markup).toContain('href="/a3/register"');
    expect(markup.match(/开启我的智学旅程/g)).toHaveLength(1);
    expect(markup).not.toContain('A3 PERSONAL LEARNING ENGINE');
    expect(markup).not.toContain('eyebrow');
  });

  it('requests a contained image width for the mobile hero composition', () => {
    const markup = renderToStaticMarkup(createElement(A3HomepageHero));

    expect(markup).toContain(
      'sizes="(max-width: 767px) calc(100vw - 62px), (min-width: 1600px) 920px, 68vw"',
    );
    expect(markup).not.toContain('112vw');
  });

  it('renders anonymous navigation with review, login and persistent registration routes', () => {
    authState.user = null;
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));

    expect(markup).toContain('data-testid="a3-product-homepage"');
    expect(markup).toContain('href="/a3/login"');
    expect(markup).toContain('href="/a3/login?mode=review"');
    expect(markup).toContain('href="/a3/register"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('进入学习区');
  });

  it('replaces login with the learning workspace route for signed-in users', () => {
    authState.user = {
      id: 'student-1',
      role: 'student',
      displayName: '演示学生',
      phoneBound: true,
      privacyAccepted: true,
      profileCompleted: true,
      onboardingStep: 'complete',
      createdAt: '2026-07-11T00:00:00Z',
      updatedAt: '2026-07-11T00:00:00Z',
    };
    const markup = renderToStaticMarkup(createElement(A3ProductHomepage));

    expect(markup).toContain('href="/a3/dashboard"');
    expect(markup).toContain('进入学习区');
    expect(markup).toContain('href="/a3/login?mode=review"');
    expect(markup).toContain('href="/a3/register"');
  });

  it('binds the mobile navigation toggle and closes the menu after navigation', () => {
    const homepageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'components/a3/marketing/a3-product-homepage.tsx'),
      'utf8',
    );

    expect(homepageSource).toContain('aria-expanded={menuOpen}');
    expect(homepageSource).toContain("aria-label={menuOpen ? '关闭导航' : '打开导航'}");
    expect(homepageSource.match(/onClick=\{closeMenu\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(homepageSource).toContain('onClick={closeMenuAndRestoreFocus}');
    expect(homepageSource).toContain("event.key !== 'Escape'");
  });

  it('cancels superseded and unmounted mobile-menu focus frames', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    const cancelled: number[] = [];
    const frameRef = { current: null as number | null };
    let nextFrame = 1;
    const requestFrame = (callback: FrameRequestCallback) => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    };
    const cancelFrame = (frame: number) => {
      cancelled.push(frame);
      callbacks.delete(frame);
    };
    const staleFocus = vi.fn();
    const currentFocus = vi.fn();
    const unmountedFocus = vi.fn();

    scheduleA3HomepageFocusFrame(frameRef, requestFrame, cancelFrame, staleFocus);
    scheduleA3HomepageFocusFrame(frameRef, requestFrame, cancelFrame, currentFocus);

    expect(cancelled).toEqual([1]);
    expect(callbacks.has(1)).toBe(false);
    callbacks.get(2)?.(0);
    expect(staleFocus).not.toHaveBeenCalled();
    expect(currentFocus).toHaveBeenCalledOnce();
    expect(frameRef.current).toBeNull();

    scheduleA3HomepageFocusFrame(frameRef, requestFrame, cancelFrame, unmountedFocus);
    cancelA3HomepageFocusFrame(frameRef, cancelFrame);

    expect(cancelled).toEqual([1, 3]);
    expect(callbacks.has(3)).toBe(false);
    expect(unmountedFocus).not.toHaveBeenCalled();
    expect(frameRef.current).toBeNull();
  });

  it('publishes the approved page metadata', () => {
    expect(metadata).toEqual({
      title: '智学引擎 | 每一步学习，都更懂你',
      description: '面向大学生的多智能体个性化学习平台。',
    });
  });
});
