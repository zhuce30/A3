'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpenText,
  CheckCircle2,
  Code2,
  ExternalLink,
  FileText,
  GitBranch,
  Layers3,
  Loader2,
  MonitorPlay,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, a3PostJson } from '@/lib/a3/api-client';
import { trackLearningEvent, trackResourceComplete, trackResourceOpen } from '@/lib/a3/learning-event-client';
import type {
  A3OpenMAICClassroomArtifact,
  A3OpenMAICPPTXExportArtifact,
  A3ResourceFeedbackResponse,
  A3ResourcePackV2,
  A3ResourcePackV2Resource,
  A3ResourcePackV2ResourceType,
} from '@/lib/a3/recommendation-types';
import { A3Markdown } from '../ui/a3-markdown';
import { A3Card, A3Pill } from '../ui/a3-card';
import { CaseStudyWorkbench } from './resource-workbench/case-study-workbench';
import { CodeLabWorkbench } from './resource-workbench/code-lab-workbench';
import { PracticeSetWorkbench } from './resource-workbench/practice-set-workbench';

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

type ResourcePageConfig = {
  slug: string;
  type?: A3ResourcePackV2ResourceType;
  title: string;
  subtitle: string;
  icon: typeof FileText;
  tone: 'blue' | 'green' | 'violet' | 'orange' | 'red' | 'slate';
};

const pageConfigs: Record<string, ResourcePageConfig> = {
  document: {
    slug: 'document',
    type: 'lecture_doc',
    title: '讲解文档',
    subtitle: '把本次学习需求整理成可阅读、可复习的结构化讲义。',
    icon: FileText,
    tone: 'blue',
  },
  cards: {
    slug: 'cards',
    type: 'knowledge_card',
    title: '知识卡片',
    subtitle: '用于课后快速回忆和复习。',
    icon: BookOpenText,
    tone: 'green',
  },
  ppt: {
    slug: 'ppt',
    type: 'lecture_doc',
    title: 'PPT 课件',
    subtitle: 'PPTX 由 OpenMAIC 课堂前端导出，A3 展示真实 artifact 状态。',
    icon: MonitorPlay,
    tone: 'violet',
  },
  'mind-map': {
    slug: 'mind-map',
    type: 'mind_map',
    title: '思维导图',
    subtitle: '从知识点结构、分支和子节点理解当前主题。',
    icon: GitBranch,
    tone: 'green',
  },
  practice: {
    slug: 'practice',
    type: 'practice_set',
    title: '专项练习',
    subtitle: '围绕薄弱点生成题目、答案和解析。',
    icon: CheckCircle2,
    tone: 'orange',
  },
  'case-study': {
    slug: 'case-study',
    type: 'case_study',
    title: '案例拆解',
    subtitle: '把知识点放进真实问题场景中分析。',
    icon: Layers3,
    tone: 'slate',
  },
  'code-lab': {
    slug: 'code-lab',
    type: 'code_lab',
    title: '代码实验',
    subtitle: '包含目标、步骤、起始代码、检查点和扩展任务。',
    icon: Code2,
    tone: 'red',
  },
};

