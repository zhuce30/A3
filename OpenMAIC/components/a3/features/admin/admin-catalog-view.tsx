'use client';

import { RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getA3AdminCatalogCourses, getA3AdminCatalogResources, reindexA3AdminCatalogResource, updateA3AdminCatalogCourseStatus, updateA3AdminCatalogResourceStatus } from '@/lib/a3/admin-api';
import type { A3AdminCourse, A3AdminKnowledgeResource, A3AdminPagination as PaginationValue } from '@/lib/a3/admin-types';
import { AdminAccessGuard } from './admin-access-guard';
import { AdminEmptyState, AdminErrorState, AdminFilterBar, AdminPageHeader, AdminPagination, AdminReasonDialog, AdminSkeleton, AdminStatusBadge, AdminTable, formatAdminDateTime } from './admin-ui';

type CatalogAction =
  | { type: 'course-status'; course: A3AdminCourse }
  | { type: 'resource-status'; resource: A3AdminKnowledgeResource }
  | { type: 'resource-reindex'; resource: A3AdminKnowledgeResource };

export function AdminCatalogView() { return <AdminAccessGuard><AdminCatalogContent /></AdminAccessGuard>; }

function AdminCatalogContent() {
  const [tab, setTab] = useState<'courses' | 'resources'>('courses');
  const [search, setSearch] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [courses, setCourses] = useState<A3AdminCourse[]>([]);
  const [resources, setResources] = useState<A3AdminKnowledgeResource[]>([]);
  const [pagination, setPagination] = useState<PaginationValue>({ page: 1, pageSize: 20, total: 0 });
  const [action, setAction] = useState<CatalogAction | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      if (tab === 'courses') {
        const active = status === '' ? undefined : status === 'active';
        const result = await getA3AdminCatalogCourses({ search: submittedSearch, active, page, pageSize: 20 });
        if (result.success) { setCourses(result.items); setPagination(result.pagination); }
        else setError(result.error || '课程数据加载失败');
      } else {
        const result = await getA3AdminCatalogResources({ search: submittedSearch, status, page, pageSize: 20 });
        if (result.success) { setResources(result.items); setPagination(result.pagination); }
        else setError(result.error || '知识资料加载失败');
      }
    } finally { setLoading(false); inFlight.current = false; }
  }, [page, status, submittedSearch, tab]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  function changeTab(next: 'courses' | 'resources') { setTab(next); setPage(1); setStatus(''); setSearch(''); setSubmittedSearch(''); setError(''); }

  async function executeAction(reason: string) {
    if (!action) return;
    setActionPending(true);
    setError('');
    try {
      if (action.type === 'course-status') {
        const result = await updateA3AdminCatalogCourseStatus(action.course.id, !action.course.isActive, reason);
        if (!result.success || !result.course) { setError(result.error || '课程状态更新失败'); return; }
        setCourses((current) => current.map((item) => item.id === action.course.id ? { ...item, isActive: result.course?.isActive ?? item.isActive } : item));
      } else if (action.type === 'resource-status') {
        const next = action.resource.publicationStatus === 'published' ? 'offline' : 'published';
        const result = await updateA3AdminCatalogResourceStatus(action.resource.id, next, reason);
        if (!result.success || !result.resource) { setError(result.error || '资料状态更新失败'); return; }
        setResources((current) => current.map((item) => item.id === result.resource?.id ? result.resource : item));
      } else {
        const result = await reindexA3AdminCatalogResource(action.resource.id, reason);
        if (!result.success) { setError(result.error || '重建索引任务提交失败'); return; }
        await load();
      }
      setAction(null);
    } finally { setActionPending(false); }
  }

  const visibleItems = tab === 'courses' ? courses : resources;
  return <div className="space-y-5" data-testid="a3-admin-catalog">
    <AdminPageHeader title="课程与知识库" refreshing={loading} onRefresh={() => void load()} />
    <div className="flex border-b border-[#d9d6c9]" role="tablist" aria-label="目录类型"><Tab active={tab === 'courses'} onClick={() => changeTab('courses')}>课程</Tab><Tab active={tab === 'resources'} onClick={() => changeTab('resources')}>知识资料</Tab></div>
    <AdminFilterBar><form className="flex min-w-[260px] flex-1 items-end gap-2" onSubmit={(event) => { event.preventDefault(); setPage(1); setSubmittedSearch(search.trim()); }}><label className="min-w-0 flex-1"><span className="mb-1 block text-xs text-[#64736c]">搜索</span><span className="relative block"><Search className="absolute left-3 top-2.5 size-4 text-[#7c8983]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'courses' ? '课程代码或名称' : '资料名称'} className="h-9 w-full rounded-md border border-[#c8c3b4] bg-white pl-9 pr-3 text-sm" /></span></label><button type="submit" className="h-9 rounded-md bg-[#143f32] px-3 text-sm font-semibold text-[#fffdf7]">查询</button></form><SelectField label="状态" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={tab === 'courses' ? [['', '全部状态'], ['active', '已启用'], ['inactive', '已停用']] : [['', '全部状态'], ['published', '已发布'], ['offline', '已下线'], ['owner_only', '仅所有者'], ['failed', '索引失败']]} /></AdminFilterBar>
    {error ? <AdminErrorState message={error} onRetry={() => void load()} /> : null}{loading && !visibleItems.length ? <AdminSkeleton rows={7} /> : null}{!loading && !error && !visibleItems.length ? <AdminEmptyState title={tab === 'courses' ? '没有符合条件的课程' : '没有符合条件的资料'} /> : null}
    {tab === 'courses' && courses.length ? <><CourseTable items={courses} onAction={(course) => setAction({ type: 'course-status', course })} /><AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} /></> : null}
    {tab === 'resources' && resources.length ? <><ResourceTable items={resources} onStatus={(resource) => setAction({ type: 'resource-status', resource })} onReindex={(resource) => setAction({ type: 'resource-reindex', resource })} /><AdminPagination pagination={pagination} onPageChange={setPage} disabled={loading} /></> : null}
    <AdminReasonDialog open={Boolean(action)} title={actionTitle(action)} actionLabel="确认执行" pending={actionPending} onClose={() => setAction(null)} onConfirm={executeAction} />
  </div>;
}

