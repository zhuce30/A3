'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2, Play, ShieldCheck, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import type { A3OpenMAICVideoArtifact, A3ResourceFeedbackResponse, A3ResourcePackV2, A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
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
    return artifacts.find((artifact): artifact is A3OpenMAICVideoArtifact => artifact.type === 'openmaic_video' && artifact.status === 'succeeded' && Boolean(artifact.videoUrl))
      ?? artifacts.find((artifact): artifact is A3OpenMAICVideoArtifact => artifact.type === 'openmaic_video')
      ?? null;
  }, [pack]);

  const script = pack?.resources.find((resource) => resource.type === 'micro_video_script') ?? null;

  async function recordVideoFeedback(action: 'opened' | 'completed') {
    if (!pack || (action === 'opened' && openedRecorded) || (action === 'completed' && completedRecorded)) return;
    const result = await a3PostJson<A3ResourceFeedbackResponse>(`/api/resources/packs/${pack.resourcePackId}/feedback/`, {
      action,
      resourceType: 'micro_video_script',
      score: action === 'completed' ? 90 : 0,
    });
    if (result.success && action === 'opened') setOpenedRecorded(true);
    if (result.success && action === 'completed') setCompletedRecorded(true);
  }

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
              <A3Pill tone={videoArtifact?.status === 'succeeded' ? 'green' : 'orange'}>{videoArtifact?.status ?? 'missing'}</A3Pill>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              视频不是“脚本页面”。脚本是 ResourceSynthesisAgent 生成的视频输入，真正的视频由 OpenMAIC/Seedance provider 返回 artifact 后在这里播放。
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-500">学习需求：{pack.goal}</p>
          </div>
          <div className="grid min-w-[240px] grid-cols-2 gap-2 text-sm">
            <Metric label="provider" value={videoArtifact?.provider || '未返回'} />
            <Metric label="时长" value={videoArtifact?.duration ? `${videoArtifact.duration}s` : '--'} />
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <A3Card title="视频成品" subtitle="有成功 artifact 时直接在线播放；无 artifact 时展示失败或降级原因。">
          {videoArtifact?.videoUrl ? (
            <div className="space-y-4">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-950">
                <video
                  className="aspect-video w-full bg-black"
                  src={videoArtifact.videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onPlay={() => void recordVideoFeedback('opened')}
                  onEnded={() => void recordVideoFeedback('completed')}
                  data-testid="a3-resource-video-player"
                />
              </div>
              <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 md:grid-cols-4">
                <Metric label="状态" value={videoArtifact.status || '--'} />
                <Metric label="尺寸" value={videoArtifact.width && videoArtifact.height ? `${videoArtifact.width}x${videoArtifact.height}` : '--'} />
                <Metric label="耗时" value={videoArtifact.elapsedMs ? `${Math.round(videoArtifact.elapsedMs / 1000)}s` : '--'} />
                <Metric label="资源类型" value={videoArtifact.resourceType || 'micro_video_script'} />
              </div>
              <Button asChild variant="outline" className="bg-white">
                <a href={videoArtifact.videoUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  新窗口打开原始视频
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
