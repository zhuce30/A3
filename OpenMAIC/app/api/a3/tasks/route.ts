import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, resolveA3InternalFrontendEndpoint } from '@/lib/server/a3-django-api';

type RawTaskResponse = {
  success?: boolean;
  error?: string;
  jobs?: Array<Record<string, unknown>>;
};

type UnifiedTask = {
  id: string;
  type: 'resource_generation' | 'openmaic_video' | 'knowledge_index';
  workflow: string;
  title: string;
  status: string;
  progress: number;
  stage: string;
  message: string;
  source: 'resource' | 'video' | 'knowledge_base';
  actionUrl: string;
  updatedAt: string;
  error?: string;
  progressDetail?: ProgressDetail;
};

type ProgressCounter = {
  current?: number;
  total?: number;
};

type ProgressEvent = {
  time?: string;
  phase?: string;
  message: string;
};

type ProgressDetail = {
  schemaVersion?: string;
  phase?: string;
  phaseLabel?: string;
  resourceId?: string;
  resourceName?: string;
  file?: ProgressCounter;
  page?: ProgressCounter;
  block?: ProgressCounter;
  chunk?: ProgressCounter;
  metrics?: Record<string, number>;
  recentEvents?: ProgressEvent[];
};

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const [resourceResult, knowledgeResult, videoResult] = await Promise.all([
      safeDjangoTaskRequest('/api/resources/jobs/', cookieHeader),
      safeDjangoTaskRequest('/api/kb/jobs/', cookieHeader),
      safeInternalVideoTaskRequest(request.nextUrl.origin, cookieHeader),
    ]);

    if (resourceResult.degraded && knowledgeResult.degraded && videoResult.success === false) {
      return apiSuccess({
        tasks: [],
        summary: { total: 0, running: 0, failed: 0, succeeded: 0 },
        degraded: true,
        error: resourceResult.error || knowledgeResult.error || 'Django 后端暂不可用，后台任务稍后自动刷新。',
        updatedAt: new Date().toISOString(),
      });
    }

    if (resourceResult.success === false && knowledgeResult.success === false && videoResult.success === false) {
      return apiError('UNAUTHORIZED', 401, resourceResult.error || knowledgeResult.error || videoResult.error || '请先登录后再查看任务');
    }

    const tasks = [
      ...(resourceResult.jobs ?? []).map(normalizeResourceGenerationTask),
      ...(knowledgeResult.jobs ?? []).map(normalizeKnowledgeIndexTask),
      ...(videoResult.jobs ?? []).map(normalizeOpenMAICVideoTask),
    ]
      .filter((task): task is UnifiedTask => Boolean(task))
      .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));

    return apiSuccess({
      tasks,
      summary: {
        total: tasks.length,
        running: tasks.filter((task) => ['queued', 'running'].includes(task.status)).length,
        failed: tasks.filter((task) => task.status === 'failed').length,
        succeeded: tasks.filter((task) => ['succeeded', 'partial'].includes(task.status)).length,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '任务中心暂时不可用', error instanceof Error ? error.message : undefined);
  }
}

async function safeInternalVideoTaskRequest(
  requestOrigin: string,
  cookieHeader: string | null,
): Promise<RawTaskResponse & { degraded?: boolean }> {
  try {
    const response = await fetch(
      resolveA3InternalFrontendEndpoint('/api/a3/resources/openmaic-video', requestOrigin),
      {
        headers: cookieHeader ? { cookie: cookieHeader } : {},
        cache: 'no-store',
      },
    );
    return await response.json().catch(() => ({ success: false, jobs: [] })) as RawTaskResponse;
  } catch (error) {
    return {
      success: false,
      degraded: true,
      jobs: [],
      error: error instanceof Error ? `视频任务源暂不可用：${error.message}` : '视频任务源暂不可用',
    };
  }
}

async function safeDjangoTaskRequest(path: string, cookieHeader: string | null): Promise<RawTaskResponse & { degraded?: boolean }> {
  try {
    return await fetchA3DjangoJson<RawTaskResponse>(path, cookieHeader);
  } catch (error) {
    return {
      success: false,
      degraded: true,
      jobs: [],
      error: error instanceof Error ? `Django 后端暂不可用：${error.message}` : 'Django 后端暂不可用',
    };
  }
}