export function ResourceStandaloneView({ packId, resourceType }: { packId: string; resourceType: string }) {
  const [pack, setPack] = useState<A3ResourcePackV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackSaving, setFeedbackSaving] = useState('');

  const config = pageConfigs[resourceType] ?? pageConfigs.document;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const result = await loadResourcePack(packId);
      if (cancelled) return;
      setLoading(false);
      if (!result.success || !result.resourcePack) {
        setError(result.error ?? '资源加载失败。');
        return;
      }
      setPack(sanitizeResourcePack(result.resourcePack));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  const resource = useMemo(() => {
    if (!pack || !config.type) return null;
    return pack.resources.find((item) => item.type === config.type) ?? null;
  }, [config.type, pack]);
  const openedPackId = pack?.resourcePackId ?? '';
  const openedResourceType = resource?.type ?? '';

  useEffect(() => {
    if (!openedPackId || !openedResourceType) return;
    void recordResourceFeedback(openedPackId, openedResourceType, 'opened');
    void recordResourceLearningEvent(pack, resource, config, 'opened');
  }, [config, openedPackId, openedResourceType, pack, resource]);

  async function handleFeedback(action: 'completed' | 'skipped' | 'favorited', score?: number | null) {
    if (!pack || !resource) return;
    setFeedbackSaving(action);
    setFeedbackMessage('');
    const feedbackScore = action === 'completed'
      ? score === null ? null : Math.max(0, Math.min(100, score ?? 90))
      : 0;
    const result = await recordResourceFeedback(pack.resourcePackId, resource.type, action, feedbackScore);
    void recordResourceLearningEvent(pack, resource, config, action, feedbackScore);
    setFeedbackSaving('');
    setFeedbackMessage(result.success ? feedbackSuccessText(action) : result.error ?? '资源反馈回流失败');
  }

  if (loading) {
    return (
      <A3Card>
        <div className="flex items-center gap-2 py-12 text-sm text-[var(--a3-text-muted)]">
          <Loader2 className="size-4 animate-spin" />
          正在加载资源成品...
        </div>
      </A3Card>
    );
  }

  if (error || !pack) {
    return (
      <A3Card>
        <div className="py-12 text-center">
          <div className="text-lg font-semibold text-[var(--a3-text)]">资源加载失败</div>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">{error}</p>
          <Button asChild className="mt-5 bg-blue-600 hover:bg-blue-700">
            <Link href="/a3/recommendations">返回资源生成入口</Link>
          </Button>
        </div>
      </A3Card>
    );
  }

  if (config.slug === 'ppt') {
    return <PptResourcePage pack={pack} config={config} />;
  }

  return (
    <div className="space-y-5" data-testid="a3-resource-standalone-page">
      <ResourceHeader pack={pack} config={config} resource={resource} />
      {resource ? <ResourceBody resource={resource} pack={pack} config={config} feedbackMessage={feedbackMessage} feedbackSaving={feedbackSaving} onFeedback={handleFeedback} /> : <MissingResource pack={pack} config={config} />}
    </div>
  );
}

function ResourceHeader({ pack, config, resource }: { pack: A3ResourcePackV2; config: ResourcePageConfig; resource: A3ResourcePackV2Resource | null }) {
  const Icon = config.icon;
  return (
    <section className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
      <Button asChild size="sm" variant="outline" className="bg-white">
        <Link href="/a3/recommendations">
          <ArrowLeft className="size-4" />
          返回资源生成入口
        </Link>
      </Button>
      <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
            <Icon className="size-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-normal text-slate-950">{config.title}</h1>
              <A3Pill tone={resource?.verified ? 'green' : config.tone}>{resource?.verified ? '已验证' : '待验证'}</A3Pill>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{config.subtitle}</p>
            <p className="mt-2 text-sm leading-6 text-slate-500">学习需求：{pack.goal}</p>
          </div>
        </div>
        <div className="grid min-w-[220px] grid-cols-2 gap-2 text-sm">
          <Metric label="预计时间" value={resource ? `${resource.estimatedMinutes} 分钟` : '--'} />
          <Metric label="引用" value={`${resource?.citations.length ?? 0} 条`} />
        </div>
      </div>
    </section>
  );
}

function ResourceBody({
  resource,
  pack,
  config,
  feedbackMessage,
  feedbackSaving,
  onFeedback,
}: {
  resource: A3ResourcePackV2Resource;
  pack: A3ResourcePackV2;
  config: ResourcePageConfig;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: (action: 'completed' | 'skipped' | 'favorited', score?: number | null) => void;
}) {
  if (resource.type === 'practice_set') {
    return <PracticeSetWorkbench resource={resource} feedbackMessage={feedbackMessage} feedbackSaving={feedbackSaving} onFeedback={onFeedback} />;
  }
  if (resource.type === 'case_study') {
    return <CaseStudyWorkbench resource={resource} feedbackMessage={feedbackMessage} feedbackSaving={feedbackSaving} onFeedback={onFeedback} />;
  }
  if (resource.type === 'code_lab') {
    return <CodeLabWorkbench key={`${pack.resourcePackId}:${resource.title}`} resource={resource} packId={pack.resourcePackId} feedbackMessage={feedbackMessage} feedbackSaving={feedbackSaving} onFeedback={onFeedback} />;
  }
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <A3Card title={resource.title} subtitle={resource.personalizationReason}>
        {resource.type === 'lecture_doc' && <LectureDocument resource={resource} pack={pack} />}
        {resource.type === 'knowledge_card' && <KnowledgeCards resource={resource} />}
        {resource.type === 'mind_map' && <MindMap resource={resource} />}
      </A3Card>
      <EvidencePanel pack={pack} resource={resource} config={config} feedbackMessage={feedbackMessage} feedbackSaving={feedbackSaving} onFeedback={onFeedback} />
    </div>
  );
}

