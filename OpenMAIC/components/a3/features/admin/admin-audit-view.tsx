'use client';

import { Eye, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminAuditLogs } from '@/lib/a3/admin-api';
import type {
  A3AdminAuditLog,
  A3AdminPagination as PaginationValue,
  A3JsonObject,
} from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import {
  AdminDetailDrawer,
  AdminEmptyState,
  AdminErrorState,
  AdminFilterBar,
  AdminPageHeader,
  AdminPagination,
  AdminSkeleton,
  AdminStatusBadge,
  AdminTable,
  formatAdminDateTime,
} from './admin-ui';

export function AdminAuditView() {
  return (
    <AdminAccessGuard>
      <AdminAuditContent />
    </AdminAccessGuard>
  );
}

function AdminAuditContent() {
  const [actionQuery, setActionQuery] = useState('');
  const [submittedAction, setSubmittedAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actorId, setActorId] = useState('');
  const [success, setSuccess] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<A3AdminAuditLog[]>([]);
  const [pagination, setPagination] = useState<PaginationValue>({ page: 1, pageSize: 20, total: 0 });
  const [selected, setSelected] = useState<A3AdminAuditLog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const result = await getA3AdminAuditLogs({
        action: submittedAction,
        targetType,
        actorId,
        success: success ? success === 'true' : undefined,
        page,
        pageSize: 20,
      });
      if (result.success) {
        setItems(result.items);
        setPagination(result.pagination);
      } else {
        setError(result.error || '审计日志加载失败');
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [actorId, page, submittedAction, success, targetType]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-5" data-testid="a3-admin-audit">
      <AdminPageHeader title="审计日志" refreshing={loading} onRefresh={() => void load()} />

      <AdminFilterBar>
        <form
          className="flex min-w-[240px] flex-1 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setSubmittedAction(actionQuery.trim());
          }}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs text-[#64736c]">操作名称</span>
            <span className="relative block">
              <Search className="absolute left-3 top-2.5 size-4 text-[#7c8983]" aria-hidden="true" />
              <input
                value={actionQuery}
                onChange={(event) => setActionQuery(event.target.value)}
                placeholder="例如 user.status"
                className="h-9 w-full rounded-md border border-[#c8c3b4] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#9b7b2f]"
              />
            </span>
          </label>
          <button type="submit" className="h-9 rounded-md bg-[#143f32] px-3 text-sm font-semibold text-[#fffdf7] hover:bg-[#1d5543]">查询</button>
        </form>
        <AuditSelect label="目标类型" value={targetType} onChange={(value) => { setTargetType(value); setPage(1); }} options={TARGET_OPTIONS} />
        <AuditSelect label="结果" value={success} onChange={(value) => { setSuccess(value); setPage(1); }} options={[['', '全部结果'], ['true', '成功'], ['false', '失败']]} />
        <label>
          <span className="mb-1 block text-xs text-[#64736c]">管理员编号</span>
          <input
            inputMode="numeric"
            value={actorId}
            onChange={(event) => { setActorId(event.target.value.replace(/\D/g, '')); setPage(1); }}
            placeholder="全部"
            className="h-9 w-28 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm outline-none focus:border-[#9b7b2f]"
          />
        </label>
      </AdminFilterBar>

      {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}
      {loading && !items.length ? <AdminSkeleton rows={8} /> : null}
      {!loading && !error && !items.length ? <AdminEmptyState title="没有符合条件的审计记录" /> : null}

      {items.length ? (
        <>
          <AdminTable>
            <thead className="bg-[#f0ede3] text-xs text-[#64736c]">
              <tr><Th>时间</Th><Th>管理员</Th><Th>操作</Th><Th>目标</Th><Th>原因</Th><Th>结果</Th><Th>详情</Th></tr>
            </thead>
            <tbody className="divide-y divide-[#e3dfd3]">
              {items.map((item) => (
                <tr key={item.id} className="bg-[#fffdf7] hover:bg-[#faf5df]">
                  <Td><time dateTime={item.createdAt} className="whitespace-nowrap">{formatAdminDateTime(item.createdAt)}</time></Td>
                  <Td><div className="font-medium text-[#244a3d]">{item.actor?.displayName || '系统'}</div><div className="mt-1 text-xs text-[#64736c]">{item.actorIp || '未记录 IP'}</div></Td>
                  <Td><code className="break-all text-xs text-[#244a3d]">{item.action}</code></Td>
                  <Td><div>{item.targetType || '未分类'}</div><div className="mt-1 max-w-40 truncate text-xs text-[#64736c]">{item.targetUser?.displayName || item.targetId || '—'}</div></Td>
                  <Td><span className="line-clamp-2 max-w-56 text-[#40554c]">{item.reason || item.summary || '未填写'}</span></Td>
                  <Td><AdminStatusBadge status={item.success ? 'succeeded' : 'failed'} label={item.success ? '成功' : '失败'} /></Td>
                  <Td><button type="button" aria-label={`查看审计记录 ${item.id}`} onClick={() => setSelected(item)} className="flex size-8 items-center justify-center rounded-md text-[#1f6b53] hover:bg-[#e9f0eb]"><Eye className="size-4" aria-hidden="true" /></button></Td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          <AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} />
        </>
      ) : null}

      <AdminDetailDrawer open={Boolean(selected)} title="审计详情" onClose={() => setSelected(null)}>
        {selected ? <AuditDetail item={selected} /> : null}
      </AdminDetailDrawer>
    </div>
  );
}

const TARGET_OPTIONS: Array<[string, string]> = [
  ['', '全部目标'],
  ['user', '用户'],
  ['conversation', '对话'],
  ['course', '课程'],
  ['resource', '资料'],
  ['task', '任务'],
  ['security_event', '安全事件'],
  ['configuration', '系统配置'],
];

function AuditDetail({ item }: { item: A3AdminAuditLog }) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 border-b border-[#d9d6c9] pb-4">
        <div className="min-w-0"><code className="break-all text-sm font-semibold text-[#143f32]">{item.action}</code><p className="mt-1 text-xs text-[#64736c]">记录编号 {item.id}</p></div>
        <AdminStatusBadge status={item.success ? 'succeeded' : 'failed'} label={item.success ? '成功' : '失败'} />
      </div>
      <DetailSection title="操作信息">
        <Detail label="管理员" value={item.actor?.displayName || '系统'} />
        <Detail label="管理员 IP" value={item.actorIp || '未记录'} />
        <Detail label="时间" value={formatAdminDateTime(item.createdAt)} />
        <Detail label="目标" value={[item.targetType, item.targetUser?.displayName || item.targetId].filter(Boolean).join(' · ') || '未记录'} />
        <Detail label="摘要" value={item.summary || '未填写'} />
        <Detail label="原因" value={item.reason || '未填写'} />
      </DetailSection>
      <JsonSection title="变更前" value={item.before} emptyLabel="无变更前数据" dataKey="before" />
      <JsonSection title="变更后" value={item.after} emptyLabel="无变更后数据" dataKey="after" />
      <JsonSection title="附加信息" value={item.metadata} emptyLabel="无附加信息" dataKey="metadata" />
    </div>
  );
}

