'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Circle,
  Download,
  Film,
  Loader2,
  Mic2,
  PlayCircle,
  RefreshCw,
  Save,
  WandSparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

type Stage = { id: string; label: string; status: string; detail: string };
type Segment = {
  index: number;
  title: string;
  status: string;
  duration: number;
  visual: string;
  narration: string;
  narrationEstimatedMs: number;
  narrationFits: boolean;
  videoUrl: string;
  playbackStatus: string;
  audioStatus: string;
  audioUrl: string;
  audioDurationMs: number;
  degradedReason?: string;
};
type Composition = {
  jobId: string;
  resourcePackId: string;
  status: string;
  stage: string;
  progress: number;
  message: string;
  voice: string;
  speed: number;
  voiceOptions: string[];
  error?: string;
  stages: Stage[];
  segments: Segment[];
  assets: { finalUrl: string; narrationUrl: string; subtitlesUrl: string };
};
type CompositionResponse = { success: boolean; error?: string; composition?: Composition };
type VideoJobsResponse = {
  success: boolean;
  error?: string;
  jobs?: Array<{ jobId?: string; resourcePackId?: string; status?: string }>;
};

const API = '/api/a3/resources/video-composition';
const STAGE_LABELS = ['分镜', '视频片段', '旁白与字幕', '最终合并'];