function LectureDocument({ resource, pack }: { resource: A3ResourcePackV2Resource; pack: A3ResourcePackV2 }) {
  const content = resource.content;
  const sections = arrayOfRecords(content.sections);
  const cardResource = pack.resources.find((item) => item.type === 'knowledge_card');
  const cards = arrayOfRecords(cardResource?.content?.cards).length ? arrayOfRecords(cardResource?.content?.cards) : arrayOfRecords(cardResource?.content ? [cardResource.content] : []);
  return (
    <article className="space-y-5">
      {sections.map((section, index) => (
        <section key={`${safeText(section.heading, '章节')}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-lg font-semibold text-slate-950">{safeText(section.heading, `第 ${index + 1} 部分`)}</h2>
          <A3Markdown className="mt-3 text-slate-700">{safeText(section.body, '暂无内容')}</A3Markdown>
        </section>
      ))}
      {!sections.length && <GenericContent content={content} />}
      {cards.length > 0 && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
          <h2 className="text-lg font-semibold text-emerald-950">复习卡片</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {cards.slice(0, 6).map((card, index) => (
              <div key={`${safeText(card.front, '卡片')}-${index}`} className="rounded-xl bg-white p-4">
                <div className="text-sm font-semibold text-emerald-800">{safeText(card.front, `卡片 ${index + 1}`)}</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{safeText(card.back, safeText(card.answer, '暂无背面内容'))}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function MindMap({ resource }: { resource: A3ResourcePackV2Resource }) {
  return <RadialMindMap resource={resource} />;
}

function RadialMindMap({ resource }: { resource: A3ResourcePackV2Resource }) {
  const content = resource.content;
  const branches = arrayOfRecords(content.nodes)
    .map((node, index) => ({
      id: `branch-${index}`,
      label: safeText(node.label, `分支 ${index + 1}`),
      children: Array.isArray(node.children)
        ? node.children.map((child, childIndex) => summarizeMindMapLeaf(safeText(child, `子节点 ${childIndex + 1}`))).filter(Boolean)
        : [],
    }))
    .filter((node) => node.label || node.children.length);

  if (!branches.length) return <GenericContent content={content} />;

  const rootTitle = summarizeMindMapRoot(safeText(content.root, ''), resource.title, branches);
  const layout = buildMindMapLayout(rootTitle, branches);

  return (
    <div className="rounded-2xl border border-slate-200 bg-[#fbfaf7] p-4" data-testid="a3-resource-mind-map">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-950">发散式思维导图</div>
          <p className="mt-1 text-xs text-slate-500">中心主题向两侧展开，颜色表示一级分支。</p>
        </div>
        <A3Pill tone="green">{branches.length} 个主分支</A3Pill>
      </div>
      <div className="overflow-auto rounded-2xl bg-white p-4 shadow-inner">
        <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: layout.width }}>
          <svg className="absolute inset-0" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
            {layout.branchNodes.map((branch) => (
              <path
                key={`root-line-${branch.id}`}
                d={curvePath(layout.root.x, layout.root.y, branch.x, branch.y, branch.side)}
                fill="none"
                stroke={branch.color}
                strokeWidth="7"
                strokeLinecap="round"
                opacity="0.78"
              />
            ))}
            {layout.leafNodes.map((leaf) => (
              <path
                key={`leaf-line-${leaf.id}`}
                d={curvePath(leaf.parentX, leaf.parentY, leaf.x, leaf.y, leaf.side)}
                fill="none"
                stroke={leaf.color}
                strokeWidth="3.5"
                strokeLinecap="round"
                opacity="0.78"
              />
            ))}
          </svg>

          <div
            className="absolute flex min-h-16 w-[240px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22px] border-4 border-orange-400 bg-white px-6 py-4 text-center text-2xl font-semibold leading-tight text-slate-800 shadow-sm"
            style={{ left: layout.root.x, top: layout.root.y }}
          >
            {layout.root.label}
          </div>

          {layout.branchNodes.map((branch) => (
            <div
              key={branch.id}
              className="absolute flex min-h-11 w-[170px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-xl border bg-white px-4 py-2 text-center text-base font-semibold text-slate-800 shadow-sm"
              style={{ left: branch.x, top: branch.y, borderColor: branch.color }}
            >
              <span className="mr-2 inline-flex size-5 items-center justify-center rounded-full text-xs font-bold text-white" style={{ backgroundColor: branch.color }}>
                {branch.index + 1}
              </span>
              <span className="line-clamp-2">{branch.label}</span>
            </div>
          ))}

          {layout.leafNodes.map((leaf) => (
            <div
              key={leaf.id}
              className="absolute min-h-8 w-[180px] -translate-y-1/2 px-2 text-sm font-medium leading-5 text-slate-700"
              style={{
                left: leaf.side === 'right' ? leaf.x : leaf.x - 180,
                top: leaf.y - 6,
                textAlign: leaf.side === 'right' ? 'left' : 'right',
              }}
            >
              <div>{leaf.label}</div>
              <div className="mt-1 h-[3px] rounded-full" style={{ backgroundColor: leaf.color }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function _LegacyMindMapLayoutReference({ resource }: { resource: A3ResourcePackV2Resource }) {
  const content = resource.content;
  const nodes = arrayOfRecords(content.nodes);
  return (
    <div className="overflow-x-auto rounded-2xl bg-slate-50 p-5" data-testid="a3-resource-mind-map">
      <div className="min-w-[720px]">
        <div className="mx-auto w-fit rounded-2xl border border-blue-200 bg-blue-50 px-6 py-4 text-center text-base font-semibold text-blue-950 shadow-sm">
          {safeText(content.root, resource.title)}
        </div>
        <div className="mx-auto h-8 w-px bg-blue-200" />
        <div className="grid gap-4 md:grid-cols-2">
          {nodes.map((node, index) => {
            const children = Array.isArray(node.children) ? node.children : [];
            return (
              <div key={`${safeText(node.label, '分支')}-${index}`} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-950">{safeText(node.label, `分支 ${index + 1}`)}</div>
                <div className="mt-3 space-y-2">
                  {children.map((child, childIndex) => (
                    <div key={`${safeText(child, '节点')}-${childIndex}`} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-600">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-blue-500" />
                      <span>{safeText(child, '子节点')}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type MindMapSide = 'left' | 'right';

type MindMapBranchInput = {
  id: string;
  label: string;
  children: string[];
};

type MindMapBranchNode = {
  id: string;
  index: number;
  label: string;
  side: MindMapSide;
  x: number;
  y: number;
  color: string;
};

type MindMapLeafNode = {
  id: string;
  label: string;
  side: MindMapSide;
  x: number;
  y: number;
  parentX: number;
  parentY: number;
  color: string;
};

const mindMapPalette = ['#ff6b6b', '#45aaf2', '#f7b731', '#a55eea', '#26de81', '#fd9644', '#4b7bec', '#e056fd'];

function buildMindMapLayout(rootLabel: string, branches: MindMapBranchInput[]) {
  const width = 1360;
  const rootX = width / 2;
  const leftBranches = branches.filter((_, index) => index % 2 === 1);
  const rightBranches = branches.filter((_, index) => index % 2 === 0);
  const leftHeight = measureMindMapSide(leftBranches);
  const rightHeight = measureMindMapSide(rightBranches);
  const height = Math.max(720, Math.max(leftHeight, rightHeight) + 180);
  const rootY = height / 2;

  const branchNodes: MindMapBranchNode[] = [];
  const leafNodes: MindMapLeafNode[] = [];

  placeMindMapSide({
    branches: rightBranches,
    side: 'right',
    startY: (height - rightHeight) / 2,
    rootX,
    branchNodes,
    leafNodes,
  });
  placeMindMapSide({
    branches: leftBranches,
    side: 'left',
    startY: (height - leftHeight) / 2,
    rootX,
    branchNodes,
    leafNodes,
  });

  return {
    width,
    height,
    root: { label: rootLabel, x: rootX, y: rootY },
    branchNodes,
    leafNodes,
  };
}

function measureMindMapSide(branches: MindMapBranchInput[]) {
  return branches.reduce((sum, branch) => sum + mindMapGroupHeight(branch) + 34, 0);
}

function mindMapGroupHeight(branch: MindMapBranchInput) {
  return Math.max(128, Math.max(1, branch.children.length) * 48);
}

function placeMindMapSide({
  branches,
  side,
  startY,
  rootX,
  branchNodes,
  leafNodes,
}: {
  branches: MindMapBranchInput[];
  side: MindMapSide;
  startY: number;
  rootX: number;
  branchNodes: MindMapBranchNode[];
  leafNodes: MindMapLeafNode[];
}) {
  const direction = side === 'right' ? 1 : -1;
  let cursorY = startY;
  branches.forEach((branch) => {
    const originalIndex = Number(branch.id.replace('branch-', '')) || 0;
    const color = mindMapPalette[originalIndex % mindMapPalette.length];
    const groupHeight = mindMapGroupHeight(branch);
    const branchX = rootX + direction * 280;
    const branchY = cursorY + groupHeight / 2;
    const children = branch.children.length ? branch.children : ['继续补充子节点'];

    branchNodes.push({
      id: branch.id,
      index: originalIndex,
      label: branch.label,
      side,
      x: branchX,
      y: branchY,
      color,
    });

    const leafStartY = branchY - ((children.length - 1) * 44) / 2;
    children.forEach((child, childIndex) => {
      leafNodes.push({
        id: `${branch.id}-leaf-${childIndex}`,
        label: child,
        side,
        x: rootX + direction * 510,
        y: leafStartY + childIndex * 44,
        parentX: branchX + direction * 84,
        parentY: branchY,
        color,
      });
    });

    cursorY += groupHeight + 34;
  });
}

function curvePath(fromX: number, fromY: number, toX: number, toY: number, side: MindMapSide) {
  const direction = side === 'right' ? 1 : -1;
  const controlOffset = Math.max(90, Math.abs(toX - fromX) * 0.48);
  return `M ${fromX} ${fromY} C ${fromX + direction * controlOffset} ${fromY}, ${toX - direction * controlOffset} ${toY}, ${toX} ${toY}`;
}

function summarizeMindMapRoot(root: string, title: string, branches: MindMapBranchInput[]) {
  const raw = `${root} ${title} ${branches.map((branch) => branch.label).join(' ')}`;
  const normalized = raw.replace(/\s+/g, '');
  const hasOperatingSystem = /操作系统|进程|线程|调度|死锁|信号量|虚拟内存|页面置换|文件系统|磁盘调度/.test(normalized);
  if (hasOperatingSystem) {
    const terms = [
      ['进程调度', '进程调度'],
      ['处理机调度', '处理机调度'],
      ['信号量', '信号量'],
      ['同步互斥', '同步互斥'],
      ['死锁', '死锁'],
      ['虚拟内存', '虚拟内存'],
      ['页面置换', '页面置换'],
      ['文件系统', '文件系统'],
      ['磁盘调度', '磁盘调度'],
    ]
      .filter(([keyword]) => normalized.includes(keyword))
      .map(([, label]) => label);
    const uniqueTerms = Array.from(new Set(terms)).slice(0, 2);
    return uniqueTerms.length ? `操作系统：${uniqueTerms.join('与')}` : '操作系统复习图';
  }
  const titleText = safeText(title, '');
  const rootText = safeText(root, '');
  const candidate = titleText && titleText.length <= 18 ? titleText : rootText;
  const cleaned = candidate
    .replace(/^我正在学习/, '')
    .replace(/请结合.*$/, '')
    .replace(/帮助我.*$/, '')
    .replace(/[，。；、,.].*$/, '')
    .trim();
  if (cleaned && cleaned.length <= 18) return cleaned;
  if (branches.length) return `${branches[0].label}学习图`;
  return '知识点思维导图';
}

function summarizeMindMapLeaf(value: string) {
  const text = value
    .replace(/\s+/g, '')
    .replace(/^标准问题[:：]?/, '')
    .replace(/^相似问法[:：]?/, '')
    .replace(/^无答案[:：]?/, '')
    .replace(/^答[:：]?/, '')
    .replace(/^答案[:：]?/, '')
    .replace(/^RenderedPPTXslide\d+/i, '课件示例')
    .trim();

  const topicTerms: Array<[RegExp, string]> = [
    [/时间片轮转|轮转调度|RR调度/, '时间片轮转'],
    [/处理机调度|CPU调度|调度算法/, '调度算法'],
    [/进程.*PCB|PCB.*进程/, '进程与 PCB'],
    [/线程|并发执行/, '线程并发'],
    [/信号量|PV操作|P\/V/, '信号量机制'],
    [/临界区|互斥/, '同步互斥'],
    [/死锁|银行家算法/, '死锁处理'],
    [/虚拟内存|缺页中断/, '虚拟内存'],
    [/页面置换|FIFO|LRU|OPT/, '页面置换'],
    [/文件系统|目录结构/, '文件系统'],
    [/磁盘调度|SSTF|SCAN/, '磁盘调度'],
    [/关键步骤/, '关键步骤'],
    [/影响因素/, '影响因素'],
    [/题目应用|例题|练习/, '题目应用'],
  ];
  const matched = topicTerms.find(([pattern]) => pattern.test(text));
  if (matched) return matched[1];

  const firstClause = text.split(/[。；;，,？?：:]/).find((part) => part.trim().length >= 2)?.trim() || text;
  if (firstClause.length <= 16) return firstClause;
  return `${firstClause.slice(0, 14)}…`;
}

function KnowledgeCards({ resource }: { resource: A3ResourcePackV2Resource }) {
  const cards = arrayOfRecords(resource.content.cards).length ? arrayOfRecords(resource.content.cards) : [resource.content];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {cards.map((card, index) => (
        <div key={`${safeText(card.front, '卡片')}-${index}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <div className="text-sm font-semibold text-blue-700">卡片 {index + 1}</div>
          <h2 className="mt-2 text-base font-semibold text-slate-950">{safeText(card.front, '暂无正面')}</h2>
          <p className="mt-3 text-sm leading-6 text-slate-700">{safeText(card.back, safeText(card.answer, '暂无背面内容'))}</p>
        </div>
      ))}
    </div>
  );
}

function PptResourcePage({ pack, config }: { pack: A3ResourcePackV2; config: ResourcePageConfig }) {
  const classroomArtifact = pack.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICClassroomArtifact => artifact.type === 'openmaic_classroom') ?? null;
  const pptxArtifact = pack.multimodalArtifacts?.find((artifact): artifact is A3OpenMAICPPTXExportArtifact => artifact.type === 'openmaic_pptx_export') ?? null;
  return (
    <div className="space-y-5" data-testid="a3-resource-ppt-page">
      <ResourceHeader pack={pack} config={config} resource={pack.resources.find((item) => item.type === 'lecture_doc') ?? null} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <A3Card title="PPT 生成状态" subtitle="A3 只展示真实课堂和导出记录；PPTX 文件由 OpenMAIC 课堂前端导出。">
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-950">OpenMAIC 课堂</div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {classroomArtifact
                      ? `状态：${classroomArtifact.status}，场景数：${classroomArtifact.scenesCount || 0}`
                      : '当前资源包还没有课堂 artifact。请回到资源生成入口点击“生成 PPT 课堂”。'}
                  </p>
                </div>
                <A3Pill tone={classroomArtifact?.status === 'succeeded' ? 'green' : 'orange'}>{classroomArtifact?.status ?? 'missing'}</A3Pill>
              </div>
              {classroomArtifact?.classroomUrl && (
                <Button asChild className="mt-4 bg-violet-600 text-white hover:bg-violet-700">
                  <Link href={classroomArtifact.classroomUrl}>
                    <MonitorPlay className="size-4" />
                    打开课堂并导出 PPTX
                  </Link>
                </Button>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-950">PPTX 导出回写</div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    {pptxArtifact
                      ? `文件：${pptxArtifact.fileName || '未记录文件名'}，页数：${pptxArtifact.slidesCount || 0}`
                      : '还没有 PPTX 导出 artifact。进入课堂导出后，A3 会显示回写记录。'}
                  </p>
                </div>
                <A3Pill tone={pptxArtifact?.status === 'succeeded' ? 'green' : 'slate'}>{pptxArtifact?.status ?? 'not exported'}</A3Pill>
              </div>
            </div>
          </div>
        </A3Card>
        <A3Card title="为什么这样设计" subtitle="避免把 PPT 做成前端假下载。">
          <div className="space-y-3 text-sm leading-6 text-slate-600">
            <p>PPT 课件的真实链路是：A3 资源包 {'->'} OpenMAIC 课堂 {'->'} 前端导出 PPTX {'->'} artifact 写回 A3。</p>
            <p>因此这里展示课堂和导出证据。没有 artifact 时，页面不会伪造成“已生成 PPT”。</p>
            <Button asChild variant="outline" className="bg-white">
              <Link href={`/a3/resources/${pack.resourcePackId}`}>
                <ExternalLink className="size-4" />
                查看 artifact 历史
              </Link>
            </Button>
          </div>
        </A3Card>
      </div>
    </div>
  );
}

