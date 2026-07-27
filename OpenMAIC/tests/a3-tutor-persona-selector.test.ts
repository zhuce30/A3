// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { A3TutorPersona } from '@/lib/a3/tutor-persona-types';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/lib/a3/api-client', () => ({
  a3GetJson: apiMocks.get,
  a3PatchJson: apiMocks.patch,
}));

import {
  loadTutorPersonaPreference,
  saveTutorPersonaPreference,
} from '@/components/a3/features/tutor-persona/use-tutor-persona';
import { TutorPersonaSelector } from '@/components/a3/features/tutor-persona/tutor-persona-selector';

const personas: A3TutorPersona[] = [
  persona('structured-teacher', '结构讲解', '先搭框架，再分步骤讲清概念'),
  persona('socratic-guide', '启发追问', '通过关键问题，引导你自己找到答案'),
  persona('practice-coach', '例题实战', '用例题、步骤和即时反馈巩固薄弱点'),
  persona('foundation-coach', '基础补强', '从先修概念开始，用短句和小步讲解'),
];

let mountedRoot: Root | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMocks.get.mockReset();
  apiMocks.patch.mockReset();
  FakeAudio.instances = [];
  FakeAudio.playResults = [];
  fetchMock = vi.fn();
  createObjectURL = vi.fn((blob: Blob) => `blob:preview-${blob.size}-${createObjectURL.mock.calls.length}`);
  revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Audio', FakeAudio);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  vi.unstubAllGlobals();
});

