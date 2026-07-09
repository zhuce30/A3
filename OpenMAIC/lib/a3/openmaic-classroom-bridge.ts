import type { A3ResourcePackV2Citation } from './recommendation-types';

type BridgeProfile = Record<string, unknown>;

export type A3OpenMAICRequirementInput = {
  goal: string;
  learnerProfileSnapshot?: BridgeProfile;
  citations?: A3ResourcePackV2Citation[];
};

export type OpenMAICClassroomJobResult = {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  result?: {
    classroomId?: string;
    url?: string;
    scenesCount?: number;
  };
  error?: string;
};

export type A3OpenMAICArtifactPayload = {
  jobId: string;
  status: string;
  classroomId: string;
  classroomUrl: string;
  scenesCount: number;
  pptxExportable: boolean;
  provider: 'openmaic-generate-classroom';
  elapsedMs: number;
  degradedReason: string;
};

export type OpenMAICVideoBridgeInput = {
  provider: string;
  status: 'succeeded' | 'failed' | string;
  resourceType: string;
  result?: {
    url?: string;
    duration?: number;
    width?: number;
    height?: number;
  };
  segments?: A3OpenMAICVideoSegment[];
  error?: string;
};

export type A3OpenMAICVideoSegment = {
  index: number;
  title: string;
  status: 'succeeded' | 'failed' | string;
  videoUrl: string;
  duration: number;
  width: number;
  height: number;
  degradedReason: string;
};

export type A3OpenMAICVideoPayload = {
  type: 'openmaic_video';
  status: string;
  provider: string;
  resourceType: string;
  videoUrl: string;
  duration: number;
  width: number;
  height: number;
  segments?: A3OpenMAICVideoSegment[];
  elapsedMs: number;
  degradedReason: string;
};

export type A3OpenMAICClassroomContext = {
  resourcePackId: string;
  classroomJobId: string;
  classroomId: string;
  classroomUrl: string;
};

export type A3OpenMAICPPTXExportPayload = {
  resourcePackId: string;
  jobId: string;
  status: 'succeeded' | 'failed';
  classroomId: string;
  classroomUrl: string;
  fileName: string;
  slidesCount: number;
  provider: 'openmaic-pptx-export';
  elapsedMs: number;
  degradedReason: string;
};

export type A3OpenMAICInteractionPayload = {
  resourcePackId: string;
  eventType: string;
  classroomId: string;
  classroomJobId: string;
  classroomUrl: string;
  sceneId: string;
  sceneTitle: string;
  actionType: string;
  actionId: string;
  progress: number;
  elapsedMs: number;
};

export function buildA3OpenMAICClassroomRequirement(input: A3OpenMAICRequirementInput): string {
  const profile = input.learnerProfileSnapshot ?? {};
  const weakPoints = asStringList(profile.weakPoints).join('、') || '当前路径薄弱点';
  const preferences = asStringList(profile.resourcePreferences ?? profile.expectedResources).join('、') || '讲解、例题、互动练习';
  const citationText = (input.citations ?? [])
    .slice(0, 5)
    .map((item, index) => `${index + 1}. ${item.title || '未命名来源'}：${item.snippet || item.location || '用于支撑课堂内容'}`)
    .join('\n');

  return [
    '请生成一个 A3 个性化学习课堂。',
    `主题：${input.goal || '当前学习目标'}`,
    `学生画像：${stringValue(profile.grade, '未知年级')}，${stringValue(profile.majorDirection, '未知专业')}，基础水平 ${stringValue(profile.foundationLevel, '待诊断')}`,
    `薄弱点：${weakPoints}`,
    `资源偏好：${preferences}`,
    '教学目标：围绕薄弱点生成可导出 PPTX 的互动课堂，包含概念讲解、可视化推导、例题分步、即时检查和课后练习。',
    '生成要求：使用中文，控制在 4-6 个场景，保留课堂 Agent 互动，避免编造引用。',
    `知识库引用：\n${citationText || '暂无引用时，请明确说明需要先补充知识库证据。'}`,
  ].join('\n');
}

export function buildA3OpenMAICArtifactPayload(
  job: OpenMAICClassroomJobResult,
  elapsedMs: number,
  context?: { resourcePackId?: string },
): A3OpenMAICArtifactPayload {
  const succeeded = job.status === 'succeeded' && Boolean(job.result?.url);
  const classroomId = job.result?.classroomId ?? '';
  const classroomUrl = job.result?.url && context?.resourcePackId
    ? buildOpenMAICClassroomUrlWithA3Context(job.result.url, {
        resourcePackId: context.resourcePackId,
        classroomJobId: job.jobId,
        classroomId,
      })
    : (job.result?.url ?? '');
  return {
    jobId: job.jobId,
    status: job.status,
    classroomId,
    classroomUrl,
    scenesCount: Number(job.result?.scenesCount ?? 0),
    pptxExportable: succeeded,
    provider: 'openmaic-generate-classroom',
    elapsedMs,
    degradedReason: succeeded ? '' : (job.error || ''),
  };
}

