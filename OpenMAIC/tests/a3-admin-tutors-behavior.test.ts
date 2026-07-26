// @vitest-environment jsdom

import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  A3AdminTutorPersona,
  A3AdminTutorsResponse,
  A3AdminTutorUpdateResponse,
} from '../lib/a3/admin-types';

const adminApi = vi.hoisted(() => ({
  getA3AdminTutors: vi.fn(),
  updateA3AdminTutor: vi.fn(),
}));

vi.mock('../lib/a3/admin-api', () => adminApi);
vi.mock('../components/a3/features/admin/admin-access-guard', () => ({
  AdminAccessGuard: ({ children }: { children: ReactNode }) => children,
}));

import { AdminTutorsView } from '../components/a3/features/admin/admin-tutors-view';

type MountedView = { container: HTMLDivElement; root: Root; mounted: boolean };
const mountedViews: MountedView[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function persona(overrides: Partial<A3AdminTutorPersona> = {}): A3AdminTutorPersona {
  return {
    id: 'structured-teacher',
    name: '结构化讲师',
    shortDescription: '按步骤讲清知识结构',
    teachingStyle: '结构化讲解',
    allowedWorkflows: ['coaching'],
    schemaVersion: 'a3.tutor-persona.v1',
    enabled: true,
    avatarAssetId: 'teacher-default-v1',
    voicePreviewEnabled: true,
    configurationDataStatus: 'collected',
    updatedAt: '2026-07-27T08:00:00+00:00',
    ...overrides,
  };
}

function response(overrides: Partial<A3AdminTutorsResponse> = {}): A3AdminTutorsResponse {
  return {
    success: true,
    range: '30d',
    dataStatus: 'collected',
    kpis: {
      enabledPersonaCount: 1,
      sessionCount: 8,
      verifiedResponseRate: {
        value: 0.75,
        numerator: 6,
        denominator: 8,
        dataStatus: 'collected',
      },
      satisfaction: { value: 4.5, sampleCount: 4, dataStatus: 'collected' },
    },
    personas: [persona()],
    assets: [{
      assetId: 'teacher-default-v1',
      displayName: '默认导师',
      fileSizeBytes: 1024,
      status: 'enabled',
      isDefault: true,
      licenseComplete: null,
    }],
    providerStatus: [{ id: 'tutorVoicePreview', status: 'unknown', dataStatus: 'not_collected' }],
    analytics: {
      adoption: [
        { date: '2026-07-26', value: 0.5, numerator: 1, denominator: 2, dataStatus: 'collected' },
      ],
      sessionQuality: [{
        metric: 'verifiedAssistantResponseRate',
        value: 0.75,
        numerator: 6,
        denominator: 8,
        dataStatus: 'collected',
      }],
      feedback: [{ metric: 'satisfaction', value: 4.5, sampleCount: 4, dataStatus: 'collected' }],
      assessmentAssociation: {
        averageDelta: null,
        positiveCount: 0,
        flatCount: 0,
        negativeCount: 0,
        pairCount: 0,
        coverage: { value: null, denominator: 0, dataStatus: 'not_collected' },
        observedAssociation: true,
        note: '观察到的相关性，不代表因果关系',
        dataStatus: 'insufficient_sample',
      },
    },
    ...overrides,
  };
}

function renderView() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const mounted = { container, root, mounted: true };
  mountedViews.push(mounted);
  act(() => root.render(React.createElement(AdminTutorsView)));
  return mounted;
}

function unmountView(view: MountedView) {
  if (!view.mounted) return;
  act(() => view.root.unmount());
  view.mounted = false;
  view.container.remove();
}

async function settleTimer() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openReasonDialog(container: HTMLElement, triggerText = '已启用') {
  act(() => buttonByText(container, triggerText).click());
  await settleTimer();
  const textarea = container.ownerDocument.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Reason textarea not found');
  return textarea;
}

async function submitReason(container: HTMLElement, reason: string, triggerText = '已启用') {
  const textarea = await openReasonDialog(container, triggerText);
  changeTextarea(textarea, reason);
  const form = textarea.closest('form');
  if (!form) throw new Error('Reason form not found');
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await flushPromises();
}

