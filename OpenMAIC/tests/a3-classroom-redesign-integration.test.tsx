// @vitest-environment jsdom

import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClassroomContext } from '@/lib/a3/classroom-types';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const tutorMocks = vi.hoisted(() => ({
  reload: vi.fn(),
  selectPersona: vi.fn(),
}));
const resourceMocks = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: apiMocks.get,
  a3PostJson: apiMocks.post,
  resolveA3Endpoint: (value: string) => value,
}));
vi.mock('@/lib/a3/i18n', () => ({
  useA3Locale: () => ({ locale: 'zh-CN' }),
}));
vi.mock('@/lib/a3/use-resource-generation', () => ({
  useResourceGeneration: () => ({
    activeType: null,
    error: '',
    generating: false,
    generate: resourceMocks.generate,
  }),
}));
vi.mock('@/lib/a3/intent-router', () => ({
  classifyIntent: vi.fn(),
}));
vi.mock('@/components/a3/features/tutor-persona/use-tutor-persona', () => ({
  useTutorPersona: () => ({
    personas: [],
    preference: null,
    selectedPersona: { id: 'structured-teacher', name: '结构化导师' },
    selectedPersonaId: 'structured-teacher',
    recommendedPersonaId: '',
    loading: false,
    saving: false,
    error: '',
    reload: tutorMocks.reload,
    selectPersona: tutorMocks.selectPersona,
  }),
}));
vi.mock('@/components/a3/features/tutor-persona/tutor-persona-selector', () => ({
  TutorPersonaSelector: () => <div data-testid="test-tutor-selector">结构化导师</div>,
}));
vi.mock('@/components/a3/ui/a3-speech-controls', () => ({
  A3SpeechControls: () => null,
}));

import { ClassroomViewRedesign } from '@/components/a3/features/classroom-view-redesign';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const resizeObserverInstances: TestResizeObserver[] = [];

class TestResizeObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  constructor() {
    resizeObserverInstances.push(this);
  }
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => []);
  readonly unobserve = vi.fn();

  constructor(_callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
  }
}

let mountedRoot: Root | null = null;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function classroom(title: string): ClassroomContext {
  return {
    course: { id: 'course-1', title: '操作系统', edition: '2026' },
    path: { id: 'path-1', title: '操作系统路径', progress: 40 },
    target: {
      id: 'target-1',
      title,
      description: '理解进程调度的核心机制。',
      chapter: { order: 2, title: '进程管理' },
      progress: 40,
      status: 'current',
      estimatedMinutes: 25,
      reason: '当前学习路径节点',
      wrongCount: 1,
    },
    agents: [],
    sources: [],
    recommended: [],
    actions: [],
    graphSummary: {
      total: 5,
      mastered: 1,
      learning: 1,
      weak: 1,
      locked: 1,
      unstarted: 1,
      masteryRate: 20,
      nextCount: 1,
    },
  };
}

function classroomResponse(title: string) {
  return { success: true, classroom: classroom(title) };
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function queryRequired<T extends Element>(container: ParentNode, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

beforeEach(() => {
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
  tutorMocks.reload.mockReset();
  tutorMocks.selectPersona.mockReset();
  resourceMocks.generate.mockReset();
  resizeObserverInstances.length = 0;
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ClassroomViewRedesign progressive context integration', () => {
  it('keeps one attached dialogue root and loaded context throughout refresh', async () => {
    const refresh = deferred<ReturnType<typeof classroomResponse>>();
    let classroomRequestCount = 0;
    apiMocks.get.mockImplementation((path: string) => {
      if (path === '/api/learning/classroom/') {
        classroomRequestCount += 1;
        return classroomRequestCount === 1
          ? Promise.resolve(classroomResponse('进程调度'))
          : refresh.promise;
      }
      if (path === '/api/resources/packs/') return Promise.resolve({ success: true, resourcePacks: [] });
      if (path === '/api/learning/classroom/history/') return Promise.resolve({ success: true, messages: [], sessions: [] });
      if (path === '/api/learning/study-plan/?auto=1') return Promise.resolve({ success: false, error: 'not needed' });
      if (path === '/api/profiles/dynamic-profile/') return Promise.resolve({ success: false, error: 'not needed' });
      return Promise.resolve({ success: false, error: `Unexpected path: ${path}` });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    mountedRoot = createRoot(container);
    await act(async () => {
      mountedRoot?.render(<ClassroomViewRedesign />);
    });
    await waitFor(() => {
      expect(container.textContent).toContain('进程调度');
    });

    const dialogueRoot = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue"]');
    const contentRoot = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue-content"]');
    const composerFrame = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-composer-frame"]');
    const loadedHeader = queryRequired<HTMLElement>(container, 'h1');
    expect(container.querySelectorAll('[data-testid="a3-classroom-dialogue"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="a3-classroom-dialogue-content"]')).toHaveLength(1);
    expect(dialogueRoot.contains(contentRoot)).toBe(true);
    expect(container.querySelector('[data-testid="a3-classroom-context-loading"]')).toBeNull();
    expect(resizeObserverInstances).toHaveLength(2);
    const contentObserver = resizeObserverInstances.find((observer) => (
      observer.observe.mock.calls.some(([target]) => target === contentRoot)
    ));
    const composerObserver = resizeObserverInstances.find((observer) => (
      observer.observe.mock.calls.some(([target]) => target === composerFrame)
    ));
    expect(contentObserver).toBeDefined();
    expect(composerObserver).toBeDefined();

    const refreshButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('刷新上下文'));
    if (!refreshButton) throw new Error('Missing classroom refresh button');
    await act(async () => {
      refreshButton.click();
      await Promise.resolve();
    });

    expect(classroomRequestCount).toBe(2);
    expect(container.querySelector('[data-testid="a3-classroom-dialogue"]')).toBe(dialogueRoot);
    expect(container.querySelector('[data-testid="a3-classroom-dialogue-content"]')).toBe(contentRoot);
    expect(container.querySelector('h1')).toBe(loadedHeader);
    expect(container.textContent).toContain('进程调度');
    expect(container.querySelector('[data-testid="a3-classroom-context-loading"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="a3-classroom-dialogue"]')).toHaveLength(1);
    expect(resizeObserverInstances).toHaveLength(2);
    expect(contentObserver?.disconnect).not.toHaveBeenCalled();
    expect(composerObserver?.disconnect).not.toHaveBeenCalled();

    await act(async () => {
      refresh.resolve(classroomResponse('进程调度与优先级'));
      await refresh.promise;
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent).toContain('进程调度与优先级');
    });

    expect(container.querySelector('[data-testid="a3-classroom-dialogue"]')).toBe(dialogueRoot);
    expect(container.querySelector('[data-testid="a3-classroom-dialogue-content"]')).toBe(contentRoot);
    expect(container.querySelectorAll('[data-testid="a3-classroom-dialogue"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="a3-classroom-dialogue-content"]')).toHaveLength(1);
    expect(resizeObserverInstances).toHaveLength(2);
    expect(contentObserver?.disconnect).not.toHaveBeenCalled();
    expect(composerObserver?.disconnect).not.toHaveBeenCalled();
  });
});
