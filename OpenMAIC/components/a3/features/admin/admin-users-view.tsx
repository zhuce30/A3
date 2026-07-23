'use client';

import { ChevronLeft, ChevronRight, Eye, RefreshCw, Search, UserRound, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  getA3AdminUser,
  getA3AdminUsers,
  revealA3AdminUserIp,
  updateA3AdminUserStatus,
} from '@/lib/a3/admin-api';
import type { A3AdminUser } from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';
import { AdminAccessGuard } from './admin-access-guard';

export function AdminUsersView() {
  return <AdminAccessGuard><AdminUsersContent /></AdminAccessGuard>;
}

function AdminUsersContent() {
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<A3AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<A3AdminUser | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const result = await getA3AdminUsers({ search: submittedSearch, role, status, page, pageSize: 20 });
    if (result.success) {
      setItems(result.items);
      setTotal(result.pagination.total);
    } else {
      setError(result.error || '用户数据加载失败');
    }
    setLoading(false);
  }, [page, role, status, submittedSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openDetail = async (user: A3AdminUser) => {
    setSelected(user);
    const result = await getA3AdminUser(user.id);
    if (result.success && result.user) setSelected(result.user);
  };

  return (
    <div className="space-y-6" data-testid="a3-admin-users">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--a3-border)] pb-5">
        <div><p className="text-sm font-medium text-emerald-700">系统管理</p><h1 className="mt-1 text-2xl font-semibold">用户管理</h1><p className="mt-2 text-sm text-[var(--a3-text-muted)]">区分账号状态、在线状态与学习活动，IP 默认脱敏。</p></div>
        <Button variant="outline" onClick={() => void load()}><RefreshCw className={cn('size-4', loading && 'animate-spin')} />刷新</Button>
      </header>

      <form
        className="grid gap-3 border-y border-[var(--a3-border)] py-4 md:grid-cols-[minmax(260px,1fr)_180px_180px_auto]"
        onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}
      >
        <label className="relative"><Search className="absolute left-3 top-3 size-4 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名、邮箱、手机号、学号或 IP" className="h-10 w-full rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] pl-9 pr-3 text-sm outline-none focus:border-emerald-500" /></label>
        <select aria-label="角色" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} className="h-10 rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm"><option value="">全部角色</option><option value="student">学生</option><option value="teacher">教师</option><option value="admin">管理员</option></select>
        <select aria-label="账号状态" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="h-10 rounded-md border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-3 text-sm"><option value="">全部状态</option><option value="active">已启用</option><option value="disabled">已停用</option></select>
        <Button type="submit" className="bg-emerald-700 hover:bg-emerald-800"><Search className="size-4" />查询</Button>
      </form>

      {error ? <div className="border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div> : null}
      <div className="overflow-x-auto border-y border-[var(--a3-border)]">
        <table className="min-w-[1120px] w-full text-left text-sm">
          <thead className="sticky top-0 bg-[var(--a3-surface-muted)] text-xs text-[var(--a3-text-muted)]"><tr><Th>用户</Th><Th>角色</Th><Th>账号</Th><Th>在线状态</Th><Th>最近 IP</Th><Th>学习活动</Th><Th>注册时间</Th><Th>操作</Th></tr></thead>
          <tbody className="divide-y divide-[var(--a3-border)]">
            {items.map((user) => (
              <tr key={user.id} className="bg-[var(--a3-surface-solid)] hover:bg-amber-50/50 dark:hover:bg-amber-950/10">
                <Td><div className="font-medium">{user.displayName}</div><div className="mt-1 text-xs text-[var(--a3-text-muted)]">{user.email || user.phone || '未填写联系方式'}</div></Td>
                <Td>{roleLabel(user.role)}</Td>
                <Td><StatusDot active={user.isActive} />{user.isActive ? '已启用' : '已停用'}</Td>
                <Td><Presence status={user.presence.status} /></Td>
                <Td>{user.lastIp.label}{user.country ? ` · ${user.country}` : ''}</Td>
                <Td>{user.activity.learningEvents} 事件 · {user.activity.coachingSessions} 辅导</Td>
                <Td>{formatDate(user.createdAt)}</Td>
                <Td><button type="button" onClick={() => void openDetail(user)} className="inline-flex size-9 items-center justify-center rounded-md text-emerald-700 hover:bg-emerald-50" title="查看详情"><Eye className="size-4" /></button></Td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !items.length ? <div className="py-16 text-center text-sm text-[var(--a3-text-muted)]">没有符合条件的用户</div> : null}
        {loading ? <div className="py-16 text-center text-sm text-[var(--a3-text-muted)]">正在读取用户数据...</div> : null}
      </div>

      <div className="flex items-center justify-between text-sm text-[var(--a3-text-muted)]"><span>共 {total} 个账号</span><div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="size-4" /></Button><span>第 {page} 页</span><Button size="sm" variant="outline" disabled={page * 20 >= total} onClick={() => setPage((value) => value + 1)}><ChevronRight className="size-4" /></Button></div></div>

      {selected ? <AdminUserDrawer user={selected} onClose={() => setSelected(null)} onChanged={(user) => { setSelected(user); setItems((current) => current.map((item) => item.id === user.id ? user : item)); }} /> : null}
    </div>
  );
}

function AdminUserDrawer({ user, onClose, onChanged }: { user: A3AdminUser; onClose: () => void; onChanged: (user: A3AdminUser) => void }) {
  const [error, setError] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const toggleStatus = async () => {
    const reason = window.prompt(user.isActive ? '请输入停用原因' : '请输入启用原因');
    if (!reason) return;
    if (!window.confirm(`确认${user.isActive ? '停用' : '启用'}“${user.displayName}”？`)) return;
    const result = await updateA3AdminUserStatus(user.id, !user.isActive, reason);
    if (result.success && result.user) onChanged(result.user);
    else setError(result.error || '账号状态更新失败');
  };
  const reveal = async (field: 'last' | 'registration') => {
    if (!window.confirm('完整 IP 属于敏感访问数据，本次查看会写入管理员审计日志。确认继续？')) return;
    const result = await revealA3AdminUserIp(user.id, field, '管理员在用户详情中查看');
    if (result.success) setRevealed((current) => ({ ...current, [field]: result.ip || '历史未记录' }));
    else setError(result.error || 'IP 查看失败');
  };
  return (
    <div className="fixed inset-0 z-[80] bg-slate-950/35" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label="用户详情" className="absolute inset-y-0 right-0 w-full max-w-[520px] overflow-y-auto border-l border-[var(--a3-border)] bg-[var(--a3-surface-solid)] p-6 shadow-2xl">
        <div className="flex items-start justify-between"><div className="flex gap-3"><div className="flex size-11 items-center justify-center rounded-full bg-amber-100 text-amber-800"><UserRound className="size-5" /></div><div><h2 className="text-lg font-semibold">{user.displayName}</h2><p className="text-sm text-[var(--a3-text-muted)]">{roleLabel(user.role)} · {user.school || '未填写学校'}</p></div></div><button type="button" onClick={onClose} title="关闭"><X className="size-5" /></button></div>
        {error ? <p className="mt-4 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
        <Section title="账号信息"><Detail label="邮箱" value={user.email || '未填写'} /><Detail label="手机号" value={user.phone || '未填写'} /><Detail label="学号" value={user.studentId || '未填写'} /><Detail label="账号状态" value={user.isActive ? '已启用' : '已停用'} /></Section>
        <Section title="访问状态"><Detail label="在线状态" value={presenceLabel(user.presence.status)} /><IpDetail label="最近 IP" value={revealed.last || user.lastIp.label} onReveal={() => void reveal('last')} /><IpDetail label="注册 IP" value={revealed.registration || user.registrationIp.label} onReveal={() => void reveal('registration')} /><Detail label="地区" value={user.country || '未采集'} /></Section>
        <Section title="学习使用"><Detail label="学习方向" value={user.learningProfile.majorDirection || '未填写'} /><Detail label="首要目标" value={user.learningProfile.primaryGoal || '未填写'} /><Detail label="学习事件" value={`${user.activity.learningEvents}`} /><Detail label="辅导会话" value={`${user.activity.coachingSessions}`} /><Detail label="资源包 / Agent" value={`${user.activity.resourcePacks} / ${user.activity.agentRuns}`} /></Section>
        <Button type="button" variant="outline" onClick={() => void toggleStatus()} className={cn('mt-8 w-full', user.isActive && 'border-rose-200 text-rose-700 hover:bg-rose-50')}>{user.isActive ? '停用账号' : '启用账号'}</Button>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section className="mt-7 border-t border-[var(--a3-border)] pt-4"><h3 className="text-sm font-semibold">{title}</h3><dl className="mt-3 space-y-3">{children}</dl></section>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="grid grid-cols-[100px_1fr] gap-3 text-sm"><dt className="text-[var(--a3-text-muted)]">{label}</dt><dd className="break-all">{value}</dd></div>; }
function IpDetail({ label, value, onReveal }: { label: string; value: string; onReveal: () => void }) { return <div className="grid grid-cols-[100px_1fr_auto] gap-3 text-sm"><dt className="text-[var(--a3-text-muted)]">{label}</dt><dd>{value}</dd><button type="button" onClick={onReveal} className="text-xs text-emerald-700">查看完整值</button></div>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="px-4 py-3 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-4 py-4">{children}</td>; }
function StatusDot({ active }: { active: boolean }) { return <span className={cn('mr-2 inline-block size-2 rounded-full', active ? 'bg-emerald-500' : 'bg-slate-400')} />; }
function Presence({ status }: { status: A3AdminUser['presence']['status'] }) { return <span className="inline-flex items-center"><StatusDot active={status === 'online'} />{presenceLabel(status)}</span>; }
function presenceLabel(status: A3AdminUser['presence']['status']) { return status === 'online' ? '在线' : status === 'idle' ? '暂离' : '离线'; }
function roleLabel(role: A3AdminUser['role']) { return role === 'admin' ? '管理员' : role === 'teacher' ? '教师' : '学生'; }
function formatDate(value: string | null) { return value ? new Date(value).toLocaleDateString('zh-CN') : '未记录'; }