async function submitReasonWithFakeTimers(container: HTMLElement, reason: string) {
  act(() => buttonByText(container, '已启用').click());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const textarea = container.ownerDocument.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Reason textarea not found');
  changeTextarea(textarea, reason);
  const form = textarea.closest('form');
  if (!form) throw new Error('Reason form not found');
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await flushPromises();
}

beforeEach(() => {
  adminApi.getA3AdminTutors.mockReset();
  adminApi.updateA3AdminTutor.mockReset();
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0),
  });
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
});

afterEach(() => {
  for (const view of mountedViews.splice(0)) unmountView(view);
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('admin tutor rendered metrics and evidence', () => {
  it('marks enabled persona count as not collected when the persona collection is empty', async () => {
    adminApi.getA3AdminTutors.mockResolvedValue(response({
      personas: [],
      kpis: { ...response().kpis, enabledPersonaCount: 0 },
    }));

    const view = renderView();
    await settleTimer();

    const enabledPersonaKpi = view.container.querySelector('[aria-label="导师核心指标"]')?.firstElementChild;
    const paragraphs = enabledPersonaKpi?.querySelectorAll('p');
    expect(paragraphs?.[1]?.textContent).toBe('未采集');
    expect(paragraphs?.[2]?.textContent).toContain('dataStatus: not_collected');
    expect(paragraphs?.[2]?.textContent).toContain('sampleCount: 0');
    expect(view.container.textContent).toContain('尚未登记导师人格配置');
  });

  it('checks dataStatus before values and never turns missing persona metrics into zero', async () => {
    adminApi.getA3AdminTutors.mockResolvedValue(response({
      kpis: {
        enabledPersonaCount: 1,
        sessionCount: 8,
        verifiedResponseRate: { value: 0, denominator: 8, dataStatus: 'not_collected' },
        satisfaction: { value: 4.8, sampleCount: 3, dataStatus: 'insufficient_sample' },
      },
      analytics: {
        adoption: [
          { date: '2026-07-25', value: 0, numerator: 0, denominator: 2, dataStatus: 'collected' },
          { date: '2026-07-26', value: 0, numerator: 0, denominator: 0, dataStatus: 'not_collected' },
        ],
        sessionQuality: [
          {
            metric: 'perPersonaSessionCount',
            value: null,
            values: [{ personaId: 'structured-teacher', sessionCount: 8 }],
            dataStatus: 'not_collected',
          },
          { metric: 'averageStudentMessageTurns', value: 0, sampleCount: 8, dataStatus: 'partial' },
          { metric: 'normalEndedRate', value: 0, denominator: 8, dataStatus: 'collected' },
        ],
        feedback: [],
        assessmentAssociation: {
          averageDelta: 0,
          positiveCount: 0,
          flatCount: 0,
          negativeCount: 0,
          pairCount: 3,
          coverage: { value: 0, denominator: 3, dataStatus: 'partial' },
          observedAssociation: true,
          note: '观察到的相关性，不代表因果关系',
          dataStatus: 'insufficient_sample',
        },
      },
    }));

    const view = renderView();
    await settleTimer();

    const text = view.container.textContent || '';
    expect(text).toContain('未采集');
    expect(text).toContain('样本不足');
    expect(text).toContain('数据不完整');
    expect(text).not.toContain('8 次会话');
    expect(text).toContain('0.0%');
    expect(text).toContain('观察到的相关性，不代表因果关系');

    const chart = view.container.querySelector('[role="img"][aria-describedby]');
    const table = view.container.querySelector('table.sr-only');
    expect(chart).not.toBeNull();
    expect(table?.textContent).toContain('2026-07-25');
    expect(table?.textContent).toContain('0.0%');
    expect(table?.textContent).toContain('2026-07-26');
    expect(table?.textContent).toContain('未采集');
    expect(table?.textContent).toContain('sampleCount');
    expect(table?.textContent).toContain('dataStatus');
  });

  it('keeps daily trend evidence readable when every point has insufficient samples', async () => {
    const base = response();
    adminApi.getA3AdminTutors.mockResolvedValue(response({
      analytics: {
        ...base.analytics,
        adoption: [{
          date: '2026-07-27',
          value: 0,
          numerator: 0,
          denominator: 0,
          dataStatus: 'insufficient_sample',
        }],
      },
    }));

    const view = renderView();
    await settleTimer();

    expect(view.container.textContent).toContain('该周期暂无人格辅导会话');
    const table = view.container.querySelector('table.sr-only');
    expect(table?.textContent).toContain('2026-07-27');
    expect(table?.textContent).toContain('样本不足');
    expect(table?.textContent).toContain('insufficient_sample');
  });
});

describe('admin tutor range and refresh behavior', () => {
  it('renders the latest clicked range and ignores an older response', async () => {
    const first = deferred<A3AdminTutorsResponse>();
    const latest = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);

    const view = renderView();
    await settleTimer();
    act(() => buttonByText(view.container, '90 天').click());
    await settleTimer();

    latest.resolve(response({ range: '90d', kpis: { ...response().kpis, sessionCount: 90 } }));
    await flushPromises();
    first.resolve(response({ range: '30d', kpis: { ...response().kpis, sessionCount: 30 } }));
    await flushPromises();

    expect(buttonByText(view.container, '90 天').getAttribute('aria-pressed')).toBe('true');
    expect(view.container.textContent).toContain('90');
    expect(view.container.textContent).not.toContain('30 次');
  });

  it('refreshes silently every 30 seconds, skips hidden pages, prevents overlap, and aborts on unmount', async () => {
    vi.useFakeTimers();
    adminApi.getA3AdminTutors.mockResolvedValue(response());
    const view = renderView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);

    const pending = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors.mockReturnValueOnce(pending.promise);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[aria-label="正在加载"]')).toBeNull();
    expect(view.container.textContent).toContain('结构化讲师');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(2);
    const signal = adminApi.getA3AdminTutors.mock.calls[1][1]?.signal as AbortSignal;
    unmountView(view);
    expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(2);
    pending.resolve(response());
  });

  it('handles a pending GET rejection after unmount without an unhandled promise', async () => {
    const pending = deferred<A3AdminTutorsResponse>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adminApi.getA3AdminTutors.mockReturnValue(pending.promise);
    const view = renderView();
    await settleTimer();

    unmountView(view);
    pending.reject(new Error('aborted request rejected late'));
    await flushPromises();

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('admin tutor mutation behavior', () => {
  it.each([
    ['success', {
      success: true,
      persona: persona({ enabled: false, updatedAt: '2026-07-27T09:00:00+00:00' }),
    }],
    ['ordinary error', { success: false, status: 400, error: '资产当前不可用' }],
    ['stale_update', {
      success: false,
      status: 409,
      errorCode: 'stale_update',
      error: '任意并发文案',
    }],
  ] satisfies Array<[string, A3AdminTutorUpdateResponse]>) (
    'ignores a pending PATCH %s result after unmount',
    async (_label, result) => {
      const save = deferred<A3AdminTutorUpdateResponse>();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      adminApi.getA3AdminTutors.mockResolvedValue(response());
      adminApi.updateA3AdminTutor.mockReturnValue(save.promise);
      const view = renderView();
      await settleTimer();
      await submitReason(view.container, '卸载期间保存');

      unmountView(view);
      save.resolve(result);
      await flushPromises();

      expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    },
  );

  it('blocks timer, visibility, manual, and range GETs while PATCH is in flight, then resumes', async () => {
    vi.useFakeTimers();
    const save = deferred<{ success: boolean; persona: A3AdminTutorPersona }>();
    adminApi.getA3AdminTutors
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        personas: [persona({ enabled: false, updatedAt: '2026-07-27T09:00:00+00:00' })],
        kpis: { ...response().kpis, enabledPersonaCount: 0 },
      }));
    adminApi.updateA3AdminTutor.mockReturnValue(save.promise);
    const view = renderView();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await submitReasonWithFakeTimers(view.container, '延迟保存');
    const refreshButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="刷新数据"]');
    const rangeButtons = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('[aria-label="统计周期"] button'),
    );
    expect(refreshButton?.disabled).toBe(true);
    expect(rangeButtons.every((button) => button.disabled)).toBe(true);
    expect(buttonByText(view.container, '已启用').disabled).toBe(true);

    refreshButton?.click();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);

    save.resolve({
      success: true,
      persona: persona({ enabled: false, updatedAt: '2026-07-27T09:00:00+00:00' }),
    });
    await flushPromises();
    expect(view.container.textContent).toContain('已停用');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('已停用');
  });

  it('keeps a successful PATCH persona and updatedAt when an older silent GET resolves later', async () => {
    const staleRefresh = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(staleRefresh.promise);
    adminApi.updateA3AdminTutor
      .mockResolvedValueOnce({
        success: true,
        persona: persona({ enabled: false, updatedAt: '2026-07-27T09:00:00+00:00' }),
      })
      .mockResolvedValueOnce({ success: false, status: 400, error: '停止第二次更新' });
    const view = renderView();
    await settleTimer();

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    const staleSignal = adminApi.getA3AdminTutors.mock.calls[1][1]?.signal as AbortSignal;

    await submitReason(view.container, '保存新版本');
    expect(staleSignal.aborted).toBe(true);
    expect(view.container.textContent).toContain('已停用');

    staleRefresh.resolve(response({
      personas: [persona({ name: '旧响应导师', enabled: true })],
    }));
    await flushPromises();
    expect(view.container.textContent).toContain('已停用');
    expect(view.container.textContent).not.toContain('旧响应导师');

    await submitReason(view.container, '验证新版本号', '已停用');
    expect(adminApi.updateA3AdminTutor).toHaveBeenLastCalledWith(
      'structured-teacher',
      expect.objectContaining({ expectedUpdatedAt: '2026-07-27T09:00:00+00:00' }),
    );
  });

  it('does not let an aborted silent GET overwrite an ordinary PATCH error', async () => {
    const staleRefresh = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(staleRefresh.promise);
    adminApi.updateA3AdminTutor.mockResolvedValue({
      success: false,
      status: 400,
      error: '资产当前不可用',
    });
    const view = renderView();
    await settleTimer();

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    const staleSignal = adminApi.getA3AdminTutors.mock.calls[1][1]?.signal as AbortSignal;
    await submitReason(view.container, '尝试普通失败');
    expect(staleSignal.aborted).toBe(true);

    staleRefresh.resolve(response({ personas: [persona({ name: '错误路径旧响应导师' })] }));
    await flushPromises();
    expect(view.container.textContent).toContain('资产当前不可用');
    expect(view.container.textContent).not.toContain('错误路径旧响应导师');
    expect(view.container.textContent).toContain('结构化讲师');
  });

  it('uses the explicit stale-update reload and ignores the GET aborted by the PATCH', async () => {
    const staleRefresh = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce(response({
        personas: [persona({ name: '刷新后的导师', updatedAt: '2026-07-27T10:00:00+00:00' })],
      }));
    adminApi.updateA3AdminTutor.mockResolvedValue({
      success: false,
      status: 409,
      errorCode: 'stale_update',
      error: '任意并发文案',
    });
    const view = renderView();
    await settleTimer();

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    const staleSignal = adminApi.getA3AdminTutors.mock.calls[1][1]?.signal as AbortSignal;
    await submitReason(view.container, '并发失败后刷新');
    expect(staleSignal.aborted).toBe(true);
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(3);
    expect(view.container.textContent).toContain('刷新后的导师');

    staleRefresh.resolve(response({ personas: [persona({ name: '并发路径旧响应导师' })] }));
    await flushPromises();
    expect(view.container.textContent).toContain('配置已发生并发变更');
    expect(view.container.textContent).toContain('刷新后的导师');
    expect(view.container.textContent).not.toContain('并发路径旧响应导师');
  });

  it('requires and focuses the reason, stays pending, then applies only a successful PATCH', async () => {
    adminApi.getA3AdminTutors.mockResolvedValue(response());
    const save = deferred<{ success: boolean; persona: A3AdminTutorPersona }>();
    adminApi.updateA3AdminTutor.mockReturnValue(save.promise);
    const view = renderView();
    await settleTimer();

    const textarea = await openReasonDialog(view.container);
    expect(document.activeElement).toBe(textarea);
    const form = textarea.closest('form')!;
    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(document.body.textContent).toContain('请填写操作原因');
    expect(adminApi.updateA3AdminTutor).not.toHaveBeenCalled();

    changeTextarea(textarea, '关闭测试人格');
    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await flushPromises();
    expect(document.body.textContent).toContain('处理中');
    expect(buttonByText(document.body, '处理中…').disabled).toBe(true);
    expect(view.container.textContent).toContain('已启用');

    save.resolve({ success: true, persona: persona({ enabled: false, updatedAt: '2026-07-27T09:00:00+00:00' }) });
    await flushPromises();
    expect(view.container.textContent).toContain('运行配置已保存');
    expect(view.container.textContent).toContain('已停用');
    expect(adminApi.updateA3AdminTutor).toHaveBeenCalledWith(
      'structured-teacher',
      expect.objectContaining({
        enabled: false,
        reason: '关闭测试人格',
        expectedUpdatedAt: '2026-07-27T08:00:00+00:00',
      }),
    );
  });

  it('refreshes only stale_update and leaves other HTTP 409 errors untouched', async () => {
    adminApi.getA3AdminTutors.mockResolvedValue(response());
    adminApi.updateA3AdminTutor
      .mockResolvedValueOnce({ success: false, status: 400, error: '资产当前不可用' })
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        errorCode: 'last_enabled_persona',
        error: '不能停用最后一个可用导师人格',
      })
      .mockResolvedValueOnce({
        success: false,
        status: 409,
        errorCode: 'stale_update',
        error: 'ANY_STALE_COPY',
      });
    const view = renderView();
    await settleTimer();

    await submitReason(view.container, '第一次更新');
    expect(view.container.textContent).toContain('资产当前不可用');
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);

    await submitReason(view.container, '最后人格保护');
    expect(view.container.textContent).toContain('不能停用最后一个可用导师人格');
    expect(view.container.textContent).not.toContain('配置已发生并发变更');
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(1);

    await submitReason(view.container, '并发更新');
    expect(view.container.textContent).toContain('配置已发生并发变更，已刷新最新数据，请重新操作。');
    expect(adminApi.getA3AdminTutors).toHaveBeenCalledTimes(2);
  });
});

