import { a3PostJson } from './api-client';

export const A3_LEARNING_EVENT_SCHEMA_VERSION = 'a3.learning-event.v2';

export type A3LearningEventType =
  | 'page_viewed'
  | 'resource_clicked'
  | 'resource_opened'
  | 'resource_completed'
  | 'resource_skipped'
  | 'resource_favorited'
  | 'practice_started'
  | 'practice_submitted'
  | 'question_answered'
  | 'assessment_submitted'
  | 'task_started'
  | 'task_completed'
  | 'coach_message_sent'
  | 'classroom_opened'
  | 'video_opened'
  | 'video_completed';

export type A3LearningEventPayload = {
  eventId: string;
  eventType: A3LearningEventType;
  sourcePage: string;
  clientTimestamp: string;
  targetType: string;
  targetId: string;
  resourceType: string;
  knowledgePointId: string;
  durationSec: number;
  score: number | null;
  quality: Record<string, unknown>;
  metadata: Record<string, unknown>;
  traceId: string;
  schemaVersion: typeof A3_LEARNING_EVENT_SCHEMA_VERSION;
};

export type A3LearningEventInput = Partial<Omit<A3LearningEventPayload, 'schemaVersion' | 'clientTimestamp' | 'durationSec' | 'score'>> & {
  eventType: A3LearningEventType;
  clientTimestamp?: string;
  durationSec?: number | string | null;
  score?: number | string | null;
};

type A3LearningEventResponse = {
  success: boolean;
  error?: string;
  status?: string;
};

type A3LearningEventsBatchResponse = A3LearningEventResponse & {
  accepted?: number;
  duplicates?: number;
  rejected?: number;
};

const SESSION_STORAGE_KEY = 'a3.learningEvent.sessionId';
const SEQUENCE_STORAGE_KEY = 'a3.learningEvent.sequence';

export async function trackLearningEvent(input: A3LearningEventInput): Promise<A3LearningEventResponse> {
  try {
    const event = buildLearningEvent(input);
    const result = await a3PostJson<A3LearningEventResponse>('/api/learning/events/', event);
    return normalizeTrackingResult(result);
  } catch {
    return normalizeTrackingResult({ success: false, error: '学习事件写入失败' });
  }
}

export async function trackLearningEventsBatch(inputs: A3LearningEventInput[]): Promise<A3LearningEventsBatchResponse> {
  if (!inputs.length) return { success: true, accepted: 0, duplicates: 0, rejected: 0 };
  try {
    const events = inputs.map(buildLearningEvent);
    const result = await a3PostJson<A3LearningEventsBatchResponse>('/api/learning/events/batch/', { events });
    return normalizeTrackingResult(result);
  } catch {
    return normalizeTrackingResult({ success: false, error: '学习事件批量写入失败' });
  }
}

export function trackPageView(sourcePage?: string, metadata?: Record<string, unknown>) {
  return trackLearningEvent({
    eventType: 'page_viewed',
    targetType: 'page',
    targetId: sourcePage ?? currentSourcePage(),
    sourcePage,
    metadata,
  });
}

export function trackResourceOpen(input: Omit<A3LearningEventInput, 'eventType'>) {
  return trackLearningEvent({
    ...input,
    eventType: 'resource_opened',
  });
}

export function trackResourceComplete(input: Omit<A3LearningEventInput, 'eventType'>) {
  return trackLearningEvent({
    ...input,
    eventType: 'resource_completed',
  });
}

export function trackPracticeSubmit(input: Omit<A3LearningEventInput, 'eventType'>) {
  return trackLearningEvent({
    ...input,
    eventType: 'practice_submitted',
  });
}

export function buildLearningEvent(input: A3LearningEventInput): A3LearningEventPayload {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const sessionId = getSessionId();
  return {
    schemaVersion: A3_LEARNING_EVENT_SCHEMA_VERSION,
    eventId: normalizeText(input.eventId) || createEventId(sessionId),
    eventType: input.eventType,
    sourcePage: normalizeText(input.sourcePage) || currentSourcePage(),
    clientTimestamp: input.clientTimestamp || new Date().toISOString(),
    targetType: normalizeText(input.targetType),
    targetId: normalizeText(input.targetId),
    resourceType: normalizeText(input.resourceType),
    knowledgePointId: normalizeText(input.knowledgePointId),
    durationSec: normalizeNonNegativeInteger(input.durationSec),
    score: normalizeScore(input.score),
    quality: isRecord(input.quality) ? input.quality : {},
    metadata: {
      ...metadata,
      sessionId,
    },
    traceId: normalizeText(input.traceId),
  };
}

function normalizeTrackingResult<T extends A3LearningEventResponse>(result: T): T {
  if (!result?.success && process.env.NODE_ENV !== 'production') {
    console.warn('[A3] learning event tracking failed', result?.error ?? 'unknown error');
  }
  return result ?? ({ success: false, error: 'learning event tracking failed' } as T);
}

function createEventId(sessionId: string) {
  const sequence = nextSequence();
  return `a3evt_${sessionId}_${sequence}`;
}

function getSessionId() {
  if (typeof window === 'undefined') return 'server';
  try {
    const existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const created = createStableId();
    window.localStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return createStableId();
  }
}

function nextSequence() {
  if (typeof window === 'undefined') return Date.now();
  try {
    const current = Number(window.localStorage.getItem(SEQUENCE_STORAGE_KEY) || '0');
    const next = Number.isFinite(current) ? current + 1 : 1;
    window.localStorage.setItem(SEQUENCE_STORAGE_KEY, String(next));
    return next;
  } catch {
    return Date.now();
  }
}

function createStableId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function currentSourcePage() {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNonNegativeInteger(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function normalizeScore(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
