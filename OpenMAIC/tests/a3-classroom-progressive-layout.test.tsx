// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClassroomContextShell,
  ClassroomStickyContextBar,
  useClassroomContextVisibility,
  type ClassroomContextSummary,
} from '@/components/a3/features/classroom/classroom-context-shell';
import { ClassroomComposerFrame } from '@/components/a3/features/classroom/classroom-composer-frame';

let observerCallback: IntersectionObserverCallback | null = null;
const observerInstances: ControlledIntersectionObserver[] = [];
let resizeObserverCallback: ResizeObserverCallback | null = null;
const resizeObserverInstances: ControlledResizeObserver[] = [];

class ControlledResizeObserver implements ResizeObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn<(target: Element) => void>();
  readonly unobserve = vi.fn<(target: Element) => void>();

  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
    resizeObserverInstances.push(this);
  }
}

class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn<(target: Element) => void>();
  readonly takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => []);
  readonly unobserve = vi.fn<(target: Element) => void>();

  constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
    observerCallback = callback;
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? '0px';
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    observerInstances.push(this);
  }
}

type MountedContext = {
  container: HTMLDivElement;
  contextElement: HTMLElement;
  scrollRootElement: HTMLElement;
  rerender: (options: {
    storageKey: string;
    statusTone?: ClassroomContextSummary['statusTone'];
  }) => Promise<void>;
  unmount: () => void;
};

const mountedContexts: MountedContext[] = [];

function ContextHarness({
  storageKey,
  statusTone = 'neutral',
}: {
  storageKey: string;
  statusTone?: ClassroomContextSummary['statusTone'];
}) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const layout = useClassroomContextVisibility({ storageKey, scrollRootRef });
  const summary: ClassroomContextSummary = {
    title: '进程调度',
    tutorLabel: '结构化导师',
    statusLabel: statusTone === 'warning' ? '导师暂不可用' : '4 个场景',
    statusTone,
  };

  return (
    <div
      ref={scrollRootRef}
      data-testid="test-scroll-root"
      style={{ height: 320, overflowY: 'auto' }}
    >
      <ClassroomContextShell
        regionRef={layout.regionRef}
        regionId={layout.regionId}
        expanded={layout.expanded}
        summary={summary}
        summaryAction={<button data-testid="summary-action" type="button">重试</button>}
        collapseLabel="收起课堂信息"
        expandLabel="展开课堂信息"
        onCollapse={layout.collapse}
        onExpand={layout.expand}
      >
        <div style={{ height: 180 }}>课堂完整信息</div>
      </ClassroomContextShell>
      <ClassroomStickyContextBar
        visible={!layout.contextInView}
        regionId={layout.regionId}
        summary={summary}
        actions={<button data-testid="desktop-actions" type="button">刷新</button>}
        mobileActions={<button data-testid="mobile-actions" type="button">刷新</button>}
        onOpen={layout.openFromSticky}
        openLabel="展开课堂信息"
      />
      <div style={{ height: 600 }}>对话内容</div>
    </div>
  );
}

async function mountContext({
  storageKey,
  statusTone,
}: {
  storageKey: string;
  statusTone?: ClassroomContextSummary['statusTone'];
}): Promise<MountedContext> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const rerender = async (options: {
    storageKey: string;
    statusTone?: ClassroomContextSummary['statusTone'];
  }) => {
    await act(async () => {
      root.render(
        <ContextHarness storageKey={options.storageKey} statusTone={options.statusTone} />,
      );
    });
  };

  await rerender({ storageKey, statusTone });

  const contextElement = container.querySelector<HTMLElement>('[data-testid="a3-classroom-context-region"]');
  const scrollRootElement = container.querySelector<HTMLElement>('[data-testid="test-scroll-root"]');
  if (!contextElement || !scrollRootElement) throw new Error('Classroom context harness did not mount');

  const mounted: MountedContext = {
    container,
    contextElement,
    scrollRootElement,
    rerender,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      const index = mountedContexts.indexOf(mounted);
      if (index >= 0) mountedContexts.splice(index, 1);
    },
  };
  mountedContexts.push(mounted);
  return mounted;
}

function createDomRect(height = 0): DOMRectReadOnly {
  return {
    x: 0,
    y: 0,
    width: 0,
    height,
    top: 0,
    right: 0,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };
}

function emitResize({
  contentHeight,
  borderHeight,
  borderBoxShape = 'array',
}: {
  contentHeight: number;
  borderHeight?: number;
  borderBoxShape?: 'array' | 'object' | 'missing';
}) {
  const observer = resizeObserverInstances.at(-1);
  if (!observer || !resizeObserverCallback) throw new Error('Resize observer was not created');

  const borderBoxSize = borderHeight === undefined || borderBoxShape === 'missing'
    ? undefined
    : borderBoxShape === 'object'
      ? { blockSize: borderHeight, inlineSize: 0 }
      : [{ blockSize: borderHeight, inlineSize: 0 }];
  const entry = {
    target: document.querySelector('[data-testid="a3-classroom-composer-frame"]'),
    contentRect: createDomRect(contentHeight),
    borderBoxSize,
  } as unknown as ResizeObserverEntry;

  act(() => {
    resizeObserverCallback?.([entry], observer);
  });
}

