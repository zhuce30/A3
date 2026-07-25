'use client';

import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  RefreshCw,
  X,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type {
  A3AdminDataStatus,
  A3AdminPagination as PaginationValue,
  A3AdminServiceStatus,
  A3AdminTaskStatus,
} from '@/lib/a3/admin-types';
import { cn } from '@/lib/utils';

export function AdminPageHeader({
  title,
  updatedAt,
  refreshing = false,
  onRefresh,
  actions,
}: {
  title: string;
  updatedAt?: string | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-3 border-b border-[#d9d6c9] pb-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold text-[#143f32]">{title}</h1>
        {updatedAt ? (
          <p className="mt-1 text-xs text-[#64736c]">
            更新于 <time dateTime={updatedAt}>{formatAdminDateTime(updatedAt)}</time>
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="刷新数据"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-[#c8c3b4] bg-[#fffdf7] px-3 text-sm font-medium text-[#244a3d] transition-colors hover:bg-[#f0ede3] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden="true" />
            刷新
          </button>
        ) : null}
        {actions}
      </div>
    </header>
  );
}

export function AdminFilterBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-end gap-3 border-b border-[#e3dfd3] bg-[#fffdf7] py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

const dataStatusLabels: Record<A3AdminDataStatus, string> = {
  collected: '已采集',
  not_collected: '未采集',
  partial: '部分数据',
};

export function AdminDataStatusBadge({ status }: { status: A3AdminDataStatus }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium',
        status === 'collected' && 'border-emerald-200 bg-emerald-50 text-emerald-800',
        status === 'partial' && 'border-amber-200 bg-amber-50 text-amber-800',
        status === 'not_collected' && 'border-stone-200 bg-stone-100 text-stone-600',
      )}
    >
      {dataStatusLabels[status]}
    </span>
  );
}

type AdminStatus = A3AdminTaskStatus | A3AdminServiceStatus | string;

const statusLabels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stale: '已停滞',
  configured: '已配置',
  healthy: '正常',
  degraded: '降级',
  down: '不可用',
  unknown: '未知',
  active: '启用',
  inactive: '停用',
  pending: '待处理',
  confirmed: '已确认',
  false_positive: '误报',
  resolved: '已解决',
  published: '已发布',
  offline: '已下线',
  owner_only: '仅所有者',
};

export function AdminStatusBadge({ status, label }: { status: AdminStatus; label?: string }) {
  const normalized = String(status || 'unknown');
  const positive = ['succeeded', 'healthy', 'active', 'published', 'resolved'].includes(normalized);
  const warning = ['queued', 'configured', 'degraded', 'pending', 'stale'].includes(normalized);
  const negative = ['failed', 'down', 'confirmed'].includes(normalized);
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium',
        positive && 'border-emerald-200 bg-emerald-50 text-emerald-800',
        warning && 'border-amber-200 bg-amber-50 text-amber-800',
        negative && 'border-rose-200 bg-rose-50 text-rose-700',
        !positive && !warning && !negative && 'border-stone-200 bg-stone-100 text-stone-600',
      )}
    >
      {label ?? statusLabels[normalized] ?? normalized}
    </span>
  );
}