function normalizeResourceGenerationTask(job: Record<string, unknown>): UnifiedTask {
  const id = text(job.jobId || job.id);
  const resourcePackId = text(job.resourcePackId);
  return {
    id,
    type: 'resource_generation',
    workflow: text(job.workflow, 'resource_generate'),
    title: text(job.resourceType) ? `生成${resourceTypeLabel(text(job.resourceType))}` : '生成个性化资源包',
    status: text(job.status, 'queued'),
    progress: number(job.progress),
    stage: text(job.stage, 'queued'),
    message: text(job.message, '资源任务等待执行'),
    source: 'resource',
    actionUrl: text(job.actionUrl, resourcePackId ? `/a3/resources/${resourcePackId}` : '/a3/recommendations'),
    updatedAt: text(job.updatedAt || job.createdAt, new Date(0).toISOString()),
    error: text(job.error),
  };
}

function normalizeKnowledgeIndexTask(job: Record<string, unknown>): UnifiedTask {
  const id = text(job.id);
  const currentFile = text(job.currentFile);
  const progressDetail = normalizeProgressDetail(job.progressDetail);
  const phaseLabel = text(progressDetail?.phaseLabel);
  return {
    id,
    type: 'knowledge_index',
    workflow: `knowledge_${text(job.type, 'index')}`,
    title: text(job.type) === 'parse' ? '多模态解析资料' : '构建本地知识库',
    status: text(job.status, 'queued'),
    progress: number(job.progress),
    stage: text(progressDetail?.phase, currentFile ? 'processing_file' : text(job.type, 'index')),
    message: phaseLabel || (currentFile ? `正在处理 ${currentFile}` : buildKnowledgeMessage(job)),
    source: 'knowledge_base',
    actionUrl: '/a3/knowledge-base',
    updatedAt: text(job.finishedAt || job.startedAt || job.createdAt, new Date(0).toISOString()),
    error: text(job.error),
    progressDetail,
  };
}

function normalizeOpenMAICVideoTask(job: Record<string, unknown>): UnifiedTask {
  const id = text(job.jobId || job.id);
  const resourcePackId = text(job.resourcePackId);
  return {
    id,
    type: 'openmaic_video',
    workflow: text(job.workflow, 'openmaic_video'),
    title: '生成教学视频',
    status: text(job.status, 'queued'),
    progress: number(job.progress),
    stage: text(job.stage, 'queued'),
    message: text(job.message, '视频任务等待执行'),
    source: 'video',
    actionUrl: text(job.actionUrl, resourcePackId ? `/a3/resources/${resourcePackId}/video` : '/a3/recommendations'),
    updatedAt: normalizeTimestamp(job.updatedAt),
    error: text(job.error),
  };
}

function buildKnowledgeMessage(job: Record<string, unknown>) {
  const processed = number(job.processedFiles);
  const total = number(job.totalFiles);
  if (total) return `已处理 ${processed}/${total} 个文件`;
  return '知识库任务等待执行';
}

function resourceTypeLabel(type: string) {
  const labels: Record<string, string> = {
    lecture_doc: '讲义文档',
    knowledge_card: '知识卡片',
    mind_map: '思维导图',
    practice_set: '专项练习',
    case_study: '案例拆解',
    code_lab: '代码实验',
    micro_video_script: '视频脚本',
  };
  return labels[type] || type;
}

function text(value: unknown, fallback = '') {
  const next = String(value ?? '').trim();
  return next || fallback;
}

function number(value: unknown) {
  const next = Number(value ?? 0);
  return Number.isFinite(next) ? Math.max(0, Math.min(100, Math.round(next))) : 0;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return text(value, new Date(0).toISOString());
}

function normalizeProgressDetail(value: unknown): ProgressDetail | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  return {
    schemaVersion: text(source.schemaVersion),
    phase: text(source.phase),
    phaseLabel: text(source.phaseLabel),
    resourceId: text(source.resourceId),
    resourceName: text(source.resourceName),
    file: normalizeCounter(source.file),
    page: normalizeCounter(source.page),
    block: normalizeCounter(source.block),
    chunk: normalizeCounter(source.chunk),
    metrics: normalizeMetrics(source.metrics),
    recentEvents: Array.isArray(source.recentEvents)
      ? source.recentEvents
          .map((event) => normalizeProgressEvent(event))
          .filter((event): event is ProgressEvent => Boolean(event))
      : [],
  };
}

function normalizeCounter(value: unknown): ProgressCounter | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const current = Number(source.current);
  const total = Number(source.total);
  return {
    current: Number.isFinite(current) ? Math.max(0, Math.round(current)) : undefined,
    total: Number.isFinite(total) ? Math.max(0, Math.round(total)) : undefined,
  };
}

function normalizeMetrics(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, Number(item)])
      .filter(([, item]) => Number.isFinite(item))
      .map(([key, item]) => [key, Math.max(0, Math.round(item as number))]),
  );
}

function normalizeProgressEvent(value: unknown): ProgressEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const message = text(source.message);
  if (!message) return null;
  return {
    time: text(source.time),
    phase: text(source.phase),
    message,
  };
}
