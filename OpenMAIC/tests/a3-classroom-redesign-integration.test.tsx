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
const intentMocks = vi.hoisted(() => ({
  classify: vi.fn(),
}));
const stickToBottomMocks = vi.hoisted(() => ({
  scrollToBottom: vi.fn(),
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
  classifyIntent: intentMocks.classify,
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
vi.mock('use-stick-to-bottom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('use-stick-to-bottom')>();
  return {
    ...actual,
    useStickToBottom: (...args: Parameters<typeof actual.useStickToBottom>) => {
      const instance = actual.useStickToBottom(...args);
      return {
        ...instance,
        scrollToBottom: (options?: Parameters<typeof instance.scrollToBottom>[0]) => {
          stickToBottomMocks.scrollToBottom(options);
          const instantOptions = typeof options === 'object'
            ? { ...options, animation: 'instant' as const }
            : 'instant' as const;
          const result = instance.scrollToBottom(instantOptions);
          void Promise.resolve(result).then(() => {
            instance.scrollRef.current?.dispatchEvent(new Event('scroll'));
          });
          return result;
        },
      };
    },
  };
});

import { ClassroomViewRedesign } from '@/components/a3/features/classroom-view-redesign';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};
type ClassroomHistoryMessageFixture = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  verified?: boolean;
  citations?: never[];
  claims?: never[];
};

const resizeObserverInstances: TestResizeObserver[] = [];

