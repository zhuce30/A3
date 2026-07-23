'use client';

import { Activity, AlertTriangle, Database, RefreshCw, Server, Users } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { getA3AdminOverview } from '@/lib/a3/admin-api';
import type { A3AdminOverview, A3AdminServiceStatus } from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';
import { AdminAccessGuard } from './admin-access-guard';

const metricLabels: Record<string, string> = {
  users: '注册用户',
  activeUsers24h: '24 小时活跃',
  coachingSessions24h: '辅导会话',
  learningEvents24h: '学习事件',
  resourcePacks24h: '资源包',
  agentRuns24h: 'Agent 运行',
};

export function AdminOverviewView() {
  return (
    <AdminAccessGuard>
      <AdminOverviewContent />
    </AdminAccessGuard>
  );
}

function AdminOverviewContent() {
  const [data, setData] = useState<A3AdminOverview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setError('');
    const result = await getA3AdminOverview();
    if (result.success) setData(result);
    else setError(result.error || '运行数据加载失败');
    setLoading(false);
    inFlight.current = false;
  }, []);

  useEffect(() => {
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
    <div className="space-y-7" data-testid="a3-admin-overview">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--a3-border)] pb-5">
        <div>
          <p className="text-sm font-medium text-emerald-700">系统管理</p>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--a3-text)]">运行总览</h1>
          <p className="mt-2 text-sm text-[var(--a3-text-muted)]">账号、学习活动、任务和服务探针的真实运行状态。</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          刷新
        </Button>
      </header>

      {error ? <div className="border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      {loading && !data ? <div className="py-16 text-center text-sm text-[var(--a3-text-muted)]">正在读取运行数据...</div> : null}
      {data ? (
        <>
          <section className="grid gap-px overflow-hidden rounded-lg border border-[var(--a3-border)] bg-[var(--a3-border)] sm:grid-cols-2 xl:grid-cols-6">
            {Object.entries(data.metrics).map(([key, metric]) => (
              <div key={key} className="min-h-28 bg-[var(--a3-surface-solid)] p-4">
                <div className="text-xs text-[var(--a3-text-muted)]">{metricLabels[key] || key}</div>
                <div className="mt-3 text-2xl font-semibold text-[var(--a3-text)]">{metric.dataStatus === 'not_collected' ? '未采集' : metric.value ?? '未采集'}</div>
                <div className="mt-2 line-clamp-2 text-xs leading-5 text-[var(--a3-text-muted)]">{metric.definition}</div>
              </div>
            ))}
          </section>

          <div className="grid gap-7 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
            <section>
              <div className="mb-3 flex items-center gap-2"><Server className="size-5 text-emerald-700" /><h2 className="font-semibold">服务状态</h2></div>
              <div className="divide-y divide-[var(--a3-border)] border-y border-[var(--a3-border)]">
                {data.services.map((service) => (
                  <div key={service.key} className="flex items-center gap-3 py-3">
                    <span className={cn('size-2.5 rounded-full', statusColor(service.status))} />
                    <div className="min-w-0 flex-1"><div className="text-sm font-medium">{service.name}</div><div className="truncate text-xs text-[var(--a3-text-muted)]">{service.message}</div></div>
                    <span className="text-xs text-[var(--a3-text-muted)]">{statusLabel(service.status)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center gap-2"><Activity className="size-5 text-emerald-700" /><h2 className="font-semibold">任务分布</h2></div>
              <div className="space-y-4 border-y border-[var(--a3-border)] py-4">
                {Object.entries(data.tasks).map(([name, counts]) => (
                  <div key={name}>
                    <div className="flex justify-between text-sm font-medium"><span>{taskLabel(name)}</span><span>{Object.values(counts).reduce((sum, value) => sum + value, 0)}</span></div>
                    <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs text-[var(--a3-text-muted)]">
                      <span>排队 {counts.queued}</span><span>运行 {counts.running}</span><span>成功 {counts.succeeded}</span><span>失败 {counts.failed}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
                <Summary icon={Database} label="知识资源" value={data.knowledgeBase.resources} />
                <Summary icon={AlertTriangle} label="索引失败" value={data.knowledgeBase.failedJobs} />
                <Summary icon={Users} label="安全事件" value={data.security.events24h} />
              </div>
            </section>
          </div>
          <p className="text-right text-xs text-[var(--a3-text-muted)]">更新时间：{new Date(data.generatedAt).toLocaleString('zh-CN')}</p>
        </>
      ) : null}
    </div>
  );
}

function Summary({ icon: Icon, label, value }: { icon: typeof Users; label: string; value: number }) {
  return <div className="border-l-2 border-amber-300 pl-3"><Icon className="size-4 text-amber-700" /><div className="mt-2 text-xl font-semibold">{value}</div><div className="text-xs text-[var(--a3-text-muted)]">{label}</div></div>;
}

function statusColor(status: A3AdminServiceStatus) {
  return status === 'healthy' ? 'bg-emerald-500' : status === 'degraded' ? 'bg-amber-500' : status === 'down' ? 'bg-rose-500' : 'bg-slate-400';
}
function statusLabel(status: A3AdminServiceStatus) {
  return ({ healthy: '正常', degraded: '降级', down: '不可用', configured: '已配置', unknown: '未知' } as const)[status];
}
function taskLabel(name: string) {
  return ({ resource: '资源生成', video: '视频生成', knowledge: '知识库索引' } as Record<string, string>)[name] || name;
}
