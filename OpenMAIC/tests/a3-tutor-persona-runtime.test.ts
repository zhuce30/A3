import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createDashScopeRealtimeSession } from '@/lib/server/a3-dashscope-realtime';
import { buildOpenAIRealtimeSessionConfig } from '@/lib/server/a3-realtime-sdp';
import {
  resolveA3TutorPersonaRuntime,
  toPublicTutorPersona,
} from '@/lib/server/a3-tutor-persona-runtime';

const originalDashScopeKey = process.env.DASHSCOPE_API_KEY;

afterEach(() => {
  if (originalDashScopeKey === undefined) delete process.env.DASHSCOPE_API_KEY;
  else process.env.DASHSCOPE_API_KEY = originalDashScopeKey;
});

describe('A3 tutor persona realtime runtime', () => {
  it('resolves allowlisted personas and falls back for unknown ids', () => {
    const selected = resolveA3TutorPersonaRuntime('socratic-guide');
    const fallback = resolveA3TutorPersonaRuntime('invented-tutor');

    expect(selected.persona.id).toBe('socratic-guide');
    expect(selected.fallbackUsed).toBe(false);
    expect(selected.instructions('进程调度')).toContain('一次只提出一个关键问题');
    expect(fallback.persona.id).toBe('structured-teacher');
    expect(fallback.fallbackUsed).toBe(true);
  });

  it('keeps private instructions and provider voices out of public persona snapshots', () => {
    const runtime = resolveA3TutorPersonaRuntime('practice-coach');
    const publicPersona = toPublicTutorPersona(runtime);

    expect(publicPersona.id).toBe('practice-coach');
    expect(publicPersona).not.toHaveProperty('instructions');
    expect(publicPersona).not.toHaveProperty('openaiVoice');
    expect(publicPersona).not.toHaveProperty('dashscopeVoice');
  });

  it('builds OpenAI sessions with the resolved strategy and voice', () => {
    const runtime = resolveA3TutorPersonaRuntime('foundation-coach');
    const session = buildOpenAIRealtimeSessionConfig('gpt-realtime-2', runtime, '虚拟内存');

    expect(session.instructions).toContain('从已确认的先修概念开始');
    expect(session.instructions).toContain('当前学习目标：虚拟内存');
    expect(session.audio.output.voice).toBe(runtime.openaiVoice);
  });

  it('binds DashScope proxy URLs only to the persisted coaching session', async () => {
    process.env.DASHSCOPE_API_KEY = 'test-key';
    const runtime = resolveA3TutorPersonaRuntime('practice-coach');
    const result = await createDashScopeRealtimeSession({
      coachingSessionId: 'session-123',
      targetTitle: '时间片轮转',
      resolvedPersona: toPublicTutorPersona(runtime),
    });

    const url = new URL(result.connection.connectionUrl || '', 'https://a3.example');
    expect(url.searchParams.get('coachingSessionId')).toBe('session-123');
    expect(url.searchParams.has('personaId')).toBe(false);
    expect(result.resolvedPersona.id).toBe('practice-coach');
  });

  it('requires authenticated session lookup in both SDP and DashScope proxy paths', () => {
    const root = process.cwd();
    const sdpRoute = fs.readFileSync(path.resolve(root, 'app/api/a3/coaching/realtime/sdp/route.ts'), 'utf8');
    const proxy = fs.readFileSync(path.resolve(root, 'scripts/a3-dashscope-realtime-proxy.mjs'), 'utf8');

    expect(sdpRoute).toContain('coachingSessionId');
    expect(sdpRoute).toContain('/api/learning/coaching/sessions/');
    expect(proxy).toContain('coachingSessionId');
    expect(proxy).toContain('/api/learning/coaching/sessions/');
    expect(proxy).toContain('session.update');
  });
});