function createIntersectionEntry(
  target: Element,
  isIntersecting: boolean,
): IntersectionObserverEntry {
  const bounds = createDomRect();
  return {
    time: 0,
    rootBounds: bounds,
    boundingClientRect: bounds,
    intersectionRect: bounds,
    intersectionRatio: isIntersecting ? 1 : 0,
    isIntersecting,
    target,
  };
}

function emitIntersection(view: MountedContext, isIntersecting: boolean) {
  const observer = observerInstances.at(-1);
  if (!observer || !observerCallback) throw new Error('Intersection observer was not created');

  act(() => {
    observerCallback?.(
      [createIntersectionEntry(view.contextElement, isIntersecting)],
      observer,
    );
  });
}

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

beforeEach(() => {
  observerCallback = null;
  observerInstances.length = 0;
  resizeObserverCallback = null;
  resizeObserverInstances.length = 0;
  sessionStorage.clear();
  vi.stubGlobal('IntersectionObserver', ControlledIntersectionObserver);
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  stubReducedMotion(false);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  for (const mounted of [...mountedContexts]) mounted.unmount();
  document.body.replaceChildren();
  sessionStorage.clear();
  observerCallback = null;
  observerInstances.length = 0;
  resizeObserverCallback = null;
  resizeObserverInstances.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('floating classroom composer frame', () => {
  it('reports one rounded border-box height across array, object, and fallback resize shapes', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onHeightChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValueOnce(createDomRect(87.1))
      .mockReturnValue(createDomRect(103.2));

    await act(async () => {
      root.render(
        <ClassroomComposerFrame onHeightChange={onHeightChange}>
          <div>Composer content</div>
        </ClassroomComposerFrame>,
      );
    });

    const frame = container.querySelector('[data-testid="a3-classroom-composer-frame"]');
    expect(frame).not.toBeNull();
    expect(onHeightChange).toHaveBeenCalledWith(88);
    expect(resizeObserverInstances).toHaveLength(1);
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledWith(frame);

    emitResize({ contentHeight: 80.1, borderHeight: 96.2, borderBoxShape: 'array' });
    expect(onHeightChange).toHaveBeenLastCalledWith(97);

    emitResize({ contentHeight: 81.1, borderHeight: 98.4, borderBoxShape: 'object' });
    expect(onHeightChange).toHaveBeenLastCalledWith(99);

    emitResize({ contentHeight: 82.1, borderBoxShape: 'missing' });
    expect(onHeightChange).toHaveBeenLastCalledWith(104);

    act(() => root.unmount());
    expect(resizeObserverInstances[0].disconnect).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('still reports its initial height when ResizeObserver is unavailable', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onHeightChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(createDomRect(63.2));
    vi.stubGlobal('ResizeObserver', undefined);

    await act(async () => {
      root.render(
        <ClassroomComposerFrame onHeightChange={onHeightChange}>
          <div>Composer content</div>
        </ClassroomComposerFrame>,
      );
    });

    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledWith(64);
    expect(resizeObserverInstances).toHaveLength(0);

    act(() => root.unmount());
    container.remove();
  });
});

describe('progressive classroom context', () => {
  it('defaults a new target to expanded and restores a collapsed session', async () => {
    const first = await mountContext({ storageKey: 'target-a' });
    const expanded = first.container.querySelector<HTMLElement>('[data-testid="a3-classroom-context-expanded"]');
    const collapseButton = first.container.querySelector<HTMLButtonElement>('[aria-label="收起课堂信息"]');
    const regionId = first.contextElement.id;

    expect(expanded?.id).toBe('');
    expect(regionId).not.toBe('');
    expect(first.contextElement.tabIndex).toBe(-1);
    expect(collapseButton?.getAttribute('aria-expanded')).toBe('true');
    expect(collapseButton?.getAttribute('aria-controls')).toBe(regionId);
    expect(document.getElementById(regionId)).toBe(first.contextElement);
    expect(collapseButton?.className).toContain('min-h-11');

    await act(async () => collapseButton?.click());

    expect(sessionStorage.getItem('a3:classroom-context:target-a')).toBe('collapsed');
    expect(first.container.querySelector('[data-testid="a3-classroom-context-summary"]')).not.toBeNull();
    const expandButton = first.container.querySelector<HTMLButtonElement>('[aria-label="展开课堂信息"]');
    const summaryAction = first.container.querySelector<HTMLElement>('[data-testid="summary-action"]');
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    expect(expandButton?.getAttribute('aria-controls')).toBe(regionId);
    expect(summaryAction?.closest('button')).toBe(summaryAction);
    expect(expandButton?.contains(summaryAction)).toBe(false);
    first.unmount();

    const restored = await mountContext({ storageKey: 'target-a' });
    expect(restored.container.querySelector('[data-testid="a3-classroom-context-summary"]')).not.toBeNull();
  });

  it('does not reuse a collapsed state for a different target', async () => {
    sessionStorage.setItem('a3:classroom-context:target-a', 'collapsed');

    const first = await mountContext({ storageKey: 'target-b' });
    const second = await mountContext({ storageKey: 'target-c' });

    expect(first.container.querySelector('[data-testid="a3-classroom-context-expanded"]')).not.toBeNull();
    expect(sessionStorage.getItem('a3:classroom-context:target-b')).toBeNull();
    expect(first.contextElement.id).not.toBe(second.contextElement.id);
  });

  it('resets a collapsed context when the same mounted harness changes target', async () => {
    const view = await mountContext({ storageKey: 'target-a' });
    const regionId = view.contextElement.id;
    const collapseButton = view.container.querySelector<HTMLButtonElement>('[aria-label="收起课堂信息"]');
    await act(async () => collapseButton?.click());
    emitIntersection(view, false);
    expect(view.container.querySelector('[data-testid="a3-classroom-sticky-context"]')).not.toBeNull();
    const scrollTo = vi.fn();
    Object.defineProperty(view.scrollRootElement, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    await view.rerender({ storageKey: 'target-b' });

    expect(view.container.querySelector('[data-testid="a3-classroom-context-expanded"]')).not.toBeNull();
    expect(view.contextElement.id).toBe(regionId);
    expect(sessionStorage.getItem('a3:classroom-context:target-a')).toBe('collapsed');
    expect(sessionStorage.getItem('a3:classroom-context:target-b')).toBeNull();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(view.container.querySelector('[data-testid="a3-classroom-sticky-context"]')).toBeNull();

    await view.rerender({ storageKey: 'target-a' });

    expect(view.container.querySelector('[data-testid="a3-classroom-context-summary"]')).not.toBeNull();
    expect(view.contextElement.id).toBe(regionId);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('roots the observer at the real scroll root and shows the sticky bar when context leaves view', async () => {
    const view = await mountContext({ storageKey: 'target-a', statusTone: 'warning' });
    const observer = observerInstances.at(-1);

    expect(observer?.root).toBe(view.scrollRootElement);
    expect(observer?.thresholds).toEqual([0]);
    expect(observer?.observe).toHaveBeenCalledWith(view.contextElement);
    expect(view.container.querySelector('[data-testid="a3-classroom-sticky-context"]')).toBeNull();

    emitIntersection(view, false);

    const sticky = view.container.querySelector<HTMLElement>('[data-testid="a3-classroom-sticky-context"]');
    const openButton = sticky?.querySelector<HTMLButtonElement>('[aria-label="展开课堂信息"]');
    const warningStatus = Array.from(sticky?.querySelectorAll('span') ?? [])
      .find((element) => element.textContent === '导师暂不可用');
    expect(sticky?.className).toContain('absolute');
    expect(sticky?.className).toContain('h-12');
    expect(openButton?.getAttribute('aria-controls')).toBe(view.contextElement.id);
    expect(document.getElementById(openButton?.getAttribute('aria-controls') ?? '')).toBe(view.contextElement);
    expect(openButton?.className).toContain('min-h-11');
    expect(warningStatus?.className).toContain('text-amber-700');
    expect(sticky?.querySelector('[data-testid="mobile-actions"]')?.parentElement?.className).toContain('sm:hidden');
    expect(sticky?.querySelector('[data-testid="desktop-actions"]')?.parentElement?.className).toContain('sm:flex');
  });

  it('opens from the sticky bar, persists expansion, smooth-scrolls, and focuses the context', async () => {
    const view = await mountContext({ storageKey: 'target-a' });
    const collapseButton = view.container.querySelector<HTMLButtonElement>('[aria-label="收起课堂信息"]');
    await act(async () => collapseButton?.click());
    emitIntersection(view, false);
    const scrollIntoView = vi.fn();
    Object.defineProperty(view.contextElement, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const stickyOpenButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="a3-classroom-sticky-context"] [aria-label="展开课堂信息"]',
    );
    await act(async () => stickyOpenButton?.click());

    expect(view.container.querySelector('[data-testid="a3-classroom-context-expanded"]')).not.toBeNull();
    expect(sessionStorage.getItem('a3:classroom-context:target-a')).toBe('expanded');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(document.activeElement).toBe(view.contextElement);
    expect(view.contextElement.className).toContain('focus-visible:ring-2');
    expect(view.contextElement.className).toContain('focus-visible:ring-inset');
    expect(view.contextElement.className).toContain('focus-visible:ring-blue-500');
  });

  it('uses auto scrolling when reduced motion is requested', async () => {
    const view = await mountContext({ storageKey: 'target-a' });
    const collapseButton = view.container.querySelector<HTMLButtonElement>('[aria-label="收起课堂信息"]');
    await act(async () => collapseButton?.click());
    emitIntersection(view, false);
    stubReducedMotion(true);
    const scrollIntoView = vi.fn();
    Object.defineProperty(view.contextElement, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const stickyOpenButton = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="a3-classroom-sticky-context"] [aria-label="展开课堂信息"]',
    );
    await act(async () => stickyOpenButton?.click());

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
    expect(document.activeElement).toBe(view.contextElement);
  });
});