describe('TutorPersonaSelector', () => {
  it('renders a stable loading state', () => {
    const html = renderSelector({ loading: true, personas: [] });
    expect(html).toContain('data-testid="a3-tutor-persona-loading"');
    expect(html).toContain('正在读取辅导方式');
  });

  it('renders four public options with selected and recommended states', () => {
    const html = renderSelector({
      personas,
      selectedPersonaId: 'socratic-guide',
      recommendedPersonaId: 'foundation-coach',
    });

    expect((html.match(/data-testid="a3-tutor-persona-option-/g) || []).length).toBe(4);
    expect(html).toContain('data-testid="a3-tutor-persona-option-socratic-guide"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('适合当前基础');
    expect(html).not.toContain('strategyInstruction');
    expect(html).not.toContain('openaiVoice');
    expect(html).not.toContain('dashscopeVoice');
  });

  it('renders stable icon preview controls and an explicit unavailable state', () => {
    const html = renderSelector({
      personas: [personas[0], { ...personas[1], voicePreviewEnabled: false }],
    });

    expect(html).toContain('data-testid="a3-tutor-voice-preview-structured-teacher"');
    expect(html).toContain('aria-label="试听结构讲解音色"');
    expect(html).toContain('data-slot="tooltip-trigger"');
    expect(html).toContain('size-8');
    expect(html).toContain('aria-label="启发追问音色试听不可用"');
    expect(html).toContain('不可试听');
  });

  it('previews without selecting and sends only personaId', async () => {
    const onSelect = vi.fn();
    fetchMock.mockResolvedValue(audioResponse(new Blob(['voice'])));
    mountSelector({
      personas,
      selectedPersonaId: 'socratic-guide',
      onSelect,
    });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();

    expect(onSelect).not.toHaveBeenCalled();
    expect(query('[data-testid="a3-tutor-persona-option-socratic-guide"]').getAttribute('aria-checked')).toBe('true');
    expect(fetchMock).toHaveBeenCalledWith('/api/a3/tutors/voice-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ personaId: 'structured-teacher' }),
      signal: expect.any(AbortSignal),
    });
    expect(query('[data-testid="a3-tutor-voice-preview-structured-teacher"]').getAttribute('aria-label')).toBe('停止试听结构讲解音色');
  });

  it('aborts an old request and ignores its stale completion after rapid clicks', async () => {
    const first = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(audioResponse(new Blob(['second'])));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    click('[data-testid="a3-tutor-voice-preview-practice-coach"]');
    await flushEffects();

    expect(firstSignal.aborted).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    expect(query('[data-testid="a3-tutor-voice-preview-practice-coach"]').getAttribute('aria-label')).toBe('停止试听例题实战音色');

    first.resolve(audioResponse(new Blob(['stale'])));
    await flushEffects();

    expect(FakeAudio.instances).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(query('[data-testid="a3-tutor-voice-preview-practice-coach"]').getAttribute('aria-label')).toBe('停止试听例题实战音色');
  });

  it('stops and revokes playing audio before another preview', async () => {
    fetchMock
      .mockResolvedValueOnce(audioResponse(new Blob(['first'])))
      .mockResolvedValueOnce(audioResponse(new Blob(['second'])));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const firstAudio = FakeAudio.instances[0];
    const firstUrl = firstAudio.src;

    click('[data-testid="a3-tutor-voice-preview-foundation-coach"]');
    await flushEffects();

    expect(firstAudio.pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(query('[data-testid="a3-tutor-voice-preview-foundation-coach"]').getAttribute('aria-label')).toBe('停止试听基础补强音色');
  });

  it('stops the same preview without issuing another request', async () => {
    fetchMock.mockResolvedValue(audioResponse(new Blob(['voice'])));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const audio = FakeAudio.instances[0];

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(audio.src);
    expect(query('[data-testid="a3-tutor-voice-preview-structured-teacher"]').getAttribute('aria-label')).toBe('试听结构讲解音色');
  });

  it('returns to idle and releases audio when playback ends', async () => {
    fetchMock.mockResolvedValue(audioResponse(new Blob(['voice'])));
    mountSelector({ personas });
    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const audio = FakeAudio.instances[0];

    act(() => audio.emit('ended'));

    expect(revokeObjectURL).toHaveBeenCalledWith(audio.src);
    expect(query('[data-testid="a3-tutor-voice-preview-structured-teacher"]').getAttribute('aria-label')).toBe('试听结构讲解音色');
  });

  it('reports an audio element error once in Chinese and releases resources', async () => {
    const playback = deferred<void>();
    FakeAudio.playResults.push(playback.promise);
    fetchMock.mockResolvedValue(audioResponse(new Blob(['voice'])));
    mountSelector({ personas });
    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const audio = FakeAudio.instances[0];

    act(() => audio.emit('error'));
    playback.reject(new Error('provider secret detail'));
    await flushEffects();

    expect(document.body.textContent).toContain('音频播放失败，请重试');
    expect(document.body.textContent).not.toContain('provider secret detail');
    expect(document.querySelectorAll('[data-testid="a3-tutor-voice-preview-error"]')).toHaveLength(1);
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(audio.src);
  });

  it('reports an immediate play rejection once in Chinese and releases resources', async () => {
    FakeAudio.playResults.push(Promise.reject(new Error('NotAllowedError: internal detail')));
    fetchMock.mockResolvedValue(audioResponse(new Blob(['voice'])));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();

    const audio = FakeAudio.instances[0];
    expect(document.body.textContent).toContain('音频播放失败，请重试');
    expect(document.body.textContent).not.toContain('NotAllowedError');
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('ignores stale play rejection and audio error after switching previews', async () => {
    const firstPlayback = deferred<void>();
    FakeAudio.playResults.push(firstPlayback.promise, Promise.resolve());
    fetchMock
      .mockResolvedValueOnce(audioResponse(new Blob(['first'])))
      .mockResolvedValueOnce(audioResponse(new Blob(['second'])));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const firstAudio = FakeAudio.instances[0];
    click('[data-testid="a3-tutor-voice-preview-practice-coach"]');
    await flushEffects();

    firstPlayback.reject(new Error('stale playback failure'));
    act(() => firstAudio.emit('error'));
    await flushEffects();

    expect(document.querySelector('[data-testid="a3-tutor-voice-preview-error"]')).toBeNull();
    expect(query('[data-testid="a3-tutor-voice-preview-practice-coach"]').getAttribute('aria-label')).toBe('停止试听例题实战音色');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(firstAudio.src);
  });

  it('parses trusted JSON errors and hides ordinary response content', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse({ error: '当前未配置音色试听' }, 'application/json'))
      .mockResolvedValueOnce(errorResponse('provider=secret-key', 'text/plain'));
    mountSelector({ personas });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    expect(document.body.textContent).toContain('当前未配置音色试听');

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    expect(document.body.textContent).toContain('音色试听失败，请稍后重试');
    expect(document.body.textContent).not.toContain('secret-key');
  });

  it('does not request unavailable previews', () => {
    mountSelector({ personas: [{ ...personas[0], voicePreviewEnabled: false }] });

    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses roving tab stops and falls back to the first enabled option', () => {
    mountSelector({
      personas: [
        { ...personas[0], enabled: false },
        personas[1],
        personas[2],
      ],
      selectedPersonaId: '',
    });

    expect(option('structured-teacher').tabIndex).toBe(-1);
    expect(option('structured-teacher').disabled).toBe(true);
    expect(option('socratic-guide').tabIndex).toBe(0);
    expect(option('practice-coach').tabIndex).toBe(-1);
  });

  it('moves selection with arrows, skips disabled options, and wraps', () => {
    const onSelect = vi.fn();
    mountSelector({
      personas: [
        personas[0],
        personas[1],
        { ...personas[2], enabled: false },
        personas[3],
      ],
      selectedPersonaId: 'socratic-guide',
      onSelect,
    });

    keydown(option('socratic-guide'), 'ArrowRight');
    expect(document.activeElement).toBe(option('foundation-coach'));
    expect(onSelect).toHaveBeenNthCalledWith(1, 'foundation-coach');

    keydown(option('foundation-coach'), 'ArrowDown');
    expect(document.activeElement).toBe(option('structured-teacher'));
    expect(onSelect).toHaveBeenNthCalledWith(2, 'structured-teacher');

    keydown(option('structured-teacher'), 'ArrowLeft');
    expect(document.activeElement).toBe(option('foundation-coach'));
    expect(onSelect).toHaveBeenNthCalledWith(3, 'foundation-coach');
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('moves to the first and last enabled options with Home and End', () => {
    const onSelect = vi.fn();
    mountSelector({
      personas: [
        personas[0],
        { ...personas[1], enabled: false },
        personas[2],
        personas[3],
      ],
      selectedPersonaId: 'practice-coach',
      onSelect,
    });

    keydown(option('practice-coach'), 'Home');
    expect(document.activeElement).toBe(option('structured-teacher'));
    expect(onSelect).toHaveBeenNthCalledWith(1, 'structured-teacher');

    keydown(option('structured-teacher'), 'End');
    expect(document.activeElement).toBe(option('foundation-coach'));
    expect(onSelect).toHaveBeenNthCalledWith(2, 'foundation-coach');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('stops preview-button keyboard events before they can select a persona', () => {
    const onSelect = vi.fn();
    const bubbled = vi.fn();
    mountSelectorWithKeyObserver(
      { personas, selectedPersonaId: 'socratic-guide', onSelect },
      bubbled,
    );

    keydown(query('[data-testid="a3-tutor-voice-preview-structured-teacher"]'), 'ArrowRight');

    expect(bubbled).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(option('socratic-guide').getAttribute('aria-checked')).toBe('true');
  });

  it('aborts pending work and releases playing audio on unmount', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    mountSelector({ personas });
    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(signal.aborted).toBe(true);

    fetchMock.mockResolvedValueOnce(audioResponse(new Blob(['voice'])));
    document.body.innerHTML = '<div id="root"></div>';
    mountSelector({ personas });
    click('[data-testid="a3-tutor-voice-preview-structured-teacher"]');
    await flushEffects();
    const audio = FakeAudio.instances[0];

    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith(audio.src);
  });

  it('renders retry recovery without hiding the options', () => {
    const html = renderSelector({ personas, error: '辅导方式暂时无法加载' });
    expect(html).toContain('辅导方式暂时无法加载');
    expect(html).toContain('data-testid="a3-tutor-persona-retry"');
    expect(html).toContain('结构讲解');
  });

  it('loads and patches the canonical preference endpoint', async () => {
    const response = {
      success: true,
      personas,
      preference: {
        personaId: 'practice-coach' as const,
        source: 'saved' as const,
        schemaVersion: 'a3.tutor-preference.v1',
        updatedAt: '',
      },
      selectedPersona: personas[2],
    };
    apiMocks.get.mockResolvedValue(response);
    apiMocks.patch.mockResolvedValue(response);

    await expect(loadTutorPersonaPreference()).resolves.toEqual(response);
    await expect(saveTutorPersonaPreference('practice-coach')).resolves.toEqual(response);
    expect(apiMocks.get).toHaveBeenCalledWith('/api/profiles/tutor-preference/');
    expect(apiMocks.patch).toHaveBeenCalledWith('/api/profiles/tutor-preference/', {
      personaId: 'practice-coach',
    });
  });
});

function renderSelector(overrides: Partial<Parameters<typeof TutorPersonaSelector>[0]>) {
  return renderToStaticMarkup(createElement(TutorPersonaSelector, selectorProps(overrides)));
}

function mountSelector(overrides: Partial<Parameters<typeof TutorPersonaSelector>[0]>) {
  const container = document.querySelector('#root');
  if (!container) throw new Error('Missing test root');
  mountedRoot = createRoot(container);
  act(() => mountedRoot?.render(createElement(TutorPersonaSelector, selectorProps(overrides))));
}

function mountSelectorWithKeyObserver(
  overrides: Partial<Parameters<typeof TutorPersonaSelector>[0]>,
  onKeyDown: () => void,
) {
  const container = document.querySelector('#root');
  if (!container) throw new Error('Missing test root');
  mountedRoot = createRoot(container);
  act(() => mountedRoot?.render(createElement(
    'div',
    { onKeyDown },
    createElement(TutorPersonaSelector, selectorProps(overrides)),
  )));
}

function selectorProps(overrides: Partial<Parameters<typeof TutorPersonaSelector>[0]>) {
  return {
    personas: [],
    selectedPersonaId: '' as const,
    recommendedPersonaId: '' as const,
    loading: false,
    saving: false,
    error: '',
    onSelect: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(selector: string) {
  act(() => {
    query(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function keydown(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function query(selector: string) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element as HTMLElement;
}

function option(personaId: A3TutorPersona['id']) {
  return query(`[data-testid="a3-tutor-persona-option-${personaId}"]`) as HTMLButtonElement;
}

function persona(
  id: A3TutorPersona['id'],
  name: string,
  shortDescription: string,
): A3TutorPersona {
  return {
    id,
    name,
    shortDescription,
    teachingStyle: id,
    avatarAssetId: 'teacher-default-v1',
    avatarPublicPath: '/a3/assets/teacher-avatar/teacher.vrm',
    voiceProfileId: `voice-${id}`,
    voicePreviewEnabled: true,
    allowedWorkflows: ['coaching', 'classroom'],
    schemaVersion: 'a3.tutor-persona.v1',
  };
}

function audioResponse(blob: Blob) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': blob.type || 'audio/mpeg' }),
    blob: vi.fn().mockResolvedValue(blob),
  } as unknown as Response;
}

function errorResponse(body: unknown, contentType: string) {
  return {
    ok: false,
    headers: new Headers({ 'content-type': contentType }),
    json: vi.fn().mockImplementation(async () => {
      if (contentType !== 'application/json') throw new SyntaxError('not json');
      return body;
    }),
  } as unknown as Response;
}

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  static playResults: Promise<void>[] = [];
  readonly src: string;
  readonly pause = vi.fn();
  readonly play = vi.fn<() => Promise<void>>();
  onended: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(src: string) {
    super();
    this.src = src;
    this.play.mockReturnValue(FakeAudio.playResults.shift() || Promise.resolve());
    FakeAudio.instances.push(this);
  }

  emit(name: 'ended' | 'error') {
    const event = new Event(name);
    if (name === 'ended') this.onended?.(event);
    else this.onerror?.(event);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
