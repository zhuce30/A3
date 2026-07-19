'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowRight,
  BookOpenText,
  Brain,
  CheckCircle2,
  Code2,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  MonitorPlay,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Video,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { buildProfileChangeInsight, buildRecommendationEffectInsight, buildRecommendationProfileRationale, type LearningFlowInsight } from '@/lib/a3/learning-flow-insights';
import type { DynamicProfileFeedResponse } from '@/lib/a3/profile-timeline';
import type { A3SystemLibraryResponse } from '@/lib/a3/library-types';
import type {
  A3MultimodalArtifact,
  A3OpenMAICClassroomArtifact,
  A3OpenMAICVideoArtifact,
  A3Recommendation,
  A3ResourceFeedbackResponse,
  A3ResourceGenerateResponse,
  A3ResourcePackV2,
  A3ResourcePackV2Citation,
  A3ResourcePackV2Resource,
  A3ResourcePackV2ResourceType,
  RecommendationResponse,
} from '@/lib/a3/recommendation-types';
import { cn } from '@/lib/utils';
import { A3Card, A3Pill } from '../ui/a3-card';

type ResourcePackListResponse = { success: boolean; error?: string; resourcePacks?: A3ResourcePackV2[] };
type ProfileFeedResponse = DynamicProfileFeedResponse;

type A3OpenMAICBridgeResponse = {
  success: boolean;
  error?: string;
  jobId?: string;
  status?: string;
  progress?: number;
  stage?: string;
  message?: string;
  done?: boolean;
  pollUrl?: string;
  pollIntervalMs?: number;
  startedAt?: number;
  artifact?: A3MultimodalArtifact;
  resourcePack?: A3ResourcePackV2;
};

type OpenMAICJobPollResponse = {
  success: boolean;
  error?: string;
  jobId: string;
  status: string;
  result?: { classroomId?: string; url?: string; scenesCount?: number };
  done?: boolean;
};

type ResourceEntry = {
  key: string;
  title: string;
  subtitle: string;
  route: string;
  resourceType?: A3ResourcePackV2ResourceType;
  icon: typeof FileText;
  tone: 'blue' | 'green' | 'violet' | 'orange' | 'red' | 'slate';
  productNote: string;
};

type ProgressStepStatus = 'pending' | 'running' | 'succeeded' | 'failed';
type LongRunningProgress = {
  kind: 'video' | 'classroom' | 'resource';
  title: string;
  message: string;
  steps: Array<{ label: string; status: ProgressStepStatus; detail?: string }>;
};

const videoProgressLabels = [
  '准备视频脚本',
  '第 1/6 段',
  '第 2/6 段',
  '第 3/6 段',
  '第 4/6 段',
  '第 5/6 段',
  '第 6/6 段',
  '写回 A3 资源包',
];

const classroomProgressLabels = [
  '创建 OpenMAIC 课堂',
  '生成课堂场景',
  '同步课堂状态',
  '写回 A3 资源包',
  '进入课堂导出 PPTX',
];

const resourceProgressLabels = [
  '检索知识库',
  '分析学习画像',
  '生成资源内容',
  '校验引用来源',
  '保存资源包',
  '准备打开页面',
];

const resourceEntries: ResourceEntry[] = [
  {
    key: 'document',
    title: '讲义文档',
    subtitle: '按你的描述整理成可直接阅读的讲义。',
    route: 'document',
    resourceType: 'lecture_doc',
    icon: FileText,
    tone: 'blue',
    productNote: '包含概念解释、例子、复习卡和引用来源。',
  },
  {
    key: 'ppt',
    title: '生成课堂/PPT',
    subtitle: '进入 OpenMAIC 课堂后导出 PPTX。',
    route: 'ppt',
    resourceType: 'lecture_doc',
    icon: MonitorPlay,
    tone: 'violet',
    productNote: 'PPT 不由 Django 伪造，必须由 OpenMAIC 课堂导出并写回 artifact。',
  },
  {
    key: 'mind-map',
    title: '思维导图',
    subtitle: '把知识点、先修关系和易错点连起来。',
    route: 'mind-map',
    resourceType: 'mind_map',
    icon: GitBranch,
    tone: 'green',
    productNote: '适合先看结构，再进入文档或练习。',
  },
  {
    key: 'practice',
    title: '专项练习',
    subtitle: '围绕薄弱点生成题目、答案和解析。',
    route: 'practice',
    resourceType: 'practice_set',
    icon: CheckCircle2,
    tone: 'orange',
    productNote: '完成后可继续写回学习反馈。',
  },
  {
    key: 'case-study',
    title: '案例拆解',
    subtitle: '把知识点放进一个真实问题场景里分析。',
    route: 'case-study',
    resourceType: 'case_study',
    icon: Layers3,
    tone: 'slate',
    productNote: '适合答辩展示“资源不是通用模板”。',
  },
  {
    key: 'code-lab',
    title: '代码实验',
    subtitle: '给出目标、步骤、起始代码和检查点。',
    route: 'code-lab',
    resourceType: 'code_lab',
    icon: Code2,
    tone: 'red',
    productNote: '这是独立 code_lab 类型，不再混在案例里。',
  },
  {
    key: 'video',
    title: '视频脚本',
    subtitle: '先生成脚本，再提交 OpenMAIC/Seedance 生成可播放视频。',
    route: 'video',
    resourceType: 'micro_video_script',
    icon: Video,
    tone: 'blue',
    productNote: '脚本是视频生成的输入；成功后在独立视频页播放。',
  },
];

const resourceLabels: Record<A3ResourcePackV2ResourceType, string> = {
  lecture_doc: '讲解文档',
  knowledge_card: '知识卡片',
  mind_map: '思维导图',
  practice_set: '专项练习',
  case_study: '案例拆解',
  code_lab: '代码实验',
  micro_video_script: '视频脚本',
};

const PROFILE_SETUP_HREF = '/a3/profile-setup';

