'use client';

import { CheckCircle2, CircleDashed, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminConfiguration, verifyA3AdminConfiguration } from '@/lib/a3/admin-api';
import type { A3AdminConfigurationCheck } from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import { AdminEmptyState, AdminErrorState, AdminPageHeader, AdminReasonDialog, AdminSkeleton, AdminStatusBadge, formatAdminDateTime } from './admin-ui';

const groups = [
  { key: 'runtime', label: '运行环境' },
  { key: 'providers', label: '模型与实时服务' },
  { key: 'notifications', label: '通知服务' },
  { key: 'storage', label: '存储与索引' },
] as const;

export function AdminSettingsView() { return <AdminAccessGuard><AdminSettingsContent /></AdminAccessGuard>; }

function AdminSettingsContent() {
  const [items, setItems] = useState<A3AdminConfigurationCheck[]>([]); const [generatedAt, setGeneratedAt] = useState<string | null>(null); const [selected, setSelected] = useState<A3AdminConfigurationCheck | null>(null);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [actionPending, setActionPending] = useState(false); const inFlight = useRef(false);
  const load = useCallback(async () => { if (inFlight.current) return; inFlight.current = true; setLoading(true); setError(''); try { const result = await getA3AdminConfiguration(); if (result.success) { setItems(result.items); setGeneratedAt(result.generatedAt); } else setError(result.error || '配置状态加载失败'); } finally { setLoading(false); inFlight.current = false; } }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  async function verify(reason: string) { if (!selected) return; setActionPending(true); setError(''); try { const result = await verifyA3AdminConfiguration(selected.check, reason); if (!result.success || !result.item) { setError(result.error || '配置验证失败'); return; } setItems((current) => current.map((item) => item.check === result.item?.check ? result.item : item)); setSelected(null); } finally { setActionPending(false); } }
  return <div className="space-y-5" data-testid="a3-admin-settings"><AdminPageHeader title="系统配置" updatedAt={generatedAt} refreshing={loading} onRefresh={() => void load()} />{error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}{loading && !items.length ? <AdminSkeleton rows={8} /> : null}{!loading && !error && !items.length ? <AdminEmptyState title="没有可检查的配置项" /> : null}{items.length ? <div className="space-y-7">{groups.map((group) => { const groupItems = items.filter((item) => item.group === group.key); if (!groupItems.length) return null; return <section key={group.key}><h2 className="mb-3 text-sm font-semibold text-[#143f32]">{group.label}</h2><div className="divide-y divide-[#e3dfd3] border-y border-[#d9d6c9] bg-[#fffdf7]">{groupItems.map((item) => <ConfigurationRow key={item.check} item={item} onVerify={() => setSelected(item)} />)}</div></section>; })}</div> : null}<AdminReasonDialog open={Boolean(selected)} title={selected ? `验证${selected.label}` : '验证配置'} actionLabel="开始验证" pending={actionPending} onClose={() => setSelected(null)} onConfirm={verify} /></div>;
}
function ConfigurationRow({ item, onVerify }: { item: A3AdminConfigurationCheck; onVerify: () => void }) { const label = configurationStatusLabel(item); return <div className="grid gap-3 px-3 py-4 md:grid-cols-[minmax(170px,0.7fr)_minmax(260px,1.3fr)_auto_auto] md:items-center"><div className="flex items-center gap-3">{statusIcon(item)}<div><div className="font-medium text-[#244a3d]">{item.label}</div><code className="mt-1 block text-xs text-[#7c8983]">{item.check}</code></div></div><div className="min-w-0"><p className="text-sm text-[#40554c]">{item.message}</p><Evidence evidence={item.evidence} /><p className="mt-1 text-xs text-[#7c8983]">最近验证：{formatAdminDateTime(item.lastVerifiedAt)}</p></div><AdminStatusBadge status={item.status} label={label} /><button type="button" onClick={onVerify} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-[#c8c3b4] px-3 text-sm font-medium text-[#244a3d] hover:bg-[#f0ede3]"><RefreshCw className="size-4" />验证连接</button></div>; }
function configurationStatusLabel(item: A3AdminConfigurationCheck) { if (!item.configured || item.status === 'not_configured') return '未配置'; if (item.status === 'not_monitored' || (item.status === 'configured' && !item.lastVerifiedAt)) return '已配置 · 未监控'; if (['error', 'down', 'degraded'].includes(item.status)) return '异常'; return '已验证'; }
function statusIcon(item: A3AdminConfigurationCheck) { const label = configurationStatusLabel(item); if (label === '已验证') return <CheckCircle2 className="size-5 shrink-0 text-emerald-700" />; if (label === '异常') return <ShieldAlert className="size-5 shrink-0 text-rose-700" />; return <CircleDashed className="size-5 shrink-0 text-[#9b7b2f]" />; }
function Evidence({ evidence }: { evidence: A3AdminConfigurationCheck['evidence'] }) { const entries = Object.entries(evidence || {}); if (!entries.length) return null; return <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#64736c]">{entries.map(([key, value]) => <span key={key}>{evidenceLabel(key)}: {typeof value === 'boolean' ? value ? '是' : '否' : String(value)}</span>)}</div>; }
function evidenceLabel(key: string) { return ({ reachable: '可连接', remoteConnectionTested: '已测远程连接', workerCount: 'Worker 数', scheduleConfigured: '定时任务', configured: '配置存在', messageSent: '已发测试消息', paidCallPerformed: '已执行付费调用', available: '可用', absolutePathReturned: '暴露绝对路径', remoteCallPerformed: '已执行远程调用' } as Record<string, string>)[key] || key; }