export function buildA3OpenMAICVideoPayload(
  input: OpenMAICVideoBridgeInput,
  elapsedMs: number,
): A3OpenMAICVideoPayload {
  const videoUrl = input.result?.url ?? '';
  const segments = input.segments?.filter((segment) => segment && typeof segment === 'object') ?? [];
  return {
    type: 'openmaic_video',
    status: input.status,
    provider: input.provider,
    resourceType: input.resourceType,
    videoUrl,
    duration: Number(input.result?.duration ?? segments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0)),
    width: Number(input.result?.width ?? 0),
    height: Number(input.result?.height ?? 0),
    ...(segments.length ? { segments } : {}),
    elapsedMs,
    degradedReason: input.status === 'succeeded' ? '' : (input.error || ''),
  };
}

export function buildOpenMAICClassroomUrlWithA3Context(
  classroomUrl: string,
  context: { resourcePackId: string; classroomJobId: string; classroomId?: string },
): string {
  if (!classroomUrl || !context.resourcePackId || !context.classroomJobId) return classroomUrl;
  const url = new URL(classroomUrl, 'http://a3.local');
  url.searchParams.set('a3PackId', context.resourcePackId);
  url.searchParams.set('a3ClassroomJobId', context.classroomJobId);
  if (context.classroomId) {
    url.searchParams.set('a3ClassroomId', context.classroomId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getA3OpenMAICContextFromUrl(urlValue: string): A3OpenMAICClassroomContext | null {
  if (!urlValue) return null;
  const url = new URL(urlValue, 'http://a3.local');
  const resourcePackId = url.searchParams.get('a3PackId')?.trim() ?? '';
  const classroomJobId = url.searchParams.get('a3ClassroomJobId')?.trim() ?? '';
  if (!resourcePackId || !classroomJobId) return null;
  const classroomId = url.searchParams.get('a3ClassroomId')?.trim() || classroomIdFromPath(url.pathname);
  return {
    resourcePackId,
    classroomJobId,
    classroomId,
    classroomUrl: `${url.pathname}${url.search}${url.hash}`,
  };
}

export function buildA3OpenMAICPPTXExportPayload(input: {
  context: A3OpenMAICClassroomContext;
  fileName: string;
  slidesCount: number;
  elapsedMs: number;
  exportedAtMs?: number;
  status?: 'succeeded' | 'failed';
  degradedReason?: string;
}): A3OpenMAICPPTXExportPayload {
  const exportedAtMs = input.exportedAtMs ?? Date.now();
  return {
    resourcePackId: input.context.resourcePackId,
    jobId: `pptx-${input.context.classroomJobId}-${exportedAtMs}`,
    status: input.status ?? 'succeeded',
    classroomId: input.context.classroomId,
    classroomUrl: input.context.classroomUrl,
    fileName: input.fileName,
    slidesCount: Number(input.slidesCount || 0),
    provider: 'openmaic-pptx-export',
    elapsedMs: Number(input.elapsedMs || 0),
    degradedReason: input.degradedReason ?? '',
  };
}

export function buildA3OpenMAICInteractionPayload(input: {
  context: A3OpenMAICClassroomContext;
  eventType: string;
  sceneId?: string;
  sceneTitle?: string;
  actionType: string;
  actionId?: string;
  progress?: number;
  elapsedMs?: number;
}): A3OpenMAICInteractionPayload {
  return {
    resourcePackId: input.context.resourcePackId,
    eventType: input.eventType,
    classroomId: input.context.classroomId,
    classroomJobId: input.context.classroomJobId,
    classroomUrl: input.context.classroomUrl,
    sceneId: input.sceneId ?? '',
    sceneTitle: input.sceneTitle ?? '',
    actionType: input.actionType,
    actionId: input.actionId ?? '',
    progress: Number(input.progress ?? 0),
    elapsedMs: Number(input.elapsedMs ?? 0),
  };
}

export async function writeBackA3OpenMAICInteraction(input: {
  urlValue: string;
  eventType: string;
  sceneId?: string;
  sceneTitle?: string;
  actionType: string;
  actionId?: string;
  progress?: number;
  elapsedMs?: number;
  fetcher?: typeof fetch;
}): Promise<boolean> {
  const context = getA3OpenMAICContextFromUrl(input.urlValue);
  if (!context) return false;
  const fetcher = input.fetcher ?? fetch;
  const payload = buildA3OpenMAICInteractionPayload({
    context,
    eventType: input.eventType,
    sceneId: input.sceneId,
    sceneTitle: input.sceneTitle,
    actionType: input.actionType,
    actionId: input.actionId,
    progress: input.progress,
    elapsedMs: input.elapsedMs,
  });

  const response = await fetcher('/api/a3/resources/openmaic-interaction', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.ok;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function stringValue(value: unknown, fallback: string) {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  return text || fallback;
}

function classroomIdFromPath(pathname: string): string {
  const match = pathname.match(/\/classroom\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