export function RecommendationsView() {
  const [context, setContext] = useState<RecommendationResponse | null>(null);
  const [goal, setGoal] = useState('');
  const [pack, setPack] = useState<A3ResourcePackV2 | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [generatingPack, setGeneratingPack] = useState(false);
  const [singleGeneratingType, setSingleGeneratingType] = useState('');
  const [generatingClassroom, setGeneratingClassroom] = useState(false);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [classroomSummary, setClassroomSummary] = useState('');
  const [videoSummary, setVideoSummary] = useState('');
  const [longRunningProgress, setLongRunningProgress] = useState<LongRunningProgress | null>(null);
  const [recommendationsExpanded, setRecommendationsExpanded] = useState(false);
  const [profileFeed, setProfileFeed] = useState<ProfileFeedResponse | null>(null);
  const [systemLibrary, setSystemLibrary] = useState<A3SystemLibraryResponse | null>(null);

  const evidence = useMemo(() => buildGenerationEvidence(context, goal, pack), [context, goal, pack]);
  const classroomArtifact = pack?.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICClassroomArtifact => artifact.type === 'openmaic_classroom');
  const videoArtifact = pack?.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICVideoArtifact =>
    artifact.type === 'openmaic_video'
    && (Boolean(artifact.videoUrl) || Boolean(artifact.segments?.some((segment) => segment.status === 'succeeded' && segment.videoUrl)))
  ) ?? pack?.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICVideoArtifact => artifact.type === 'openmaic_video');
  const generatedTypes = new Set(pack?.resources.map((resource) => resource.type) ?? []);
  const recommendations = context?.recommendations ?? [];
  const visibleRecommendations = recommendationsExpanded ? recommendations : recommendations.slice(0, 3);
  const profileChangeInsight = useMemo(() => buildProfileChangeInsight(profileFeed), [profileFeed]);

  async function loadInitialContext() {
    const [result, profileResponse, libraryResponse] = await Promise.all([
      a3PostJson<RecommendationResponse>('/api/recommend/', {
        goal: '',
        topK: 4,
        mode: 'fast',
      }),
      a3GetJson<ProfileFeedResponse>('/api/profiles/dynamic-profile/'),
      a3GetJson<A3SystemLibraryResponse>('/api/kb/library/?recommended=3'),
    ]);
    setLoadingContext(false);
    if (profileResponse.success) setProfileFeed(profileResponse);
    if (libraryResponse.success) setSystemLibrary(libraryResponse);
    if (!result.success) {
      setError(result.error ?? '无法加载画像和知识库上下文。');
      return;
    }
    const normalized = sanitizeRecommendationResponse(result);
    setContext(normalized);
  }

  async function loadLatestPack() {
    const result = await a3GetJson<ResourcePackListResponse>('/api/resources/packs/');
    if (!result.success || !result.resourcePacks?.length) return;
    setPack(sanitizeResourcePackV2(result.resourcePacks[0]));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadInitialContext();
      void loadLatestPack();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function generateResourcePack() {
    const nextGoal = normalizeGoal(goal, context);
    setGeneratingPack(true);
    setError('');
    setMessage('');
    setLongRunningProgress(buildProgress('resource', 0, '正在检索与你目标相关的课程资料'));
    const result = await postNextJson<A3ResourceGenerateResponse>('/api/a3/resources/jobs', {
      goal: nextGoal,
      topK: 5,
    });
    const synced = result.success ? await pollResourceGenerationJob(result) : result;
    setGeneratingPack(false);
    if (!synced.success || !synced.resourcePack) {
      setError(result.error ?? '资源包生成失败。');
      return;
    }
    const normalizedPack = sanitizeResourcePackV2(synced.resourcePack);
    setPack(normalizedPack);
    setLongRunningProgress(buildProgress('resource', 5, '资源包已生成，可以选择一个成品单独查看', 'succeeded'));
    setMessage(`已生成个性化资源包，traceId: ${(synced.traceId ?? normalizedPack.traceId).slice(0, 12)}。请从下面选择一个成品单独查看。`);
  }

  async function generateSingleResourceV2(resourceType: A3ResourcePackV2ResourceType) {
    const nextGoal = normalizeGoal(goal, context);
    setSingleGeneratingType(resourceType);
    setError('');
    setMessage('');
    setLongRunningProgress(buildProgress('resource', 0, `正在准备${resourceLabels[resourceType]}`));
    const result = await postNextJson<A3ResourceGenerateResponse>('/api/a3/resources/jobs', {
      goal: nextGoal,
      topK: 5,
      resourceType,
    });
    const synced = result.success ? await pollResourceGenerationJob(result) : result;
    setSingleGeneratingType('');
    if (!synced.success || !synced.resourcePack) {
      setLongRunningProgress(buildProgress('resource', 2, synced.error ?? `${resourceLabels[resourceType]}生成失败`, 'failed'));
      setError(synced.error ?? `${resourceLabels[resourceType]}生成失败。`);
      return null;
    }
    const normalizedPack = sanitizeResourcePackV2(synced.resourcePack);
    setPack(normalizedPack);
    setLongRunningProgress(buildProgress('resource', 5, `${resourceLabels[resourceType]}已生成，可以打开查看`, 'succeeded'));
    setMessage(`已单独生成${resourceLabels[resourceType]}，traceId: ${(synced.traceId ?? normalizedPack.traceId).slice(0, 12)}。`);
    return normalizedPack;
  }

  async function generateClassroomForPpt() {
    const currentPack = pack ?? (await generateSingleResourceV2('lecture_doc'));
    if (!currentPack) return;
    setGeneratingClassroom(true);
    setError('');
    setMessage('');
    setClassroomSummary('');
    setLongRunningProgress(buildProgress('classroom', 0, '正在创建课堂任务'));
    const citations = currentPack.resources.flatMap((resource) => resource.citations).slice(0, 6);
    const result = await postNextJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-classroom', {
      resourcePackId: currentPack.resourcePackId,
      goal: currentPack.goal,
      learnerProfileSnapshot: currentPack.learnerProfileSnapshot,
      citations,
    });
    if (!result.success || !result.jobId || !result.pollUrl) {
      setGeneratingClassroom(false);
      setLongRunningProgress(buildProgress('classroom', 0, result.error ?? '课堂任务创建失败', 'failed'));
      setError(result.error ?? 'OpenMAIC 课堂任务创建失败。');
      return;
    }
    setClassroomSummary(`课堂任务已创建：${result.jobId}，正在等待 OpenMAIC 回写。`);
    setLongRunningProgress(buildProgress('classroom', 1, `课堂任务 ${result.jobId} 已创建，正在生成场景`));
    const synced = await pollAndSyncOpenMAICClassroom(result, currentPack.resourcePackId);
    setGeneratingClassroom(false);
    if (!synced.success) {
      setLongRunningProgress(buildProgress('classroom', 2, synced.error ?? '课堂同步失败', 'failed'));
      setError(synced.error ?? 'OpenMAIC 课堂同步失败。');
      return;
    }
    if (synced.resourcePack) setPack(sanitizeResourcePackV2(synced.resourcePack));
    if (synced.artifact?.type === 'openmaic_classroom' && synced.artifact.status === 'succeeded') {
      setLongRunningProgress(buildProgress('classroom', 4, '课堂已写回 A3，可以进入课堂导出 PPTX', 'succeeded'));
      setClassroomSummary(`课堂已生成：${synced.artifact.scenesCount} 个场景。进入 PPT 页面可打开课堂并导出 PPTX。`);
      setMessage('PPT 课件入口已准备好。');
    } else {
      setLongRunningProgress(buildProgress('classroom', 3, '课堂已回写，但 OpenMAIC 未返回成功状态', 'failed'));
      setClassroomSummary('课堂任务已回写，但尚未成功生成 PPT 可导出的课堂。');
    }
  }

  async function generateVideoFromScript() {
    let currentPack = pack;
    let script = currentPack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;
    setLongRunningProgress(buildProgress('video', 0, '正在准备视频脚本'));
    if (!currentPack || !script) {
      currentPack = await generateSingleResourceV2('micro_video_script');
      script = currentPack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;
    }
    if (!currentPack || !script) return;
    setGeneratingVideo(true);
    setError('');
    setMessage('');
    setVideoSummary('');
    let activeVideoStep = 1;
    setLongRunningProgress(buildProgress('video', activeVideoStep, '正在生成 60 秒视频，系统会拆成 6 个 10 秒片段'));
    const videoProgressTimer = window.setInterval(() => {
      activeVideoStep = Math.min(activeVideoStep + 1, 6);
      setLongRunningProgress(buildProgress('video', activeVideoStep, `正在生成第 ${activeVideoStep}/6 段，完成后会自动写回资源包`));
    }, 9000);
    const result = await postNextJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-video', {
      resourcePackId: currentPack.resourcePackId,
      provider: 'seedance',
      resourceType: script.type,
      prompt: buildVideoPrompt(currentPack.goal, script),
      duration: estimateVideoDuration(script),
      aspectRatio: '16:9',
      resolution: '1080p',
    });
    window.clearInterval(videoProgressTimer);
    const synced = result.success && result.jobId && result.pollUrl ? await pollOpenMAICVideoJob(result) : result;
    setGeneratingVideo(false);
    if (!synced.success) {
      setLongRunningProgress(buildProgress('video', activeVideoStep, synced.error ?? '视频任务创建失败', 'failed'));
      setError(synced.error ?? 'OpenMAIC 视频任务创建失败。');
      return;
    }
    if (synced.resourcePack) setPack(sanitizeResourcePackV2(synced.resourcePack));
    if (synced.artifact?.type === 'openmaic_video' && ['succeeded', 'partial'].includes(synced.artifact.status)) {
      const segmentCount = synced.artifact.segments?.filter((segment) => segment.status === 'succeeded' && segment.videoUrl).length ?? 0;
      const totalSegments = synced.artifact.segments?.length ?? 0;
      const segmentText = totalSegments ? `，分段 ${segmentCount}/${totalSegments}` : '';
      setLongRunningProgress(buildVideoArtifactProgress(
        synced.artifact,
        synced.artifact.status === 'partial'
          ? `视频部分片段生成成功并已写回资源包：${segmentCount}/${totalSegments || 6}`
          : `视频已写回资源包，成功片段 ${segmentCount}/${totalSegments || 6}`,
      ));
      setVideoSummary(`视频已生成：${synced.artifact.provider} / ${synced.artifact.duration || '--'} 秒${segmentText}。`);
      setMessage('视频成品已写回资源包，可以进入视频页播放。');
      return;
    }
    const failureReason = synced.artifact?.type === 'openmaic_video'
      ? synced.artifact.degradedReason || synced.artifact.status
      : '未返回视频 artifact';
    if (synced.artifact?.type === 'openmaic_video') {
      setLongRunningProgress(buildVideoArtifactProgress(synced.artifact, `视频生成未成功，但失败证据已写回资源包：${failureReason}`));
    } else {
      setLongRunningProgress(buildProgress('video', activeVideoStep, failureReason, 'failed'));
    }
    setMessage('');
    setVideoSummary('');
    setError(`视频生成未成功：${failureReason}`);
  }

  async function pollOpenMAICVideoJob(start: A3OpenMAICBridgeResponse) {
    const pollUrl = normalizeOpenMAICVideoPollUrl(start.pollUrl);
    if (!pollUrl) return { success: false, error: '视频任务缺少轮询地址，请重新生成。' } as A3OpenMAICBridgeResponse;
    const intervalMs = Math.max(1000, Math.min(start.pollIntervalMs ?? 2500, 5000));
    const maxAttempts = Math.ceil((60 * 60 * 1000) / intervalMs);
    let latestJob: A3OpenMAICBridgeResponse | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 500 : intervalMs);
      let response: Response;
      try {
        response = await fetch(pollUrl, { cache: 'no-store' });
      } catch (error) {
        return {
          success: false,
          error: `视频任务查询失败：${error instanceof Error ? error.message : '无法连接本地服务'}`,
        } as A3OpenMAICBridgeResponse;
      }
      const job = (await response.json().catch(() => ({}))) as A3OpenMAICBridgeResponse;
      if (!response.ok || !job.success) return { success: false, error: job.error || `视频任务查询失败：${response.status}` } as A3OpenMAICBridgeResponse;
      latestJob = job;
      const progress = typeof job.progress === 'number' ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
      const activeStep = progress >= 90 ? 7 : Math.max(1, Math.min(6, Math.ceil((progress / 90) * 6)));
      setLongRunningProgress(buildProgress('video', activeStep, `${job.stage || 'generating'}：${job.message || `任务进度 ${progress}%`}`));
      setVideoSummary(`视频任务${job.stage ? ` ${job.stage}` : ''}：${progress}%`);
      if (job.done || ['succeeded', 'partial', 'failed'].includes(String(job.status))) break;
    }
    if (!latestJob) return { success: false, error: '视频任务未返回状态。' } as A3OpenMAICBridgeResponse;
    if (!latestJob.done && !['succeeded', 'partial', 'failed'].includes(String(latestJob.status))) {
      return { success: false, error: '视频任务仍在运行，请稍后刷新资源包查看结果。' } as A3OpenMAICBridgeResponse;
    }
    return latestJob;
  }

  async function pollResourceGenerationJob(start: A3ResourceGenerateResponse) {
    const jobStart = start as A3ResourceGenerateResponse & {
      pollUrl?: string;
      pollIntervalMs?: number;
      status?: string;
      progress?: number;
      stage?: string;
      message?: string;
      done?: boolean;
    };
    const pollUrl = normalizeResourceGenerationPollUrl(jobStart.pollUrl);
    if (!pollUrl) return { success: false, error: '资源生成任务缺少进度地址，请重新生成。' } as A3ResourceGenerateResponse;
    const intervalMs = Math.max(800, Math.min(jobStart.pollIntervalMs ?? 1500, 4000));
    const maxAttempts = Math.ceil((30 * 60 * 1000) / intervalMs);
    const requestTimeoutMs = 12_000;
    let consecutiveTransientFailures = 0;
    const initialProgress = typeof jobStart.progress === 'number' ? jobStart.progress : 0;
    let lastActiveStep = Math.max(0, Math.min(4, Math.floor(initialProgress / 20)));
    let latestJob: (A3ResourceGenerateResponse & {
      status?: string;
      progress?: number;
      stage?: string;
      message?: string;
      done?: boolean;
    }) | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 300 : intervalMs);
      let response: Response;
      try {
        response = await fetch(pollUrl, {
          cache: 'no-store',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        consecutiveTransientFailures += 1;
        setLongRunningProgress(buildProgress(
          'resource',
          lastActiveStep,
          `资源生成仍在后台运行，正在重新连接进度服务（第 ${consecutiveTransientFailures} 次）`,
        ));
        continue;
      }
      const job = (await response.json().catch(() => ({}))) as A3ResourceGenerateResponse & {
        status?: string;
        progress?: number;
        stage?: string;
        message?: string;
        done?: boolean;
      };
      if (!response.ok || !job.success) {
        if (isRetryableResourcePollStatus(response.status)) {
          consecutiveTransientFailures += 1;
          setLongRunningProgress(buildProgress(
            'resource',
            lastActiveStep,
            `资源生成仍在后台运行，正在重新连接进度服务（第 ${consecutiveTransientFailures} 次）`,
          ));
          continue;
        }
        return { success: false, error: job.error || `资源生成进度查询失败：${response.status}` } as A3ResourceGenerateResponse;
      }
      consecutiveTransientFailures = 0;
      latestJob = job;
      const progress = typeof job.progress === 'number' ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
      const activeStep = progress >= 95 ? 5 : Math.max(0, Math.min(4, Math.floor(progress / 20)));
      lastActiveStep = activeStep;
      setLongRunningProgress(buildProgress('resource', activeStep, job.message || `资源生成进度 ${progress}%`));
      if (job.done || ['succeeded', 'failed'].includes(String(job.status))) break;
    }
    if (!latestJob) return { success: false, error: '资源生成任务未返回状态。' } as A3ResourceGenerateResponse;
    if (!latestJob.done && !['succeeded', 'failed'].includes(String(latestJob.status))) {
      return { success: false, error: '资源生成仍在运行，请稍后刷新资源包查看结果。' } as A3ResourceGenerateResponse;
    }
    return latestJob;
  }

  async function pollAndSyncOpenMAICClassroom(start: A3OpenMAICBridgeResponse, resourcePackId: string) {
    const pollUrl = normalizeOpenMAICPollUrl(start.pollUrl);
    if (!pollUrl) {
      return { success: false, error: 'OpenMAIC 课堂任务缺少轮询地址，请重新生成 PPT 课件。' } as A3OpenMAICBridgeResponse;
    }
    let latestJob: OpenMAICJobPollResponse | null = null;
    const intervalMs = Math.max(500, Math.min(start.pollIntervalMs ?? 5000, 5000));
    const maxAttempts = Math.max(12, Math.ceil((10 * 60 * 1000) / intervalMs));
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 800 : intervalMs);
      let response: Response;
      try {
        response = await fetch(pollUrl, { cache: 'no-store' });
      } catch (error) {
        return {
          success: false,
          error: `OpenMAIC 课堂状态查询失败：无法连接本地前端服务。请确认 3002 服务正在运行后重试。${error instanceof Error ? `（${error.message}）` : ''}`,
        } as A3OpenMAICBridgeResponse;
      }
      const job = (await response.json().catch(() => ({}))) as OpenMAICJobPollResponse;
      if (!response.ok || !job.success) {
        return { success: false, error: job.error || `OpenMAIC job 查询失败：${response.status}` } as A3OpenMAICBridgeResponse;
      }
      latestJob = job;
      setClassroomSummary(`OpenMAIC 课堂生成中：${job.status}，第 ${attempt + 1} 次检查。`);
      setLongRunningProgress(buildProgress('classroom', job.done || job.status === 'succeeded' ? 3 : 2, `同步课堂状态：${job.status}，第 ${attempt + 1} 次检查`));
      if (job.done || job.status === 'succeeded' || job.status === 'failed') break;
    }
    if (!latestJob) return { success: false, error: 'OpenMAIC job 未返回状态。' } as A3OpenMAICBridgeResponse;
    return postNextJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-classroom', {
      action: 'sync',
      resourcePackId,
      startedAt: start.startedAt,
      job: latestJob,
    });
  }

  async function recordResourceFeedback(action: 'opened' | 'completed' | 'skipped' | 'favorited', resourceType: string, score = 0) {
    if (!pack?.resourcePackId || !resourceType) return;
    await a3PostJson<A3ResourceFeedbackResponse>(`/api/resources/packs/${pack.resourcePackId}/feedback/`, {
      action,
      resourceType,
      score,
    });
  }

  return (
    <div data-testid="a3-recommendations-view" className="space-y-5">
      <section className="overflow-hidden rounded-[18px] border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-bg)] text-[var(--a3-highlight-text)] shadow-[var(--a3-highlight-shadow)]">
        <div className="grid gap-6 p-5 lg:grid-cols-[1fr_360px] lg:p-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-lg bg-[var(--a3-highlight-surface)] px-3 py-1 text-sm font-medium text-[var(--a3-highlight-accent)]">
              <Sparkles className="size-4" />
              资源生成工作台
            </div>
            <h1 className="mt-4 max-w-3xl text-2xl font-semibold tracking-normal">
              说出你现在卡住的内容，生成一套能直接学习的专属资料。
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--a3-highlight-muted)]">
              文档、课件、导图、练习、案例、代码实验和视频会分开呈现，想先看哪一类就打开哪一类。
            </p>
            <div data-tour-id="resource-generation-need" className="mt-5">
              <label htmlFor="resource-goal" className="text-sm font-semibold text-[var(--a3-highlight-text)]">
                你的学习需求
              </label>
              <textarea
                id="resource-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={5}
                placeholder="例如：进程调度、同步互斥、死锁和虚拟内存这些内容我还不太清楚，希望生成一套适合复习和练习的资料。"
                className="mt-2 w-full resize-none rounded-xl border border-[var(--a3-highlight-border)] bg-[var(--a3-surface-solid)] px-4 py-3 text-sm leading-6 text-[var(--a3-text)] outline-none transition placeholder:text-[var(--a3-text-muted)] focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
                data-testid="a3-resource-goal-input"
              />
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--a3-highlight-muted)]">
                <span className="rounded-full bg-[var(--a3-highlight-surface)] px-3 py-1">示例：时间片轮转怎么分析</span>
                <span className="rounded-full bg-[var(--a3-highlight-surface)] px-3 py-1">示例：信号量不会做题</span>
                <span className="rounded-full bg-[var(--a3-highlight-surface)] px-3 py-1">示例：虚拟内存复习</span>
              </div>
              <div data-tour-id="resource-generation-actions" className="mt-4 flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={generateResourcePack}
                  disabled={generatingPack || !goal.trim()}
                  className="h-11 bg-blue-500 text-white hover:bg-blue-400"
                   data-testid="a3-resource-generation-primary"
                >
                  {generatingPack ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  生成完整资源包
                 </Button>
                 <Button asChild type="button" variant="outline" className="h-11 border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10" data-testid="a3-full-resource-pack-generate">
                   <Link href="/a3/resources/latest" data-testid="a3-open-latest-resource-pack">查看最新资源包</Link>
                 </Button>
                 <Button asChild type="button" variant="outline" className="h-11 border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                   <Link href="/a3/classroom">进课堂学习</Link>
                 </Button>
                <Button asChild type="button" variant="outline" className="h-11 border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                  <Link href="/a3/knowledge-base">
                    <BookOpenText className="size-4" />
                    管理知识库资料
                  </Link>
                </Button>
                <Button asChild type="button" variant="outline" className="h-11 border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] text-[var(--a3-highlight-text)] hover:bg-white/80 dark:hover:bg-white/10">
                  <Link href="/a3/resources">
                    <Archive className="size-4" />
                    查看资源记录
                  </Link>
                </Button>
              </div>
              <div data-tour-id="resource-generation-types" className="mt-5 rounded-2xl border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] p-3">
                <div className="text-xs font-semibold text-[var(--a3-highlight-muted)]">按需单项生成</div>
                <div className="mt-3 flex flex-wrap gap-2" data-testid="a3-single-resource-type-grid">
                  {resourceEntries.map((entry) => {
                    const item = { type: entry.resourceType, label: entry.title };
                    const isPpt = entry.key === 'ppt';
                    const isVideo = entry.key === 'video';
                    const loading =
                      (!isPpt && !isVideo && entry.resourceType && singleGeneratingType === entry.resourceType) ||
                      (isPpt && generatingClassroom) ||
                      (isVideo && generatingVideo);
                    return (
                      <Button
                        key={entry.key}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!goal.trim() || Boolean(loading) || generatingPack}
                        data-testid={isPpt ? 'a3-classroom-ppt-generate' : 'a3-single-resource-generate'}
                        onClick={() => {
                          if (isPpt) void generateClassroomForPpt();
                          else if (isVideo) void generateVideoFromScript();
                          else if (item.type) void generateSingleResourceV2(item.type);
                        }}
                        className="border-[var(--a3-highlight-border)] bg-[var(--a3-surface-solid)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]"
                      >
                        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <entry.icon className="size-3.5" />}
                        {entry.title}
                      </Button>
                    );
                   })}
                   {(() => {
                     const item = { type: 'lecture_doc' as A3ResourcePackV2ResourceType };
                     return (
                       <Button
                         type="button"
                         size="sm"
                         variant="outline"
                         disabled={!goal.trim() || singleGeneratingType === item.type || generatingPack}
                         data-testid="a3-single-resource-generate"
                         className="border-[var(--a3-highlight-border)] bg-[var(--a3-surface-solid)] text-[var(--a3-text)] hover:bg-[var(--a3-surface-muted)]"
                         onClick={() => void generateSingleResourceV2(item.type)}
                       >
                         快速生成讲义文档
                       </Button>
                     );
                   })()}
                 </div>
              </div>
            </div>
          </div>

          <div data-tour-id="resource-generation-context" className="rounded-2xl border border-[var(--a3-highlight-border)] bg-[var(--a3-highlight-surface)] p-4" data-testid="a3-resource-generation-evidence">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-[var(--a3-highlight-text)]">本次会参考</div>
                <p className="mt-1 text-xs leading-5 text-[var(--a3-highlight-muted)]">系统会把你的描述和学习记录一起使用。</p>
              </div>
              <A3Pill tone="blue">实时更新</A3Pill>
            </div>
            <div className="mt-4 grid gap-3">
              <EvidenceLine label="当前课程" value={evidence.course} />
              <EvidenceLine label="当前路径节点" value={evidence.node} />
              <EvidenceLine label="重点补强" value={evidence.weakPoints} />
              <EvidenceLine label="知识库来源" value={evidence.sourceCount} />
              <EvidenceLine label="生成范围" value="文档、PPT、导图、练习、案例、代码实验、视频" />
            </div>
            <div className="mt-4 rounded-xl bg-blue-50 p-3 text-xs leading-5 text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
              RetrieverAgent 先检索资料，ResourceSynthesisAgent 生成资源，VerifierAgent 标明来源状态。
            </div>
          </div>
        </div>
      </section>

      {(message || error || classroomSummary || videoSummary) && (
        <StatusStrip message={message || classroomSummary || videoSummary} error={error} />
      )}

      {longRunningProgress && (
        <LongRunningProgressPanel progress={longRunningProgress} />
      )}

      {systemLibrary?.recommended.length ? (
        <section className="border-y border-[var(--a3-border)] py-5" data-testid="a3-curated-recommendations">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--a3-text)]">
                <BookOpenText className="size-5 text-blue-600" />
                平台资料精准推荐
              </h2>
              <p className="mt-1 text-sm text-[var(--a3-text-muted)]">已入库资料按你的路径、错题、薄弱点和可用时间排序，不需要重复上传解析。</p>
            </div>
            <Button asChild size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]">
              <Link href="/a3/library">进入系统资料库<ArrowRight className="size-4" /></Link>
            </Button>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {systemLibrary.recommended.slice(0, 3).map((resource) => (
              <Link
                key={resource.resourceCode}
                href={`/a3/library/${resource.resourceCode}`}
                className="group rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition-colors hover:border-blue-300"
              >
                <div className="flex items-center justify-between gap-3">
                  <A3Pill tone={resource.resourceType === 'video' ? 'violet' : resource.resourceType === 'code_lab' ? 'green' : 'blue'}>{resource.resourceTypeLabel}</A3Pill>
                  <span className="text-xs font-semibold text-blue-700">匹配 {resource.personalization.score}</span>
                </div>
                <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-6 text-[var(--a3-text)] group-hover:text-blue-700">{resource.title}</h3>
                <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{resource.personalization.reason}</p>
                <div className="mt-3 flex items-center justify-between text-xs text-[var(--a3-text-muted)]">
                  <span>{resource.estimatedMinutes} 分钟</span>
                  <ArrowRight className="size-4 text-blue-600 transition-transform group-hover:translate-x-0.5" />
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {recommendations.length ? (
        <section className="grid gap-4">
          <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3" data-testid="a3-recommendation-sort-benefit-strip">
            <div className="text-sm font-semibold text-blue-950">这次排序给你的直接帮助</div>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-blue-800" data-testid="a3-recommendation-user-benefit">
              <span className="rounded-full bg-[var(--a3-surface-solid)] px-3 py-1">今日优先学习动作：进课堂学习</span>
              <span className="rounded-full bg-[var(--a3-surface-solid)] px-3 py-1">按目标重新推荐</span>
              <span className="rounded-full bg-[var(--a3-surface-solid)] px-3 py-1">补充知识库证据</span>
            </div>
          </div>
          <A3Card
            title="为什么先推荐这些"
            subtitle="系统会把当前课程节点、薄弱点、知识库来源和使用反馈合起来，给出最适合先做的资源。"
            action={
              <div className="flex items-center gap-2">
                <A3Pill tone={context?.rationale.resourceEffectAttribution?.summary?.resourceEventCount ? 'green' : 'orange'}>{context?.rationale.resourceEffectAttribution?.summary?.resourceEventCount ?? 0} 条学习记录</A3Pill>
                {recommendations.length > 3 && (
                  <Button type="button" size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]" data-testid="a3-recommendation-list-toggle" onClick={() => setRecommendationsExpanded((value) => !value)}>
                    {recommendationsExpanded ? '收起' : `展开 ${recommendations.length - 3} 条`}
                  </Button>
                )}
              </div>
            }
          >
            <ProfileSignalStrip signals={context?.profileSignals ?? []} />
            <RecommendationProfileChangePanel insight={profileChangeInsight} />
            <RecommendationWeights weights={context?.rationale.weights ?? []} />
            <div className="mt-4 grid gap-3 xl:grid-cols-2">
              {visibleRecommendations.map((item) => (
                <RecommendationEvidenceItem key={item.id} item={item} profileFeed={profileFeed} />
              ))}
            </div>
            {recommendations.length > 3 && (
              <div className="mt-4 flex items-center gap-2" data-testid="a3-recommendation-list-inline-toggle">
                <Button type="button" size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]" onClick={() => setRecommendationsExpanded((value) => !value)}>
                  {recommendationsExpanded ? '收起推荐' : '查看更多推荐'}
                </Button>
              </div>
            )}
          </A3Card>
        </section>
      ) : null}

      <A3Card
        title="成品入口"
        subtitle="每一类资源进入自己的页面查看，不在当前页展开内容。"
        action={pack ? <Button asChild size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]"><Link href={`/a3/resources/${pack.resourcePackId}`}>查看审计记录</Link></Button> : null}
      >
        {pack ? (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4 text-sm text-[var(--a3-text-muted)] md:grid-cols-4" data-testid="a3-resource-result-overview">
              <Metric label="资源包" value={pack.resourcePackId.slice(0, 10)} />
              <Metric label="结构化资源" value={`${pack.resources.length} 类`} />
              <Metric label="已验证" value={`${pack.resources.filter((resource) => resource.verified).length}/${pack.resources.length}`} />
              <Metric label="trace" value={pack.traceId.slice(0, 10)} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2" data-testid="a3-resource-result-preview">
              {resourceEntries.map((entry) => (
                <ResourceEntryRow
                  key={entry.key}
                  entry={entry}
                  pack={pack}
                  generated={entry.resourceType ? generatedTypes.has(entry.resourceType) : false}
                  classroomArtifact={classroomArtifact}
                  videoArtifact={videoArtifact}
                  generating={(entry.key !== 'ppt' && entry.key !== 'video' && singleGeneratingType === entry.resourceType) || (entry.key === 'ppt' && generatingClassroom) || (entry.key === 'video' && generatingVideo)}
                  onGenerateSingle={generateSingleResourceV2}
                  onGenerateClassroom={generateClassroomForPpt}
                  onGenerateVideo={generateVideoFromScript}
                  onRecordFeedback={recordResourceFeedback}
                />
              ))}
            </div>
            <div className="grid gap-3 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 text-sm text-[var(--a3-text-muted)] md:grid-cols-3" data-testid="a3-resource-result-evidence">
              <Metric label="当前课程" value={evidence.course} />
              <Metric label="当前路径节点" value={evidence.node} />
              <Metric label="知识库来源" value={evidence.sourceCount} />
            </div>
            <div className="flex flex-wrap gap-2 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4" data-testid="a3-resource-result-next-actions">
              {(pack.nextActions.length ? pack.nextActions : [{ label: '进课堂学习', href: '/a3/classroom', reason: '用资源包继续学习' }]).map((action, index) => (
                <Button key={`${action.label}-${index}`} asChild size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]">
                  <Link href={action.href}>{action.label}</Link>
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-8 text-center">
            <Brain className="mx-auto size-9 text-blue-600" />
            <div className="mt-3 text-base font-semibold text-[var(--a3-text)]">还没有生成资源包</div>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--a3-text-muted)]">
              在上方输入你的学习需求后生成。系统会调用真实后端 `/api/resources/generate/`，不是前端假数据。
            </p>
          </div>
        )}
      </A3Card>

      <details className="rounded-[14px] border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-5 text-sm text-[var(--a3-text-muted)]">
        <summary className="cursor-pointer font-semibold text-[var(--a3-text)]">查看系统自动识别的学习上下文</summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {loadingContext ? (
            <div className="flex items-center gap-2 text-[var(--a3-text-muted)]"><Loader2 className="size-4 animate-spin" />正在读取画像、路径和知识库。</div>
          ) : (
            <>
              <ContextBox title="当前路径" value={context?.target?.title || '暂无路径节点'} />
              <ContextBox title="推荐策略" value={context?.rationale?.strategy || '等待后端返回'} />
              <ContextBox title="画像输入" value={formatProfileInputs(context)} />
              <ContextBox title="本地资料" value={`${context?.sources?.length ?? 0} 条可用引用。`} />
            </>
          )}
        </div>
      </details>
    </div>
  );
}

function isRetryableResourcePollStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function RecommendationEvidenceItem({ item, profileFeed }: { item: A3Recommendation; profileFeed: ProfileFeedResponse | null }) {
  const effect = item.evidence.resourceEffect;
  const effectInsight = buildRecommendationEffectInsight(item);
  const profileRationale = buildRecommendationProfileRationale(item, profileFeed);
  const confidence = effect?.effectConfidence ?? 'low';
  const source = item.evidence.sourceEvidence ?? item.citation;
  const hasSource = Boolean(source?.title);
  const sourceValue = hasSource
    ? `${formatSourceOrigin(source)} · ${source?.title}${source?.location ? ` · ${source.location}` : ''}`
    : '暂无可引用资料，生成时会标明来源不足';
  const usageText = formatResourceUsage(effect);
  const confidenceLabel = confidence === 'high' ? '资料依据充分' : confidence === 'medium' ? '依据基本可用' : '需要边学边验证';
  const confidenceTone = confidence === 'high' ? 'green' : confidence === 'medium' ? 'blue' : 'orange';
  const action = buildRecommendationAction(item);
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 shadow-sm" data-testid="a3-recommendation-effect-evidence">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <A3Pill tone={effectInsight.tone}>{effectInsight.label}</A3Pill>
            <div className="text-sm font-semibold leading-5 text-[var(--a3-text)]">{item.title}</div>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{item.reason}</p>
          <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800" data-testid="a3-recommendation-effect-reason">
            {effectInsight.detail}
          </div>
          <div className="mt-3 min-w-0 break-words rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-xs leading-5 text-orange-800" data-testid="a3-recommendation-profile-rationale">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-orange-950">{profileRationale.label}</span>
              <Link href={profileRationale.href || PROFILE_SETUP_HREF} className="font-semibold text-orange-700 hover:text-orange-900">
                查看画像
              </Link>
            </div>
            <div className="mt-1 break-words">{profileRationale.detail}</div>
            {profileRationale.confidence > 0 && <div className="mt-1 text-orange-700">证据置信度 {profileRationale.confidence}%</div>}
          </div>
        </div>
        <A3Pill tone={confidenceTone}>{confidenceLabel}</A3Pill>
      </div>

      <div className="mt-4 grid gap-3 text-xs leading-5 text-[var(--a3-text-muted)] sm:grid-cols-3">
        <RecommendationSignal label="适合现在学" value={item.evidence.profileMatch.reason || '匹配当前画像和学习路径'} />
        <RecommendationSignal label="参考资料" value={sourceValue} />
        <RecommendationSignal label="使用反馈" value={usageText} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--a3-surface-muted)] px-3 py-2 text-xs text-[var(--a3-text-muted)]">
        <span>{action.reason}</span>
        {action.href ? (
          <Link href={action.href} className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:text-blue-800" data-testid="a3-recommendation-next-action">
            {action.label} <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function buildRecommendationAction(item: A3Recommendation) {
  const hasSource = Boolean(item.evidence.sourceEvidence?.title || item.citation?.title);
  if (item.type.includes('practice')) {
    return { label: '去做专项练习', href: item.href || '/a3/assessment', reason: '今日优先学习动作：先练薄弱点，完成后更新掌握度。' };
  }
  if (hasSource) {
    return { label: '查看来源资料', href: item.href || '/a3/knowledge-base', reason: '先核对资料来源，再进入课堂追问。' };
  }
  return { label: '进课堂学习', href: item.href || '/a3/classroom', reason: '先让 AI 课堂围绕当前路径节点讲清楚。' };
}

function RecommendationSignal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 py-2">
      <div className="text-[11px] font-medium text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 line-clamp-2 font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function formatSourceOrigin(source: { sourceScope?: string; sourceOrigin?: string } | null | undefined) {
  if (source && source.sourceScope === 'personal') return '我的资料';
  if (source && source.sourceScope === 'teacher') return '教师资料';
  if (source && source.sourceScope === 'class') return '班级资料';
  if (source && source.sourceScope === 'global') return '全局资料';
  return source?.sourceOrigin || '知识库';
}

function ProfileSignalStrip({ signals }: { signals: NonNullable<RecommendationResponse['profileSignals']> }) {
  if (!signals.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {signals.map((signal, index) => (
        <A3Pill key={`${signal.label}-${index}`} tone={signal.tone}>
          {signal.label}：{profileSignalToneLabel(signal.tone)} · {signal.value}
        </A3Pill>
      ))}
    </div>
  );
}

function RecommendationWeights({ weights }: { weights: RecommendationResponse['rationale']['weights'] }) {
  if (!weights.length) return null;
  return (
    <div className="mt-3 grid gap-2 text-xs text-[var(--a3-text-muted)] sm:grid-cols-3">
      {weights.slice(0, 3).map((weight, index) => (
        <div key={`${weight.label}-${index}`} className="rounded-lg border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-3 py-2">
          <span className="font-semibold text-[var(--a3-text)]">{weight.label}</span>
          <span className="ml-2 text-[var(--a3-text-muted)]">{Math.round(weight.value * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function profileSignalToneLabel(tone: NonNullable<RecommendationResponse['profileSignals']>[number]['tone']) {
  if (tone === 'green') return '优势';
  if (tone === 'orange' || tone === 'red') return '需要关注';
  if (tone === 'violet') return '偏好';
  if (tone === 'slate') return '背景';
  return '匹配';
}

function formatResourceUsage(effect: A3Recommendation['evidence']['resourceEffect']) {
  if (!effect) return '暂无历史记录，先按课程和薄弱点推荐';
  const opened = Number(effect.opened ?? 0);
  const completed = Number(effect.completed ?? 0);
  const skipped = Number(effect.skipped ?? 0);
  if (completed > 0) return `同类资源已完成 ${completed} 次`;
  if (opened > 0) return `同类资源已打开 ${opened} 次`;
  if (skipped > 0) return `有人跳过 ${skipped} 次，建议先快速浏览`;
  return effect.explorationRecommended ? '还缺使用反馈，适合先试学' : '按当前学习目标推荐';
}

function ResourceEntryRow({
  entry,
  pack,
  generated,
  classroomArtifact,
  videoArtifact,
  generating,
  onGenerateSingle,
  onGenerateClassroom,
  onGenerateVideo,
  onRecordFeedback,
}: {
  entry: ResourceEntry;
  pack: A3ResourcePackV2;
  generated: boolean;
  classroomArtifact?: A3OpenMAICClassroomArtifact;
  videoArtifact?: A3OpenMAICVideoArtifact;
  generating: boolean;
  onGenerateSingle: (type: A3ResourcePackV2ResourceType) => Promise<A3ResourcePackV2 | null>;
  onGenerateClassroom: () => Promise<void>;
  onGenerateVideo: () => Promise<void>;
  onRecordFeedback: (action: 'opened' | 'completed' | 'skipped' | 'favorited', resourceType: string, score?: number) => Promise<void>;
}) {
  const Icon = entry.icon;
  const href = `/a3/resources/${pack.resourcePackId}/${entry.route}`;
  const videoSucceeded = Boolean(
    videoArtifact
    && ['succeeded', 'partial'].includes(videoArtifact.status)
    && (videoArtifact.videoUrl || videoArtifact.segments?.some((segment) => segment.status === 'succeeded' && segment.videoUrl)),
  );
  const classroomReady = classroomArtifact?.status === 'succeeded' && Boolean(classroomArtifact.classroomUrl);

  let status = generated ? '已生成' : '可单独生成';
  if (entry.key === 'ppt') status = classroomReady ? '课堂已生成' : classroomArtifact ? '课堂未完成' : '需生成课堂';
  if (entry.key === 'video') status = videoSucceeded ? '视频已生成' : generated ? '脚本已生成' : '需生成脚本';

  return (
    <div className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-4 transition hover:border-blue-200 hover:shadow-sm" data-testid="a3-resource-entry">
      <div className="flex gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[var(--a3-surface-muted)] text-[var(--a3-text-muted)]">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-[var(--a3-text)]">{entry.title}</h3>
            <A3Pill tone={entry.tone}>{status}</A3Pill>
          </div>
          <p className="mt-1 text-sm leading-6 text-[var(--a3-text-muted)]">{entry.subtitle}</p>
          <p className="mt-2 text-xs leading-5 text-[var(--a3-text-muted)]">{entry.productNote}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {entry.key === 'ppt' && !classroomReady ? (
          <Button type="button" size="sm" onClick={onGenerateClassroom} disabled={generating} className="bg-violet-600 text-white hover:bg-violet-700" data-testid="a3-classroom-ppt-generate">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <MonitorPlay className="size-4" />}
            生成课堂/PPT
          </Button>
        ) : entry.key === 'video' && !videoSucceeded ? (
          <Button type="button" size="sm" onClick={onGenerateVideo} disabled={generating} className="bg-blue-600 text-white hover:bg-blue-700">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {generated ? '生成视频任务' : '生成视频任务'}
          </Button>
        ) : !generated && entry.resourceType ? (
          <Button type="button" size="sm" onClick={() => void onGenerateSingle(entry.resourceType!)} disabled={generating} className="bg-slate-900 text-white hover:bg-slate-800">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            单独生成
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline" className="bg-[var(--a3-surface-solid)]">
          <Link
            href={href}
            data-testid="a3-resource-entry-open"
            onClick={() => {
              const feedbackType = entry.key === 'video' ? 'micro_video_script' : entry.resourceType ?? 'lecture_doc';
              void onRecordFeedback('opened', feedbackType);
            }}
          >
            进入资源页
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function RecommendationProfileChangePanel({ insight }: { insight: LearningFlowInsight | null }) {
  if (!insight) return null;
  return (
    <div data-testid="a3-recommendation-profile-change-reason" className="mt-4 rounded-xl border border-orange-100 bg-orange-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-orange-950">{insight.title}</div>
          <p className="mt-1 text-xs leading-5 text-orange-800">{insight.detail}</p>
        </div>
        <A3Pill tone={insight.tone}>{insight.meta || '画像证据'}</A3Pill>
      </div>
      <Button asChild size="sm" variant="outline" className="mt-3 border-orange-200 bg-[var(--a3-surface-solid)] text-orange-800 hover:bg-orange-50 dark:text-orange-200 dark:hover:bg-orange-950/40">
        <Link href={insight.href}>确认后刷新推荐</Link>
      </Button>
    </div>
  );
}

function LongRunningProgressPanel({ progress }: { progress: LongRunningProgress }) {
  const doneCount = progress.steps.filter((step) => step.status === 'succeeded').length;
  const percent = Math.round((doneCount / progress.steps.length) * 100);
  const stepsGrid = (
    <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
      {progress.steps.map((step) => (
        <div key={step.label} className={cn('rounded-xl border px-3 py-2 text-xs leading-5', progressStepClassName(step.status))}>
          <div className="flex items-center gap-2 font-medium">
            <span className={cn('size-2 rounded-full', progressStepDotClassName(step.status))} />
            {step.label}
          </div>
          {step.detail && <div className="mt-1 text-[11px] opacity-80">{step.detail}</div>}
        </div>
      ))}
    </div>
  );
  return (
    <div data-testid="a3-long-running-progress" className="rounded-2xl border border-blue-100 bg-[var(--a3-surface-solid)] p-4 shadow-sm dark:border-blue-900/50">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-sm font-semibold text-[var(--a3-text)]">{progress.title}</div>
          <p className="mt-1 text-sm leading-6 text-[var(--a3-text-muted)]">{progress.message}</p>
        </div>
        <A3Pill tone={progress.steps.some((step) => step.status === 'failed') ? 'red' : percent === 100 ? 'green' : 'blue'}>
          {percent}%
        </A3Pill>
      </div>
      {progress.kind === 'video' ? (
        <div data-testid="a3-video-generation-progress">{stepsGrid}</div>
      ) : (
        <div data-testid="a3-classroom-generation-progress">{stepsGrid}</div>
      )}
    </div>
  );
}

function StatusStrip({ message, error }: { message: string; error: string }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm md:flex-row md:items-center md:justify-between',
        error
          ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200'
          : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200',
      )}
      data-testid="a3-recommendation-message"
    >
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
        <span>{error || message}</span>
      </div>
    </div>
  );
}

function EvidenceLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[var(--a3-surface-solid)] px-3 py-2">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 line-clamp-2 text-sm font-medium text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}

function ContextBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-3">
      <div className="text-xs font-semibold text-blue-700">{title}</div>
      <p className="mt-2 text-sm leading-6 text-[var(--a3-text-muted)]">{value}</p>
    </div>
  );
}

function buildProgress(kind: LongRunningProgress['kind'], activeIndex: number, message: string, finalStatus?: ProgressStepStatus): LongRunningProgress {
  const labels = kind === 'video' ? videoProgressLabels : kind === 'resource' ? resourceProgressLabels : classroomProgressLabels;
  return {
    kind,
    title: kind === 'video' ? '视频生成进度' : kind === 'resource' ? '资源生成进度' : 'PPT 课堂生成进度',
    message,
    steps: labels.map((label, index) => {
      let status: ProgressStepStatus = index < activeIndex ? 'succeeded' : index === activeIndex ? 'running' : 'pending';
      if (finalStatus && index === activeIndex) status = finalStatus;
      if (finalStatus === 'succeeded' && index <= activeIndex) status = 'succeeded';
      if (finalStatus === 'failed' && index === activeIndex) status = 'failed';
      return { label, status };
    }),
  };
}

function buildVideoArtifactProgress(artifact: A3OpenMAICVideoArtifact, message: string): LongRunningProgress {
  const segments = artifact.segments ?? [];
  return {
    kind: 'video',
    title: '视频生成进度',
    message,
    steps: videoProgressLabels.map((label, index) => {
      const status: ProgressStepStatus = index === 0
        ? 'succeeded'
        : label === '写回 A3 资源包' ? 'succeeded'
          : segments[index - 1]?.status === 'succeeded' ? 'succeeded' : 'failed';
      const segment = index > 0 && index <= segments.length ? segments[index - 1] : undefined;
      return {
        label,
        status,
        detail: segment?.status === 'failed' ? segment.degradedReason : undefined,
      };
    }),
  };
}

function progressStepClassName(status: ProgressStepStatus) {
  if (status === 'succeeded') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-800';
  if (status === 'failed') return 'border-rose-200 bg-rose-50 text-rose-800';
  return 'border-slate-200 bg-slate-50 text-slate-500';
}

function progressStepDotClassName(status: ProgressStepStatus) {
  if (status === 'succeeded') return 'bg-emerald-500';
  if (status === 'running') return 'animate-pulse bg-blue-500';
  if (status === 'failed') return 'bg-rose-500';
  return 'bg-slate-300';
}

function buildGenerationEvidence(context: RecommendationResponse | null, goal: string, pack: A3ResourcePackV2 | null) {
  const profileInputs = context?.rationale?.profileInputs;
  return {
    goal: sanitizeText(goal || pack?.goal || context?.query || context?.target?.title, '等待输入学习需求'),
    course: sanitizeText(context?.target?.chapter?.title, '跟随当前课程上下文'),
    node: sanitizeText(context?.target?.title, '跟随当前学习路径节点'),
    weakPoints: profileInputs?.weakPoints?.slice(0, 3).map((item) => sanitizeText(item, '薄弱点')).join('、') || '根据诊断和错题动态补充',
    sourceCount: `${context?.sources?.length ?? 0} 条候选资料`,
  };
}

function formatProfileInputs(context: RecommendationResponse | null) {
  const inputs = context?.rationale?.profileInputs;
  if (!inputs) return '暂无画像输入，生成时会使用当前路径和知识库作为兜底。';
  return [
    `基础：${sanitizeText(inputs.foundationLevel, '待诊断')}`,
    `每日时间：${inputs.dailyMinutes || '--'} 分钟`,
    `目标：${inputs.learningGoals?.slice(0, 2).join('、') || '待补充'}`,
    `偏好：${inputs.expectedResources?.slice(0, 2).join('、') || '待补充'}`,
  ].join('；');
}

function normalizeGoal(goal: string, context: RecommendationResponse | null) {
  return sanitizeText(goal, context?.query || context?.target?.title || '当前学习目标');
}

async function postNextJson<T extends { success: boolean; error?: string }>(url: string, body: unknown): Promise<T> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) return { ...data, success: false, error: data.error || `请求失败：${response.status}` };
    return data;
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '请求失败' } as T;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOpenMAICPollUrl(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, window.location.origin);
    if (parsed.pathname.startsWith('/api/generate-classroom/')) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeOpenMAICVideoPollUrl(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, window.location.origin);
    if (parsed.pathname === '/api/a3/resources/openmaic-video' && parsed.searchParams.get('jobId')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeResourceGenerationPollUrl(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text, window.location.origin);
    if (parsed.pathname === '/api/a3/resources/jobs' && parsed.searchParams.get('jobId')) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return '';
  }
  return '';
}

function buildVideoPrompt(goal: string, resource: A3ResourcePackV2Resource) {
  const content = resource.content ?? {};
  const shots = Array.isArray(content.shots) ? content.shots.map((shot) => (typeof shot === 'object' && shot ? shot as Record<string, unknown> : {})) : [];
  const evidence = resource.citations
    .slice(0, 3)
    .map((citation, index) => `${index + 1}. ${sanitizeText(citation.title || citation.location, '本地知识库')}：${sanitizeText(citation.snippet, '')}`)
    .filter((item) => item.trim().length > 3);

  if (shots.length) {
    const shotPlan = shots.slice(0, 8).map((shot, index) => {
      const scene = sanitizeText(shot.scene, `镜头 ${index + 1}`);
      const visual = sanitizeVideoVisualText(shot.visual);
      const narration = sanitizeText(shot.narration, '用一句话解释当前步骤');
      const duration = Number(shot.durationSeconds || 0);
      return `${index + 1}. ${scene}${duration ? `，约 ${Math.min(Math.max(duration, 3), 10)} 秒` : ''}：无文字画面 ${visual}；旁白/字幕 ${narration}`;
    });
    return [
      `生成一个 ${estimateVideoDuration(resource)} 秒、16:9、1080p 的中文课程讲解视频。系统会拆成多个 10 秒无文字动画片段连续播放。`,
      `主题：${sanitizeText(goal, '当前学习目标')}。标题：${sanitizeText(resource.title, '教学视频')}。`,
      '画风：干净的现代教育动画，使用人物动作、图标、颜色、流程箭头和抽象示意表达。画面中禁止出现任何可读文字、汉字、英文、公式、标题、板书、白板字、字幕或水印；中文内容只通过旁白/字幕层呈现。',
      '按下面分镜生成，镜头之间自然过渡：',
      ...shotPlan,
      evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达资源包已有内容，不编造教材页码。',
      '最终效果：学生看完能知道概念关系、步骤顺序和下一步练习动作。',
    ].join('\n');
  }

  return [
    `生成一个 ${estimateVideoDuration(resource)} 秒、16:9、1080p 的中文课程讲解视频。系统会拆成多个 10 秒无文字动画片段连续播放。`,
    `主题：${sanitizeText(goal, '当前学习目标')}。资源标题：${sanitizeText(resource.title, '教学视频')}。`,
    `个性化原因：${sanitizeText(resource.personalizationReason, '根据画像、路径节点和知识库证据生成。')}`,
    '画面结构：人物困惑引入、核心概念的无文字图解、步骤或例题的动作演示、最后用图标提示练习动作。画面中禁止出现任何可读文字、汉字、英文、公式、标题、板书、白板字、字幕或水印；中文内容只通过旁白/字幕层呈现。',
    evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达摘要内容，不编造来源。',
  ].join('\n');
}

function sanitizeVideoVisualText(value: unknown) {
  const visual = sanitizeText(value, '用人物动作、图标、颜色和箭头表达，不出现文字');
  return visual
    .replace(/标题|字幕|屏幕文字|板书|白板|文字|小字|公式|英文|汉字/g, '无文字图形')
    .replace(/本地资料摘录|资料摘录|文案|题干/g, '资料图标')
    .replace(/四栏|列表|表格/g, '分组图标')
    .slice(0, 160);
}

function estimateVideoDuration(_resource: A3ResourcePackV2Resource): 60 {
  return 60;
}

function sanitizeRecommendationResponse(result: RecommendationResponse): RecommendationResponse {
  return {
    ...result,
    error: result.error ? sanitizeText(result.error, '推荐资源加载失败') : result.error,
    query: sanitizeText(result.query, '当前学习目标'),
    target: result.target
      ? {
          ...result.target,
          title: sanitizeText(result.target.title, '当前路径节点'),
          description: sanitizeText(result.target.description, '当前学习目标'),
          reason: sanitizeText(result.target.reason, '根据学习路径选择当前节点。'),
          chapter: { ...result.target.chapter, title: sanitizeText(result.target.chapter.title, '当前章节') },
        }
      : result.target,
    recommendations: (result.recommendations ?? []).map(sanitizeRecommendation),
    sources: (result.sources ?? []).map((source) => ({
      ...source,
      title: sanitizeText(source.title, '引用来源'),
      location: sanitizeText(source.location, '资料位置待返回'),
      snippet: sanitizeText(source.snippet, '暂无可展示片段。'),
      type: sanitizeText(source.type, '本地资料'),
      sourceTypeLabel: sanitizeText(source.sourceTypeLabel, '本地资料'),
      sourceOrigin: sanitizeText(source.sourceOrigin, '知识库索引'),
    })),
    rationale: {
      ...result.rationale,
      strategy: sanitizeText(result.rationale.strategy, '结合画像、路径、错题和知识库证据生成。'),
    },
  };
}

function sanitizeRecommendation(item: A3Recommendation): A3Recommendation {
  const profileMatch = item.evidence.profileMatch;
  const sourceEvidence = item.evidence.sourceEvidence;
  return {
    ...item,
    title: sanitizeText(item.title, '学习资源'),
    type: sanitizeText(item.type, '学习资源'),
    reason: sanitizeText(item.reason, '根据当前画像、路径节点、错题和知识库证据推荐。'),
    citation: item.citation
      ? {
          ...item.citation,
          title: sanitizeText(item.citation.title, '引用来源'),
          location: sanitizeText(item.citation.location, '资料位置待返回'),
          snippet: sanitizeText(item.citation.snippet, '暂无可展示片段。'),
          type: sanitizeText(item.citation.type, '本地资料'),
          sourceTypeLabel: sanitizeText(item.citation.sourceTypeLabel, '本地资料'),
          sourceOrigin: sanitizeText(item.citation.sourceOrigin, '知识库索引'),
        }
      : item.citation,
    evidence: {
      ...item.evidence,
      profileMatch: {
        ...profileMatch,
        reason: sanitizeText(profileMatch.reason, '按当前路径与学习状态匹配'),
        signals: (profileMatch.signals ?? []).map((signal) => sanitizeText(signal, '学习信号')),
      },
      rankingBasis: (item.evidence.rankingBasis ?? []).map((basis) => ({
        ...basis,
        label: sanitizeText(basis.label, '推荐依据'),
        value: typeof basis.value === 'string' ? sanitizeText(basis.value, '已纳入排序') : basis.value,
      })),
      sourceEvidence: sourceEvidence
        ? {
            ...sourceEvidence,
            title: sanitizeText(sourceEvidence.title, '引用来源'),
            location: sanitizeText(sourceEvidence.location, '资料位置待返回'),
            snippet: sanitizeText(sourceEvidence.snippet, '暂无可展示片段。'),
            type: sanitizeText(sourceEvidence.type, '本地资料'),
            sourceTypeLabel: sanitizeText(sourceEvidence.sourceTypeLabel, '本地资料'),
            sourceOrigin: sanitizeText(sourceEvidence.sourceOrigin, '知识库索引'),
          }
        : sourceEvidence,
    },
  };
}

function sanitizeResourcePackV2(resourcePack: A3ResourcePackV2): A3ResourcePackV2 {
  return {
    ...resourcePack,
    goal: sanitizeText(resourcePack.goal, '当前学习目标'),
    learnerProfileSnapshot: sanitizeUnknownRecord(resourcePack.learnerProfileSnapshot ?? {}),
    resources: (resourcePack.resources ?? []).map((resource) => ({
      ...resource,
      title: sanitizeText(resource.title, resourceLabels[resource.type] ?? '学习资源'),
      content: sanitizeUnknownRecord(resource.content ?? {}),
      citations: (resource.citations ?? []).map(sanitizeCitation),
      personalizationReason: sanitizeText(resource.personalizationReason, '根据当前画像、路径节点和知识库证据生成。'),
    })),
    nextActions: (resourcePack.nextActions ?? []).map((action) => ({
      ...action,
      label: sanitizeText(action.label, '继续学习'),
      reason: action.reason ? sanitizeText(action.reason, '继续完成资源包学习。') : action.reason,
    })),
  };
}

function sanitizeCitation(citation: A3ResourcePackV2Citation): A3ResourcePackV2Citation {
  return {
    ...citation,
    title: citation.title ? sanitizeText(citation.title, '引用来源') : citation.title,
    location: citation.location ? sanitizeText(citation.location, '资料位置待返回') : citation.location,
    type: citation.type ? sanitizeText(citation.type, '本地资料') : citation.type,
    sourceTypeLabel: citation.sourceTypeLabel ? sanitizeText(citation.sourceTypeLabel, '本地资料') : citation.sourceTypeLabel,
    sourceOrigin: citation.sourceOrigin ? sanitizeText(citation.sourceOrigin, '知识库索引') : citation.sourceOrigin,
    snippet: citation.snippet ? sanitizeText(citation.snippet, '暂无可展示片段。') : citation.snippet,
  };
}

function sanitizeUnknownRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeUnknownValue(value)]));
}

function sanitizeUnknownValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value, '内容已生成');
  if (Array.isArray(value)) return value.map(sanitizeUnknownValue);
  if (value && typeof value === 'object') return sanitizeUnknownRecord(value as Record<string, unknown>);
  return value;
}

function sanitizeText(value: unknown, fallback: string) {
  return sanitizeA3Text(value, fallback);
}

function sanitizeA3Text(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string) {
  const markerCodePoints = [0xfffd, 0x951b, 0x7ee1, 0x93ba, 0x74a7, 0x938d, 0x9422, 0x7470, 0x93c1, 0x701b, 0x94d6, 0x95c5, 0x68f0, 0x9352, 0x935b, 0x942d, 0x95bf, 0x7f01, 0x93cc, 0x6fb6, 0x9369, 0x59e3, 0x52ec, 0x9301, 0x20ac];
  return [...text].some((char) => markerCodePoints.includes(char.codePointAt(0) ?? 0));
}
