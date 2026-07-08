'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson } from '@/lib/a3/api-client';
import {
  filterOpenMAICArtifactHistory,
  formatArtifactTimestamp,
  normalizeResourcePackArtifacts,
  type OpenMAICArtifactHistoryFilter,
  type OpenMAICArtifactHistoryItem,
  sortOpenMAICArtifactHistory,
  summarizeOpenMAICArtifactHistory,
} from '@/lib/a3/openmaic-artifact-history';
import type { A3ResourcePackV2, A3ResourcePackV2Resource } from '@/lib/a3/recommendation-types';
import { cn } from '@/lib/utils';
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

const artifactFilters: Array<{ key: OpenMAICArtifactHistoryFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'classroom', label: '课堂' },
  { key: 'pptx', label: 'PPTX 导出' },
  { key: 'video', label: '视频' },
  { key: 'degraded', label: '降级/未完成' },
];

export function ResourcePackDetailView({ packId }: { packId: string }) {
  const [pack, setPack] = useState<A3ResourcePackV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [artifactFilter, setArtifactFilter] = useState<OpenMAICArtifactHistoryFilter>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const result = await loadResourcePack(packId);
      if (cancelled) return;
      setLoading(false);
      if (!result.success || !result.resourcePack) {
        setError(result.error ?? '资源包不存在或无法加载');
        return;
      }
      setPack(result.resourcePack);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  if (loading) {
    return (
      <A3Card>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--a3-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          正在加载资源包详情...
        </div>
      </A3Card>
    );
  }

  if (error || !pack) {
    return (
      <A3Card>
        <div className="py-12 text-center">
          <div className="text-lg font-semibold text-[var(--a3-text)]">资源包加载失败</div>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{error}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button asChild className="bg-blue-600 hover:bg-blue-700">
              <Link href="/a3/recommendations">重新生成资源</Link>
            </Button>
            <Button asChild variant="outline" className="bg-white">
              <Link href="/a3/resources/latest">查看最新资源包</Link>
            </Button>
          </div>
        </div>
      </A3Card>
    );
  }

  const artifacts = sortOpenMAICArtifactHistory(normalizeResourcePackArtifacts(pack.multimodalArtifacts ?? []));
  const filteredArtifacts = filterOpenMAICArtifactHistory(artifacts, artifactFilter);
  const artifactSummary = summarizeOpenMAICArtifactHistory(artifacts);
  const filteredSummary = summarizeOpenMAICArtifactHistory(filteredArtifacts);
  const verifiedCount = pack.resources.filter((resource) => resource.verified).length;

  return (
    <div className="space-y-5" data-testid="a3-resource-pack-detail">
      <A3Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <Button asChild size="sm" variant="outline">
              <Link href="/a3/recommendations">
                <ArrowLeft className="size-4" />
                返回推荐页
              </Link>
            </Button>
            <h1 className="mt-4 text-2xl font-semibold text-[var(--a3-text)]">{pack.goal}</h1>
            <p className="mt-2 text-sm text-[var(--a3-text-muted)]">
              资源包 ID：<span className="font-mono">{pack.resourcePackId}</span>
            </p>
            <p className="mt-1 text-sm text-[var(--a3-text-muted)]">
              traceId：<span className="font-mono">{pack.traceId}</span>
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric label="资源" value={`${pack.resources.length}/6`} />
            <Metric label="验证" value={`${verifiedCount}/${pack.resources.length}`} />
            <Metric label="artifact" value={`${artifactSummary.total}`} />
          </div>
        </div>
      </A3Card>

      <A3Card
        title="OpenMAIC artifact 历史"
        subtitle="展示该资源包下所有课堂、PPTX 导出和视频任务写回记录，避免只看最新一次。"
      >
        <div className="mb-4 grid gap-3 md:grid-cols-5" data-testid="a3-resource-pack-artifact-summary">
          <Metric label="课堂成功" value={`${artifactSummary.classroomSucceeded}/${artifactSummary.classroom}`} />
          <Metric label="PPTX 导出" value={`${artifactSummary.pptxExportSucceeded}/${artifactSummary.pptxExport}`} />
          <Metric label="视频成功" value={`${artifactSummary.videoSucceeded}/${artifactSummary.video}`} />
          <Metric label="降级记录" value={`${artifactSummary.degraded}`} />
          <Metric label="最近回写" value={artifactSummary.latestAt ? formatArtifactTimestamp(artifacts[0]) : '暂无'} />
        </div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3" data-testid="a3-resource-pack-artifact-filter">
          <div className="flex flex-wrap gap-2">
            {artifactFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setArtifactFilter(filter.key)}
                data-testid={`a3-artifact-filter-${filter.key}`}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-semibold transition',
                  artifactFilter === filter.key
                    ? 'border-blue-600 bg-blue-600 text-white'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700',
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="text-xs text-[var(--a3-text-muted)]">
            当前显示 {filteredSummary.total} 条，原始历史 {artifactSummary.total} 条
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="a3-resource-pack-artifact-history">
          {filteredArtifacts.map((artifact, index) => (
            <ArtifactCard key={`${artifact.type}-${artifact.jobId || artifact.createdAt || index}`} artifact={artifact} />
          ))}
          {!filteredArtifacts.length && (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm leading-6 text-[var(--a3-text-muted)]">
              {artifacts.length
                ? '当前筛选条件下没有 artifact。可以切换到“全部”查看完整写回历史。'
                : '该资源包还没有 OpenMAIC 课堂、PPTX 导出或视频任务。请回到推荐页生成相关产物。'}
            </div>
          )}
        </div>
      </A3Card>

      <A3Card title="七类资源内容">
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {pack.resources.map((resource) => (
            <div key={resource.type} className="rounded-2xl border border-[var(--a3-border)] bg-white p-4" data-testid="a3-resource-pack-detail-resource">
              <div className="flex items-center justify-between gap-2">
                <A3Pill tone={resource.verified ? 'green' : 'orange'}>{resource.verified ? 'verified' : 'unverified'}</A3Pill>
                <span className="text-xs text-[var(--a3-text-muted)]">{resource.estimatedMinutes} 分钟</span>
              </div>
              <div className="mt-3 text-xs font-semibold text-blue-700">{resource.type}</div>
              <div className="mt-1 text-base font-semibold text-[var(--a3-text)]">{resource.title}</div>
              <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--a3-text-muted)]">{resource.personalizationReason}</p>
              <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">
                引用 {resource.citations.length} 条{resource.citations[0]?.title ? `：${resource.citations[0].title}` : ''}
              </div>
              <ResourceContentPreview resource={resource} />
            </div>
          ))}
        </div>
      </A3Card>
    </div>
  );
}