function CourseTable({ items, onAction }: { items: A3AdminCourse[]; onAction: (item: A3AdminCourse) => void }) { return <AdminTable><thead className="bg-[#f0ede3] text-xs text-[#64736c]"><tr><Th>课程</Th><Th>版本</Th><Th>章节 / 知识点</Th><Th>教师 / 学生</Th><Th>状态</Th><Th>更新时间</Th><Th>操作</Th></tr></thead><tbody className="divide-y divide-[#e3dfd3]">{items.map((item) => <tr key={item.id} className="hover:bg-[#faf5df]"><Td><div className="font-medium text-[#244a3d]">{item.title}</div><div className="mt-1 text-xs text-[#64736c]">{item.code}</div></Td><Td>{item.edition || '未填写'}</Td><Td><span className="tabular-nums">{item.chapterCount} / {item.knowledgePointCount}</span></Td><Td><span className="tabular-nums">{item.teacherCount} / {item.studentCount}</span></Td><Td><AdminStatusBadge status={item.isActive ? 'active' : 'inactive'} /></Td><Td>{formatAdminDateTime(item.updatedAt)}</Td><Td><button type="button" onClick={() => onAction(item)} className={item.isActive ? 'text-xs font-medium text-rose-700' : 'text-xs font-medium text-[#1f6b53]'}>{item.isActive ? '下线' : '启用'}</button></Td></tr>)}</tbody></AdminTable>; }
function ResourceTable({ items, onStatus, onReindex }: { items: A3AdminKnowledgeResource[]; onStatus: (item: A3AdminKnowledgeResource) => void; onReindex: (item: A3AdminKnowledgeResource) => void }) { return <AdminTable><thead className="bg-[#f0ede3] text-xs text-[#64736c]"><tr><Th>资料</Th><Th>范围</Th><Th>发布状态</Th><Th>索引</Th><Th>分块</Th><Th>更新时间</Th><Th>操作</Th></tr></thead><tbody className="divide-y divide-[#e3dfd3]">{items.map((item) => <tr key={item.id} className="hover:bg-[#faf5df]"><Td><div className="max-w-64 truncate font-medium text-[#244a3d]">{item.name}</div><div className="mt-1 text-xs text-[#64736c]">{item.fileType} · {formatBytes(item.fileSize)} · {item.owner.displayName}</div></Td><Td>{item.scope || item.courseKey || '通用'}</Td><Td><AdminStatusBadge status={item.publicationStatus} /></Td><Td><AdminStatusBadge status={item.indexJob?.status || item.status} /><div className="mt-1 text-xs tabular-nums text-[#64736c]">{item.indexJob ? `${item.indexJob.progress}%` : '无任务'}</div></Td><Td><span className="tabular-nums">{item.chunkCount}</span></Td><Td>{formatAdminDateTime(item.updatedAt)}</Td><Td><div className="flex items-center gap-3"><button type="button" onClick={() => onStatus(item)} className="text-xs font-medium text-[#1f6b53]">{item.publicationStatus === 'published' ? '下线' : '发布'}</button><button type="button" onClick={() => onReindex(item)} className="inline-flex items-center gap-1 text-xs font-medium text-[#8a651f]"><RefreshCw className="size-3" />重建索引</button></div></Td></tr>)}</tbody></AdminTable>; }
function actionTitle(action: CatalogAction | null) { if (!action) return '目录操作'; if (action.type === 'course-status') return `${action.course.isActive ? '下线' : '启用'}课程`; if (action.type === 'resource-status') return `${action.resource.publicationStatus === 'published' ? '下线' : '发布'}资料`; return '重建资料索引'; }
function formatBytes(value: number) { if (!value) return '0 B'; if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`; return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={active ? 'border-b-2 border-[#9b7b2f] px-4 py-2.5 text-sm font-semibold text-[#143f32]' : 'px-4 py-2.5 text-sm text-[#64736c] hover:text-[#143f32]'}>{children}</button>; }
function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) { return <label><span className="mb-1 block text-xs text-[#64736c]">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 min-w-32 rounded-md border border-[#c8c3b4] bg-white px-2 text-sm">{options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }
function Th({ children }: { children: React.ReactNode }) { return <th className="whitespace-nowrap px-3 py-2.5 font-medium">{children}</th>; }
function Td({ children }: { children: React.ReactNode }) { return <td className="px-3 py-3 text-[#40554c]">{children}</td>; }
