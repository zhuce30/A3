// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: apiMocks.get,
  a3PostJson: apiMocks.post,
}));

import {
  TutorFeedbackPanel,
  TutorFeedbackPanelView,
  isTutorFeedbackVisible,
  loadTutorFeedback,
  saveTutorFeedback,
} from '@/components/a3/features/coaching/tutor-feedback-panel';
import {
  commitRealtimeEndedSession,
  createCoachingSessionLoader,
} from '@/components/a3/features/coaching/coaching-session-loader';

let mountedRoot: Root | null = null;
const root = process.cwd();

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
});

describe('TutorFeedbackPanel', () => {
  it('renders five stable rating controls, four fixed tags, and no free text input', () => {
    const html = renderPanel();

    expect((html.match(/type="radio"/g) || []).length).toBe(5);
    expect((html.match(/data-testid="a3-tutor-feedback-tag-/g) || []).length).toBe(4);
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toContain('讲解清楚');
    expect(html).toContain('节奏合适');
    expect(html).toContain('帮助理解');
    expect(html).toContain('仍然困惑');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('type="text"');
  });

  it('shows only for ended sessions with a readable missing-id recovery state', () => {
    expect(isTutorFeedbackVisible({ id: 'session-1', status: 'ended' })).toBe(true);
    expect(isTutorFeedbackVisible({ id: 'session-1', status: 'active' })).toBe(false);
    expect(isTutorFeedbackVisible(null)).toBe(false);

    const html = renderPanel({ sessionId: '', loadError: '缺少辅导会话 ID，请重新选择已结束的会话。' });
    expect(html).toContain('缺少辅导会话 ID');
  });

  it('uses the canonical endpoint and sends only rating and tags', async () => {
    apiMocks.get.mockResolvedValue({ success: true, feedback: null });
    apiMocks.post.mockResolvedValue({
      success: true,
      feedback: {
        rating: 4,
        tags: ['讲解清楚'],
        personaId: 'socratic-guide',
        createdAt: '2026-07-26T10:00:00Z',
        updatedAt: '2026-07-26T10:00:00Z',
      },
    });

    await loadTutorFeedback('session / 1');
    await saveTutorFeedback('session / 1', 4, ['讲解清楚']);

    expect(apiMocks.get).toHaveBeenCalledWith(
      '/api/learning/coaching/sessions/session%20%2F%201/tutor-feedback/',
    );
    expect(apiMocks.post).toHaveBeenCalledWith(
      '/api/learning/coaching/sessions/session%20%2F%201/tutor-feedback/',
      { rating: 4, tags: ['讲解清楚'] },
    );
  });

  it('renders loading, error, success, and update states', () => {
    expect(renderPanel({ loading: true })).toContain('data-testid="a3-tutor-feedback-loading"');
    expect(renderPanel({ loadError: '请先登录后读取反馈' })).toContain('请先登录后读取反馈');
    expect(renderPanel({ submitError: '反馈提交失败' })).toContain('反馈提交失败');
    expect(renderPanel({ successMessage: '反馈已提交' })).toContain('data-testid="a3-tutor-feedback-success"');

    const updateHtml = renderPanel({ existing: true, rating: 4, tags: ['讲解清楚'] });
    expect(updateHtml).toContain('更新反馈');
    expect(updateHtml).toContain('checked=""');
  });

  it('commits only the latest coaching session response and invalidates on dispose', async () => {
    const first = deferred<{ id: string }>();
    const second = deferred<{ id: string }>();
    const commits: string[] = [];
    const loader = createCoachingSessionLoader((sessionId) => (
      sessionId === 'A' ? first.promise : second.promise
    ));

    const firstLoad = loader.load('A', (result) => commits.push(result.id));
    const secondLoad = loader.load('B', (result) => commits.push(result.id));
    second.resolve({ id: 'B' });
    await secondLoad;
    first.resolve({ id: 'A' });
    await firstLoad;

    expect(commits).toEqual(['B']);

    const afterDispose = deferred<{ id: string }>();
    const disposable = createCoachingSessionLoader(() => afterDispose.promise);
    const pending = disposable.load('C', (result) => commits.push(result.id));
    disposable.dispose();
    afterDispose.resolve({ id: 'C' });
    await pending;
    expect(commits).toEqual(['B']);
  });

  it('keeps realtime ended feedback target when an older history response finishes later', async () => {
    const history = deferred<{ id: string; status: string }>();
    const loader = createCoachingSessionLoader(() => history.promise);
    let feedbackTarget: { id: string; status: string } | null = null;
    const pendingHistory = loader.load('history-A', (session) => {
      feedbackTarget = session;
    });

    commitRealtimeEndedSession(loader, 'realtime-ended', (sessionId) => {
      feedbackTarget = { id: sessionId, status: 'ended' };
    });
    expect(feedbackTarget).toEqual({ id: 'realtime-ended', status: 'ended' });

    history.resolve({ id: 'history-A', status: 'ended' });
    await pendingHistory;

    expect(feedbackTarget).toEqual({ id: 'realtime-ended', status: 'ended' });
  });

  it('retries feedback loading with GET and renders the existing draft', async () => {
    apiMocks.get
      .mockResolvedValueOnce({ success: false, error: '反馈读取失败', feedback: null })
      .mockResolvedValueOnce({
        success: true,
        feedback: feedback(4, ['讲解清楚']),
      });

    mountPanel('session-load');
    await flushEffects();
    expect(document.body.textContent).toContain('反馈读取失败');

    click('[data-testid="a3-tutor-feedback-load-retry"]');
    await flushEffects();

    expect(apiMocks.get).toHaveBeenCalledTimes(2);
    expect((query('input[value="4"]') as HTMLInputElement).checked).toBe(true);
    expect(query('[data-testid="a3-tutor-feedback-tag-讲解清楚"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('retries failed POST without reloading and preserves the selected draft', async () => {
    apiMocks.get.mockResolvedValue({ success: true, feedback: null });
    apiMocks.post
      .mockResolvedValueOnce({ success: false, error: '提交网络失败', feedback: null })
      .mockResolvedValueOnce({ success: true, feedback: feedback(4, ['帮助理解']) });

    mountPanel('session-submit');
    await flushEffects();
    click('input[value="4"]');
    click('[data-testid="a3-tutor-feedback-tag-帮助理解"]');
    click('[data-testid="a3-tutor-feedback-submit"]');
    await flushEffects();

    expect(document.body.textContent).toContain('提交网络失败');
    expect((query('input[value="4"]') as HTMLInputElement).checked).toBe(true);
    expect(query('[data-testid="a3-tutor-feedback-tag-帮助理解"]').getAttribute('aria-pressed')).toBe('true');

    click('[data-testid="a3-tutor-feedback-submit-retry"]');
    await flushEffects();

    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledTimes(2);
    expect(apiMocks.post).toHaveBeenLastCalledWith(
      '/api/learning/coaching/sessions/session-submit/tutor-feedback/',
      { rating: 4, tags: ['帮助理解'] },
    );
    expect(document.body.textContent).toContain('反馈已提交');
  });

  it('ignores stale feedback loads after session change and unmount', async () => {
    const first = deferred<ReturnType<typeof feedbackResponse>>();
    const second = deferred<ReturnType<typeof feedbackResponse>>();
    apiMocks.get.mockImplementation((url: string) => (
      url.includes('session-A') ? first.promise : second.promise
    ));

    mountPanel('session-A');
    rerenderPanel('session-B');
    second.resolve(feedbackResponse(2));
    await flushEffects();
    first.resolve(feedbackResponse(5));
    await flushEffects();

    expect((query('input[value="2"]') as HTMLInputElement).checked).toBe(true);
    expect((query('input[value="5"]') as HTMLInputElement).checked).toBe(false);

    const afterUnmount = deferred<ReturnType<typeof feedbackResponse>>();
    apiMocks.get.mockReturnValueOnce(afterUnmount.promise);
    rerenderPanel('session-C');
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    afterUnmount.resolve(feedbackResponse(3));
    await flushEffects();
    expect(document.body.textContent).toBe('');
  });

  it('exposes five native radios inside a labelled fieldset', async () => {
    apiMocks.get.mockResolvedValue({ success: true, feedback: null });
    mountPanel('session-radio');
    await flushEffects();

    const fieldset = query('fieldset');
    expect(fieldset.querySelector('legend')?.textContent).toContain('辅导评分');
    const radios = Array.from(fieldset.querySelectorAll('input[type="radio"]'));
    expect(radios).toHaveLength(5);
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      '1 星', '2 星', '3 星', '4 星', '5 星',
    ]);
  });

  it('keeps ended-session and realtime summary integration wired', async () => {
    const coachingView = read('components/a3/features/coaching-view.tsx');
    const realtimeCall = read('components/a3/features/coaching/realtime-coaching-call.tsx');

    expect(coachingView).toContain('<TutorFeedbackPanel');
    expect(coachingView).toContain('isTutorFeedbackVisible(feedbackSession)');
    expect(coachingView).toContain('onSessionEnded={handleRealtimeSessionEnded}');
    expect(realtimeCall).toContain('onSessionEnded?.(session.coachingSessionId)');
    expect(realtimeCall).toContain("status === 'ended' && summary");
  });
});

function renderPanel(overrides: Partial<Parameters<typeof TutorFeedbackPanelView>[0]> = {}) {
  return renderToStaticMarkup(createElement(TutorFeedbackPanelView, {
    sessionId: 'session-1',
    rating: 0,
    tags: [],
    loading: false,
    submitting: false,
    existing: false,
    loadError: '',
    submitError: '',
    successMessage: '',
    onRatingChange: vi.fn(),
    onTagToggle: vi.fn(),
    onSubmit: vi.fn(),
    onRetryLoad: vi.fn(),
    onRetrySubmit: vi.fn(),
    ...overrides,
  }));
}

function mountPanel(sessionId: string) {
  const container = document.querySelector('#root');
  if (!container) throw new Error('Missing test root');
  mountedRoot = createRoot(container);
  act(() => mountedRoot?.render(createElement(TutorFeedbackPanel, { sessionId })));
}

function rerenderPanel(sessionId: string) {
  act(() => mountedRoot?.render(createElement(TutorFeedbackPanel, { sessionId })));
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(selector: string) {
  act(() => {
    query(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function query(selector: string) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as HTMLElement;
}

function feedback(rating: number, tags: string[] = []) {
  return {
    rating,
    tags,
    personaId: 'socratic-guide',
    createdAt: '2026-07-26T10:00:00Z',
    updatedAt: '2026-07-26T10:00:00Z',
  };
}

function feedbackResponse(rating: number) {
  return { success: true, feedback: feedback(rating) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function read(relativePath: string) {
  return fs.readFileSync(path.resolve(root, relativePath), 'utf8');
}
