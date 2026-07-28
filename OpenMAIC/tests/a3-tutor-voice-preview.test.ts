import { mkdtemp, readFile, readdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QWEN_TTS_MAX_AUDIO_BYTES,
  generateTTS,
} from '@/lib/audio/tts-providers';
import {
  TUTOR_VOICE_PREVIEW_TIMEOUT_MS,
  generateTutorVoicePreview,
  writeTutorVoicePreviewCache,
  type TutorVoicePreviewGenerate,
  type TutorVoicePreviewRuntime,
} from '@/lib/server/a3-tutor-voice-preview';
import {
  createTutorVoicePreviewRateLimiter,
  createRedisTutorVoicePreviewRateLimiter,
  consumeTutorVoicePreviewRateLimit,
  getTutorVoicePreviewRedisOptions,
  resolveTutorVoicePreviewSessionKey,
  TutorVoicePreviewRequestError,
  validateTutorVoicePreviewPersona,
} from '@/lib/server/a3-tutor-config-client';

const audio = Buffer.from([0x49, 0x44, 0x33, 0x04]);
const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function cacheDir() {
  return mkdtemp(path.join(tmpdir(), 'a3-tutor-preview-'));
}

function runtime(
  directory: string,
  overrides: Partial<TutorVoicePreviewRuntime> = {},
): TutorVoicePreviewRuntime {
  return {
    cacheDir: directory,
    getConfiguredProviders: () => ({ 'qwen-tts': {}, 'openai-tts': {} }),
    resolveApiKey: (providerId) => `${providerId}-secret`,
    resolveBaseUrl: () => undefined,
    generateTTS: vi.fn<TutorVoicePreviewGenerate>(async () => ({ audio, format: 'mp3' })),
    ...overrides,
  };
}

