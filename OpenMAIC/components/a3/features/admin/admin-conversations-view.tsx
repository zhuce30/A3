'use client';

import { Eye, LockKeyhole, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminConversation, getA3AdminConversations, revealA3AdminConversation } from '@/lib/a3/admin-api';
import type { A3AdminConversation, A3AdminConversationMessage, A3AdminPagination as PaginationValue } from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import { AdminDetailDrawer, AdminEmptyState, AdminErrorState, AdminFilterBar, AdminPageHeader, AdminPagination, AdminReasonDialog, AdminSkeleton, AdminStatusBadge, AdminTable, formatAdminDateTime } from './admin-ui';

export function AdminConversationsView() {
  return <AdminAccessGuard><AdminConversationsContent /></AdminAccessGuard>;
}

function AdminConversationsContent() {
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<A3AdminConversation[]>([]);
  const [pagination, setPagination] = useState<PaginationValue>({ page: 1, pageSize: 20, total: 0 });
  const [selected, setSelected] = useState<A3AdminConversation | null>(null);
  const [messages, setMessages] = useState<A3AdminConversationMessage[] | null>(null);
  const [messagePagination, setMessagePagination] = useState<PaginationValue | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
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
      const result = await getA3AdminConversations({ search: submittedSearch, status, page, pageSize: 20 });
      if (result.success) {
        setItems(result.items);
        setPagination(result.pagination);
      } else setError(result.error || '对话记录加载失败');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [page, status, submittedSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function openDetail(item: A3AdminConversation) {
    setSelected(item);
    setMessages(null);
    setMessagePagination(null);
    setDetailError('');
    const result = await getA3AdminConversation(item.id);
    if (result.success && result.conversation) setSelected(result.conversation);
    else if (!result.success) setDetailError(result.error || '对话详情加载失败');
  }

  async function reveal(reason: string, targetPage = 1) {
    if (!selected) return;
    setActionPending(true);
    setDetailError('');
    try {
      const result = await revealA3AdminConversation(selected.id, reason, { page: targetPage, pageSize: 20 });
      if (!result.success) {
        setDetailError(result.error || '对话正文读取失败');
        return;
      }
      setMessages(result.messages || []);
      setMessagePagination(result.pagination || null);
      setRevealOpen(false);
    } finally {
      setActionPending(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="a3-admin-conversations">
      <AdminPageHeader title="对话记录" refreshing={loading} onRefresh={() => void load()} />
      <AdminFilterBar>
        <form className="flex min-w-[260px] flex-1 items-end gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}>
          <label className="min-w-0 flex-1"><span className="mb-1 block text-xs text-[#64736c]">搜索</span><span className="relative block"><Search className="absolute left-3 top-2.5 size-4 text-[#7c8983]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="主题、目标、工作流或 traceId" className="h-9 w-full rounded-md border border-[#c8c3b4] bg-white pl-9 pr-3 text-sm outline-none focus:border-[#9b7b2f]" /></span></label>
          <button type="submit" className="h-9 rounded-md bg-[#143f32] px-3 text-sm font-semibold text-[#fffdf7]">查询</button>
        </form>
        <SelectField label="状态" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[['', '全部状态'], ['active', '进行中'], ['completed', '已结束']]} />
      </AdminFilterBar>
      {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}
      {loading && !items.length ? <AdminSkeleton rows={7} /> : null}
      {!loading && !error && !items.length ? <AdminEmptyState title="没有符合条件的对话" /> : null}
      {items.length ? <><AdminTable><thead className="bg-[#f0ede3] text-xs text-[#64736c]"><tr><Th>用户 / 主题</Th><Th>状态</Th><Th>消息</Th><Th>验证 / 降级 / 拦截</Th><Th>最近活动</Th><Th>详情</Th></tr></thead><tbody className="divide-y divide-[#e3dfd3]">{items.map((item) => <tr key={item.id} className="hover:bg-[#faf5df]"><Td><div className="font-medium text-[#244a3d]">{item.user.displayName}</div><div className="mt-1 max-w-72 truncate text-xs text-[#64736c]">{item.topicTitle || item.learningGoal || '未命名对话'}</div></Td><Td><AdminStatusBadge status={item.status} /></Td><Td><span className="tabular-nums">{item.messageCount}</span></Td><Td><span className="tabular-nums">{item.verifiedMessageCount} / {item.degradedMessageCount} / {item.safetyBlockedCount}</span></Td><Td>{formatAdminDateTime(item.updatedAt)}</Td><Td><button type="button" aria-label={`查看 ${item.topicTitle || item.id}`} onClick={() => void openDetail(item)} className="flex size-8 items-center justify-center rounded-md text-[#1f6b53] hover:bg-[#e9f0eb]"><Eye className="size-4" /></button></Td></tr>)}</tbody></AdminTable><AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} /></> : null}

      <AdminDetailDrawer open={Boolean(selected)} title="对话详情" onClose={() => { setSelected(null); setRevealOpen(false); }}>
        {selected ? <div className="space-y-6">{detailError ? <AdminErrorState message={detailError} /> : null}<DetailSection title="会话摘要"><Detail label="用户" value={selected.user.displayName} /><Detail label="主题" value={selected.topicTitle || '未命名'} /><Detail label="学习目标" value={selected.learningGoal || '未记录'} /><Detail label="课程" value={selected.course?.title || '未关联'} /><Detail label="知识点" value={selected.knowledgePoint?.title || '未关联'} /><Detail label="工作流" value={selected.workflow || '未记录'} /><Detail label="Trace ID" value={selected.traceId || '未记录'} /></DetailSection>{messages === null ? <div className="border-y border-[#d9d6c9] bg-[#f7f1dc] px-4 py-5 text-center"><LockKeyhole className="mx-auto size-6 text-[#9b7b2f]" /><p className="mt-2 text-sm text-[#40554c]">对话正文默认隐藏，查看操作会写入审计日志。</p><button type="button" onClick={() => setRevealOpen(true)} className="mt-3 h-9 rounded-md bg-[#143f32] px-4 text-sm font-semibold text-[#fffdf7]">查看正文</button></div> : <MessageList messages={messages} />}{messagePagination && messagePagination.total > messagePagination.pageSize ? <AdminPagination pagination={messagePagination} onPageChange={(nextPage) => { setRevealOpen(true); setMessagePagination((current) => current ? { ...current, page: nextPage } : current); }} /> : null}</div> : null}
      </AdminDetailDrawer>
      <AdminReasonDialog open={revealOpen} title="查看对话正文" actionLabel="确认查看" pending={actionPending} onClose={() => setRevealOpen(false)} onConfirm={(reason) => reveal(reason, messagePagination?.page || 1)} />
    </div>
  );
}

function MessageList({ messages }: { messages: A3AdminConversationMessage[] }) { return <section><h3 className="mb-3 text-sm font-semibold text-[#143f32]">消息正文</h3>{messages.length ? <div className="space-y-3">{messages.map((message) => <article key={message.id} className="border-l-2 border-[#d3bd72] bg-[#fffdf7] py-2 pl-3"><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-[#64736c]">{message.role}</span><time className="text-xs text-[#7c8983]">{formatAdminDateTime(message.createdAt)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[#244a3d]">{message.content}</p><div className="mt-2 flex flex-wrap gap-2">{message.verified ? <AdminStatusBadge status="succeeded" label="已验证" /> : null}{message.degraded ? <AdminStatusBadge status="degraded" label="已降级" /> : null}{message.safetyBlocked ? <AdminStatusBadge status="failed" label="已拦截" /> : null}</div></article>)}</div> : <AdminEmptyState title="本页没有消息" />}</section>; }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) { return <label><span className="mb-1 block text-xs text-[#64736c]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-32 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm">{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) { return <section><h3 className="border-b border-[#e3dfd3] pb-2 text-sm font-semibold text-[#143f32]">{title}</h3><dl className="mt-3 space-y-3">{children}</dl></section>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-sm"><dt className="text-[#64736c]">{label}</dt><dd className="break-words text-[#244a3d]">{value}</dd></div>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-3 text-[#40554c]">{children}</td>; }
