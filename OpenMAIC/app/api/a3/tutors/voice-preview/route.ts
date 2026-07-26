import type { A3TutorPersonaId } from '@/lib/a3/tutor-persona-types';
import {
  consumeTutorVoicePreviewRateLimit,
  resolveTutorVoicePreviewSessionKey,
  TutorVoicePreviewRequestError,
  validateTutorVoicePreviewPersona,
} from '@/lib/server/a3-tutor-config-client';
import {
  generateTutorVoicePreview,
  TutorVoicePreviewError,
  type TutorVoicePreviewRuntime,
} from '@/lib/server/a3-tutor-voice-preview';

export const runtime = 'nodejs';
const MAX_JSON_BYTES = 1_024;

export async function POST(request: Request) {
  return handleTutorVoicePreview(request);
}

export async function handleTutorVoicePreview(
  request: Request,
  previewRuntime?: TutorVoicePreviewRuntime,
) {
  try {
    validateJsonContentType(request);
    validateRequestOrigin(request);
    validateDeclaredBodySize(request);

    const body = await readBoundedJson(request);
    if (Object.keys(body).length !== 1 || typeof body.personaId !== 'string') {
      throw new TutorVoicePreviewRequestError(400, '请求只能包含导师人格编号');
    }
    const cookieHeader = request.headers.get('cookie');
    const sessionKey = resolveTutorVoicePreviewSessionKey(cookieHeader);
    const personaId = body.personaId.trim();
    const persona = await validateTutorVoicePreviewPersona(cookieHeader, personaId);
    await consumeTutorVoicePreviewRateLimit(sessionKey);
    const preview = await generateTutorVoicePreview(persona.id as A3TutorPersonaId, {
      ...previewRuntime,
      signal: request.signal,
    });
    return new Response(Uint8Array.from(preview.audio), {
      status: 200,
      headers: {
        'Content-Type': preview.contentType,
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof TutorVoicePreviewRequestError || error instanceof TutorVoicePreviewError) {
      return jsonError(error.status, error.message);
    }
    return jsonError(500, '音色试听暂时不可用');
  }
}

function validateJsonContentType(request: Request) {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new TutorVoicePreviewRequestError(415, '请求必须使用 JSON 格式');
  }
}

function validateRequestOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  const trusted = new Set(
    (process.env.A3_TRUSTED_ORIGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (origin !== requestOrigin && !trusted.has(origin)) {
    throw new TutorVoicePreviewRequestError(403, '请求来源不受信任');
  }
}

function validateDeclaredBodySize(request: Request) {
  const raw = request.headers.get('content-length');
  if (!raw) return;
  const size = Number.parseInt(raw, 10);
  if (!Number.isFinite(size) || size < 0 || size > MAX_JSON_BYTES) {
    throw new TutorVoicePreviewRequestError(413, '请求内容过大');
  }
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new TutorVoicePreviewRequestError(400, '请求内容无效');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TutorVoicePreviewRequestError(413, '请求内容过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new TutorVoicePreviewRequestError(400, '请求内容无效');
  }
}

function jsonError(status: number, error: string) {
  return Response.json(
    { success: false, error },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
