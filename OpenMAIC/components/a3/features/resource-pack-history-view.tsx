'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Archive, ArrowRight, CheckCircle2, Clock3, FileText, GitBranch, Loader2, MonitorPlay, Play, Plus, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson } from '@/lib/a3/api-client';
import { normalizeResourcePackArtifacts, summarizeOpenMAICArtifactHistory } from '@/lib/a3/openmaic-artifact-history';
import type { A3ResourcePackV2, A3ResourcePackV2ResourceType } from '@/lib/a3/recommendation-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type ResourcePackListResponse = {
  success: boolean;
  error?: string;
  resourcePacks?: A3ResourcePackV2[];
};

const resourceTypeLabels: Record<A3ResourcePackV2ResourceType, string> = {
  lecture_doc: '文档',
  knowledge_card: '卡片',
  mind_map: '导图',
  practice_set: '练习',
  case_study: '案例',
  code_lab: '代码',
  micro_video_script: '视频脚本',
};

const quickLinks: Array<{ type: A3ResourcePackV2ResourceType; label: string; route: string }> = [
  { type: 'lecture_doc', label: '文档', route: 'document' },
  { type: 'mind_map', label: '导图', route: 'mind-map' },
  { type: 'practice_set', label: '练习', route: 'practice' },
  { type: 'code_lab', label: '代码', route: 'code-lab' },
  { type: 'micro_video_script', label: '视频', route: 'video' },
];

export function ResourcePackHistoryView() {
  const [packs, setPacks] = useState<A3ResourcePackV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const result = await a3GetJson<ResourcePackListResponse>('/api/resources/packs/');
      if (cancelled) return;
      setLoading(false);
      if (!result.success) {
        setError(result.error ?? '资源记录加载失败。');
        return;
      }
      setPacks((result.resourcePacks ?? []).map(sanitizePack));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => summarizePacks(packs), [packs]);

  if (loading) {
    return (
      <A3Card>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--a3-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          正在加载资源记录...
        </div>
      </A3Card>
    );
  }

  if (error) {
    return (
      <A3Card>
        <div className="py-12 text-center">
          <div className="text-lg font-semibold text-[var(--a3-text)]">资源记录加载失败</div>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{error}</p>
          <Button asChild className="mt-5 bg-blue-600 text-white hover:bg-blue-700">
            <Link href="/a3/recommendations">去生成资源</Link>
          </Button>
        </div>
      </A3Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="a3-resource-pack-history">
      <section className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">
              <Archive className="size-4" />
              资源记录
            </div>
            <h1 className="mt-4 text-2xl font-semibold tracking-normal text-slate-950">每次生成都会保存成一个资源包。</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              新生成的资源不会覆盖旧内容。你可以在这里回看历史文档、导图、练习、代码实验、PPT 课堂和视频状态。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild className="bg-blue-600 text-white hover:bg-blue-700">
              <Link href="/a3/recommendations">
                <Plus className="size-4" />
                生成新资源
              </Link>
            </Button>
            <Button asChild variant="outline" className="bg-white">
              <Link href="/a3/resources/latest">打开最新</Link>
            </Button>
          </div>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard label="资源包" value={`${summary.total}`} icon={<Archive className="size-4" />} />
        <MetricCard label="已验证资源" value={`${summary.verifiedResources}`} icon={<CheckCircle2 className="size-4" />} />
        <MetricCard label="课堂/PPT记录" value={`${summary.classroom + summary.pptx}`} icon={<MonitorPlay className="size-4" />} />
        <MetricCard label="视频记录" value={`${summary.video}`} icon={<Video className="size-4" />} />
      </div>

      {packs.length ? (
        <div className="space-y-3">
          {packs.map((pack, index) => (
            <ResourcePackHistoryCard key={pack.resourcePackId || index} pack={pack} latest={index === 0} />
          ))}
        </div>
      ) : (
        <A3Card>
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
            <Archive className="mx-auto size-9 text-blue-600" />
            <div className="mt-3 text-base font-semibold text-slate-950">还没有资源记录</div>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
              到资源生成入口输入学习需求，生成后会自动出现在这里。
            </p>
            <Button asChild className="mt-5 bg-blue-600 text-white hover:bg-blue-700">
              <Link href="/a3/recommendations">去生成资源</Link>
            </Button>
          </div>
        </A3Card>
      )}
    </div>
  );
}