async function loadResourcePack(packId: string): Promise<ResourcePackDetailResponse> {
  if (packId !== 'latest') {
    return a3GetJson<ResourcePackDetailResponse>(`/api/resources/packs/${packId}/`);
  }
  const list = await a3GetJson<ResourcePackListResponse>('/api/resources/packs/');
  if (!list.success) {
    return { success: false, error: list.error ?? '资源包列表加载失败' };
  }
  const latest = list.resourcePacks?.[0];
  if (!latest) {
    return { success: false, error: '暂无资源包，请先在推荐页生成 A3 七类资源包。' };
  }
  return { success: true, resourcePack: latest };
}

function ResourceContentPreview({ resource }: { resource: A3ResourcePackV2Resource }) {
  const content = resource.content ?? {};
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4" data-testid="a3-resource-content-preview">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-slate-950">查看成品</div>
        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-500">{resource.type}</span>
      </div>
      {resource.type === 'mind_map' ? (
        <MindMapPreview content={content} />
      ) : resource.type === 'lecture_doc' ? (
        <LectureDocPreview content={content} />
      ) : resource.type === 'practice_set' ? (
        <PracticeSetPreview content={content} />
      ) : resource.type === 'case_study' ? (
        <CaseStudyPreview content={content} />
      ) : resource.type === 'code_lab' ? (
        <CodeLabPreview content={content} />
      ) : resource.type === 'micro_video_script' ? (
        <VideoScriptPreview content={content} />
      ) : resource.type === 'knowledge_card' ? (
        <KnowledgeCardPreview content={content} />
      ) : (
        <GenericResourcePreview content={content} />
      )}
      <AdditionalContentFields content={content} />
    </div>
  );
}

