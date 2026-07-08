'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { a3GetJson, resolveA3Endpoint } from '@/lib/a3/api-client';
import type { A3ApiResponse } from '@/lib/a3/learning-types';
import { A3Card, A3Pill } from '../ui/a3-card';

type ParseAsset = {
  id: string;
  kind: string;
  mimeType: string;
  width: number;
  height: number;
  previewUrl: string;
};

type ParsePage = {
  id: string;
  pageNumber: number | null;
  slideNumber: number | null;
  summary: string;
  qualityScore: number;
  warnings: string[];
  assets: ParseAsset[];
  assetCount: number;
  blockCount: number;
};

type ParseBlock = {
  id: string;
  pageId: string | null;
  previewUrl: string;
  modality: string;
  text: string;
  confidence: number;
  warnings: string[];
  metadata: Record<string, unknown>;
};

type ParseDetail = {
  resource: { id: string; name: string; type: string; status: string };
  multimodal: {
    parseStatus: string;
    parser: string;
    pages: number;
    textBlocks: number;
    imageBlocks: number;
    tableBlocks: number;
    formulaBlocks: number;
    pageImageBlocks: number;
    qualityScore: number;
    warnings: string[];
  };
  pages: ParsePage[];
  blocks: ParseBlock[];
};

export function CourseMaterialPreviewView({ resourceId }: { resourceId: string }) {
  const [detail, setDetail] = useState<ParseDetail | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      setError('');
      const result = await a3GetJson<A3ApiResponse<ParseDetail>>(`/api/kb/resources/${resourceId}/parse/`);
      if (!active) return;
      if (result.success) {
        setDetail(result);
        setActiveIndex(0);
      } else {
        setError(result.error || '课件预览加载失败');
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [resourceId]);

  const slides = useMemo(() => buildSlides(detail), [detail]);
  const activeSlide = slides[activeIndex] ?? null;
  const downloadUrl = `/api/kb/resources/${resourceId}/download/`;
  const inlineUrl = `${downloadUrl}?disposition=inline`;

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center text-slate-500">
        <Loader2 className="mr-2 size-5 animate-spin" />
        正在打开课件预览
      </div>
    );
  }

  if (error || !detail) {
    return (
      <A3Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <A3Pill tone="orange">无法预览</A3Pill>
            <h1 className="mt-3 text-xl font-semibold text-slate-950">课件暂时打不开</h1>
            <p className="mt-2 text-sm text-slate-500">{error || '没有读取到课件解析结果。'}</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/a3/courses">
              <ArrowLeft className="mr-2 size-4" />
              返回课程
            </Link>
          </Button>
        </div>
      </A3Card>
    );
  }

  const hasSlides = slides.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Button asChild size="sm" variant="ghost">
              <Link href="/a3/courses">
                <ArrowLeft className="mr-2 size-4" />
                课程
              </Link>
            </Button>
            <A3Pill tone={hasSlides ? 'green' : 'slate'}>{hasSlides ? `${slides.length} 页` : '待解析'}</A3Pill>
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-normal text-slate-950">{detail.resource.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {detail.resource.type} · {statusText(detail.resource.status)} · {detail.multimodal.textBlocks} 个文本块
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a href={resolveA3Endpoint(inlineUrl)} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 size-4" />
              原文件
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={resolveA3Endpoint(downloadUrl)} target="_blank" rel="noreferrer">
              <Download className="mr-2 size-4" />
              下载
            </a>
          </Button>
        </div>
      </div>

      {hasSlides ? (
        <div className="grid gap-5 xl:grid-cols-[220px_1fr_320px]">
          <A3Card title="页码">
            <div className="space-y-2">
              {slides.map((slide, index) => (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    index === activeIndex ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-700 hover:bg-blue-50 hover:text-blue-800'
                  }`}
                >
                  <span>第 {slide.number} 页</span>
                  <span className="text-xs opacity-80">{slide.hasImage ? '预览' : '文本'}</span>
                </button>
              ))}
            </div>
          </A3Card>

          <section className="rounded-xl border border-slate-200 bg-slate-100 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <Button size="sm" variant="outline" onClick={() => setActiveIndex(Math.max(0, activeIndex - 1))} disabled={activeIndex === 0}>
                <ChevronLeft className="mr-1 size-4" />
                上一页
              </Button>
              <div className="text-sm font-medium text-slate-600">
                {activeIndex + 1} / {slides.length}
              </div>
              <Button size="sm" variant="outline" onClick={() => setActiveIndex(Math.min(slides.length - 1, activeIndex + 1))} disabled={activeIndex >= slides.length - 1}>
                下一页
                <ChevronRight className="ml-1 size-4" />
              </Button>
            </div>
            <div className="flex min-h-[520px] items-center justify-center rounded-lg bg-slate-950/5 p-3">
              {activeSlide?.previewUrl ? (
                <img
                  src={resolveA3Endpoint(activeSlide.previewUrl)}
                  alt={`第 ${activeSlide.number} 页`}
                  className="max-h-[72vh] w-full rounded-md object-contain shadow-sm"
                />
              ) : (
                <div className="max-w-2xl rounded-lg border border-slate-200 bg-white p-6">
                  <FileText className="size-8 text-blue-600" />
                  <div className="mt-4 whitespace-pre-wrap text-sm leading-7 text-slate-700">{activeSlide?.text || activeSlide?.summary || '这一页没有可展示的预览图。'}</div>
                </div>
              )}
            </div>
          </section>

          <A3Card title="本页内容">
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold text-slate-500">摘要</div>
                <p className="mt-2 text-sm leading-6 text-slate-700">{activeSlide?.summary || '暂无摘要'}</p>
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-500">可检索文本</div>
                <p className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                  {activeSlide?.text || '暂无文本块'}
                </p>
              </div>
              {!!activeSlide?.warnings.length && (
                <div className="rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                  {activeSlide.warnings.join('；')}
                </div>
              )}
            </div>
          </A3Card>
        </div>
      ) : (
        <A3Card>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <A3Pill tone="orange">还没有课件画面</A3Pill>
              <h2 className="mt-3 text-xl font-semibold text-slate-950">这份 PPTX 还未完成多模态解析</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                课件已保存到系统，但还没有生成可预览的幻灯片图片。可以先打开原文件；解析完成后，这里会自动显示幻灯片画面。
              </p>
              {!!detail.multimodal.warnings.length && (
                <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                  {detail.multimodal.warnings.slice(0, 3).join('；')}
                </div>
              )}
            </div>
            <Button asChild variant="outline">
              <Link href="/a3/knowledge-base">
                <RefreshCw className="mr-2 size-4" />
                查看知识库状态
              </Link>
            </Button>
          </div>
        </A3Card>
      )}
    </div>
  );
}

function buildSlides(detail: ParseDetail | null) {
  if (!detail) return [];
  return detail.pages.map((page, index) => {
    const blocks = detail.blocks.filter((block) => block.pageId === page.id);
    const imageAsset = page.assets.find((asset) => asset.kind === 'rendered_slide') ?? page.assets[0];
    const imageBlock = blocks.find((block) => block.previewUrl);
    return {
      id: page.id,
      number: page.slideNumber ?? page.pageNumber ?? index + 1,
      summary: page.summary,
      previewUrl: imageAsset?.previewUrl || imageBlock?.previewUrl || '',
      hasImage: Boolean(imageAsset?.previewUrl || imageBlock?.previewUrl),
      text: blocks
        .filter((block) => block.modality !== 'slide_image' && block.modality !== 'page_image')
        .map((block) => block.text)
        .filter(Boolean)
        .join('\n\n'),
      warnings: [...page.warnings, ...blocks.flatMap((block) => block.warnings)].filter(Boolean),
    };
  });
}

function statusText(status: string) {
  return {
    uploaded: '待解析',
    indexing: '解析中',
    indexed: '已进入检索',
    indexed_with_warnings: '已进入检索，有警告',
    failed: '解析失败',
  }[status] ?? status;
}