function ResourcePackHistoryCard({ pack, latest }: { pack: A3ResourcePackV2; latest: boolean }) {
  const artifacts = summarizeOpenMAICArtifactHistory(normalizeResourcePackArtifacts(pack.multimodalArtifacts ?? []));
  const resourceTypes = new Set(pack.resources.map((resource) => resource.type));
  const verifiedCount = pack.resources.filter((resource) => resource.verified).length;
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="a3-resource-pack-history-card">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {latest && <A3Pill tone="blue">最新</A3Pill>}
            <A3Pill tone={verifiedCount ? 'green' : 'orange'}>{verifiedCount}/{pack.resources.length} 已验证</A3Pill>
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <Clock3 className="size-3.5" />
              {formatPackTime(pack.createdAt)}
            </span>
          </div>
          <h2 className="mt-3 line-clamp-2 text-lg font-semibold text-slate-950">{summarizeGoal(pack.goal)}</h2>
          <p className="mt-2 text-xs text-slate-500">
            ID: <span className="font-mono">{pack.resourcePackId}</span>
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {pack.resources.map((resource) => (
              <span key={resource.type} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                {resourceTypeLabels[resource.type] ?? resource.type}
              </span>
            ))}
          </div>
        </div>

        <div className="grid min-w-[260px] gap-2 text-sm md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <SmallStat label="课堂" value={`${artifacts.classroomSucceeded}/${artifacts.classroom}`} />
          <SmallStat label="PPTX" value={`${artifacts.pptxExportSucceeded}/${artifacts.pptxExport}`} />
          <SmallStat label="视频" value={`${artifacts.videoSucceeded}/${artifacts.video}`} />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        <Button asChild size="sm" className="bg-slate-950 text-white hover:bg-slate-800">
          <Link href={`/a3/resources/${pack.resourcePackId}`}>
            查看详情
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        {quickLinks.map((item) => {
          const available = resourceTypes.has(item.type);
          const content = (
            <>
              {item.route === 'mind-map' ? <GitBranch className="size-3.5" /> : item.route === 'video' ? <Play className="size-3.5" /> : <FileText className="size-3.5" />}
              {item.label}
            </>
          );
          return available ? (
            <Button key={item.route} asChild size="sm" variant="outline" className="bg-white">
              <Link href={`/a3/resources/${pack.resourcePackId}/${item.route}`}>{content}</Link>
            </Button>
          ) : (
            <Button key={item.route} size="sm" variant="outline" className="bg-white" disabled>
              {content}
            </Button>
          );
        })}
      </div>
    </article>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 text-slate-500">
        <span className="text-sm">{label}</span>
        {icon}
      </div>
      <div className="mt-2 text-2xl font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-slate-950">{value}</div>
    </div>
  );
}

function summarizePacks(packs: A3ResourcePackV2[]) {
  return packs.reduce(
    (acc, pack) => {
      const artifacts = summarizeOpenMAICArtifactHistory(normalizeResourcePackArtifacts(pack.multimodalArtifacts ?? []));
      acc.total += 1;
      acc.verifiedResources += pack.resources.filter((resource) => resource.verified).length;
      acc.classroom += artifacts.classroom;
      acc.pptx += artifacts.pptxExport;
      acc.video += artifacts.video;
      return acc;
    },
    { total: 0, verifiedResources: 0, classroom: 0, pptx: 0, video: 0 },
  );
}

function sanitizePack(pack: A3ResourcePackV2): A3ResourcePackV2 {
  return {
    ...pack,
    goal: cleanText(pack.goal, '本次学习资源包'),
    resources: (pack.resources ?? []).map((resource) => ({
      ...resource,
      title: cleanText(resource.title, resourceTypeLabels[resource.type] ?? '学习资源'),
      personalizationReason: cleanText(resource.personalizationReason, '根据学习画像和知识库资料生成。'),
    })),
  };
}

function summarizeGoal(goal: string) {
  const text = cleanText(goal, '本次学习资源包').replace(/\s+/g, ' ');
  const sentence = text.split(/[。；;!?！？]/).find((part) => part.trim().length >= 4)?.trim() || text;
  return sentence.length > 72 ? `${sentence.slice(0, 72)}...` : sentence;
}

function formatPackTime(value?: string) {
  if (!value) return '时间待记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function cleanText(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string) {
  return ['�', '锛', '涓', '璧', '鎺', '鐢', '瑙', '鏁', '瀛', '€'].some((marker) => text.includes(marker));
}