describe('A3 tutor voice preview configuration', () => {
  it('uses only the explicit Django session cookie name and defaults to sessionid', () => {
    vi.stubEnv('DJANGO_SESSION_COOKIE_NAME', 'a3_sessionid');
    const first = resolveTutorVoicePreviewSessionKey(
      'tracking=one; a3_sessionid=same-session; experiment=a',
    );
    const second = resolveTutorVoicePreviewSessionKey(
      'tracking=two; a3_sessionid=same-session; experiment=b',
    );
    expect(first).toBe(second);
    expect(first).not.toContain('same-session');
    vi.stubEnv('DJANGO_SESSION_COOKIE_NAME', '');

    expect(resolveTutorVoicePreviewSessionKey('a3_sessionid=wrong; sessionid=standard')).toBe(
      resolveTutorVoicePreviewSessionKey('sessionid=standard'),
    );
    expect(() => resolveTutorVoicePreviewSessionKey('a3_sessionid=not-guessed')).toThrow('请先登录');
  });

  it('keeps the rate limiter strictly bounded and expires stale entries', () => {
    const limiter = createTutorVoicePreviewRateLimiter({
      maxEntries: 2,
      maxRequests: 1,
      windowMs: 100,
    });
    limiter.consume('session-a', 0);
    limiter.consume('session-b', 1);
    limiter.consume('session-c', 2);
    expect(limiter.size).toBe(2);
    expect(() => limiter.consume('session-a', 3)).not.toThrow();
    expect(limiter.size).toBe(2);
    expect(() => limiter.consume('session-a', 200)).not.toThrow();
  });

  it('uses one atomic Redis window counter keyed only by the session hash', async () => {
    const sessionHash = 'a'.repeat(64);
    const evalCommand = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(13);
    const limiter = createRedisTutorVoicePreviewRateLimiter(
      { eval: evalCommand },
      { maxRequests: 12, windowMs: 60_000 },
    );

    await expect(limiter.consume(sessionHash)).resolves.toBeUndefined();
    await expect(limiter.consume(sessionHash)).rejects.toMatchObject({ status: 429 });
    expect(evalCommand).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      `a3:tutor-preview-rate:${sessionHash}`,
      '60000',
    );
  });

  it('fails closed without leaking Redis details when the shared limiter fails', async () => {
    const limiter = createRedisTutorVoicePreviewRateLimiter(
      { eval: vi.fn(async () => { throw new Error('redis://secret-host:6379/3'); }) },
      { maxRequests: 12, windowMs: 60_000 },
    );
    const failure = await limiter.consume('b'.repeat(64)).catch((error) => error);
    expect(failure).toMatchObject({ status: 503 });
    expect(failure.message).not.toContain('redis');
    expect(failure.message).not.toContain('secret-host');
  });

  it('bounds Redis commands and keeps reconnecting with capped backoff', () => {
    const options = getTutorVoicePreviewRedisOptions();
    expect(options).toMatchObject({
      commandTimeout: 1_500,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
    });
    expect(options.retryStrategy(1)).toBeGreaterThan(0);
    expect(options.retryStrategy(20)).toBeLessThanOrEqual(1_000);
  });

  it('fails closed when production has no shared Redis URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('A3_TUTOR_PREVIEW_REDIS_URL', '');
    await expect(consumeTutorVoicePreviewRateLimit('c'.repeat(64))).rejects.toMatchObject({
      status: 503,
    });
  });

  it('keeps dev backend startup semantics while waiting for healthy Redis', async () => {
    const composePath = path.resolve(process.cwd(), '..', 'docker-compose.yml');
    const compose = loadYaml(await readFile(composePath, 'utf8')) as {
      services: {
        frontend: {
          depends_on: Record<string, { condition: string }>;
        };
      };
    };
    expect(compose.services.frontend.depends_on).toEqual({
      backend: { condition: 'service_started' },
      redis: { condition: 'service_healthy' },
    });
  });

  it('forwards the session cookie to Django and accepts only an enabled preview persona', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('cookie')).toBe('sessionid=student-session');
      return Response.json({
        success: true,
        personas: [
          { id: 'structured-teacher', voicePreviewEnabled: true },
          { id: 'practice-coach', voicePreviewEnabled: false },
        ],
      });
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      validateTutorVoicePreviewPersona('sessionid=student-session', 'structured-teacher'),
    ).resolves.toMatchObject({ id: 'structured-teacher' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invented-tutor', 400],
    ['practice-coach', 403],
  ])('rejects unknown or disabled persona %s', async (personaId, status) => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        personas: [
          { id: 'structured-teacher', voicePreviewEnabled: true },
          { id: 'practice-coach', voicePreviewEnabled: false },
        ],
      }),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(validateTutorVoicePreviewPersona('sessionid=ok', personaId)).rejects.toMatchObject({
      status,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('A3 tutor voice preview generation', () => {
  it('uses server-fixed normal Chinese copy and prioritizes Qwen over OpenAI', async () => {
    const directory = await cacheDir();
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(async () => ({ audio, format: 'mp3' }));

    await generateTutorVoicePreview(
      'structured-teacher',
      runtime(directory, { generateTTS }),
    );

    expect(generateTTS).toHaveBeenCalledTimes(1);
    expect(generateTTS.mock.calls[0]?.[0]).toMatchObject({ providerId: 'qwen-tts' });
    expect(generateTTS.mock.calls[0]?.[1]).toBe(
      '你好，我会先搭建知识框架，再分步骤帮你理解今天的内容。',
    );
  });

  it('falls back to OpenAI and returns a Chinese 503 error when neither provider exists', async () => {
    const directory = await cacheDir();
    const openaiGenerate = vi.fn<TutorVoicePreviewGenerate>(async () => ({ audio, format: 'mp3' }));
    await generateTutorVoicePreview(
      'socratic-guide',
      runtime(directory, {
        getConfiguredProviders: () => ({ 'openai-tts': {} }),
        generateTTS: openaiGenerate,
      }),
    );
    expect(openaiGenerate.mock.calls[0]?.[0]).toMatchObject({ providerId: 'openai-tts' });

    await expect(
      generateTutorVoicePreview(
        'socratic-guide',
        runtime(await cacheDir(), { getConfiguredProviders: () => ({}) }),
      ),
    ).rejects.toMatchObject({ status: 503, message: '当前未配置音色试听' });
  });

  it('falls back from Qwen to OpenAI within one shared deadline', async () => {
    const calls: string[] = [];
    const startedAt = Date.now();
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(async (config, _text, signal) => {
      calls.push(config.providerId);
      if (config.providerId === 'qwen-tts') {
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error('qwen unavailable');
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    await expect(
      generateTutorVoicePreview(
        'structured-teacher',
        runtime(await cacheDir(), { generateTTS, timeoutMs: 120 }),
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect(calls).toEqual(['qwen-tts', 'openai-tts']);
    expect(Date.now() - startedAt).toBeLessThan(190);
  });

  it('logs provider failures without exposing credentials or signed audio URLs', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(async () => {
      throw new Error(
        'provider failed with sk-production-secret at https://example.com/audio.wav?token=signed-secret',
      );
    });

    await expect(
      generateTutorVoicePreview(
        'structured-teacher',
        runtime(await cacheDir(), {
          getConfiguredProviders: () => ({ 'qwen-tts': {} }),
          generateTTS,
        }),
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(warning).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).toContain('qwen-tts');
    expect(logged).toContain('provider failed');
    expect(logged).not.toContain('sk-production-secret');
    expect(logged).not.toContain('signed-secret');
    expect(logged).not.toContain('https://example.com');
  });

  it('does not fall back after request cancellation', async () => {
    const controller = new AbortController();
    let providerSignal!: AbortSignal;
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(
      (_config, _text, signal) => {
        providerSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      },
    );
    const pending = generateTutorVoicePreview(
      'structured-teacher',
      runtime(await cacheDir(), { generateTTS, signal: controller.signal }),
    );
    await vi.waitFor(() => expect(generateTTS).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499 });
    expect(providerSignal.aborted).toBe(true);
    expect(generateTTS).toHaveBeenCalledTimes(1);
  });

  it('isolates caller aborts from a shared in-flight provider generation', async () => {
    const directory = await cacheDir();
    const firstController = new AbortController();
    const secondController = new AbortController();
    let release!: () => void;
    let providerSignal!: AbortSignal;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(async (_config, _text, signal) => {
      providerSignal = signal;
      await gate;
      return { audio, format: 'mp3' };
    });
    const shared = runtime(directory, { generateTTS, timeoutMs: 500 });

    const first = generateTutorVoicePreview('structured-teacher', {
      ...shared,
      signal: firstController.signal,
    });
    const second = generateTutorVoicePreview('structured-teacher', {
      ...shared,
      signal: secondController.signal,
    });
    await vi.waitFor(() => expect(generateTTS).toHaveBeenCalledTimes(1));
    firstController.abort();
    await expect(first).rejects.toMatchObject({ status: 499 });
    expect(providerSignal.aborted).toBe(false);
    release();
    await expect(second).resolves.toMatchObject({ contentType: 'audio/mpeg' });
    expect(generateTTS).toHaveBeenCalledTimes(1);
  });

  it('handles an abort that occurs while the caller listener is registered', async () => {
    const signal = {
      aborted: false,
      addEventListener: vi.fn(function (this: { aborted: boolean }) {
        this.aborted = true;
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const generateTTS = vi.fn<TutorVoicePreviewGenerate>(
      (_config, _text, internalSignal) => {
        return new Promise((_resolve, reject) => {
          internalSignal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      },
    );

    await expect(generateTutorVoicePreview(
      'structured-teacher',
      runtime(await cacheDir(), { generateTTS, signal, timeoutMs: 100 }),
    )).rejects.toMatchObject({ status: 499 });
    expect(signal.addEventListener).toHaveBeenCalledWith('abort', expect.any(Function), {
      once: true,
    });
    expect(generateTTS).not.toHaveBeenCalled();
  });

  it('aborts generation after exactly 15 seconds', async () => {
    expect(TUTOR_VOICE_PREVIEW_TIMEOUT_MS).toBe(15_000);
    const generateTTS = vi.fn(
      (_config: unknown, _text: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const pending = generateTutorVoicePreview(
      'practice-coach',
      runtime(await cacheDir(), { generateTTS, timeoutMs: 200 }),
    );

    await vi.waitFor(() => expect(generateTTS).toHaveBeenCalledTimes(1));
    expect(generateTTS.mock.calls[0]?.[2].aborted).toBe(false);
    await expect(pending).rejects.toMatchObject({ status: 504 });
    expect(generateTTS.mock.calls[0]?.[2].aborted).toBe(true);
  });

  it('forwards the abort signal to the underlying supported provider request', async () => {
    const fetchMock = vi.fn(
      (_input: string | URL | Request, _init?: RequestInit) => new Promise<Response>(() => undefined),
    );
    global.fetch = fetchMock as typeof fetch;
    const pending = generateTutorVoicePreview('structured-teacher', {
      cacheDir: await cacheDir(),
      getConfiguredProviders: () => ({ 'qwen-tts': {} }),
      resolveApiKey: () => 'server-secret',
      resolveBaseUrl: () => undefined,
      timeoutMs: 200,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await expect(pending).rejects.toMatchObject({ status: 504 });
    expect(signal?.aborted).toBe(true);
  });

  it('keeps one in-flight provider call per versioned SHA256 cache key', async () => {
    const directory = await cacheDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generateTTS = vi.fn(async () => {
      await gate;
      return { audio, format: 'mp3' };
    });
    const configured = runtime(directory, { generateTTS });

    const first = generateTutorVoicePreview('foundation-coach', configured);
    const second = generateTutorVoicePreview('foundation-coach', configured);
    await vi.waitFor(() => expect(generateTTS).toHaveBeenCalledTimes(1));
    release();

    const previews = await Promise.all([first, second]);
    expect(previews[0].audio.equals(previews[1].audio)).toBe(true);
    expect(previews[0].cacheKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('serves a persistent cache hit and stores only audio bytes', async () => {
    const directory = await cacheDir();
    const generated = await generateTutorVoicePreview('structured-teacher', runtime(directory));
    const failIfCalled = vi.fn(async () => {
      throw new Error('provider must not run on a persistent cache hit');
    });

    const cached = await generateTutorVoicePreview(
      'structured-teacher',
      runtime(directory, { generateTTS: failIfCalled }),
    );

    expect(cached.cacheHit).toBe(true);
    expect(failIfCalled).not.toHaveBeenCalled();
    const files = await readdir(directory);
    expect(files).toEqual([`${generated.cacheKey}.mp3`]);
    expect(await readFile(path.join(directory, files[0]!))).toEqual(audio);
    expect(cached.contentType).toBe(generated.contentType);
  });

  it('cleans temporary cache files after rename conflicts and failures', async () => {
    const directory = await cacheDir();
    const target = path.join(directory, 'preview.mp3');
    await expect(
      writeTutorVoicePreviewCache(target, audio, {
        rename: vi.fn(async () => {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }),
      }),
    ).resolves.toBeUndefined();
    expect(await readdir(directory)).toEqual([]);

    await expect(
      writeTutorVoicePreviewCache(target, audio, {
        rename: vi.fn(async () => {
          throw new Error('disk failure');
        }),
      }),
    ).rejects.toThrow('disk failure');
    expect(await readdir(directory)).toEqual([]);
  });

  it('cleans a partially written temporary file when writeFile fails', async () => {
    const directory = await cacheDir();
    const target = path.join(directory, 'preview.mp3');
    await expect(
      writeTutorVoicePreviewCache(target, audio, {
        writeFile: async (temporaryPath, bytes) => {
          await fsWriteFile(temporaryPath, bytes);
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
      }),
    ).rejects.toThrow('disk full');
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('Qwen preview audio download security', () => {
  const qwenConfig = {
    providerId: 'qwen-tts' as const,
    apiKey: 'server-secret',
    voice: 'Cherry',
  };

  it('accepts regional DashScope result buckets on official Aliyun OSS hosts', async () => {
    const audioUrl =
      'https://dashscope-result-gd.oss-cn-shenzhen.aliyuncs.com/generated/audio.wav?signature=test';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output: { audio: { url: audioUrl } } }))
      .mockResolvedValueOnce(
        new Response(audio, { headers: { 'content-type': 'audio/x-wav' } }),
      ) as typeof fetch;

    await expect(generateTTS(qwenConfig, '你好')).resolves.toMatchObject({ format: 'wav' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav',
    'https://localhost/audio.wav',
    'https://127.0.0.1/audio.wav',
    'https://example.com/audio.wav',
    'https://example.aliyuncs.com/audio.wav',
    'https://dashscope-result-bj.evil.aliyuncs.com/audio.wav',
  ])('rejects untrusted Qwen audio URL %s', async (audioUrl) => {
    global.fetch = vi.fn(async () =>
      Response.json({ output: { audio: { url: audioUrl } } }),
    ) as typeof fetch;
    await expect(generateTTS(qwenConfig, '你好')).rejects.toThrow(/Qwen TTS audio URL/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects redirects from an allowlisted Qwen audio host', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        output: {
          audio: {
            url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav',
          },
        },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private' },
      })) as typeof fetch;
    await expect(generateTTS(qwenConfig, '你好')).rejects.toThrow(/redirect/i);
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
      redirect: 'manual',
    });
  });

  it('rejects declared and streamed Qwen audio larger than 5 MB', async () => {
    const trustedUrl = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav';
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output: { audio: { url: trustedUrl } } }))
      .mockResolvedValueOnce(new Response(new Uint8Array(1), {
        headers: { 'content-length': String(QWEN_TTS_MAX_AUDIO_BYTES + 1) },
      })) as typeof fetch;
    await expect(generateTTS(qwenConfig, '你好')).rejects.toThrow(/too large/i);

    const cancelSpy = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(QWEN_TTS_MAX_AUDIO_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelSpy,
    });
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ output: { audio: { url: trustedUrl } } }))
      .mockResolvedValueOnce(new Response(oversized)) as typeof fetch;
    await expect(generateTTS(qwenConfig, '你好')).rejects.toThrow(/too large/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI preview audio download limits', () => {
  const openaiConfig = {
    providerId: 'openai-tts' as const,
    apiKey: 'server-secret',
    voice: 'alloy',
  };

  it('rejects declared OpenAI audio larger than 5 MB', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array(1), {
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(QWEN_TTS_MAX_AUDIO_BYTES + 1),
      },
    })) as typeof fetch;
    await expect(generateTTS(openaiConfig, '你好')).rejects.toThrow(/too large/i);
  });

  it('cancels streamed OpenAI audio after the actual 5 MB limit', async () => {
    const cancelSpy = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(QWEN_TTS_MAX_AUDIO_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelSpy,
    });
    global.fetch = vi.fn(async () => new Response(oversized, {
      headers: { 'content-type': 'audio/mpeg' },
    })) as typeof fetch;
    await expect(generateTTS(openaiConfig, '你好')).rejects.toThrow(/too large/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized non-2xx OpenAI error body at 64 KB', async () => {
    const cancelSpy = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelSpy,
    });
    global.fetch = vi.fn(async () => new Response(oversized, {
      status: 500,
      statusText: 'Provider failure',
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await expect(generateTTS(openaiConfig, '你好')).rejects.toThrow(/too large/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe('A3 tutor voice preview route security', () => {
  it.each([
    ['text/plain', 'http://localhost', 415],
    ['application/json', 'https://evil.example', 403],
  ])('rejects unsafe content type or origin before Django', async (contentType, origin, status) => {
    const { POST } = await import('@/app/api/a3/tutors/voice-preview/route');
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    const response = await POST(new Request('http://localhost/api/a3/tutors/voice-preview', {
      method: 'POST',
      headers: {
        cookie: 'a3_sessionid=security-test',
        'content-type': contentType,
        origin,
      },
      body: JSON.stringify({ personaId: 'structured-teacher' }),
    }));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects declared and actual oversized JSON before Django', async () => {
    const { POST } = await import('@/app/api/a3/tutors/voice-preview/route');
    const fetchMock = vi.fn();
    global.fetch = fetchMock as typeof fetch;
    const declared = await POST(new Request('http://localhost/api/a3/tutors/voice-preview', {
      method: 'POST',
      headers: {
        cookie: 'a3_sessionid=size-declared',
        'content-type': 'application/json',
        'content-length': '99999',
      },
      body: '{}',
    }));
    const actual = await POST(new Request('http://localhost/api/a3/tutors/voice-preview', {
      method: 'POST',
      headers: {
        cookie: 'a3_sessionid=size-actual',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ personaId: 'structured-teacher', padding: 'x'.repeat(3_000) }),
    }));
    expect(declared.status).toBe(413);
    expect(actual.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let garbage cookies bypass the pre-Django session limiter', async () => {
    vi.stubEnv('DJANGO_SESSION_COOKIE_NAME', 'a3_sessionid');
    const { handleTutorVoicePreview } = await import('@/app/api/a3/tutors/voice-preview/route');
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      personas: [{ id: 'structured-teacher', voicePreviewEnabled: true }],
    }));
    global.fetch = fetchMock as typeof fetch;
    const configured = runtime(await cacheDir());
    let response!: Response;
    for (let index = 0; index < 13; index += 1) {
      response = await handleTutorVoicePreview(new Request('http://localhost/api/a3/tutors/voice-preview', {
        method: 'POST',
        headers: {
          cookie: `a3_sessionid=bounded-session; garbage=${index}`,
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ personaId: 'structured-teacher' }),
      }), configured);
    }
    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(13);
  });

  it('requires a cookie before reading the request body', async () => {
    const { handleTutorVoicePreview } = await import(
      '@/app/api/a3/tutors/voice-preview/route'
    );
    const response = await handleTutorVoicePreview(
      new Request('http://localhost/api/a3/tutors/voice-preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId: 'structured-teacher' }),
      }),
      runtime(await cacheDir()),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false, error: '请先登录' });
  });

  it('returns binary audio with no provider metadata in headers or body', async () => {
    const { handleTutorVoicePreview } = await import(
      '@/app/api/a3/tutors/voice-preview/route'
    );
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/profiles/tutor-preference/')) {
        return Response.json({
          success: true,
          personas: [{ id: 'structured-teacher', voicePreviewEnabled: true }],
        });
      }
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } });
    }) as typeof fetch;

    const response = await handleTutorVoicePreview(
      new Request('http://localhost/api/a3/tutors/voice-preview', {
        method: 'POST',
        headers: {
          cookie: 'sessionid=student-session',
          'content-type': 'application/json',
          'x-forwarded-for': '192.0.2.4',
        },
        body: JSON.stringify({ personaId: 'structured-teacher' }),
      }),
      runtime(await cacheDir()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    const headers = JSON.stringify(Object.fromEntries(response.headers)).toLowerCase();
    expect(headers).not.toMatch(/provider|voice|model|path|url|key/);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(audio);
  });
});

it('exposes typed request failures without leaking private details', () => {
  const error = new TutorVoicePreviewRequestError(400, '不支持该辅导风格');
  expect(error).toMatchObject({ status: 400, message: '不支持该辅导风格' });
});
