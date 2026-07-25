'use client';

import { Eye, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminAgentRun, getA3AdminAgentRuns } from '@/lib/a3/admin-api';
import type { A3AdminAgentMetadata, A3AdminAgentRun, A3AdminAgentRunDetail, A3AdminPagination as PaginationValue } from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import { AdminDetailDrawer, AdminEmptyState, AdminErrorState, AdminFilterBar, AdminPageHeader, AdminPagination, AdminSkeleton, AdminStatusBadge, AdminTable, formatAdminDateTime } from './admin-ui';

export function AdminAgentsView() { return <AdminAccessGuard><AdminAgentsContent /></AdminAccessGuard>; }

function AdminAgentsContent() {
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<A3AdminAgentRun[]>([]);
  const [pagination, setPagination] = useState<PaginationValue>({ page: 1, pageSize: 20, total: 0 });
  const [run, setRun] = useState<A3AdminAgentRunDetail | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await getA3AdminAgentRuns({ search: submittedSearch, status, workflow, page, pageSize: 20 });
      if (result.success) { setItems(result.items); setPagination(result.pagination); }
      else setError(result.error || 'Agent 运行记录加载失败');
    } finally { setLoading(false); inFlight.current = false; }
  }, [page, status, submittedSearch, workflow]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  async function openDetail(item: A3AdminAgentRun) {
    setDetailError('');
    const result = await getA3AdminAgentRun(item.traceId);
    if (result.success && result.run) setRun(result.run);
    else setDetailError(result.error || 'Agent 运行详情加载失败');
  }

  return <div className="space-y-5" data-testid="a3-admin-agents">
    <AdminPageHeader title="Agent 运行" refreshing={loading} onRefresh={() => void load()} />
    <AdminFilterBar><form className="flex min-w-[260px] flex-1 items-end gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}><label className="min-w-0 flex-1"><span className="mb-1 block text-xs text-[#64736c]">搜索</span><span className="relative block"><Search className="absolute left-3 top-2.5 size-4 text-[#7c8983]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="traceId、目标或工作流" className="h-9 w-full rounded-md border border-[#c8c3b4] bg-white pl-9 pr-3 text-sm" /></span></label><button type="submit" className="h-9 rounded-md bg-[#143f32] px-3 text-sm font-semibold text-[#fffdf7]">查询</button></form><SelectField label="状态" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[['', '全部状态'], ['running', '运行中'], ['succeeded', '成功'], ['failed', '失败'], ['degraded', '降级']]} /><label><span className="mb-1 block text-xs text-[#64736c]">工作流</span><input value={workflow} onChange={(event) => { setWorkflow(event.target.value); setPage(1); }} placeholder="全部" className="h-9 w-36 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm" /></label></AdminFilterBar>
    {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}{loading && !items.length ? <AdminSkeleton rows={7} /> : null}{!loading && !error && !items.length ? <AdminEmptyState title="没有 Agent 运行记录" /> : null}
    {items.length ? <><AdminTable><thead className="bg-[#f0ede3] text-xs text-[#64736c]"><tr><Th>Trace / 用户</Th><Th>工作流</Th><Th>状态</Th><Th>步骤 / Span</Th><Th>耗时</Th><Th>开始时间</Th><Th>详情</Th></tr></thead><tbody className="divide-y divide-[#e3dfd3]">{items.map((item) => <tr key={item.traceId} className="hover:bg-[#faf5df]"><Td><code className="block max-w-52 truncate text-xs text-[#244a3d]">{item.traceId}</code><span className="mt-1 block text-xs text-[#64736c]">{item.user.displayName}</span></Td><Td>{item.workflow || '未分类'}</Td><Td><AdminStatusBadge status={item.status} /></Td><Td><span className="tabular-nums">{item.stepCount} / {item.spanCount}</span></Td><Td><span className="tabular-nums">{formatDuration(item.latencyMs)}</span></Td><Td>{formatAdminDateTime(item.startedAt)}</Td><Td><button type="button" aria-label={`查看 Agent ${item.traceId}`} onClick={() => void openDetail(item)} className="flex size-8 items-center justify-center rounded-md text-[#1f6b53] hover:bg-[#e9f0eb]"><Eye className="size-4" /></button></Td></tr>)}</tbody></AdminTable><AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} /></> : null}
    {detailError && !run ? <AdminErrorState message={detailError} /> : null}
    <AdminDetailDrawer open={Boolean(run)} title="Agent 执行轨迹" onClose={() => setRun(null)}>{run ? <RunDetail run={run} /> : null}</AdminDetailDrawer>
  </div>;
}

function RunDetail({ run }: { run: A3AdminAgentRunDetail }) { return <div className="space-y-6"><div className="flex items-start justify-between gap-3 border-b border-[#d9d6c9] pb-4"><div className="min-w-0"><code className="block truncate text-sm font-semibold text-[#143f32]">{run.traceId}</code><p className="mt-1 text-xs text-[#64736c]">{run.workflow} · {run.user.displayName}</p></div><AdminStatusBadge status={run.status} /></div><Metadata value={run.metadata} /><section><h3 className="mb-3 text-sm font-semibold text-[#143f32]">执行步骤</h3><div className="border-l border-[#cbb66d] pl-4">{run.steps.map((step) => <div key={`${step.order}-${step.name}`} className="relative border-b border-[#ebe7db] py-3 before:absolute before:-left-[20px] before:top-5 before:size-2 before:rounded-full before:bg-[#9b7b2f]"><div className="flex items-center justify-between gap-3"><div className="font-medium text-[#244a3d]">{step.order}. {step.name}</div><AdminStatusBadge status={step.status} /></div><div className="mt-1 text-xs text-[#64736c]">{step.role} · {formatDuration(step.latencyMs)}</div><Metadata value={step.metadata} compact /></div>)}</div>{run.stepsTruncated ? <p className="mt-2 text-xs text-amber-700">步骤过多，当前仅展示受限结果。</p> : null}</section><section><h3 className="mb-3 text-sm font-semibold text-[#143f32]">调用 Span</h3><div className="divide-y divide-[#ebe7db] border-y border-[#d9d6c9]">{run.spans.map((span) => <div key={span.id} className="py-3"><div className="flex items-center justify-between gap-3"><div className="font-medium text-[#244a3d]">{span.name}</div><AdminStatusBadge status={span.status} /></div><div className="mt-1 text-xs text-[#64736c]">{span.kind} · {span.parentStep || '无父步骤'} · {formatDuration(span.latencyMs)}</div><Metadata value={span.metadata} compact /></div>)}</div>{run.spansTruncated ? <p className="mt-2 text-xs text-amber-700">Span 过多，当前仅展示受限结果。</p> : null}</section></div>; }
function Metadata({ value, compact = false }: { value: A3AdminAgentMetadata; compact?: boolean }) { const entries = Object.entries(value || {}); if (!entries.length) return null; return <dl className={compact ? 'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs' : 'grid gap-2 border-y border-[#e3dfd3] py-3 text-sm sm:grid-cols-2'}>{entries.map(([key, item]) => <div key={key} className="min-w-0"><dt className="inline text-[#64736c]">{key}: </dt><dd className="inline break-all text-[#244a3d]">{typeof item === 'object' ? JSON.stringify(item) : String(item)}</dd></div>)}</dl>; }
function formatDuration(value: number | null | undefined) { if (value === null || value === undefined) return '—'; return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`; }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) { return <label><span className="mb-1 block text-xs text-[#64736c]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-32 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm">{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-3 text-[#40554c]">{children}</td>; }