export function VideoCompositionView({ packId }: { packId: string }) {
  const [composition, setComposition] = useState<Composition | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const jobIdRef = useRef('');
  const draftsDirtyRef = useRef(false);

  const loadComposition = useCallback(async (knownJobId?: string) => {
    let jobId = knownJobId || jobIdRef.current;
    if (!jobId) {
      const jobsResponse = await fetch('/api/a3/resources/openmaic-video', { cache: 'no-store' });
      const jobs = await jobsResponse.json() as VideoJobsResponse;
      jobId = jobs.jobs?.find((job) => job.resourcePackId === packId)?.jobId || '';
    }
    if (!jobId) throw new Error('当前资源包还没有可制作的持久化视频任务');
    const response = await fetch(`${API}?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const result = await response.json() as CompositionResponse;
    if (!response.ok || !result.success || !result.composition) {
      throw new Error(result.error || '视频制作状态加载失败');
    }
    jobIdRef.current = result.composition.jobId;
    setComposition(result.composition);
    if (!draftsDirtyRef.current) {
      setDrafts(Object.fromEntries(result.composition.segments.map((segment) => [segment.index, segment.narration])));
    }
    return result.composition;
  }, [packId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadComposition()
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '视频制作状态加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadComposition]);

  const activeJobId = composition?.jobId || '';
  const activeStatus = composition?.status || '';

  useEffect(() => {
    if (!activeJobId || !['queued', 'generating_narration', 'composing'].includes(activeStatus)) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        await loadComposition(activeJobId);
        if (!cancelled) setError('');
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : '视频制作状态刷新失败，请稍后重试');
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 4000);
      }
    };
    timer = window.setTimeout(() => void poll(), 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeJobId, activeStatus, loadComposition]);

  const hasEdits = useMemo(() => composition?.segments.some(
    (segment) => (drafts[segment.index] ?? '') !== segment.narration,
  ) ?? false, [composition, drafts]);

  async function saveChanges(settings: { voice?: string; speed?: number } = {}) {
    if (!composition) return null;
    setBusy('save');
    setError('');
    const changed = composition.segments
      .filter((segment) => (drafts[segment.index] ?? '') !== segment.narration)
      .map((segment) => ({ index: segment.index, narration: drafts[segment.index] || '' }));
    try {
      const response = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: composition.jobId, segments: changed, ...settings }),
      });
      const result = await response.json() as CompositionResponse;
      if (!response.ok || !result.success || !result.composition) throw new Error(result.error || '保存失败');
      setComposition(result.composition);
      setDrafts(Object.fromEntries(result.composition.segments.map((segment) => [segment.index, segment.narration])));
      draftsDirtyRef.current = false;
      setMessage('旁白设置已保存。');
      return result.composition;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败');
      return null;
    } finally {
      setBusy('');
    }
  }

  async function startAction(action: 'generate-narration' | 'compose', segmentIndexes: number[] = []) {
    if (!composition) return;
    let current = composition;
    if (hasEdits) {
      const saved = await saveChanges();
      if (!saved) return;
      current = saved;
    }
    setBusy(action + (segmentIndexes[0] || ''));
    setError('');
    setMessage('');
    try {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: current.jobId, action, segmentIndexes }),
      });
      const result = await response.json() as CompositionResponse;
      if (!response.ok || !result.success || !result.composition) throw new Error(result.error || '任务启动失败');
      setComposition(result.composition);
      setMessage(action === 'compose' ? '最终合并任务已启动。' : '旁白生成任务已启动。');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : '任务启动失败');
    } finally {
      setBusy('');
    }
  }

  if (loading) {
    return <div className="flex min-h-[45vh] items-center justify-center gap-2 text-sm text-slate-600"><Loader2 className="size-4 animate-spin" />正在加载视频制作台...</div>;
  }

  if (error && !composition) {
    return (
      <div className="mx-auto max-w-2xl border border-amber-200 bg-amber-50 p-6 text-center">
        <Film className="mx-auto size-8 text-amber-700" />
        <h1 className="mt-3 text-lg font-semibold text-slate-950">暂时无法制作最终成片</h1>
        <p className="mt-2 text-sm leading-6 text-slate-700">{error}</p>
        <Button asChild variant="outline" className="mt-5 bg-white"><Link href={`/a3/resources/${packId}/video`}><ArrowLeft />返回视频片段</Link></Button>
      </div>
    );
  }

  if (!composition) return null;

  const active = ['queued', 'generating_narration', 'composing'].includes(composition.status);
  const finalUrl = assetUrl('final', composition.jobId);
  return (
    <div className="space-y-5" data-testid="a3-video-composition-page">
      <header className="border-b border-slate-200 pb-5">
        <Button asChild size="sm" variant="ghost" className="-ml-2"><Link href={`/a3/resources/${packId}/video`}><ArrowLeft />返回视频片段</Link></Button>
        <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold text-amber-700">最终视频制作</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">旁白、字幕与成片合并</h1>
            <p className="mt-2 text-sm text-slate-600">{composition.message || '检查分镜后生成旁白，再合并为单个 MP4。'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!hasEdits || Boolean(busy) || active} onClick={() => void saveChanges()}><Save />保存旁白</Button>
            <Button className="bg-amber-700 text-white hover:bg-amber-800" disabled={Boolean(busy) || active} onClick={() => void startAction('generate-narration')}>
              {busy === 'generate-narration' ? <Loader2 className="animate-spin" /> : <Mic2 />}生成旁白
            </Button>
            <Button className="bg-emerald-700 text-white hover:bg-emerald-800" disabled={Boolean(busy) || active} onClick={() => void startAction('compose')}>
              {busy === 'compose' ? <Loader2 className="animate-spin" /> : <WandSparkles />}合并最终视频
            </Button>
          </div>
        </div>
      </header>

      <section className="grid gap-2 md:grid-cols-4" aria-label="制作进度">
        {composition.stages.map((stage) => (
          <div key={stage.id} className={`border p-3 ${stage.status === 'completed' ? 'border-emerald-200 bg-emerald-50' : stage.status === 'failed' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'}`}>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              {stage.status === 'completed' ? <Check className="size-4 text-emerald-700" /> : stage.status === 'running' ? <Loader2 className="size-4 animate-spin text-amber-700" /> : <Circle className="size-4 text-slate-400" />}
              {stage.label || STAGE_LABELS[composition.stages.indexOf(stage)]}
            </div>
            <p className="mt-1 text-xs text-slate-600">{stage.detail}</p>
          </div>
        ))}
      </section>

      {error ? <div className="border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div> : null}
      {message ? <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div><h2 className="text-lg font-semibold text-slate-950">分镜与旁白</h2><p className="mt-1 text-sm text-slate-600">逐段校对，失败时只重试对应旁白。</p></div>
            <span className="text-sm text-slate-500">{composition.segments.length} 段</span>
          </div>
          {composition.segments.map((segment) => {
            const playbackId = audioPlaybackId(segment.audioUrl);
            const audioUrl = playbackId ? assetUrl('audio', composition.jobId, playbackId) : '';
            return (
              <article key={segment.index} className="grid gap-4 border border-slate-200 bg-white p-4 md:grid-cols-[160px_minmax(0,1fr)]">
                <div>
                  <div className="aspect-video overflow-hidden bg-slate-950">
                    {segment.videoUrl ? <video className="size-full object-cover" src={segment.videoUrl} controls preload="metadata" /> : <div className="flex size-full items-center justify-center text-xs text-slate-400">片段未完成</div>}
                  </div>
                  <p className="mt-2 text-xs font-semibold text-slate-800">第 {segment.index} 段 · {segment.title}</p>
                  <p className="mt-1 text-xs text-slate-500">{segment.duration}s · {segment.audioStatus === 'succeeded' ? '旁白已生成' : segment.audioStatus === 'failed' ? '旁白失败' : '等待旁白'}</p>
                </div>
                <div className="min-w-0">
                  <p className="text-xs leading-5 text-slate-500">{segment.visual || '暂无画面说明'}</p>
                  <textarea
                    value={drafts[segment.index] ?? ''}
                    onChange={(event) => {
                      draftsDirtyRef.current = true;
                      setDrafts((current) => ({ ...current, [segment.index]: event.target.value }));
                    }}
                    disabled={active || Boolean(busy)}
                    className="mt-2 min-h-24 w-full resize-y border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-900 outline-none focus:border-amber-600 focus:ring-2 focus:ring-amber-100"
                    aria-label={`第 ${segment.index} 段旁白`}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className={segment.narrationFits ? 'text-emerald-700' : 'text-red-700'}>{Math.ceil(segment.narrationEstimatedMs / 100) / 10}s / {segment.duration}s</span>
                    {audioUrl ? <audio controls preload="none" src={audioUrl} className="h-8 max-w-full" aria-label="试听旁白" /> : <span className="text-slate-500">试听旁白：尚未生成</span>}
                    {segment.audioStatus === 'failed' ? (
                      <Button size="sm" variant="outline" disabled={Boolean(busy) || active} onClick={() => void startAction('generate-narration', [segment.index])}>
                        {busy === `generate-narration${segment.index}` ? <Loader2 className="animate-spin" /> : <RefreshCw />}只重试本段
                      </Button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <section className="border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-950">配音设置</h2>
            <label className="mt-4 block text-xs font-medium text-slate-600" htmlFor="video-voice">音色</label>
            <select id="video-voice" value={composition.voice} disabled={active || Boolean(busy)} onChange={(event) => void saveChanges({ voice: event.target.value })} className="mt-1 h-10 w-full border border-slate-300 bg-white px-3 text-sm">
              {composition.voiceOptions.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
            </select>
            <label className="mt-4 block text-xs font-medium text-slate-600" htmlFor="video-speed">语速：{composition.speed.toFixed(1)}x</label>
            <input id="video-speed" type="range" min="0.5" max="2" step="0.1" value={composition.speed} disabled={active || Boolean(busy)} onChange={(event) => setComposition({ ...composition, speed: Number(event.target.value) })} onPointerUp={(event) => void saveChanges({ speed: Number((event.target as HTMLInputElement).value) })} onKeyUp={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') void saveChanges({ speed: Number((event.target as HTMLInputElement).value) }); }} className="mt-2 w-full accent-amber-700" />
          </section>

          <section className="border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-950">最终成片</h2>
            {composition.assets.finalUrl ? <video className="mt-3 aspect-video w-full bg-black" src={finalUrl} controls preload="metadata" /> : <div className="mt-3 flex aspect-video items-center justify-center border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500"><PlayCircle className="mr-2 size-5" />等待合并</div>}
            <div className="mt-3 grid gap-2">
              <DownloadLink enabled={Boolean(composition.assets.finalUrl)} href={finalUrl} label="下载 MP4" />
              <DownloadLink enabled={Boolean(composition.assets.narrationUrl)} href={assetUrl('narration', composition.jobId)} label="下载旁白稿" />
              <DownloadLink enabled={Boolean(composition.assets.subtitlesUrl)} href={assetUrl('subtitles', composition.jobId)} label="下载字幕" />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function assetUrl(asset: string, jobId: string, playbackId = '') {
  const params = new URLSearchParams(playbackId ? { playbackId } : { jobId });
  return `${API}/${asset}?${params.toString()}`;
}

function audioPlaybackId(url: string) {
  return url.match(/([0-9a-f-]{36})\/?$/i)?.[1] || '';
}

function DownloadLink({ enabled, href, label }: { enabled: boolean; href: string; label: string }) {
  return enabled ? (
    <Button asChild variant="outline" className="justify-start"><a href={href} download><Download />{label}</a></Button>
  ) : (
    <Button variant="outline" className="justify-start" disabled><Download />{label}</Button>
  );
}
