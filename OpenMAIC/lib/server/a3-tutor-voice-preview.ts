import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { generateTTS as generateProviderTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_MODELS } from '@/lib/audio/constants';
import type { TTSModelConfig, TTSProviderId } from '@/lib/audio/types';
import type { A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';
import { resolveA3TutorPersonaRuntime } from '@/lib/server/a3-tutor-persona-runtime';
import {
  getServerTTSProviders,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';

export const TUTOR_VOICE_PREVIEW_TIMEOUT_MS = 15_000;
const CACHE_VERSION = 'v1';
const DEFAULT_CACHE_DIR = '/app/data/tutor-previews';
const CACHE_FORMATS = ['mp3', 'wav', 'ogg', 'aac', 'flac'] as const;

const PREVIEW_TEXT: Record<A3TutorPersonaId, string> = {
  'structured-teacher': '你好，我会先搭建知识框架，再分步骤帮你理解今天的内容。',
  'socratic-guide': '你好，我会用关键问题引导你思考，一步步找到自己的答案。',
  'practice-coach': '你好，我们会通过例题练习和即时反馈，巩固你的薄弱环节。',
  'foundation-coach': '你好，我会从基础概念开始，用短句和小步骤陪你学会。',
};

type SupportedProviderId = 'qwen-tts' | 'openai-tts';
type GeneratedAudio = { audio: Uint8Array; format: string };
type PreviewProvider = {
  providerId: SupportedProviderId;
  model: string;
  voice: string;
  cacheKey: string;
};

export type TutorVoicePreviewRuntime = {
  cacheDir?: string;
  getConfiguredProviders?: () => Record<string, { baseUrl?: string }>;
  resolveApiKey?: (providerId: string) => string;
  resolveBaseUrl?: (providerId: string) => string | undefined;
  generateTTS?: (
    config: TTSModelConfig,
    text: string,
    signal: AbortSignal,
  ) => Promise<GeneratedAudio>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TutorVoicePreviewGenerate = NonNullable<TutorVoicePreviewRuntime['generateTTS']>;

export type TutorVoicePreview = {
  audio: Buffer;
  contentType: string;
  cacheKey: string;
  cacheHit: boolean;
};

export class TutorVoicePreviewError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TutorVoicePreviewError';
  }
}

type InFlightEntry = {
  promise: Promise<TutorVoicePreview>;
  controller: AbortController;
  waiterCount: number;
  settled: boolean;
};

const inFlight = new Map<string, InFlightEntry>();

export async function generateTutorVoicePreview(
  personaId: A3TutorPersonaId,
  runtime: TutorVoicePreviewRuntime = {},
): Promise<TutorVoicePreview> {
  const configured = (runtime.getConfiguredProviders || getServerTTSProviders)();
  const providers = (['qwen-tts', 'openai-tts'] as const).filter((id) => configured[id]);
  if (providers.length === 0) throw new TutorVoicePreviewError(503, '当前未配置音色试听');

  const personaRuntime = resolveA3TutorPersonaRuntime(personaId);
  if (personaRuntime.fallbackUsed) throw new TutorVoicePreviewError(400, '不支持该辅导风格');
  if (runtime.signal?.aborted) throw abortError(true);

  const text = PREVIEW_TEXT[personaId];
  const directory =
    runtime.cacheDir || process.env.A3_TUTOR_PREVIEW_CACHE_DIR || DEFAULT_CACHE_DIR;
  const candidates = providers.map((providerId): PreviewProvider => {
    const model = DEFAULT_TTS_MODELS[providerId];
    const voice =
      providerId === 'qwen-tts'
        ? personaRuntime.dashscopeVoice
        : personaRuntime.openaiVoice;
    return {
      providerId,
      model,
      voice,
      cacheKey: createCacheKey(providerId, model, voice, text),
    };
  });
  const inFlightKey = `${directory}:${candidates.map(({ cacheKey }) => cacheKey).join(':')}`;
  let entry = inFlight.get(inFlightKey);
  if (!entry) {
    const controller = new AbortController();
    const promise = generateWithinDeadline(
      { candidates, directory, runtime, text },
      controller,
    );
    const createdEntry = { promise, controller, waiterCount: 0, settled: false };
    entry = createdEntry;
    inFlight.set(inFlightKey, createdEntry);
    promise.then(
      () => settleInFlight(inFlightKey, createdEntry),
      () => settleInFlight(inFlightKey, createdEntry),
    );
  }

  return waitForCaller(inFlightKey, entry, runtime.signal);
}

async function generateWithinDeadline(
  input: {
    candidates: PreviewProvider[];
    directory: string;
    runtime: TutorVoicePreviewRuntime;
    text: string;
  },
  controller: AbortController,
): Promise<TutorVoicePreview> {
  const timeout = setTimeout(
    () => controller.abort(),
    input.runtime.timeoutMs ?? TUTOR_VOICE_PREVIEW_TIMEOUT_MS,
  );

  try {
    for (const candidate of input.candidates) {
      if (controller.signal.aborted) throw abortError(false);
      try {
        return await generateForProvider({
          ...candidate,
          directory: input.directory,
          runtime: input.runtime,
          text: input.text,
          signal: controller.signal,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && error.name === 'AbortError') ||
          (error instanceof TutorVoicePreviewError && [499, 504].includes(error.status))
        ) {
          throw abortError(false);
        }
      }
    }
    throw new TutorVoicePreviewError(502, '音色试听生成失败，请稍后重试');
  } finally {
    clearTimeout(timeout);
  }
}

async function generateForProvider(input: {
  providerId: SupportedProviderId;
  model: string;
  cacheKey: string;
  directory: string;
  text: string;
  voice: string;
  runtime: TutorVoicePreviewRuntime;
  signal: AbortSignal;
}): Promise<TutorVoicePreview> {
  const cached = await readCachedAudio(input.directory, input.cacheKey);
  if (cached) return cached;

  return generateAndCache(input);
}

function createCacheKey(
  providerId: SupportedProviderId,
  model: string,
  voice: string,
  text: string,
) {
  return createHash('sha256')
    .update(JSON.stringify({ provider: providerId, model, voice, text, version: CACHE_VERSION }))
    .digest('hex');
}

function settleInFlight(key: string, entry: InFlightEntry) {
  entry.settled = true;
  if (inFlight.get(key) === entry) inFlight.delete(key);
}

function waitForCaller(
  key: string,
  entry: InFlightEntry,
  signal?: AbortSignal,
): Promise<TutorVoicePreview> {
  entry.waiterCount += 1;

  return new Promise((resolve, reject) => {
    let detached = false;
    let callerAborted = false;
    const detach = (cancelled: boolean) => {
      if (detached) return;
      detached = true;
      entry.waiterCount -= 1;
      if (cancelled && entry.waiterCount === 0 && !entry.settled) {
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry.controller.abort();
      }
    };
    const onAbort = () => {
      if (callerAborted) return;
      callerAborted = true;
      signal?.removeEventListener('abort', onAbort);
      detach(true);
      reject(abortError(true));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    entry.promise.then(
      (preview) => {
        signal?.removeEventListener('abort', onAbort);
        detach(false);
        resolve(preview);
      },
      (error) => {
        signal?.removeEventListener('abort', onAbort);
        detach(false);
        reject(error);
      },
    );
  });
}

async function readCachedAudio(
  directory: string,
  cacheKey: string,
): Promise<TutorVoicePreview | null> {
  for (const format of CACHE_FORMATS) {
    try {
      const bytes = await readFile(path.join(directory, `${cacheKey}.${format}`));
      if (bytes.length === 0) continue;
      return {
        audio: bytes,
        contentType: contentTypeFor(format),
        cacheKey,
        cacheHit: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function generateAndCache(input: {
  providerId: SupportedProviderId;
  model: string;
  voice: string;
  text: string;
  cacheKey: string;
  directory: string;
  runtime: TutorVoicePreviewRuntime;
  signal: AbortSignal;
}): Promise<TutorVoicePreview> {
  const generate = input.runtime.generateTTS || defaultGenerateTTS;
  const generated = await generate(
    {
      providerId: input.providerId as TTSProviderId,
      modelId: input.model,
      voice: input.voice,
      speed: 1,
      apiKey: (input.runtime.resolveApiKey || resolveTTSApiKey)(input.providerId),
      baseUrl: (input.runtime.resolveBaseUrl || resolveTTSBaseUrl)(input.providerId),
    },
    input.text,
    input.signal,
  );
  if (input.signal.aborted) throw abortError(false);
  const bytes = Buffer.from(generated.audio);
  if (bytes.length === 0) throw new Error('empty audio');

  const format = normalizeFormat(generated.format);
  await mkdir(input.directory, { recursive: true });
  await writeTutorVoicePreviewCache(
    path.join(input.directory, `${input.cacheKey}.${format}`),
    bytes,
  );
  return {
    audio: bytes,
    contentType: contentTypeFor(format),
    cacheKey: input.cacheKey,
    cacheHit: false,
  };
}

export async function writeTutorVoicePreviewCache(
  cachePath: string,
  bytes: Uint8Array,
  operations: {
    writeFile?: typeof writeFile;
    rename?: typeof rename;
    unlink?: typeof unlink;
  } = {},
): Promise<void> {
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  const writeTemporaryFile = operations.writeFile || writeFile;
  const renameFile = operations.rename || rename;
  const unlinkFile = operations.unlink || unlink;
  try {
    await writeTemporaryFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await renameFile(temporaryPath, cachePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await unlinkFile(temporaryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function defaultGenerateTTS(
  config: TTSModelConfig,
  text: string,
  signal: AbortSignal,
): Promise<GeneratedAudio> {
  return Promise.race([
    generateProviderTTS({ ...config, signal }, text),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    }),
  ]);
}

function abortError(requestAborted: boolean) {
  return requestAborted
    ? new TutorVoicePreviewError(499, '试听请求已取消')
    : new TutorVoicePreviewError(504, '音色试听生成超时，请稍后重试');
}

function normalizeFormat(format: string): (typeof CACHE_FORMATS)[number] {
  const normalized = format.toLowerCase();
  if (normalized === 'wave') return 'wav';
  return CACHE_FORMATS.includes(normalized as (typeof CACHE_FORMATS)[number])
    ? (normalized as (typeof CACHE_FORMATS)[number])
    : 'mp3';
}

function contentTypeFor(format: string) {
  if (format === 'wav' || format === 'wave') return 'audio/wav';
  if (format === 'ogg') return 'audio/ogg';
  if (format === 'aac') return 'audio/aac';
  if (format === 'flac') return 'audio/flac';
  return 'audio/mpeg';
}