function JsonSection({ title, value, emptyLabel, dataKey }: { title: string; value: A3JsonObject; emptyLabel: string; dataKey: 'before' | 'after' | 'metadata' }) {
  const entries = Object.entries(value || {});
  return (
    <section data-audit-field={dataKey}>
      <h3 className="border-b border-[#e3dfd3] pb-2 text-sm font-semibold text-[#143f32]">{title}</h3>
      {entries.length ? (
        <dl className="divide-y divide-[#ebe7db]">
          {entries.map(([key, entryValue]) => (
            <div key={key} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-3">
              <dt className="break-all font-mono text-xs text-[#64736c]">{key}</dt>
              <dd className="min-w-0 break-words text-[#244a3d]">{formatAuditValue(entryValue)}</dd>
            </div>
          ))}
        </dl>
      ) : <p className="py-3 text-sm text-[#7c8983]">{emptyLabel}</p>}
    </section>
  );
}

function formatAuditValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[#f0ede3] p-2 font-mono text-xs leading-5">{JSON.stringify(value, null, 2)}</pre>;
}

function AuditSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label><span className="mb-1 block text-xs text-[#64736c]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-32 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm text-[#244a3d] outline-none focus:border-[#9b7b2f]">{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3 className="border-b border-[#e3dfd3] pb-2 text-sm font-semibold text-[#143f32]">{title}</h3><dl className="mt-3 space-y-3">{children}</dl></section>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-sm"><dt className="text-[#64736c]">{label}</dt><dd className="break-words text-[#244a3d]">{value}</dd></div>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 align-top text-[#40554c]">{children}</td>;
}
