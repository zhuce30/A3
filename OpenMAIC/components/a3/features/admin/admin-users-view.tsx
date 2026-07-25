'use client';

import { Eye, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getA3AdminUser,
  getA3AdminUsers,
  revealA3AdminUserIp,
  updateA3AdminUserStatus,
} from '@/lib/a3/admin-api';
import type { A3AdminPagination as PaginationValue, A3AdminUser } from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import {
  AdminDetailDrawer,
  AdminEmptyState,
  AdminErrorState,
  AdminFilterBar,
  AdminPageHeader,
  AdminPagination,
  AdminReasonDialog,
  AdminSkeleton,
  AdminStatusBadge,
  AdminTable,
  formatAdminDateTime,
} from './admin-ui';

type UserAction =
  | { type: 'status'; user: A3AdminUser }
  | { type: 'ip'; user: A3AdminUser; field: 'last' | 'registration' };

export function AdminUsersView() {
  return <AdminAccessGuard><AdminUsersContent /></AdminAccessGuard>;
}

function AdminUsersContent() {
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [presence, setPresence] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<A3AdminUser[]>([]);
  const [pagination, setPagination] = useState<PaginationValue>({ page: 1, pageSize: 20, total: 0 });
  const [selected, setSelected] = useState<A3AdminUser | null>(null);
  const [revealedIp, setRevealedIp] = useState<{ last?: string; registration?: string }>({});
  const [action, setAction] = useState<UserAction | null>(null);
  const [actionPending, setActionPending] = useState(false);
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
      const result = await getA3AdminUsers({ search: submittedSearch, role, status, presence, page, pageSize: 20 });
      if (result.success) {
        setItems(result.items);
        setPagination(result.pagination);
      } else setError(result.error || '用户数据加载失败');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [page, presence, role, status, submittedSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openDetail(user: A3AdminUser) {
    setSelected(user);
    setRevealedIp({});
    setDetailError('');
    const result = await getA3AdminUser(user.id);
    if (result.success && result.user) setSelected(result.user);
    else if (!result.success) setDetailError(result.error || '用户详情加载失败');
  }

  async function executeAction(reason: string) {
    if (!action) return;
    setActionPending(true);
    setDetailError('');
    try {
      if (action.type === 'status') {
        const result = await updateA3AdminUserStatus(action.user.id, !action.user.isActive, reason);
        if (!result.success || !result.user) {
          setDetailError(result.error || '账号状态更新失败');
          return;
        }
        setSelected(result.user);
        setItems((current) => current.map((item) => item.id === result.user?.id ? result.user : item));
      } else {
        const result = await revealA3AdminUserIp(action.user.id, action.field, reason);
        if (!result.success) {
          setDetailError(result.error || 'IP 查看失败');
          return;
        }
        setRevealedIp((current) => ({ ...current, [action.field]: result.ip || '历史未记录' }));
      }
      setAction(null);
    } finally {
      setActionPending(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="a3-admin-users">
      <AdminPageHeader title="用户管理" refreshing={loading} onRefresh={() => void load()} />
      <AdminFilterBar>
        <form
          className="flex min-w-[240px] flex-1 items-end gap-2"
          onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}
        >
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs text-[#64736c]">搜索</span>
            <span className="relative block"><Search className="absolute left-3 top-2.5 size-4 text-[#7c8983]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名、账号、学号或 IP" className="h-9 w-full rounded-md border border-[#c8c3b4] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#9b7b2f]" /></span>
          </label>
          <button type="submit" className="h-9 rounded-md bg-[#143f32] px-3 text-sm font-semibold text-[#fffdf7] hover:bg-[#1d5543]">查询</button>
        </form>
        <AdminSelect label="角色" value={role} onChange={(value) => { setRole(value); setPage(1); }} options={[['', '全部角色'], ['student', '学生'], ['teacher', '教师'], ['admin', '管理员']]} />
        <AdminSelect label="账号" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[['', '全部状态'], ['active', '已启用'], ['disabled', '已停用']]} />
        <AdminSelect label="在线" value={presence} onChange={(value) => { setPresence(value); setPage(1); }} options={[['', '全部状态'], ['online', '在线'], ['idle', '暂离'], ['offline', '离线']]} />
      </AdminFilterBar>

      {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}
      {loading && !items.length ? <AdminSkeleton rows={7} /> : null}
      {!loading && !error && !items.length ? <AdminEmptyState title="没有符合条件的用户" /> : null}
      {items.length ? (
        <>
          <AdminTable>
            <thead className="bg-[#f0ede3] text-xs text-[#64736c]"><tr><Th>用户</Th><Th>角色</Th><Th>账号</Th><Th>在线</Th><Th>最近 IP</Th><Th>学习活动</Th><Th>最近活跃</Th><Th>操作</Th></tr></thead>
            <tbody className="divide-y divide-[#e3dfd3]">
              {items.map((user) => (
                <tr key={user.id} className="bg-[#fffdf7] hover:bg-[#faf5df]">
                  <Td><div className="font-medium text-[#244a3d]">{user.displayName || '未命名用户'}</div><div className="mt-1 max-w-52 truncate text-xs text-[#64736c]">{user.email || user.phone || user.studentId || '未填写账号信息'}</div></Td>
                  <Td>{roleLabel(user.role)}</Td>
                  <Td><AdminStatusBadge status={user.isActive ? 'active' : 'inactive'} /></Td>
                  <Td><AdminStatusBadge status={user.presence.status} label={presenceLabel(user.presence.status)} /></Td>
                  <Td><span className="whitespace-nowrap">{user.lastIp.label}</span>{user.country ? <span className="ml-1 text-xs text-[#64736c]">· {user.country}</span> : null}</Td>
                  <Td><span className="tabular-nums">{user.activity.learningEvents}</span> 事件 · <span className="tabular-nums">{user.activity.coachingSessions}</span> 辅导</Td>
                  <Td>{formatAdminDateTime(user.presence.lastSeenAt || user.lastLoginAt)}</Td>
                  <Td><button type="button" aria-label={`查看 ${user.displayName} 详情`} onClick={() => void openDetail(user)} className="flex size-8 items-center justify-center rounded-md text-[#1f6b53] hover:bg-[#e9f0eb]"><Eye className="size-4" /></button></Td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          <AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} />
        </>
      ) : null}

      <AdminDetailDrawer open={Boolean(selected)} title="用户详情" onClose={() => { setSelected(null); setAction(null); }}>
        {selected ? (
          <div className="space-y-6">
            {detailError ? <AdminErrorState message={detailError} /> : null}
            <div className="flex items-start justify-between gap-3 border-b border-[#d9d6c9] pb-4">
              <div><h3 className="font-semibold text-[#143f32]">{selected.displayName || '未命名用户'}</h3><p className="mt-1 text-sm text-[#64736c]">{roleLabel(selected.role)} · {selected.school || '未填写学校'}</p></div>
              <AdminStatusBadge status={selected.isActive ? 'active' : 'inactive'} />
            </div>
            <DetailSection title="账号信息"><Detail label="邮箱" value={selected.email || '未填写'} /><Detail label="手机号" value={selected.phone || '未填写'} /><Detail label="学号" value={selected.studentId || '未填写'} /><Detail label="注册时间" value={formatAdminDateTime(selected.createdAt)} /></DetailSection>
            <DetailSection title="访问摘要">
              <Detail label="在线状态" value={presenceLabel(selected.presence.status)} />
              <SensitiveDetail label="最近 IP" value={revealedIp.last || selected.lastIp.label} onReveal={() => setAction({ type: 'ip', user: selected, field: 'last' })} />
              <SensitiveDetail label="注册 IP" value={revealedIp.registration || selected.registrationIp.label} onReveal={() => setAction({ type: 'ip', user: selected, field: 'registration' })} />
              <Detail label="地区" value={selected.country || '未采集'} />
            </DetailSection>
            <DetailSection title="学习使用"><Detail label="学习方向" value={selected.learningProfile.majorDirection || '未填写'} /><Detail label="基础水平" value={selected.learningProfile.foundationLevel || '未填写'} /><Detail label="学习目标" value={selected.learningProfile.primaryGoal || '未填写'} /><Detail label="资源包 / Agent" value={`${selected.activity.resourcePacks} / ${selected.activity.agentRuns}`} /></DetailSection>
            <button type="button" onClick={() => setAction({ type: 'status', user: selected })} className={selected.isActive ? 'h-10 w-full rounded-md border border-rose-300 text-sm font-semibold text-rose-700 hover:bg-rose-50' : 'h-10 w-full rounded-md bg-[#143f32] text-sm font-semibold text-[#fffdf7] hover:bg-[#1d5543]'}>{selected.isActive ? '停用账号' : '启用账号'}</button>
          </div>
        ) : null}
      </AdminDetailDrawer>

      <AdminReasonDialog
        open={Boolean(action)}
        title={action?.type === 'status' ? `${action.user.isActive ? '停用' : '启用'}账号` : '查看完整 IP'}
        actionLabel={action?.type === 'status' ? '确认变更' : '确认查看'}
        pending={actionPending}
        onClose={() => setAction(null)}
        onConfirm={executeAction}
      />
    </div>
  );
}

function AdminSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return <label><span className="mb-1 block text-xs text-[#64736c]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-32 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm text-[#244a3d] outline-none focus:border-[#9b7b2f]">{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) { return <section><h3 className="border-b border-[#e3dfd3] pb-2 text-sm font-semibold text-[#143f32]">{title}</h3><dl className="mt-3 space-y-3">{children}</dl></section>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-sm"><dt className="text-[#64736c]">{label}</dt><dd className="break-words text-[#244a3d]">{value}</dd></div>; }
function SensitiveDetail({ label, value, onReveal }: { label: string; value: string; onReveal: () => void }) { return <div className="grid grid-cols-[96px_minmax(0,1fr)_auto] gap-3 text-sm"><dt className="text-[#64736c]">{label}</dt><dd className="break-words text-[#244a3d]">{value}</dd><button type="button" onClick={onReveal} className="text-xs font-medium text-[#8a651f] hover:text-[#143f32]">查看</button></div>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-3 text-[#40554c]">{children}</td>; }
function roleLabel(role: A3AdminUser['role']) { return role === 'admin' ? '管理员' : role === 'teacher' ? '教师' : '学生'; }
function presenceLabel(status: A3AdminUser['presence']['status']) { return status === 'online' ? '在线' : status === 'idle' ? '暂离' : '离线'; }
