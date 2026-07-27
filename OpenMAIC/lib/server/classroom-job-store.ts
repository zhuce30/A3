import { promises as fs } from 'fs';
import path from 'path';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';
import type { A3ClassroomTutorContext } from '@/lib/types/stage';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  a3Context?: A3ClassroomTutorContext;
  a3Binding?: {
    ownerFingerprint: string;
    resourcePackId: string;
  };
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: process may have restarted during generation',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  a3Access?: { cookieHeader: string | null; resourcePackId: string },
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const a3Binding = input.a3Context ? buildA3JobBinding(a3Access) : undefined;
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
    ...(input.a3Context ? { a3Context: cloneTutorContext(input.a3Context) } : {}),
    ...(a3Binding ? { a3Binding } : {}),
  };

  await ensureClassroomJobsDir();
  await writeJsonFileAtomic(jobFilePath(jobId), job);
  return job;
}

function buildA3JobBinding(
  access: { cookieHeader: string | null; resourcePackId: string } | undefined,
): NonNullable<ClassroomGenerationJob['a3Binding']> {
  const ownerFingerprint = resolveDjangoSessionIdentity(access?.cookieHeader || null)?.fingerprint;
  const resourcePackId = String(access?.resourcePackId || '').trim();
  if (!ownerFingerprint || !resourcePackId) {
    throw new Error('Authenticated owner and resource pack are required for A3 classroom jobs');
  }
  return { ownerFingerprint, resourcePackId };
}

export class InvalidDjangoSessionCookieError extends Error {
  constructor() {
    super('Ambiguous Django session cookie');
    this.name = 'InvalidDjangoSessionCookieError';
  }
}

export function resolveDjangoSessionIdentity(
  cookieHeader: string | null,
): { fingerprint: string } | null {
  const cookieName = process.env.DJANGO_SESSION_COOKIE_NAME?.trim() || 'sessionid';
  const values: string[] = [];
  for (const rawPart of (cookieHeader || '').split(';')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    values.push(part.slice(separator + 1).trim());
  }
  if (values.length > 1) throw new InvalidDjangoSessionCookieError();
  const sessionValue = values[0];
  if (!sessionValue) return null;
  return { fingerprint: createHash('sha256').update(sessionValue).digest('hex') };
}

export function isAuthorizedForClassroomJob(
  job: ClassroomGenerationJob,
  cookieHeader: string | null,
  resourcePackId?: string,
): boolean {
  if (!job.a3Context) return true;
  if (!job.a3Binding) return false;
  let candidate: string | undefined;
  try {
    candidate = resolveDjangoSessionIdentity(cookieHeader)?.fingerprint;
  } catch (error) {
    if (error instanceof InvalidDjangoSessionCookieError) return false;
    throw error;
  }
  if (!candidate) return false;
  const expectedBuffer = Buffer.from(job.a3Binding.ownerFingerprint, 'hex');
  const candidateBuffer = Buffer.from(candidate, 'hex');
  if (
    expectedBuffer.length !== candidateBuffer.length
    || !timingSafeEqual(expectedBuffer, candidateBuffer)
  ) {
    return false;
  }
  return resourcePackId === undefined || job.a3Binding.resourcePackId === resourcePackId;
}

function cloneTutorContext(context: A3ClassroomTutorContext): A3ClassroomTutorContext {
  return {
    tutorPersona: {
      ...context.tutorPersona,
      allowedWorkflows: [...context.tutorPersona.allowedWorkflows],
    },
    fallbackUsed: context.fallbackUsed,
  };
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as ClassroomGenerationJob;
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      ...(existing.a3Context
        ? { a3Context: existing.a3Context, a3Binding: existing.a3Binding }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: progress.step,
    progress: progress.progress,
    message: progress.message,
    scenesGenerated: progress.scenesGenerated,
    totalScenes: progress.totalScenes,
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}