class TestResizeObserver implements ResizeObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly takeRecords = vi.fn<() => ResizeObserverEntry[]>(() => []);
  readonly unobserve = vi.fn();
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverInstances.push(this);
  }

  emit(entries: ResizeObserverEntry[]) {
    this.callback(entries, this);
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

function mockClassroomApis(value: ClassroomContext, messages: ClassroomHistoryMessageFixture[] = []) {
  apiMocks.get.mockImplementation((path: string) => {
    if (path === '/api/learning/classroom/') return Promise.resolve({ success: true, classroom: value });
    if (path === '/api/resources/packs/') return Promise.resolve({ success: true, resourcePacks: [] });
    if (path === '/api/learning/classroom/history/') return Promise.resolve({ success: true, messages, sessions: [] });
    if (path === '/api/learning/study-plan/?auto=1') return Promise.resolve({ success: false, error: 'not needed' });
    if (path === '/api/profiles/dynamic-profile/') return Promise.resolve({ success: false, error: 'not needed' });
    return Promise.resolve({ success: false, error: `Unexpected path: ${path}` });
  });
}

async function mountClassroom(
  value: ClassroomContext,
  messages: ClassroomHistoryMessageFixture[] = [],
) {
  mockClassroomApis(value, messages);
  const container = document.createElement('div');
  document.body.appendChild(container);
  mountedRoot = createRoot(container);
  await act(async () => {
    mountedRoot?.render(<ClassroomViewRedesign />);
  });
  await waitFor(() => {
    expect(container.querySelector('[data-testid="a3-classroom-input"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="a3-classroom-context-loading"]')).toBeNull();
  });
  return container;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Textarea value setter is unavailable');
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function dispatchEnter(textarea: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => textarea.dispatchEvent(event));
  return event;
}

function createResizeEntry(
  target: Element,
  contentHeight: number,
  borderHeight: number,
): ResizeObserverEntry {
  const contentRect = {
    x: 0,
    y: 0,
    width: 0,
    height: contentHeight,
    top: 0,
    right: 0,
    bottom: contentHeight,
    left: 0,
    toJSON: () => ({}),
  };
  return {
    target,
    contentRect,
    borderBoxSize: [{ blockSize: borderHeight, inlineSize: 0 }],
    contentBoxSize: [{ blockSize: contentHeight, inlineSize: 0 }],
    devicePixelContentBoxSize: [{ blockSize: contentHeight, inlineSize: 0 }],
  } as ResizeObserverEntry;
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
  intentMocks.classify.mockReset();
  stickToBottomMocks.scrollToBottom.mockReset();
  intentMocks.classify.mockResolvedValue({
    intent: 'ask_question',
    confidence: 1,
    params: {},
    source: 'rule',
  });
  apiMocks.post.mockResolvedValue({ success: true });
  resizeObserverInstances.length = 0;
  sessionStorage.clear();
  document.body.replaceChildren();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, reply: 'Answer', citations: [], claims: [] }),
  }));
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
  it('forces the generated-resource user message into view before the resource finishes', async () => {
    resourceMocks.generate.mockReturnValue(new Promise(() => undefined));
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    const container = await mountClassroom(classroom('Process scheduling'));
    const dialogue = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue"]');
    let scrollTop = 120;
    Object.defineProperties(dialogue, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 1000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });
    const framesBeforeGeneration = requestAnimationFrame.mock.calls.length;
    const resourceChips = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-resource-chips"]');
    const lectureButton = Array.from(resourceChips.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('讲解文档'));
    if (!lectureButton) throw new Error('Missing lecture resource generation button');

    await act(async () => {
      lectureButton.click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.textContent).toContain('生成讲解文档：Process scheduling');
      expect(resourceMocks.generate).toHaveBeenCalledWith('lecture_doc', 'Process scheduling');
      expect(scrollTop).toBe(699);
    });
    expect(requestAnimationFrame.mock.calls.length).toBeGreaterThan(framesBeforeGeneration);
    expect(stickToBottomMocks.scrollToBottom).toHaveBeenCalledWith({
      animation: 'smooth',
      ignoreEscapes: true,
    });
  });

  it('keeps restored classroom history at the context top on initial mount', async () => {
    const container = await mountClassroom(classroom('Process scheduling'), [
      {
        id: 'restored-user',
        role: 'user',
        content: 'How does round-robin scheduling work?',
      },
      {
        id: 'restored-assistant',
        role: 'assistant',
        content: 'It rotates through runnable processes with a fixed time slice.',
        verified: true,
        citations: [],
        claims: [],
      },
    ]);
    const dialogue = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue"]');
    const content = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue-content"]');
    const contentObserver = resizeObserverInstances.find((observer) => (
      observer.observe.mock.calls.some(([target]) => target === content)
    ));
    if (!contentObserver) throw new Error('Missing dialogue ResizeObserver');
    let scrollTop = 0;
    Object.defineProperties(dialogue, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 1600 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });

    act(() => {
      contentObserver.emit([createResizeEntry(content, 1600, 1600)]);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('How does round-robin scheduling work?');
      expect(container.textContent).toContain('It rotates through runnable processes with a fixed time slice.');
    });
    expect(scrollTop).toBe(0);
    expect(stickToBottomMocks.scrollToBottom).not.toHaveBeenCalled();
    const context = queryRequired<HTMLElement>(content, '[data-testid="a3-classroom-context-region"]');
    const firstMessage = queryRequired<HTMLElement>(content, '[data-testid="a3-classroom-message-user"]');
    expect(context.compareDocumentPosition(firstMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('preserves an escaped reading position and lets the user resume following the latest reply', async () => {
    const reply = deferred<{
      ok: boolean;
      json: () => Promise<{ success: boolean; reply: string; citations: never[]; claims: never[] }>;
    }>();
    vi.stubGlobal('fetch', vi.fn(() => reply.promise));
    const container = await mountClassroom(classroom('Process scheduling'));
    const dialogue = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue"]');
    const content = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue-content"]');
    const contentObserver = resizeObserverInstances.find((observer) => (
      observer.observe.mock.calls.some(([target]) => target === content)
    ));
    if (!contentObserver) throw new Error('Missing dialogue ResizeObserver');

    let scrollTop = 0;
    let scrollHeight = 1200;
    Object.defineProperties(dialogue, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });
    act(() => {
      contentObserver.emit([createResizeEntry(content, scrollHeight, scrollHeight)]);
    });

    const input = queryRequired<HTMLTextAreaElement>(container, '[data-testid="a3-classroom-input"]');
    setTextareaValue(input, 'Explain round-robin scheduling');
    await act(async () => {
      queryRequired<HTMLButtonElement>(container, '[data-testid="a3-classroom-submit"]').click();
      await Promise.resolve();
    });
    await waitFor(() => expect(scrollTop).toBe(899));

    act(() => {
      scrollTop = 240;
      dialogue.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="a3-classroom-jump-latest"]')).not.toBeNull();
    });
    const readingPosition = scrollTop;

    await act(async () => {
      reply.resolve({
        ok: true,
        json: async () => ({
          success: true,
          reply: 'Round-robin rotates through runnable processes.',
          citations: [],
          claims: [],
        }),
      });
      await reply.promise;
    });
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="a3-classroom-message-assistant"]')).toHaveLength(2);
    });
    scrollHeight = 1500;
    act(() => {
      contentObserver.emit([createResizeEntry(content, scrollHeight, scrollHeight)]);
    });
    expect(scrollTop).toBe(readingPosition);
    expect(container.querySelector('[data-testid="a3-classroom-jump-latest"]')).not.toBeNull();

    await act(async () => {
      queryRequired<HTMLButtonElement>(container, '[data-testid="a3-classroom-jump-latest"]').click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(scrollTop).toBeCloseTo(1199, 3);
      expect(container.querySelector('[data-testid="a3-classroom-jump-latest"]')).toBeNull();
    });
    expect(stickToBottomMocks.scrollToBottom).toHaveBeenLastCalledWith({
      animation: 'smooth',
      ignoreEscapes: true,
    });
  });

  it('uses the measured composer border box for workspace and message clearance', async () => {
    const container = await mountClassroom(classroom('进程调度'));
    const workspace = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-workspace"]');
    const dialogue = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue"]');
    const content = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-dialogue-content"]');
    const composerFrame = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-composer-frame"]');
    const composerObserver = resizeObserverInstances.find((observer) => (
      observer.observe.mock.calls.some(([target]) => target === composerFrame)
    ));
    if (!composerObserver) throw new Error('Missing composer ResizeObserver');

    act(() => {
      composerObserver.emit([createResizeEntry(composerFrame, 120, 132.2)]);
    });

    expect(workspace.style.getPropertyValue('--a3-composer-height')).toBe('133px');
    expect(dialogue.style.scrollPaddingBottom).toBe('calc(var(--a3-composer-height) + 16px)');
    expect(content.style.paddingBottom).toBe('calc(var(--a3-composer-height) + 16px)');
  });

  it('keeps retrieval controls in the form tool row between media controls and send', async () => {
    const container = await mountClassroom(classroom('进程调度'));
    const form = queryRequired<HTMLFormElement>(container, '[data-testid="a3-classroom-input"]').closest('form');
    if (!form) throw new Error('Missing classroom composer form');
    const retrieval = queryRequired<HTMLElement>(form, '[data-testid="a3-classroom-retrieval-controls"]');
    const retrievalSlot = retrieval.parentElement;
    const toolRow = retrievalSlot?.parentElement;
    const imageButton = queryRequired<HTMLButtonElement>(form, '[data-testid="a3-classroom-image-trigger"]');
    const submitButton = queryRequired<HTMLButtonElement>(form, '[data-testid="a3-classroom-submit"]');

    expect(retrievalSlot?.className).toContain('shrink-0');
    expect(toolRow?.className).toContain('min-w-0');
    expect(toolRow?.className).toContain('flex-1');
    expect(toolRow?.className).toContain('overflow-x-auto');
    expect(toolRow?.contains(imageButton)).toBe(true);
    expect(form.lastElementChild).toBe(submitButton);
    expect(imageButton.compareDocumentPosition(retrieval) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(retrieval.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers a real learning-path action when no classroom target exists', async () => {
    const noTargetClassroom = { ...classroom('等待目标'), target: null };
    const container = await mountClassroom(noTargetClassroom);
    const input = queryRequired<HTMLTextAreaElement>(container, '[data-testid="a3-classroom-input"]');
    const submit = queryRequired<HTMLButtonElement>(container, '[data-testid="a3-classroom-submit"]');
    const noTargetStatus = Array.from(container.querySelectorAll<HTMLElement>('[role="status"]'))
      .find((element) => element.textContent?.includes('请先选择学习目标'));
    if (!noTargetStatus) throw new Error('Missing no-target composer status');
    const learningPathLink = queryRequired<HTMLAnchorElement>(noTargetStatus, 'a[href="/a3/learning-path"]');

    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(learningPathLink.textContent).toBe('学习路径');
  });

  it('announces unsupported voice input as an alert', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const container = await mountClassroom(classroom('进程调度'));
    const voiceButton = queryRequired<HTMLButtonElement>(container, '[data-testid="a3-classroom-voice-input"]');

    await act(async () => voiceButton.click());

    const voiceStatus = queryRequired<HTMLElement>(container, '[data-testid="a3-classroom-voice-status"]');
    expect(voiceStatus.getAttribute('aria-live')).toBe('polite');
    expect(voiceStatus.getAttribute('role')).toBe('alert');
  });

  it('labels a 44px image removal button and preserves removal behavior', async () => {
    const container = await mountClassroom(classroom('进程调度'));
    const fileInput = queryRequired<HTMLInputElement>(container, '[data-testid="a3-classroom-image-upload"]');
    const file = new File(['image'], 'question.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });

    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="a3-classroom-image-preview"]')).not.toBeNull();
    });

    const removeButton = queryRequired<HTMLButtonElement>(container, '[data-testid="a3-classroom-image-remove"]');
    expect(removeButton.className).toContain('size-11');
    expect(removeButton.getAttribute('aria-label')).toBe('移除图片');
    expect(removeButton.getAttribute('title')).toBe('移除图片');

    await act(async () => removeButton.click());
    expect(container.querySelector('[data-testid="a3-classroom-image-preview"]')).toBeNull();
  });

  it('submits on Enter but not Shift+Enter or IME composition', async () => {
    intentMocks.classify.mockReturnValue(new Promise(() => undefined));
    const container = await mountClassroom(classroom('进程调度'));
    const input = queryRequired<HTMLTextAreaElement>(container, '[data-testid="a3-classroom-input"]');
    setTextareaValue(input, 'Explain process scheduling');

    const shiftEnter = dispatchEnter(input, { shiftKey: true });
    const composingEnter = dispatchEnter(input, { isComposing: true });
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(intentMocks.classify).not.toHaveBeenCalled();

    const enter = dispatchEnter(input);
    expect(enter.defaultPrevented).toBe(true);
    await waitFor(() => expect(intentMocks.classify).toHaveBeenCalledTimes(1));
    expect(intentMocks.classify).toHaveBeenCalledWith(
      'Explain process scheduling',
      expect.objectContaining({ surface: 'classroom' }),
    );
  });

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