export function AdminTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 overflow-x-auto border-y border-[#d9d6c9] bg-[#fffdf7]', className)}>
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function AdminPagination({
  pagination,
  onPageChange,
  disabled = false,
}: {
  pagination: PaginationValue;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(pagination.total / Math.max(pagination.pageSize, 1)));
  return (
    <nav className="flex min-w-0 items-center justify-between gap-3 py-3 text-sm text-[#64736c]" aria-label="分页">
      <span className="truncate">共 {pagination.total} 条</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="上一页"
          disabled={disabled || pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
          className="flex size-9 items-center justify-center rounded-md border border-[#c8c3b4] bg-[#fffdf7] text-[#244a3d] hover:bg-[#f0ede3] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="min-w-16 text-center tabular-nums">
          {pagination.page} / {pageCount}
        </span>
        <button
          type="button"
          aria-label="下一页"
          disabled={disabled || pagination.page >= pageCount}
          onClick={() => onPageChange(pagination.page + 1)}
          className="flex size-9 items-center justify-center rounded-md border border-[#c8c3b4] bg-[#fffdf7] text-[#244a3d] hover:bg-[#f0ede3] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

export function AdminSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-y divide-[#e3dfd3] border-y border-[#d9d6c9]" role="status" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid h-14 grid-cols-[1.5fr_1fr_0.7fr] items-center gap-4 px-3">
          <span className="h-3 animate-pulse rounded bg-[#e8e4d9]" />
          <span className="h-3 animate-pulse rounded bg-[#ece8de]" />
          <span className="h-3 animate-pulse rounded bg-[#ece8de]" />
        </div>
      ))}
    </div>
  );
}

export function AdminEmptyState({ title = '暂无数据', action }: { title?: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center border-y border-[#d9d6c9] bg-[#fffdf7] px-6 text-center">
      <Inbox className="size-7 text-[#9b7b2f]" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium text-[#40554c]">{title}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function AdminErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center border-y border-rose-200 bg-rose-50 px-6 text-center" role="alert">
      <AlertCircle className="size-7 text-rose-600" aria-hidden="true" />
      <p className="mt-3 text-sm text-rose-800">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="mt-3 h-9 rounded-md border border-rose-300 px-3 text-sm font-medium text-rose-800 hover:bg-rose-100">
          重试
        </button>
      ) : null}
    </div>
  );
}

export function AdminDetailDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70]">
      <button type="button" aria-label="关闭详情" className="absolute inset-0 bg-[#102b22]/35" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-[#d9d6c9] bg-[#fffdf7] shadow-[-18px_0_50px_rgba(20,63,50,0.14)]"
      >
        <header className="flex h-16 items-center justify-between gap-3 border-b border-[#d9d6c9] px-5">
          <h2 id={titleId} className="truncate text-base font-semibold text-[#143f32]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="flex size-9 items-center justify-center rounded-md text-[#52645d] hover:bg-[#efede4]">
            <X className="size-5" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </section>
    </div>
  );
}

export function AdminReasonDialog({
  open,
  title,
  actionLabel,
  pending = false,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  actionLabel: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
    }
  }, [open]);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = reason.trim();
    if (!normalized) {
      setError('请填写操作原因');
      return;
    }
    setError('');
    await onConfirm(normalized);
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" aria-label="取消操作" className="absolute inset-0 bg-[#102b22]/45" onClick={onClose} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        className="relative w-full max-w-md rounded-md border border-[#d9d6c9] bg-[#fffdf7] p-5 shadow-[0_24px_70px_rgba(20,63,50,0.2)]"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-[#143f32]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="flex size-8 items-center justify-center rounded-md text-[#52645d] hover:bg-[#efede4]">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <label htmlFor={reasonId} className="mt-4 block text-sm font-medium text-[#40554c]">操作原因</label>
        <textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={255}
          rows={4}
          autoFocus
          className="mt-2 w-full resize-none rounded-md border border-[#c8c3b4] bg-white px-3 py-2 text-sm text-[#183229] outline-none focus:border-[#9b7b2f] focus:ring-2 focus:ring-[#9b7b2f]/20"
        />
        {error ? <p className="mt-2 text-sm text-rose-700" role="alert">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className="h-9 rounded-md border border-[#c8c3b4] px-3 text-sm font-medium text-[#40554c] hover:bg-[#f0ede3] disabled:opacity-50">取消</button>
          <button type="submit" disabled={pending} className="h-9 rounded-md bg-[#143f32] px-4 text-sm font-semibold text-[#fffdf7] hover:bg-[#1d5543] disabled:cursor-not-allowed disabled:opacity-60">
            {pending ? '处理中…' : actionLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function formatAdminDateTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
