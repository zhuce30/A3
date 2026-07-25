'use client';

import { AlertTriangle, ArrowUpRight, Server } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminOverview } from '@/lib/a3/admin-api';
import type {
  A3AdminMetricKey,
  A3AdminOverview,
  A3AdminTaskCounts,
  A3AdminTaskStatus,
} from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';
import { AdminAccessGuard } from './admin-access-guard';
import { AdminTaskDonut, AdminTrendChart } from './admin-charts';
import {
  AdminDataStatusBadge,
  AdminEmptyState,
  AdminErrorState,
  AdminPageHeader,
  AdminSkeleton,
  AdminStatusBadge,
  formatAdminDateTime,
} from './admin-ui';

const metricOrder: Array<{ key: A3AdminMetricKey; label: string }> = [
  { key: 'users', label: '注册用户' },
  { key: 'newUsers', label: '周期新增' },
  { key: 'activeUsers', label: '活跃用户' },
  { key: 'coachingSessions', label: '辅导会话' },
  { key: 'resourcePacks', label: '成功资源包' },
  { key: 'agentFailureRate', label: 'Agent 失败率' },
];

const taskStatuses: A3AdminTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'stale', 'cancelled'];
const taskGroups: Array<{ key: 'resource' | 'video' | 'knowledge' | 'agent'; label: string }> = [
  { key: 'resource', label: '资源生成' },
  { key: 'video', label: '视频生成' },
  { key: 'knowledge', label: '知识索引' },
  { key: 'agent', label: 'Agent 运行' },
];

export function AdminOverviewView() {
  return (
    <AdminAccessGuard>
      <AdminOverviewContent />
    </AdminAccessGuard>
  );
}

