'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2, Play, RefreshCw, ShieldCheck, Video } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { trackResourceComplete, trackResourceOpen } from '@/lib/a3/learning-event-client';
import type { A3OpenMAICVideoArtifact, A3ResourceFeedbackResponse, A3ResourcePackV2, A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
import { buildA3VideoPrompt } from '@/lib/a3/video-prompt';
import { A3Card, A3Pill } from '../ui/a3-card';

type ResourcePackDetailResponse = {
  success: boolean;
  error?: string;
  resourcePack?: A3ResourcePackV2;
};

type ResourcePackListResponse = {
  success: boolean;
  error?: string;
  resourcePacks?: A3ResourcePackV2[];
};

export function ResourceVideoView({ packId }: { packId: string }) {
  const [pack, setPack] = useState<A3ResourcePackV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openedRecorded, setOpenedRecorded] = useState(false);
  const [completedRecorded, setCompletedRecorded] = useState(false);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [retryingFailedSegments, setRetryingFailedSegments] = useState(false);
  const [retryMessage, setRetryMessage] = useState('');
  const [legacyConfirmOpen, setLegacyConfirmOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const result = await loadResourcePack(packId);
      if (cancelled) return;
      setLoading(false);
      if (!result.success || !result.resourcePack) {
        setError(result.error ?? '视频资源加载失败。');
        return;
      }
      setPack(sanitizeResourcePack(result.resourcePack));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  const videoArtifact = useMemo(() => {
    const artifacts = pack?.multimodalArtifacts ?? [];
    return artifacts.find((artifact): artifact is A3OpenMAICVideoArtifact =>
      artifact.type === 'openmaic_video'
      && ['succeeded', 'partial'].includes(artifact.status)
      && (Boolean(artifact.videoUrl) || Boolean(artifact.segments?.some((segment) => segment.status === 'succeeded' && segment.videoUrl)))
    )
      ?? artifacts.find((artifact): artifact is A3OpenMAICVideoArtifact => artifact.type === 'openmaic_video')
      ?? null;
  }, [pack]);

  const script = pack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;
  const playableSegments = useMemo(() => {
    return (videoArtifact?.segments ?? [])
      .filter((segment) => segment.status === 'succeeded' && Boolean(segment.videoUrl))
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }, [videoArtifact]);
  const activeSegment = playableSegments[activeSegmentIndex] ?? null;
  const playerUrl = activeSegment?.videoUrl || videoArtifact?.videoUrl || '';
  const totalSegmentCount = videoArtifact?.segments?.length ?? 0;
  const failedSegmentCount = videoArtifact?.segments?.filter((segment) => segment.status === 'failed').length ?? 0;
  const legacyFailedSegments = (videoArtifact?.segments ?? []).filter(
    (segment) => !videoArtifact?.jobId && segment.status === 'failed',
  );
  const legacySucceededSegments = (videoArtifact?.segments ?? []).filter(
    (segment) => !videoArtifact?.jobId && segment.status === 'succeeded' && Boolean(segment.videoUrl),
  );
  const canImportLegacyFailures = legacyFailedSegments.length > 0 && legacySucceededSegments.length > 0;
  const playableDuration = playableSegments.length
    ? playableSegments.reduce((sum, segment) => sum + Number(segment.duration || 0), 0)
    : Number(videoArtifact?.duration || 0);

  async function recordVideoFeedback(action: 'opened' | 'completed') {
    if (!pack || (action === 'opened' && openedRecorded) || (action === 'completed' && completedRecorded)) return;
    void recordVideoLearningEvent(pack, videoArtifact, script, action);
    const result = await a3PostJson<A3ResourceFeedbackResponse>(`/api/resources/packs/${pack.resourcePackId}/feedback/`, {
      action,
      resourceType: 'micro_video_script',
      score: action === 'completed' ? 90 : 0,
    });
    if (result.success && action === 'opened') setOpenedRecorded(true);
    if (result.success && action === 'completed') setCompletedRecorded(true);
  }

  async function retryFailedSegments() {
    if (!videoArtifact?.jobId || !failedSegmentCount || retryingFailedSegments) return;
    setRetryingFailedSegments(true);
    setRetryMessage(`正在只重试 ${failedSegmentCount} 个失败片段，已成功片段会保留。`);
    try {
      const response = await fetch('/api/a3/resources/openmaic-video', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry-failed', jobId: videoArtifact.jobId }),
      });
      const initial = await response.json() as VideoJobResponse;
      if (!response.ok || !initial.success) throw new Error(initial.error || '失败片段重试未能启动');
      const job = await pollVideoJob(initial);
      const refreshed = await loadResourcePack(packId);
      if (refreshed.success && refreshed.resourcePack) setPack(sanitizeResourcePack(refreshed.resourcePack));
      setRetryMessage(job.status === 'succeeded' ? '失败片段已补齐。' : '重试已完成，请查看各片段状态。');
    } catch (retryError) {
      setRetryMessage(`重试失败：${retryError instanceof Error ? retryError.message : '请稍后再试'}`);
    } finally {
      setRetryingFailedSegments(false);
    }
  }

  async function pollVideoJob(initial: VideoJobResponse, isCancelled: () => boolean = () => false) {
    let job = initial;
    if (!job.jobId) throw new Error('视频任务缺少 jobId');
    const jobId = job.jobId;
    while (!job.done && !['succeeded', 'partial', 'failed'].includes(String(job.status))) {
      await wait(5000);
      if (isCancelled()) return job;
      const poll = await fetch(`/api/a3/resources/openmaic-video?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      job = await poll.json() as VideoJobResponse;
      if (!poll.ok || !job.success) throw new Error(job.error || '视频任务进度查询失败');
      if (!isCancelled()) setRetryMessage(job.message || `视频任务进度 ${job.progress ?? 0}%`);
    }
    return job;
  }

  async function importLegacyFailures() {
    if (!pack || !script || !canImportLegacyFailures || retryingFailedSegments) return;
    setLegacyConfirmOpen(false);
    setRetryingFailedSegments(true);
    setRetryMessage(`正在补生成 ${legacyFailedSegments.length} 段，保留 ${legacySucceededSegments.length} 段。`);
    try {
      const response = await fetch('/api/a3/resources/openmaic-video', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import-legacy-failures',
          resourcePackId: pack.resourcePackId,
          provider: 'seedance',
          prompt: buildA3VideoPrompt(pack.goal, script),
          aspectRatio: '16:9',
          resolution: '1080p',
        }),
      });
      const initial = await response.json() as VideoJobResponse;
      if (!response.ok || !initial.success) throw new Error(initial.error || '旧视频迁移未能启动');
      const job = await pollVideoJob(initial);
      const refreshed = await loadResourcePack(packId);
      if (refreshed.success && refreshed.resourcePack) setPack(sanitizeResourcePack(refreshed.resourcePack));
      setRetryMessage(job.status === 'succeeded' ? '失败片段已补齐。' : '补生成任务已完成，请查看各片段状态。');
    } catch (importError) {
      setRetryMessage(`补生成失败：${importError instanceof Error ? importError.message : '请稍后再试'}`);
    } finally {
      setRetryingFailedSegments(false);
    }
  }

  useEffect(() => {
    const resourcePackId = pack?.resourcePackId;
    if (!resourcePackId) return;
    let cancelled = false;

    async function restoreActiveVideoJob() {
      const result = await a3GetJson<VideoJobResponse>('/api/a3/resources/openmaic-video');
      const active = (result.jobs ?? []).find(
        (job) => (
          job.resourcePackId === resourcePackId
          || (packId !== 'latest' && job.resourcePackId === packId)
        ) && ['queued', 'running'].includes(String(job.status)),
      );
      if (!active?.jobId || cancelled) return;
      setRetryingFailedSegments(true);
      setRetryMessage(active.message || '正在恢复视频任务进度。');
      try {
        await pollVideoJob({ ...active, success: true }, () => cancelled);
        if (cancelled) return;
        const refreshed = await loadResourcePack(packId);
        if (!cancelled && refreshed.success && refreshed.resourcePack) {
          setPack(sanitizeResourcePack(refreshed.resourcePack));
        }
      } catch (restoreError) {
        if (!cancelled) {
          setRetryMessage(`任务恢复失败：${restoreError instanceof Error ? restoreError.message : '请稍后再试'}`);
        }
      } finally {
        if (!cancelled) setRetryingFailedSegments(false);
      }
    }

    void restoreActiveVideoJob();
    return () => {
      cancelled = true;
    };
  }, [pack?.resourcePackId, packId]);

  if (loading) {
    return (
      <A3Card>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--a3-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          正在加载视频资源...
        </div>
      </A3Card>
    );
  }

  if (error || !pack) {
    return (
      <A3Card>
        <div className="py-12 text-center">
          <div className="text-lg font-semibold text-[var(--a3-text)]">视频资源加载失败</div>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{error}</p>
          <Button asChild className="mt-5 bg-blue-600 hover:bg-blue-700">
            <Link href="/a3/recommendations">返回资源生成入口</Link>
          </Button>
        </div>
      </A3Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="a3-resource-video-page">
      <section className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
        <Button asChild size="sm" variant="outline" className="bg-white">
          <Link href="/a3/recommendations">
            <ArrowLeft className="size-4" />
            返回资源生成入口
          </Link>
        </Button>
        <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-normal text-slate-950">教学视频</h1>
              <A3Pill tone={videoArtifact?.status === 'succeeded' ? 'green' : videoArtifact?.status === 'partial' ? 'orange' : 'orange'}>{videoArtifact?.status ?? 'missing'}</A3Pill>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              1 分钟视频由 6 个 10 秒教学片段组成，系统会连续播放；字幕和讲解文字保留在页面层，视频画面本身不烧录乱码文字。
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">学习需求：{pack.goal}</p>
          </div>
          <div className="grid min-w-[240px] grid-cols-2 gap-2 text-sm">
            <Metric label="provider" value={videoArtifact?.provider || '未返回'} />
            <Metric label="时长" value={playableDuration ? `${playableDuration}s` : '--'} />
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <A3Card title="视频成品" subtitle="有成功 artifact 时直接在线播放；无 artifact 时展示失败或降级原因。">
          {canImportLegacyFailures ? (
            <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-4" data-testid="a3-legacy-video-migration">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-orange-950">旧视频有 {legacyFailedSegments.length} 个片段生成失败</div>
                  <p className="mt-1 text-xs leading-5 text-orange-800">
                    可补生成失败片段，并保留现有 {legacySucceededSegments.length} 个成功片段。
                  </p>
                  {retryMessage ? <p className="mt-1 text-xs text-orange-700">{retryMessage}</p> : null}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 bg-white"
                  disabled={retryingFailedSegments}
                  onClick={() => setLegacyConfirmOpen(true)}
                >
                  {retryingFailedSegments ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                  补生成失败片段
                </Button>
              </div>
              <AlertDialog open={legacyConfirmOpen} onOpenChange={setLegacyConfirmOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认补生成失败片段</AlertDialogTitle>
                    <AlertDialogDescription className="space-y-2 text-left">
                      <span className="block">本次将补生成 {legacyFailedSegments.length} 段，保留 {legacySucceededSegments.length} 段。</span>
                      <span className="block">确认后会提交付费 Seedance 任务，已成功片段不会重新生成。</span>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={() => void importLegacyFailures()}>
                      确认补生成
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}
          {failedSegmentCount > 0 && videoArtifact?.jobId ? (
            <div className="mb-4 flex flex-col gap-3 rounded-xl border border-orange-200 bg-orange-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-orange-950">有 {failedSegmentCount} 个片段生成失败</div>
                <p className="mt-1 text-xs leading-5 text-orange-800">只重试失败片段，已成功片段会保留并继续可播放。</p>
                {retryMessage ? <p className="mt-1 text-xs text-orange-700">{retryMessage}</p> : null}
              </div>
              <Button type="button" variant="outline" className="shrink-0 bg-white" disabled={retryingFailedSegments} onClick={() => void retryFailedSegments()}>
                {retryingFailedSegments ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                只重试失败片段
              </Button>
            </div>
          ) : null}
          {playerUrl ? (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
                <video
                  key={`${activeSegment?.index ?? 'single'}-${playerUrl}`}
                  className="aspect-video w-full bg-black"
                  src={playerUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onPlay={() => void recordVideoFeedback('opened')}
                  onEnded={() => {
                    if (playableSegments.length && activeSegmentIndex < playableSegments.length - 1) {
                      setActiveSegmentIndex((value) => value + 1);
                      return;
                    }
                    void recordVideoFeedback('completed');
                  }}
                  data-testid="a3-resource-video-player"
                />
              </div>
              {playableSegments.length ? (
                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4" data-testid="a3-resource-video-segment-playlist">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-blue-950">连续播放列表</div>
                      <p className="mt-1 text-xs leading-5 text-blue-800">
                        已生成 {playableSegments.length}/{totalSegmentCount || playableSegments.length} 段，当前播放第 {activeSegment?.index ?? 1} 段。
                      </p>
                    </div>
                    <Button type="button" size="sm" variant="outline" className="bg-white" onClick={() => setActiveSegmentIndex(0)}>
                      从头播放
                    </Button>
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-3">
                    {(videoArtifact?.segments ?? []).map((segment) => {
                      const enabled = segment.status === 'succeeded' && Boolean(segment.videoUrl);
                      const active = activeSegment?.index === segment.index;
                      return (
                        <button
                          key={`${segment.index}-${segment.title}`}
                          type="button"
                          disabled={!enabled}
                          onClick={() => {
                            const nextIndex = playableSegments.findIndex((item) => item.index === segment.index);
                            if (nextIndex >= 0) setActiveSegmentIndex(nextIndex);
                          }}
                          className={[
                            'rounded-xl border px-3 py-2 text-left text-xs leading-5 transition',
                            active ? 'border-blue-500 bg-white text-blue-900 shadow-sm' : 'border-blue-100 bg-white/70 text-slate-700',
                            enabled ? 'hover:border-blue-300' : 'cursor-not-allowed opacity-60',
                          ].join(' ')}
                          data-testid="a3-resource-video-segment"
                        >
                          <div className="font-semibold">第 {segment.index} 段 · {safeText(segment.title, '教学片段')}</div>
                          <div className="mt-1 text-slate-500">{segment.status === 'succeeded' ? `${segment.duration || 10}s，可播放` : safeText(segment.degradedReason, '生成失败')}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 md:grid-cols-4">
                <Metric label="状态" value={videoArtifact?.status || '--'} />
                <Metric label="尺寸" value={videoArtifact?.width && videoArtifact?.height ? `${videoArtifact.width}x${videoArtifact.height}` : '--'} />
                <Metric label="耗时" value={videoArtifact?.elapsedMs ? `${Math.round(videoArtifact.elapsedMs / 1000)}s` : '--'} />
                <Metric label="资源类型" value={videoArtifact?.resourceType || 'micro_video_script'} />
              </div>
              <Button asChild variant="outline" className="bg-white">
                <a href={playerUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  新窗口打开当前片段
                </a>
              </Button>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-orange-200 bg-orange-50 p-6 text-sm leading-6 text-orange-900">
              <div className="flex items-center gap-2 font-semibold">
                <Video className="size-4" />
                暂无可播放视频
              </div>
              <p className="mt-2">
                {videoArtifact?.degradedReason || '当前资源包只有视频脚本，还没有成功的视频 artifact。请回到资源生成入口点击“生成视频”。'}
              </p>
              <Button asChild className="mt-4 bg-orange-600 text-white hover:bg-orange-700">
                <Link href="/a3/recommendations">
                  <Play className="size-4" />
                  返回生成视频
                </Link>
              </Button>
            </div>
          )}
        </A3Card>

        <A3Card title="脚本与证据" subtitle="脚本用于驱动视频 provider。">
          {script ? <VideoScriptSummary resource={script} /> : <p className="text-sm leading-6 text-slate-600">当前资源包没有 micro_video_script，请先生成教学视频资源。</p>}
        </A3Card>
      </div>
    </div>
  );
}

type VideoJobResponse = {
  success: boolean;
  error?: string;
  jobId?: string;
  resourcePackId?: string;
  status?: string;
  progress?: number;
  message?: string;
  done?: boolean;
  importedSucceeded?: number;
  queuedFailed?: number;
  jobs?: VideoJobResponse[];
};

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function VideoScriptSummary({ resource }: { resource: A3ResourcePackV2Resource }) {
  const shots = Array.isArray(resource.content.shots) ? resource.content.shots : [];
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-700">{resource.personalizationReason}</div>
      <div className="space-y-3">
        {shots.slice(0, 6).map((shot, index) => {
          const item = shot && typeof shot === 'object' ? shot as Record<string, unknown> : {};
          return (
            <div key={`${safeText(item.scene, '镜头')}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-xs font-semibold text-blue-700">{safeText(item.scene, `镜头 ${index + 1}`)}</div>
              <p className="mt-2 text-xs leading-5 text-slate-600">{safeText(item.narration, '暂无旁白')}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{safeText(item.visual, '暂无画面说明')}</p>
            </div>
          );
        })}
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-blue-700">
          <ShieldCheck className="size-3.5" />
          引用来源
        </div>
        <div className="mt-2 space-y-2">
          {resource.citations.slice(0, 3).map((citation, index) => (
            <p key={`${citation.title || citation.location || 'source'}-${index}`} className="text-xs leading-5 text-slate-600">
              {index + 1}. {safeText(citation.title, '本地知识库来源')}：{safeText(citation.snippet, '暂无片段')}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function recordVideoLearningEvent(
  pack: A3ResourcePackV2,
  videoArtifact: A3OpenMAICVideoArtifact | null,
  script: A3ResourcePackV2Resource | null,
  action: 'opened' | 'completed',
) {
  const fallbackDurationSec = (script?.estimatedMinutes ?? 0) * 60;
  const segmentDurationSec = (videoArtifact?.segments ?? []).reduce((sum, segment) => sum + Number(segment.duration || 0), 0);
  const completedDurationSec = segmentDurationSec || videoArtifact?.duration || fallbackDurationSec;
  const eventInput = {
    eventId: `resource_${pack.resourcePackId}_micro_video_script_${action}_video`,
    sourcePage: `/a3/resources/${pack.resourcePackId}/video`,
    targetType: 'resource_pack',
    targetId: pack.resourcePackId,
    resourceType: 'micro_video_script',
    durationSec: action === 'completed' ? completedDurationSec : 0,
    score: action === 'completed' ? 90 : null,
    quality: action === 'completed' ? { completionRate: 1 } : {},
    metadata: {
      action,
      artifactStatus: videoArtifact?.status ?? 'missing',
      provider: videoArtifact?.provider ?? '',
      scriptTitle: script?.title ?? '',
    },
    traceId: pack.traceId,
  };
  return action === 'opened' ? trackResourceOpen(eventInput) : trackResourceComplete(eventInput);
}

async function loadResourcePack(packId: string): Promise<ResourcePackDetailResponse> {
  if (packId !== 'latest') {
    return a3GetJson<ResourcePackDetailResponse>(`/api/resources/packs/${packId}/`);
  }
  const list = await a3GetJson<ResourcePackListResponse>('/api/resources/packs/');
  if (!list.success) return { success: false, error: list.error ?? '资源包列表加载失败。' };
  const latest = list.resourcePacks?.[0];
  if (!latest) return { success: false, error: '暂无资源包，请先生成资源。' };
  return { success: true, resourcePack: latest };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function sanitizeResourcePack(pack: A3ResourcePackV2): A3ResourcePackV2 {
  return {
    ...pack,
    goal: safeText(pack.goal, '当前学习目标'),
    resources: (pack.resources ?? []).map((resource) => ({
      ...resource,
      title: safeText(resource.title, '学习资源'),
      content: sanitizeRecord(resource.content ?? {}),
      personalizationReason: safeText(resource.personalizationReason, '根据画像、路径节点和知识库证据生成。'),
      citations: (resource.citations ?? []).map((citation) => ({
        ...citation,
        title: citation.title ? safeText(citation.title, '本地知识库来源') : citation.title,
        location: citation.location ? safeText(citation.location, '来源位置待返回') : citation.location,
        snippet: citation.snippet ? safeText(citation.snippet, '暂无片段') : citation.snippet,
      })),
    })),
  };
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeValue(value)]));
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value, '内容已生成');
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return sanitizeRecord(value as Record<string, unknown>);
  return value;
}

function safeText(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string) {
  return ['�', '锛', '涓', '璧', '鎺', '鐢', '瑙', '鏁', '瀛', '€'].some((marker) => text.includes(marker));
}
