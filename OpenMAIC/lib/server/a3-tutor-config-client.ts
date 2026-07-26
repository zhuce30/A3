import { createHash } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';

import type { A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';

type TutorPreviewPersona = {
  id: A3TutorPersonaId;
  voicePreviewEnabled?: boolean;
};

type TutorPreferenceResponse = {
  personas?: TutorPreviewPersona[];
};

const PERSONA_IDS = new Set<A3TutorPersonaId>([
  'structured-teacher',
  'socratic-guide',
  'practice-coach',
  'foundation-coach',
]);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const RATE_LIMIT_MAX_ENTRIES = 2_000;
const REDIS_RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return current
`.trim();

export class TutorVoicePreviewRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TutorVoicePreviewRequestError';
  }
}

export async function validateTutorVoicePreviewPersona(
  cookieHeader: string | null,
  personaId: string,
): Promise<TutorPreviewPersona> {
  if (!cookieHeader) throw new TutorVoicePreviewRequestError(401, '请先登录');

  const response = await fetchA3DjangoJson<TutorPreferenceResponse>(
    '/api/profiles/tutor-preference/',
    cookieHeader,
  );
  if (!response.success) {
    const unauthorized = response.error === '请先登录';
    throw new TutorVoicePreviewRequestError(
      unauthorized ? 401 : 502,
      unauthorized ? '请先登录' : '导师配置暂时不可用',
    );
  }
  if (!PERSONA_IDS.has(personaId as A3TutorPersonaId)) {
    throw new TutorVoicePreviewRequestError(400, '不支持该辅导风格');
  }

  const persona = response.personas?.find((item) => item.id === personaId);
  if (!persona || persona.voicePreviewEnabled === false) {
    throw new TutorVoicePreviewRequestError(403, '当前辅导风格暂不可试听');
  }
  return persona;
}

type RateLimitEntry = { timestamps: number[]; touchedAt: number };

export function resolveTutorVoicePreviewSessionKey(cookieHeader: string | null): string {
  const configuredName = process.env.DJANGO_SESSION_COOKIE_NAME?.trim();
  const sessionCookieName = configuredName || 'sessionid';
  const cookies = new Map<string, string>();
  for (const part of (cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) cookies.set(name, value);
  }
  const sessionValue = cookies.get(sessionCookieName);
  if (!sessionValue) throw new TutorVoicePreviewRequestError(401, '请先登录');
  return createHash('sha256').update(sessionValue).digest('hex');
}

export function createTutorVoicePreviewRateLimiter(options: {
  maxEntries: number;
  maxRequests: number;
  windowMs: number;
}) {
  const entries = new Map<string, RateLimitEntry>();
  return {
    get size() {
      return entries.size;
    },
    consume(key: string, now = Date.now()) {
      for (const [candidate, entry] of entries) {
        if (now - entry.touchedAt >= options.windowMs) entries.delete(candidate);
      }

      const current = entries.get(key);
      const timestamps = (current?.timestamps || []).filter(
        (timestamp) => now - timestamp < options.windowMs,
      );
      if (!current) {
        while (entries.size >= options.maxEntries) {
          const oldest = entries.keys().next().value as string | undefined;
          if (!oldest) break;
          entries.delete(oldest);
        }
      } else {
        entries.delete(key);
      }
      entries.set(key, { timestamps, touchedAt: now });
      if (timestamps.length >= options.maxRequests) {
        throw new TutorVoicePreviewRequestError(429, '试听请求过于频繁，请稍后重试');
      }
      timestamps.push(now);
    },
  };
}

type RedisEvalClient = {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
};

export function createRedisTutorVoicePreviewRateLimiter(
  redis: RedisEvalClient,
  options: { maxRequests: number; windowMs: number },
) {
  return {
    async consume(sessionHash: string): Promise<void> {
      let rawCount: unknown;
      try {
        rawCount = await redis.eval(
          REDIS_RATE_LIMIT_SCRIPT,
          1,
          `a3:tutor-preview-rate:${sessionHash}`,
          String(options.windowMs),
        );
      } catch {
        throw new TutorVoicePreviewRequestError(503, '音色试听限流服务暂时不可用');
      }
      const count = Number(rawCount);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new TutorVoicePreviewRequestError(503, '音色试听限流服务暂时不可用');
      }
      if (count > options.maxRequests) {
        throw new TutorVoicePreviewRequestError(429, '试听请求过于频繁，请稍后重试');
      }
    },
  };
}

const tutorVoicePreviewRateLimiter = createTutorVoicePreviewRateLimiter({
  maxEntries: RATE_LIMIT_MAX_ENTRIES,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

let sharedRedisLimiter:
  | { url: string; limiter: ReturnType<typeof createRedisTutorVoicePreviewRateLimiter> }
  | undefined;

function getSharedRedisLimiter(url: string) {
  if (sharedRedisLimiter?.url === url) return sharedRedisLimiter.limiter;
  const client = new Redis(url, getTutorVoicePreviewRedisOptions());
  client.on('error', () => undefined);
  const limiter = createRedisTutorVoicePreviewRateLimiter(client, {
    maxRequests: RATE_LIMIT_MAX_REQUESTS,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });
  sharedRedisLimiter = { url, limiter };
  return limiter;
}

export function getTutorVoicePreviewRedisOptions(): RedisOptions & {
  commandTimeout: number;
  connectTimeout: number;
  maxRetriesPerRequest: number;
  retryStrategy: (times: number) => number;
} {
  return {
    lazyConnect: true,
    commandTimeout: 1_500,
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(100 * 2 ** Math.min(Math.max(times - 1, 0), 4), 1_000),
  };
}

export async function consumeTutorVoicePreviewRateLimit(
  sessionKey: string,
  now = Date.now(),
): Promise<void> {
  const redisUrl = process.env.A3_TUTOR_PREVIEW_REDIS_URL?.trim();
  if (redisUrl) {
    await getSharedRedisLimiter(redisUrl).consume(sessionKey);
    return;
  }
  if (!['development', 'test'].includes(process.env.NODE_ENV || '')) {
    throw new TutorVoicePreviewRequestError(503, '音色试听限流服务暂时不可用');
  }
  tutorVoicePreviewRateLimiter.consume(sessionKey, now);
}