function AdminOverviewContent() {
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('7d');
  const [data, setData] = useState<A3AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError('');
    try {
      const result = await getA3AdminOverview(range);
      if (result.success) setData(result);
      else setError(result.error || '运行数据加载失败');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refresh]);

  return (
    <div className="space-y-5" data-testid="a3-admin-overview">
      <AdminPageHeader
        title="运行总览"
        updatedAt={data?.generatedAt}
        refreshing={loading}
        onRefresh={() => void refresh()}
        actions={<RangeControl value={range} onChange={setRange} />}
      />

      {error && !data ? <AdminErrorState message={error} onRetry={() => void refresh()} /> : null}
      {loading && !data ? <AdminSkeleton rows={6} /> : null}
      {data ? (
        <>
          {error ? <AdminErrorState message={error} onRetry={() => void refresh()} /> : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-[#64736c]">{data.period.startDate} 至 {data.period.endDate} · {data.period.timeZone}</span>
            <AdminDataStatusBadge status={data.dataStatus} />
          </div>

          <section className="grid overflow-hidden rounded-md border border-[#d9d6c9] bg-[#d9d6c9] sm:grid-cols-2 xl:grid-cols-6" aria-label="核心指标">
            {metricOrder.map(({ key, label }) => {
              const metric = data.metrics[key];
              return (
                <div key={key} className="min-h-28 bg-[#fffdf7] p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-[#64736c]">{label}</span>
                    {metric ? <AdminDataStatusBadge status={metric.dataStatus} /> : null}
                  </div>
                  <div className="mt-3 text-2xl font-semibold tabular-nums text-[#143f32]">
                    {metric?.dataStatus === 'not_collected' ? '未采集' : formatMetric(key, metric?.value)}
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs leading-5 text-[#64736c]">{metric?.definition || '暂无口径信息'}</div>
                </div>
              );
            })}
          </section>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.75fr)]">
            <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7] py-4">
              <div className="flex items-center justify-between px-4">
                <h2 className="text-sm font-semibold text-[#143f32]">运行趋势</h2>
                <AdminDataStatusBadge status={data.trends.some((item) => item.dataStatus === 'partial') ? 'partial' : 'collected'} />
              </div>
              {data.trends.length ? <AdminTrendChart data={data.trends} className="mt-3" /> : <AdminEmptyState title="暂无趋势数据" />}
            </section>

            <section className="min-w-0 border-y border-[#d9d6c9] bg-[#fffdf7] py-4">
              <h2 className="px-4 text-sm font-semibold text-[#143f32]">任务分布</h2>
              <div className="grid items-center gap-2 sm:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)] xl:grid-cols-1 2xl:grid-cols-[minmax(180px,0.8fr)_minmax(180px,1fr)]">
                <AdminTaskDonut counts={data.taskTotals} className="max-h-[260px]" />
                <TaskCountList counts={data.taskTotals} />
              </div>
            </section>
          </div>

          <section className="min-w-0">
            <h2 className="mb-3 text-sm font-semibold text-[#143f32]">任务类型</h2>
            <div className="overflow-x-auto border-y border-[#d9d6c9] bg-[#fffdf7]">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-[#f0ede3] text-xs text-[#64736c]">
                  <tr><th className="px-3 py-2.5">类型</th>{taskStatuses.map((status) => <th key={status} className="px-3 py-2.5">{taskStatusLabel(status)}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[#e3dfd3]">
                  {taskGroups.map((group) => (
                    <tr key={group.key}>
                      <th className="px-3 py-3 font-medium text-[#244a3d]">{group.label}</th>
                      {taskStatuses.map((status) => <td key={status} className="px-3 py-3 tabular-nums text-[#40554c]">{data.tasks[group.key][status]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <ServiceSection data={data} />
            <AlertSection data={data} />
          </div>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-[#143f32]">近期动态</h2>
            {data.activity.length ? (
              <div className="divide-y divide-[#e3dfd3] border-y border-[#d9d6c9] bg-[#fffdf7]">
                {data.activity.map((item) => (
                  <div key={item.id} className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                    <span className="truncate font-medium text-[#244a3d]">{item.summary}</span>
                    <AdminStatusBadge status={item.status} />
                    <time className="text-xs text-[#64736c]" dateTime={item.createdAt}>{formatAdminDateTime(item.createdAt)}</time>
                  </div>
                ))}
              </div>
            ) : <AdminEmptyState title="暂无近期动态" />}
          </section>
        </>
      ) : null}
    </div>
  );
}

function RangeControl({ value, onChange }: { value: '24h' | '7d' | '30d'; onChange: (value: '24h' | '7d' | '30d') => void }) {
  return (
    <div className="flex h-9 items-center rounded-md border border-[#c8c3b4] bg-[#fffdf7] p-0.5" aria-label="时间范围">
      {(['24h', '7d', '30d'] as const).map((item) => (
        <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)} className={cn('h-7 rounded px-2.5 text-xs font-medium', value === item ? 'bg-[#143f32] text-[#fffdf7]' : 'text-[#52645d] hover:bg-[#f0ede3]')}>
          {item === '24h' ? '24 小时' : item === '7d' ? '7 天' : '30 天'}
        </button>
      ))}
    </div>
  );
}

function TaskCountList({ counts }: { counts: A3AdminTaskCounts }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 pb-3 xl:grid-cols-3 2xl:grid-cols-2">
      {taskStatuses.map((status) => (
        <div key={status} className="flex items-center justify-between gap-3 border-b border-[#ebe7db] py-1.5 text-xs">
          <span className="text-[#64736c]">{taskStatusLabel(status)}</span>
          <strong className="tabular-nums text-[#244a3d]">{counts[status]}</strong>
        </div>
      ))}
    </div>
  );
}

function ServiceSection({ data }: { data: A3AdminOverview }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2"><Server className="size-4 text-[#9b7b2f]" /><h2 className="text-sm font-semibold text-[#143f32]">服务状态</h2></div>
      <div className="divide-y divide-[#e3dfd3] border-y border-[#d9d6c9] bg-[#fffdf7]">
        {data.services.map((service) => (
          <div key={service.key} className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0"><div className="truncate text-sm font-medium text-[#244a3d]">{service.name}</div><div className="mt-1 truncate text-xs text-[#64736c]">{service.message}</div></div>
            <div className="flex items-center gap-2"><AdminDataStatusBadge status={service.dataStatus} /><AdminStatusBadge status={service.status} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AlertSection({ data }: { data: A3AdminOverview }) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2"><AlertTriangle className="size-4 text-[#b85c46]" /><h2 className="text-sm font-semibold text-[#143f32]">待处理告警</h2></div>
      {data.alerts.length ? (
        <div className="divide-y divide-[#e3dfd3] border-y border-[#d9d6c9] bg-[#fffdf7]">
          {data.alerts.slice(0, 8).map((alert) => (
            <div key={alert.id} className="flex items-center gap-3 px-3 py-3">
              <span className={cn('size-2 rounded-full', alert.severity === 'error' ? 'bg-[#b85c46]' : alert.severity === 'warning' ? 'bg-[#c99532]' : 'bg-[#6f8d78]')} />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-[#244a3d]">{alert.title}</div><div className="mt-1 truncate text-xs text-[#64736c]">{alert.summary}</div></div>
              <span className="tabular-nums text-sm font-semibold text-[#143f32]">{alert.count}</span>
              <ArrowUpRight className="size-4 text-[#9b7b2f]" aria-hidden="true" />
            </div>
          ))}
        </div>
      ) : <AdminEmptyState title="当前没有待处理告警" />}
    </section>
  );
}

function formatMetric(key: A3AdminMetricKey, value: number | null | undefined) {
  if (value === null || value === undefined) return '未采集';
  return key === 'agentFailureRate' ? `${value}%` : value.toLocaleString('zh-CN');
}

function taskStatusLabel(status: A3AdminTaskStatus) {
  return ({ queued: '排队', running: '运行', succeeded: '成功', failed: '失败', stale: '停滞', cancelled: '取消' } as const)[status];
}