function MindMapPreview({ content }: { content: Record<string, unknown> }) {
  const root = safeText(content.root, '思维导图');
  const nodes = Array.isArray(content.nodes) ? content.nodes : [];
  return (
    <div data-testid="a3-mind-map-preview" className="overflow-x-auto rounded-xl bg-white p-4">
      <div className="min-w-[560px]">
        <div className="mx-auto w-fit rounded-2xl border border-blue-200 bg-blue-50 px-5 py-3 text-center text-sm font-semibold text-blue-950 shadow-sm">
          {root}
        </div>
        <div className="mx-auto h-6 w-px bg-blue-200" />
        <div className="grid gap-3 md:grid-cols-2">
          {nodes.map((node, index) => {
            const item = typeof node === 'object' && node ? (node as Record<string, unknown>) : {};
            const children = Array.isArray(item.children) ? item.children : [];
            return (
              <div key={`${safeText(item.label, '分支')}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-950">{safeText(item.label, `分支 ${index + 1}`)}</div>
                <div className="mt-3 space-y-2">
                  {children.map((child, childIndex) => (
                    <div key={`${safeText(child, '节点')}-${childIndex}`} className="flex items-start gap-2 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                      <span className="mt-1 size-1.5 shrink-0 rounded-full bg-blue-500" />
                      <span>{safeText(child, '子节点')}</span>
                    </div>
                  ))}
                  {!children.length && <div className="rounded-lg bg-white px-3 py-2 text-xs text-slate-400">暂无子节点</div>}
                </div>
              </div>
            );
          })}
          {!nodes.length && <div className="rounded-xl bg-white px-3 py-2 text-xs text-slate-500">暂无导图节点</div>}
        </div>
      </div>
    </div>
  );
}

function LectureDocPreview({ content }: { content: Record<string, unknown> }) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  return (
    <div className="space-y-3">
      {sections.map((section, index) => {
        const item = typeof section === 'object' && section ? (section as Record<string, unknown>) : {};
        return (
          <div key={`${safeText(item.heading, '章节')}-${index}`} className="rounded-xl bg-white p-3">
            <div className="text-sm font-semibold text-slate-950">{safeText(item.heading, `章节 ${index + 1}`)}</div>
            <p className="mt-2 text-xs leading-5 text-slate-600">{safeText(item.body, '暂无内容')}</p>
          </div>
        );
      })}
      {!sections.length && <GenericResourcePreview content={content} />}
    </div>
  );
}

function PracticeSetPreview({ content }: { content: Record<string, unknown> }) {
  const questions = Array.isArray(content.questions) ? content.questions : [];
  return (
    <div className="space-y-3">
      {questions.map((question, index) => {
        const item = typeof question === 'object' && question ? (question as Record<string, unknown>) : {};
        return (
          <div key={`${safeText(item.stem, '题目')}-${index}`} className="rounded-xl bg-white p-3">
            <div className="text-xs font-semibold text-blue-700">题目 {index + 1}</div>
            <div className="mt-1 text-sm font-semibold text-slate-950">{safeText(item.stem, '暂无题干')}</div>
            <p className="mt-2 text-xs leading-5 text-slate-600">参考答案：{safeText(item.answer, '暂无答案')}</p>
          </div>
        );
      })}
      {!questions.length && <GenericResourcePreview content={content} />}
    </div>
  );
}

function CaseStudyPreview({ content }: { content: Record<string, unknown> }) {
  const steps = Array.isArray(content.steps) ? content.steps : [];
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white p-3">
        <div className="text-xs font-semibold text-blue-700">场景</div>
        <div className="mt-2 text-sm font-semibold text-slate-950">{safeText(content.scenario, '案例场景待生成')}</div>
        <p className="mt-2 text-xs leading-5 text-slate-600">{safeText(content.task, '案例任务待生成')}</p>
      </div>
      <div className="rounded-xl bg-white p-3">
        <div className="text-xs font-semibold text-blue-700">分析步骤</div>
        <div className="mt-2 space-y-2">
          {steps.map((step, index) => (
            <div key={`${safeText(step, '步骤')}-${index}`} className="flex items-start gap-2 text-xs leading-5 text-slate-600">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[11px] font-semibold text-blue-700">{index + 1}</span>
              <span>{safeText(step, '案例分析步骤')}</span>
            </div>
          ))}
          {!steps.length && <div className="text-xs text-slate-400">暂无分析步骤</div>}
        </div>
      </div>
    </div>
  );
}

function CodeLabPreview({ content }: { content: Record<string, unknown> }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white p-3 text-xs leading-5 text-slate-600">{safeText(content.objective, '代码实验目标待生成')}</div>
      <pre className="max-h-72 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-5 text-slate-100">{safeText(content.starterCode, '# 暂无代码')}</pre>
    </div>
  );
}

function VideoScriptPreview({ content }: { content: Record<string, unknown> }) {
  const shots = Array.isArray(content.shots) ? content.shots : [];
  return (
    <div className="space-y-2">
      {shots.map((shot, index) => {
        const item = typeof shot === 'object' && shot ? (shot as Record<string, unknown>) : {};
        return (
          <div key={`${safeText(item.scene, '分镜')}-${index}`} className="rounded-xl bg-white p-3">
            <div className="text-xs font-semibold text-blue-700">{safeText(item.scene, `分镜 ${index + 1}`)}</div>
            <p className="mt-1 text-xs leading-5 text-slate-600">{safeText(item.narration, '暂无旁白')}</p>
          </div>
        );
      })}
      {!shots.length && <GenericResourcePreview content={content} />}
    </div>
  );
}

function KnowledgeCardPreview({ content }: { content: Record<string, unknown> }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl bg-white p-3">
        <div className="text-xs font-semibold text-blue-700">正面</div>
        <div className="mt-2 text-sm font-semibold text-slate-950">{safeText(content.front, '暂无正面')}</div>
      </div>
      <div className="rounded-xl bg-white p-3">
        <div className="text-xs font-semibold text-blue-700">背面</div>
        <p className="mt-2 text-xs leading-5 text-slate-600">{safeText(content.back, '暂无背面')}</p>
      </div>
    </div>
  );
}

function AdditionalContentFields({ content }: { content: Record<string, unknown> }) {
  const cards = Array.isArray(content.cards) ? content.cards : [];
  const steps = Array.isArray(content.steps) ? content.steps : [];
  const checkpoints = Array.isArray(content.checkpoints) ? content.checkpoints : [];
  const questions = Array.isArray(content.questions) ? content.questions : [];
  const shots = Array.isArray(content.shots) ? content.shots : [];
  const expectedOutput = safeText(content.expectedOutput, '');
  const extension = safeText(content.extension, '');
  const analysis = safeText(content.analysis, '');
  const reflection = safeText(content.reflection, '');
  const hasExtra =
    cards.length > 1 ||
    steps.length > 0 ||
    checkpoints.length > 0 ||
    questions.some((question) => typeof question === 'object' && question && 'explanation' in question) ||
    shots.some((shot) => typeof shot === 'object' && shot && ('visual' in shot || 'durationSeconds' in shot)) ||
    Boolean(expectedOutput || extension || analysis || reflection);

  if (!hasExtra) return null;

  return (
    <div className="mt-3 space-y-3" data-testid="a3-resource-rich-extra">
      {cards.length > 1 && (
        <div className="grid gap-3 md:grid-cols-2">
          {cards.map((card, index) => {
            const item = typeof card === 'object' && card ? (card as Record<string, unknown>) : {};
            return (
              <div key={`${safeText(item.front, '卡片')}-${index}`} className="rounded-xl bg-white p-3">
                <div className="text-xs font-semibold text-blue-700">卡片 {index + 1}</div>
                <div className="mt-2 text-sm font-semibold text-slate-950">{safeText(item.front, '暂无正面')}</div>
                <p className="mt-2 text-xs leading-5 text-slate-600">{safeText(item.back, '暂无背面')}</p>
              </div>
            );
          })}
        </div>
      )}
      {questions.some((question) => typeof question === 'object' && question && 'explanation' in question) && (
        <div className="rounded-xl bg-white p-3">
          <div className="text-xs font-semibold text-blue-700">题目解析</div>
          <div className="mt-2 space-y-2">
            {questions.map((question, index) => {
              const item = typeof question === 'object' && question ? (question as Record<string, unknown>) : {};
              if (!('explanation' in item)) return null;
              return (
                <p key={`${safeText(item.stem, '题目')}-${index}`} className="text-xs leading-5 text-slate-600">
                  {index + 1}. {safeText(item.explanation, '暂无解析')}
                </p>
              );
            })}
          </div>
        </div>
      )}
      {(steps.length > 0 || checkpoints.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          <TextList title="实验步骤" items={steps} />
          <TextList title="检查点" items={checkpoints} />
        </div>
      )}
      {(expectedOutput || extension || analysis || reflection) && (
        <div className="rounded-xl bg-white p-3 text-xs leading-5 text-slate-600">
          {expectedOutput && <p><span className="font-semibold text-slate-950">预期输出：</span>{expectedOutput}</p>}
          {extension && <p className="mt-1"><span className="font-semibold text-slate-950">扩展任务：</span>{extension}</p>}
          {analysis && <p className="mt-1"><span className="font-semibold text-slate-950">案例分析：</span>{analysis}</p>}
          {reflection && <p className="mt-1"><span className="font-semibold text-slate-950">复盘建议：</span>{reflection}</p>}
        </div>
      )}
      {shots.some((shot) => typeof shot === 'object' && shot && ('visual' in shot || 'durationSeconds' in shot)) && (
        <div className="rounded-xl bg-white p-3">
          <div className="text-xs font-semibold text-blue-700">视频画面设计</div>
          <div className="mt-2 space-y-2">
            {shots.map((shot, index) => {
              const item = typeof shot === 'object' && shot ? (shot as Record<string, unknown>) : {};
              return (
                <p key={`${safeText(item.scene, '分镜')}-${index}`} className="text-xs leading-5 text-slate-600">
                  {index + 1}. {safeText(item.scene, '分镜')}：{safeText(item.visual, '暂无画面')} {item.durationSeconds ? `(${safeText(item.durationSeconds, '')}s)` : ''}
                </p>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TextList({ title, items }: { title: string; items: unknown[] }) {
  return (
    <div className="rounded-xl bg-white p-3">
      <div className="text-xs font-semibold text-blue-700">{title}</div>
      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={`${safeText(item, title)}-${index}`} className="flex items-start gap-2 text-xs leading-5 text-slate-600">
            <span className="mt-1 size-1.5 shrink-0 rounded-full bg-blue-500" />
            <span>{safeText(item, title)}</span>
          </div>
        ))}
        {!items.length && <div className="text-xs text-slate-400">暂无内容</div>}
      </div>
    </div>
  );
}

function GenericResourcePreview({ content }: { content: Record<string, unknown> }) {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-white p-3 text-xs leading-5 text-slate-600">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function safeText(value: unknown, fallback: string) {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function ArtifactCard({ artifact }: { artifact: OpenMAICArtifactHistoryItem }) {
  const isVideo = artifact.type === 'openmaic_video';
  const isPptx = artifact.type === 'openmaic_pptx_export';
  const url = isVideo && artifact.resourcePackId ? `/a3/resources/${artifact.resourcePackId}/video` : isVideo ? artifact.videoUrl : artifact.classroomUrl;
  const title = isVideo ? 'OpenMAIC 视频' : isPptx ? 'OpenMAIC PPTX 导出' : 'OpenMAIC 课堂';
  return (
    <div className="rounded-2xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] p-4" data-testid="a3-resource-pack-artifact">
      <div className="flex items-center justify-between gap-2">
        <A3Pill tone={artifact.status === 'succeeded' ? 'green' : 'orange'}>{artifact.status}</A3Pill>
        <span className="text-xs text-[var(--a3-text-muted)]">{title}</span>
      </div>
      <div className="mt-3 text-sm font-semibold text-[var(--a3-text)]">{artifact.provider || 'provider 未记录'}</div>
      <div className="mt-2 grid gap-1 text-xs leading-5 text-[var(--a3-text-muted)]">
        <span>回写时间：{formatArtifactTimestamp(artifact)}</span>
        {artifact.resourcePackId ? <span>资源包：{artifact.resourcePackId}</span> : null}
        {artifact.jobId ? <span>job：{artifact.jobId}</span> : null}
        {!isVideo && !isPptx ? <span>场景数：{artifact.scenesCount ?? 0}，PPTX：{artifact.pptxExportable ? '可导出' : '待生成'}</span> : null}
        {isPptx ? <span>文件：{artifact.fileName || '未记录'}，页数：{artifact.slidesCount ?? 0}</span> : null}
        {isVideo ? <span>资源类型：{artifact.resourceType || 'micro_video_script'}，时长：{artifact.duration || 0}s</span> : null}
        {artifact.degradedReason ? <span className="text-orange-700">降级原因：{artifact.degradedReason}</span> : null}
      </div>
      {url && (
        <Button asChild size="sm" variant="outline" className="mt-3 bg-white">
          <Link href={url}>
            <ExternalLink className="size-4" />
            打开产物
          </Link>
        </Button>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-muted)] px-4 py-3">
      <div className="text-xs text-[var(--a3-text-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold text-[var(--a3-text)]">{value}</div>
    </div>
  );
}