describe('admin tutor page states', () => {
  it('renders loading, retry, and empty states through real interactions', async () => {
    const loading = deferred<A3AdminTutorsResponse>();
    adminApi.getA3AdminTutors
      .mockReturnValueOnce(loading.promise)
      .mockResolvedValueOnce(response({ personas: [] }));
    const view = renderView();
    await settleTimer();
    expect(view.container.querySelector('[aria-label="正在加载"]')).not.toBeNull();

    loading.resolve({ ...response(), success: false, error: '导师数据暂不可用' });
    await flushPromises();
    expect(view.container.textContent).toContain('导师数据暂不可用');
    act(() => buttonByText(view.container, '重试').click());
    await flushPromises();
    expect(view.container.textContent).toContain('尚未登记导师人格配置');
  });

  it('disables mutations when configuration evidence is unavailable', async () => {
    adminApi.getA3AdminTutors.mockResolvedValue(response({
      personas: [persona({ configurationDataStatus: 'not_collected', updatedAt: null })],
    }));
    const view = renderView();
    await settleTimer();

    expect(view.container.querySelector<HTMLButtonElement>('button[title="停用该导师人格"]')?.disabled).toBe(true);
    expect(view.container.querySelector<HTMLSelectElement>('select[aria-label$="的 VRM 资产"]')?.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('button[title="关闭音色试听"]')?.disabled).toBe(true);
  });
});