function EvidencePanel({
  pack,
  resource,
  config,
  feedbackMessage,
  feedbackSaving,
  onFeedback,
}: {
  pack: A3ResourcePackV2;
  resource: A3ResourcePackV2Resource;
  config: ResourcePageConfig;
  feedbackMessage: string;
  feedbackSaving: string;
  onFeedback: (action: 'completed' | 'skipped' | 'favorited') => void;
}) {
  const compactCitations = compactResourceCitations(resource.citations);
  const actionCard = (
    <A3Card title="学习反馈回流" subtitle="用于更新资源实际效果，影响后续推荐排序。">
      <div className="grid gap-2">
        <Button type="button" onClick={() => onFeedback('completed')} disabled={Boolean(feedbackSaving)} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="a3-resource-feedback-completed">
          {feedbackSaving === 'completed' ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          完成学习
        </Button>
        <Button type="button" variant="outline" onClick={() => onFeedback('favorited')} disabled={Boolean(feedbackSaving)} className="bg-white" data-testid="a3-resource-feedback-favorited">
          {feedbackSaving === 'favorited' ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          收藏为有效资源
        </Button>
        <Button type="button" variant="outline" onClick={() => onFeedback('skipped')} disabled={Boolean(feedbackSaving)} className="bg-white" data-testid="a3-resource-feedback-skipped">
          {feedbackSaving === 'skipped' ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
          暂不学习
        </Button>
      </div>
      {feedbackMessage && (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800" data-testid="a3-resource-feedback-message">
          {feedbackMessage}
        </div>
      )}
    </A3Card>
  );
  return (
    <div className="space-y-5">
      {actionCard}
      <A3Card title="生成证据" subtitle="评委和学生都能看懂的依据。">
        <div className="space-y-3 text-sm">
          <EvidenceItem label="资源类型" value={config.title} />
          <EvidenceItem label="生成目标" value={summarizeEvidenceText(pack.goal, 42)} />
          <EvidenceItem label="个性化原因" value={summarizeEvidenceText(resource.personalizationReason, 48)} />
          <EvidenceItem label="schema" value={pack.schemaVersion} />
          <EvidenceItem label="traceId" value={pack.traceId} />
        </div>
      </A3Card>
      <A3Card title="引用来源" subtitle={`${resource.citations.length} 条证据，已按资料合并显示。`}>
        <div className="space-y-3">
          {compactCitations.map((citation, index) => (
            <div key={`${citation.title}-${citation.location}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
                <div className="min-w-0">
                  <div className="line-clamp-2 text-xs font-semibold leading-5 text-blue-700">{citation.title}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                    {citation.location && <span className="rounded-full bg-white px-2 py-0.5">{citation.location}</span>}
                    {citation.count > 1 && <span className="rounded-full bg-white px-2 py-0.5">{citation.count} 个命中</span>}
                  </div>
                </div>
              </div>
              {citation.snippet && <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600">{citation.snippet}</p>}
            </div>
          ))}
          {!compactCitations.length && <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">暂无可展示来源，生成内容不会标记为已验证。</div>}
        </div>
      </A3Card>
    </div>
  );
}

function MissingResource({ pack, config }: { pack: A3ResourcePackV2; config: ResourcePageConfig }) {
  return (
    <A3Card>
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <div className="text-base font-semibold text-slate-950">这个资源还没有生成</div>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
          当前资源包 `{pack.resourcePackId}` 里没有 {config.title}。请回到资源生成入口，点击对应资源的“单独生成”。
        </p>
        <Button asChild className="mt-5 bg-blue-600 text-white hover:bg-blue-700">
          <Link href="/a3/recommendations">返回生成入口</Link>
        </Button>
      </div>
    </A3Card>
  );
}

function GenericContent({ content }: { content: Record<string, unknown> }) {
  return (
    <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-5 text-sm leading-6 text-slate-100">
      {JSON.stringify(content, null, 2)}
    </pre>
  );
}

function EvidenceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 break-words text-sm text-slate-800">{value}</div>
    </div>
  );
}

function compactResourceCitations(citations: A3ResourcePackV2Resource['citations']) {
  const groups = new Map<string, { title: string; location: string; snippet: string; count: number }>();
  for (const citation of citations) {
    const title = displaySourceTitle(citation.title || citation.location || citation.sourceOrigin || '');
    const location = displaySourceLocation(citation.location || citation.sourceOrigin || '');
    const snippet = summarizeEvidenceText(cleanCitationSnippet(citation.snippet || ''), 72);
    const key = `${title}|${location}`;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      if (!current.snippet && snippet) current.snippet = snippet;
      continue;
    }
    groups.set(key, {
      title: title || '本地知识库资料',
      location,
      snippet,
      count: 1,
    });
  }
  return Array.from(groups.values()).slice(0, 4);
}

function displaySourceTitle(value: string) {
  const text = safeText(value, '').replace(/\\/g, '/');
  const fileName = text.split('/').pop() || text;
  return fileName.replace(/^[a-f0-9]{24,}_/i, '').replace(/^\d+\./, '').trim() || '本地知识库资料';
}

function displaySourceLocation(value: string) {
  const text = safeText(value, '');
  const slide = text.match(/slide\s*\d+/i)?.[0];
  if (slide) return slide.replace(/slide/i, 'Slide ');
  const page = text.match(/第?\s*\d+\s*(页|章|节)/)?.[0];
  if (page) return page.replace(/\s+/g, '');
  if (/\.(pptx|pdf|docx|xlsx|txt|md)$/i.test(text)) return '资料文件';
  if (/^[A-Za-z]:\\|^\//.test(text)) return '本地资料';
  return summarizeEvidenceText(text, 18);
}

function cleanCitationSnippet(value: string) {
  return safeText(value, '')
    .replace(/^标准问题[:：]?/, '')
    .replace(/相似问法[:：]?.*?(?=答[:：]|答案[:：]|$)/, '')
    .replace(/无答案[:：]?/, '')
    .replace(/答[:：]?/, '')
    .replace(/答案[:：]?/, '')
    .trim();
}

function summarizeEvidenceText(value: string, maxLength: number) {
  const text = safeText(value, '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentence = text.split(/[。；;!?！？]/).find((part) => part.trim().length >= 4)?.trim() || text;
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength)}...` : sentence;
}

async function recordResourceFeedback(
  packId: string,
  resourceType: A3ResourcePackV2ResourceType,
  action: 'opened' | 'completed' | 'skipped' | 'favorited',
  score: number | null = 0,
) {
  return a3PostJson<A3ResourceFeedbackResponse>(`/api/resources/packs/${packId}/feedback/`, {
    action,
    resourceType,
    score,
  });
}

function recordResourceLearningEvent(
  pack: A3ResourcePackV2 | null,
  resource: A3ResourcePackV2Resource | null,
  config: ResourcePageConfig,
  action: 'opened' | 'completed' | 'skipped' | 'favorited',
  feedbackScore: number | null = 0,
) {
  if (!pack || !resource) return Promise.resolve({ success: false, error: 'missing resource' });
  const eventInput = {
    eventId: `resource_${pack.resourcePackId}_${resource.type}_${action}_${config.slug}`,
    sourcePage: `/a3/resources/${pack.resourcePackId}/${config.slug}`,
    targetType: 'resource_pack',
    targetId: pack.resourcePackId,
    resourceType: resource.type,
    durationSec: action === 'completed' ? resource.estimatedMinutes * 60 : 0,
    score: action === 'completed' && typeof feedbackScore === 'number' && feedbackScore > 0 ? feedbackScore : null,
    quality: action === 'completed' ? { completionRate: 1 } : {},
    metadata: {
      action,
      resourceTitle: resource.title,
      resourcePage: config.slug,
      generationMode: pack.generationMode ?? '',
      requestedResourceType: pack.requestedResourceType ?? '',
    },
    traceId: pack.traceId,
  };
  if (action === 'opened') return trackResourceOpen(eventInput);
  if (action === 'completed') return trackResourceComplete(eventInput);
  return trackLearningEvent({
    ...eventInput,
    eventType: action === 'favorited' ? 'resource_favorited' : 'resource_skipped',
  });
}

function feedbackSuccessText(action: 'completed' | 'skipped' | 'favorited') {
  if (action === 'completed') return '已记录完成学习，后续推荐会读取这条效果证据。';
  if (action === 'favorited') return '已记录有效资源偏好，推荐排序会提高同类资源权重。';
  return '已记录暂不学习，后续推荐会降低同类资源权重或进入探索。';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold text-slate-950">{value}</div>
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
  if (!latest) return { success: false, error: '暂无资源包，请先在资源生成入口生成。' };
  return { success: true, resourcePack: latest };
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

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : {}));
}

function safeText(value: unknown, fallback: string) {
  const text = typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
  if (!text || hasMojibake(text)) return fallback;
  return text;
}

function hasMojibake(text: string) {
  return ['�', '锛', '涓', '璧', '鎺', '鐢', '瑙', '鏁', '瀛', '€'].some((marker) => text.includes(marker));
}
