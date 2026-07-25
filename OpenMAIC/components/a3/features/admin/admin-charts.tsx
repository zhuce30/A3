'use client';

import { LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';
import type { A3AdminOverview, A3AdminTaskCounts } from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';

echarts.use([LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);

type AdminChartProps = { className?: string };

export function AdminTrendChart({
  data,
  className,
}: AdminChartProps & { data: A3AdminOverview['trends'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useAdminChart(ref, {
    animationDuration: 260,
    color: ['#1f6b53', '#aa7d22', '#b85c46', '#64736c'],
    tooltip: { trigger: 'axis', backgroundColor: '#fffdf7', borderColor: '#d9d6c9', textStyle: { color: '#183229' } },
    legend: { bottom: 0, textStyle: { color: '#64736c', fontSize: 11 } },
    grid: { left: 38, right: 18, top: 18, bottom: 48, containLabel: false },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: data.map((item) => item.label),
      axisLine: { lineStyle: { color: '#d9d6c9' } },
      axisLabel: { color: '#64736c', hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#64736c' },
      splitLine: { lineStyle: { color: '#ebe7db' } },
    },
    series: [
      trendSeries('活跃用户', data.map((item) => item.activeUsers)),
      trendSeries('辅导会话', data.map((item) => item.coachingSessions)),
      trendSeries('资源包', data.map((item) => item.resourcePacks)),
      trendSeries('Agent', data.map((item) => item.agentRuns)),
    ],
  });
  return <div ref={ref} className={cn('aspect-[16/7] min-h-[260px] w-full', className)} aria-label="学习与运行趋势图" role="img" />;
}

export function AdminTaskDonut({
  counts,
  className,
}: AdminChartProps & { counts: A3AdminTaskCounts }) {
  const ref = useRef<HTMLDivElement>(null);
  const labels: Record<keyof A3AdminTaskCounts, string> = {
    queued: '排队',
    running: '运行',
    succeeded: '成功',
    failed: '失败',
    cancelled: '取消',
    stale: '停滞',
  };
  useAdminChart(ref, {
    animationDuration: 260,
    color: ['#aa7d22', '#1f6b53', '#6f8d78', '#b85c46', '#9c9a91', '#d39b45'],
    tooltip: { trigger: 'item', backgroundColor: '#fffdf7', borderColor: '#d9d6c9', textStyle: { color: '#183229' } },
    series: [
      {
        type: 'pie',
        radius: ['58%', '78%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        emphasis: { label: { show: false } },
        data: Object.entries(counts).map(([status, value]) => ({
          name: labels[status as keyof A3AdminTaskCounts],
          value,
        })),
      },
    ],
  });
  return <div ref={ref} className={cn('aspect-square min-h-[220px] w-full', className)} aria-label="任务状态分布图" role="img" />;
}

function trendSeries(name: string, data: number[]) {
  return {
    name,
    type: 'line' as const,
    data,
    smooth: 0.22,
    symbol: 'circle',
    symbolSize: 5,
    lineStyle: { width: 2 },
    areaStyle: { opacity: 0.04 },
  };
}

function useAdminChart(
  ref: React.RefObject<HTMLDivElement | null>,
  option: echarts.EChartsCoreOption,
) {
  const chartRef = useRef<echarts.EChartsType | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const chart = echarts.init(element, undefined, { renderer: 'svg' });
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [ref]);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);
}
