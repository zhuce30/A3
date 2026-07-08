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

type A3OpenMAICBridgeResponse = {
  success: boolean;
  error?: string;
  jobId?: string;
  status?: string;
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

const resourceEntries: ResourceEntry[] = [
  {
    key: 'document',
    title: '讲解文档',
    subtitle: '按你的描述整理成可直接阅读的讲义。',
    route: 'document',
    resourceType: 'lecture_doc',
    icon: FileText,
    tone: 'blue',
    productNote: '包含概念解释、例子、复习卡和引用来源。',
  },
  {
    key: 'ppt',
    title: 'PPT 课件',
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
    title: '教学视频',
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

  const evidence = useMemo(() => buildGenerationEvidence(context, goal, pack), [context, goal, pack]);
  const classroomArtifact = pack?.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICClassroomArtifact => artifact.type === 'openmaic_classroom');
  const videoArtifact = pack?.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICVideoArtifact => artifact.type === 'openmaic_video');
  const generatedTypes = new Set(pack?.resources.map((resource) => resource.type) ?? []);

  async function loadInitialContext() {
    const result = await a3PostJson<RecommendationResponse>('/api/recommend/', {
      goal: '',
      topK: 4,
      mode: 'fast',
    });
    setLoadingContext(false);
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
    const result = await a3PostJson<A3ResourceGenerateResponse>('/api/resources/generate/', {
      goal: nextGoal,
      topK: 5,
    });
    setGeneratingPack(false);
    if (!result.success || !result.resourcePack) {
      setError(result.error ?? '资源包生成失败。');
      return;
    }
    const normalizedPack = sanitizeResourcePackV2(result.resourcePack);
    setPack(normalizedPack);
    setMessage(`已生成个性化资源包，traceId: ${(result.traceId ?? normalizedPack.traceId).slice(0, 12)}。请从下面选择一个成品单独查看。`);
  }

  async function generateSingleResource(resourceType: A3ResourcePackV2ResourceType) {
    const nextGoal = normalizeGoal(goal, context);
    setSingleGeneratingType(resourceType);
    setError('');
    setMessage('');
    const result = await a3PostJson<A3ResourceGenerateResponse>('/api/resources/generate/', {
      goal: nextGoal,
      topK: 5,
      resourceType,
    });
    setSingleGeneratingType('');
    if (!result.success || !result.resourcePack) {
      setError(result.error ?? `${resourceLabels[resourceType]}生成失败。`);
      return null;
    }
    const normalizedPack = sanitizeResourcePackV2(result.resourcePack);
    setPack(normalizedPack);
    setMessage(`已单独生成${resourceLabels[resourceType]}，traceId: ${(result.traceId ?? normalizedPack.traceId).slice(0, 12)}。`);
    return normalizedPack;
  }

  async function generateClassroomForPpt() {
    const currentPack = pack ?? (await generateSingleResource('lecture_doc'));
    if (!currentPack) return;
    setGeneratingClassroom(true);
    setError('');
    setMessage('');
    setClassroomSummary('');
    const citations = currentPack.resources.flatMap((resource) => resource.citations).slice(0, 6);
    const result = await postNextJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-classroom', {
      resourcePackId: currentPack.resourcePackId,
      goal: currentPack.goal,
      learnerProfileSnapshot: currentPack.learnerProfileSnapshot,
      citations,
    });
    if (!result.success || !result.jobId || !result.pollUrl) {
      setGeneratingClassroom(false);
      setError(result.error ?? 'OpenMAIC 课堂任务创建失败。');
      return;
    }
    setClassroomSummary(`课堂任务已创建：${result.jobId}，正在等待 OpenMAIC 回写。`);
    const synced = await pollAndSyncOpenMAICClassroom(result, currentPack.resourcePackId);
    setGeneratingClassroom(false);
    if (!synced.success) {
      setError(synced.error ?? 'OpenMAIC 课堂同步失败。');
      return;
    }
    if (synced.resourcePack) setPack(sanitizeResourcePackV2(synced.resourcePack));
    if (synced.artifact?.type === 'openmaic_classroom' && synced.artifact.status === 'succeeded') {
      setClassroomSummary(`课堂已生成：${synced.artifact.scenesCount} 个场景。进入 PPT 页面可打开课堂并导出 PPTX。`);
      setMessage('PPT 课件入口已准备好。');
    } else {
      setClassroomSummary('课堂任务已回写，但尚未成功生成 PPT 可导出的课堂。');
    }
  }

  async function generateVideoFromScript() {
    let currentPack = pack;
    let script = currentPack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;
    if (!currentPack || !script) {
      currentPack = await generateSingleResource('micro_video_script');
      script = currentPack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;
    }
    if (!currentPack || !script) return;
    setGeneratingVideo(true);
    setError('');
    setMessage('');
    setVideoSummary('');
    const result = await postNextJson<A3OpenMAICBridgeResponse>('/api/a3/resources/openmaic-video', {
      resourcePackId: currentPack.resourcePackId,
      provider: 'seedance',
      resourceType: script.type,
      prompt: buildVideoPrompt(currentPack.goal, script),
      duration: estimateVideoDuration(script),
      aspectRatio: '16:9',
      resolution: '1080p',
    });
    setGeneratingVideo(false);
    if (!result.success) {
      setError(result.error ?? 'OpenMAIC 视频任务创建失败。');
      return;
    }
    if (result.resourcePack) setPack(sanitizeResourcePackV2(result.resourcePack));
    if (result.artifact?.type === 'openmaic_video' && result.artifact.status === 'succeeded') {
      setVideoSummary(`视频已生成：${result.artifact.provider} / ${result.artifact.duration || '--'} 秒。`);
      setMessage('视频成品已写回资源包，可以进入视频页播放。');
      return;
    }
    setVideoSummary(`视频任务未成功完成：${result.artifact?.type === 'openmaic_video' ? result.artifact.degradedReason || result.artifact.status : '未返回 artifact'}`);
  }

  async function pollAndSyncOpenMAICClassroom(start: A3OpenMAICBridgeResponse, resourcePackId: string) {
    let latestJob: OpenMAICJobPollResponse | null = null;
    const intervalMs = Math.max(500, Math.min(start.pollIntervalMs ?? 5000, 5000));
    const maxAttempts = Math.max(12, Math.ceil((10 * 60 * 1000) / intervalMs));
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(attempt === 0 ? 800 : intervalMs);
      const response = await fetch(start.pollUrl!, { cache: 'no-store' });
      const job = (await response.json().catch(() => ({}))) as OpenMAICJobPollResponse;
      if (!response.ok || !job.success) {
        return { success: false, error: job.error || `OpenMAIC job 查询失败：${response.status}` } as A3OpenMAICBridgeResponse;
      }
      latestJob = job;
      setClassroomSummary(`OpenMAIC 课堂生成中：${job.status}，第 ${attempt + 1} 次检查。`);
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
      <section className="overflow-hidden rounded-[18px] border border-slate-200 bg-slate-950 text-slate-50 shadow-sm">
        <div className="grid gap-6 p-5 lg:grid-cols-[1fr_360px] lg:p-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1 text-sm font-medium text-blue-100">
              <Sparkles className="size-4" />
              个性化资源生成入口
            </div>
            <h1 className="mt-4 max-w-3xl text-2xl font-semibold tracking-normal">
              说出你现在卡住的内容，生成一套能直接学习的专属资料。
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
              文档、课件、导图、练习、案例、代码实验和视频会分开呈现，想先看哪一类就打开哪一类。
            </p>
            <div className="mt-5">
              <label htmlFor="resource-goal" className="text-sm font-semibold text-slate-100">
                你的学习需求
              </label>
              <textarea
                id="resource-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                rows={5}
                placeholder="例如：进程调度、同步互斥、死锁和虚拟内存这些内容我还不太清楚，希望生成一套适合复习和练习的资料。"
                className="mt-2 w-full resize-none rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm leading-6 text-slate-50 outline-none transition placeholder:text-slate-500 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/30"
                data-testid="a3-resource-goal-input"
              />
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="rounded-full bg-white/5 px-3 py-1">示例：时间片轮转怎么分析</span>
                <span className="rounded-full bg-white/5 px-3 py-1">示例：信号量不会做题</span>
                <span className="rounded-full bg-white/5 px-3 py-1">示例：虚拟内存复习</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={generateResourcePack}
                  disabled={generatingPack || !goal.trim()}
                  className="h-11 bg-blue-500 text-white hover:bg-blue-400"
                  data-testid="a3-full-resource-pack-generate"
                >
                  {generatingPack ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  生成 7 类个性化资源
                </Button>
                <Button asChild type="button" variant="outline" className="h-11 border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800">
                  <Link href="/a3/knowledge-base">
                    <BookOpenText className="size-4" />
                    管理知识库资料
                  </Link>
                </Button>
                <Button asChild type="button" variant="outline" className="h-11 border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800">
                  <Link href="/a3/resources">
                    <Archive className="size-4" />
                    查看资源记录
                  </Link>
                </Button>
              </div>
              <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                <div className="text-xs font-semibold text-slate-300">只想先生成一种？</div>
                <div className="mt-3 flex flex-wrap gap-2" data-testid="a3-single-resource-shortcuts">
                  {resourceEntries.map((entry) => {
                    const isPpt = entry.key === 'ppt';
                    const isVideo = entry.key === 'video';
                    const loading =
                      (entry.resourceType && singleGeneratingType === entry.resourceType) ||
                      (isPpt && generatingClassroom) ||
                      (isVideo && generatingVideo);
                    return (
                      <Button
                        key={entry.key}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!goal.trim() || Boolean(loading) || generatingPack}
                        onClick={() => {
                          if (isPpt) void generateClassroomForPpt();
                          else if (isVideo) void generateVideoFromScript();
                          else if (entry.resourceType) void generateSingleResource(entry.resourceType);
                        }}
                        className="border-slate-600 bg-slate-900 text-slate-100 hover:bg-slate-800"
                        data-testid="a3-single-resource-shortcut"
                      >
                        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <entry.icon className="size-3.5" />}
                        {entry.title}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-100">本次会参考</div>
                <p className="mt-1 text-xs leading-5 text-slate-400">系统会把你的描述和学习记录一起使用。</p>
              </div>
              <A3Pill tone="blue">实时更新</A3Pill>
            </div>
            <div className="mt-4 grid gap-3">
              <EvidenceLine label="课程进度" value={`${evidence.course} · ${evidence.node}`} />
              <EvidenceLine label="重点补强" value={evidence.weakPoints} />
              <EvidenceLine label="资料来源" value={evidence.sourceCount} />
              <EvidenceLine label="生成范围" value="文档、PPT、导图、练习、案例、代码实验、视频" />
            </div>
            <div className="mt-4 rounded-xl bg-blue-500/10 p-3 text-xs leading-5 text-blue-100">
              生成内容会优先引用你的课程资料；证据不足的部分会标明来源状态。
            </div>
          </div>
        </div>
      </section>

      {(message || error || classroomSummary || videoSummary) && (
        <StatusStrip message={message || classroomSummary || videoSummary} error={error} />
      )}

      {context?.recommendations?.length ? (
        <A3Card
          title="为什么先推荐这些"
          subtitle="系统会把当前课程节点、薄弱点、知识库来源和使用反馈合起来，给出最适合先做的资源。"
          action={<A3Pill tone={context.rationale.resourceEffectAttribution?.summary?.resourceEventCount ? 'green' : 'orange'}>{context.rationale.resourceEffectAttribution?.summary?.resourceEventCount ?? 0} 条学习记录</A3Pill>}
        >
          <div className="grid gap-3 xl:grid-cols-2">
            {context.recommendations.slice(0, 4).map((item) => (
              <RecommendationEvidenceItem key={item.id} item={item} />
            ))}
          </div>
        </A3Card>
      ) : null}

      <A3Card
        title="成品入口"
        subtitle="每一类资源进入自己的页面查看，不在当前页展开内容。"
        action={pack ? <Button asChild size="sm" variant="outline" className="bg-white"><Link href={`/a3/resources/${pack.resourcePackId}`}>查看审计记录</Link></Button> : null}
      >
        {pack ? (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 md:grid-cols-4">
              <Metric label="资源包" value={pack.resourcePackId.slice(0, 10)} />
              <Metric label="结构化资源" value={`${pack.resources.length} 类`} />
              <Metric label="已验证" value={`${pack.resources.filter((resource) => resource.verified).length}/${pack.resources.length}`} />
              <Metric label="trace" value={pack.traceId.slice(0, 10)} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {resourceEntries.map((entry) => (
                <ResourceEntryRow
                  key={entry.key}
                  entry={entry}
                  pack={pack}
                  generated={entry.resourceType ? generatedTypes.has(entry.resourceType) : false}
                  classroomArtifact={classroomArtifact}
                  videoArtifact={videoArtifact}
                  generating={singleGeneratingType === entry.resourceType || (entry.key === 'ppt' && generatingClassroom) || (entry.key === 'video' && generatingVideo)}
                  onGenerateSingle={generateSingleResource}
                  onGenerateClassroom={generateClassroomForPpt}
                  onGenerateVideo={generateVideoFromScript}
                  onRecordFeedback={recordResourceFeedback}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
            <Brain className="mx-auto size-9 text-blue-600" />
            <div className="mt-3 text-base font-semibold text-slate-950">还没有生成资源包</div>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
              在上方输入你的学习需求后生成。系统会调用真实后端 `/api/resources/generate/`，不是前端假数据。
            </p>
          </div>
        )}
      </A3Card>

      <details className="rounded-[14px] border border-slate-200 bg-white p-5 text-sm text-slate-600">
        <summary className="cursor-pointer font-semibold text-slate-950">查看系统自动识别的学习上下文</summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {loadingContext ? (
            <div className="flex items-center gap-2 text-slate-500"><Loader2 className="size-4 animate-spin" />正在读取画像、路径和知识库。</div>
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

function RecommendationEvidenceItem({ item }: { item: A3Recommendation }) {
  const effect = item.evidence.resourceEffect;
  const confidence = effect?.effectConfidence ?? 'low';
  const source = item.evidence.sourceEvidence ?? item.citation;
  const hasSource = Boolean(source?.title);
  const usageText = formatResourceUsage(effect);
  const confidenceLabel = confidence === 'high' ? '资料依据充分' : confidence === 'medium' ? '依据基本可用' : '需要边学边验证';
  const confidenceTone = confidence === 'high' ? 'green' : confidence === 'medium' ? 'blue' : 'orange';
  const nextStep = item.href ? '打开对应资源，学完后点完成，系统会更新计划和推荐。' : '先生成资源包，再进入对应页面学习。';
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="a3-recommendation-effect-evidence">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-5 text-slate-950">{item.title}</div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{item.reason}</p>
        </div>
        <A3Pill tone={confidenceTone}>{confidenceLabel}</A3Pill>
      </div>

      <div className="mt-4 grid gap-3 text-xs leading-5 text-slate-600 sm:grid-cols-3">
        <RecommendationSignal label="适合现在学" value={item.evidence.profileMatch.reason || '匹配当前画像和学习路径'} />
        <RecommendationSignal label="参考资料" value={hasSource ? `${source?.title}${source?.location ? ` · ${source.location}` : ''}` : '暂无可引用资料，生成时会标明来源不足'} />
        <RecommendationSignal label="使用反馈" value={usageText} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
        <span>{nextStep}</span>
        {item.href ? (
          <Link href={item.href} className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:text-blue-800">
            去学习 <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function RecommendationSignal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-1 line-clamp-2 font-semibold text-slate-900">{value}</div>
    </div>
  );
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
  const videoSucceeded = videoArtifact?.status === 'succeeded' && Boolean(videoArtifact.videoUrl);
  const classroomReady = classroomArtifact?.status === 'succeeded' && Boolean(classroomArtifact.classroomUrl);

  let status = generated ? '已生成' : '可单独生成';
  if (entry.key === 'ppt') status = classroomReady ? '课堂已生成' : classroomArtifact ? '课堂未完成' : '需生成课堂';
  if (entry.key === 'video') status = videoSucceeded ? '视频已生成' : generated ? '脚本已生成' : '需生成脚本';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-blue-200 hover:shadow-sm" data-testid="a3-resource-entry">
      <div className="flex gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
          <Icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-950">{entry.title}</h3>
            <A3Pill tone={entry.tone}>{status}</A3Pill>
          </div>
          <p className="mt-1 text-sm leading-6 text-slate-600">{entry.subtitle}</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">{entry.productNote}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {entry.key === 'ppt' && !classroomReady ? (
          <Button type="button" size="sm" onClick={onGenerateClassroom} disabled={generating} className="bg-violet-600 text-white hover:bg-violet-700">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <MonitorPlay className="size-4" />}
            生成 PPT 课堂
          </Button>
        ) : entry.key === 'video' && !videoSucceeded ? (
          <Button type="button" size="sm" onClick={onGenerateVideo} disabled={generating} className="bg-blue-600 text-white hover:bg-blue-700">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {generated ? '生成视频' : '生成脚本并生成视频'}
          </Button>
        ) : !generated && entry.resourceType ? (
          <Button type="button" size="sm" onClick={() => void onGenerateSingle(entry.resourceType!)} disabled={generating} className="bg-slate-900 text-white hover:bg-slate-800">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            单独生成
          </Button>
        ) : null}
        <Button asChild size="sm" variant="outline" className="bg-white">
          <Link
            href={href}
            onClick={() => {
              const feedbackType = entry.key === 'video' ? 'micro_video_script' : entry.resourceType ?? 'lecture_doc';
              void onRecordFeedback('opened', feedbackType);
            }}
          >
            打开页面
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function StatusStrip({ message, error }: { message: string; error: string }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-4 py-3 text-sm md:flex-row md:items-center md:justify-between',
        error ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800',
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
    <div className="rounded-xl bg-white/5 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-1 line-clamp-2 text-sm font-medium text-slate-100">{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function ContextBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-semibold text-blue-700">{title}</div>
      <p className="mt-2 text-sm leading-6 text-slate-700">{value}</p>
    </div>
  );
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
      const visual = sanitizeText(shot.visual, '用清晰图解表现知识点，不堆文字');
      const narration = sanitizeText(shot.narration, '用一句话解释当前步骤');
      const duration = Number(shot.durationSeconds || 0);
      return `${index + 1}. ${scene}${duration ? `，约 ${Math.min(Math.max(duration, 3), 10)} 秒` : ''}：画面 ${visual}；旁白 ${narration}`;
    });
    return [
      `生成一个 ${estimateVideoDuration(resource)} 秒、16:9、1080p 的中文课程讲解短视频。`,
      `主题：${sanitizeText(goal, '当前学习目标')}。标题：${sanitizeText(resource.title, '教学视频')}。`,
      '画风：干净的现代教育动画，信息图、流程箭头、板书结构清楚。不要真人口播，不要密集小字，不要随机英文。',
      '按下面分镜生成，镜头之间自然过渡：',
      ...shotPlan,
      evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达资源包已有内容，不编造教材页码。',
      '最终效果：学生看完能知道概念关系、步骤顺序和下一步练习动作。',
    ].join('\n');
  }

  return [
    `生成一个 ${estimateVideoDuration(resource)} 秒、16:9、1080p 的中文课程讲解短视频。`,
    `主题：${sanitizeText(goal, '当前学习目标')}。资源标题：${sanitizeText(resource.title, '教学视频')}。`,
    `个性化原因：${sanitizeText(resource.personalizationReason, '根据画像、路径节点和知识库证据生成。')}`,
    '画面结构：标题引入、核心概念图解、步骤或例题演示、最后给出练习动作。',
    evidence.length ? `知识库证据参考：${evidence.join('；')}` : '证据不足时只表达摘要内容，不编造来源。',
  ].join('\n');
}

function estimateVideoDuration(resource: A3ResourcePackV2Resource): 5 | 10 {
  const shots = Array.isArray(resource.content?.shots) ? resource.content.shots : [];
  const total = shots.reduce((sum, shot) => {
    if (typeof shot !== 'object' || !shot) return sum;
    const duration = Number((shot as Record<string, unknown>).durationSeconds || 0);
    return sum + (Number.isFinite(duration) ? duration : 0);
  }, 0);
  return total > 5 || shots.length > 4 ? 10 : 5;
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
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string) {
  const markers = ['�', '锛', '涓', '璧', '鎺', '鐢', '瑙', '鏁', '瀛', '钖', '€', '闅', '棰', '鍒', '鍛', '鐭', '閿', '缁', '鏌', '澶', '鍩', '姣', '勬', '錁'];
  return markers.some((marker) => text.includes(marker));
}
