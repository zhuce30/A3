import { a3GetJson, a3PostJson } from './api-client';
import type {
  A3AdminAgentRunDetail,
  A3AdminAgentRunsResponse,
  A3AdminApiResponse,
  A3AdminAuditLogsResponse,
  A3AdminCatalogCoursesResponse,
  A3AdminCatalogResourcesResponse,
  A3AdminConfigurationCheck,
  A3AdminConfigurationResponse,
  A3AdminConversation,
  A3AdminConversationMessage,
  A3AdminConversationsResponse,
  A3AdminKnowledgeResource,
  A3AdminOverview,
  A3AdminPagination,
  A3AdminSecurityEvent,
  A3AdminSecurityEventsResponse,
  A3AdminSecurityReviewStatus,
  A3AdminTask,
  A3AdminTaskKind,
  A3AdminTasksResponse,
  A3AdminUser,
  A3AdminUsersResponse,
} from './admin-types';

type QueryValue = string | number | boolean | null | undefined;
type PageParams = { page?: number; pageSize?: number };

function boundedPage(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value as number)) : 1;
}

function boundedPageSize(value: number | undefined) {
  if (!Number.isFinite(value)) return 20;
  return Number(value) > 20 ? 50 : 20;
}

function queryString(params: { [key: string]: QueryValue }, pagination?: PageParams) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  if (pagination) {
    query.set('page', String(boundedPage(pagination.page)));
    query.set('pageSize', String(boundedPageSize(pagination.pageSize)));
  }
  return query.toString();
}

function requireReason(reason: string) {
  const normalized = reason.trim();
  if (!normalized) throw new Error('请填写操作原因');
  return normalized;
}

function detailPathPart(value: string) {
  return encodeURIComponent(value);
}

export function getA3AdminOverview(range: '24h' | '7d' | '30d' = '24h') {
  return a3GetJson<A3AdminOverview>(`/api/admin/overview/?range=${range}`);
}

export function getA3AdminUsers(params: PageParams & { search?: string; role?: string; status?: string; presence?: string } = {}) {
  const query = queryString(
    { search: params.search, role: params.role, status: params.status, presence: params.presence },
    params,
  );
  return a3GetJson<A3AdminUsersResponse>(`/api/admin/users/?${query}`);
}

export function getA3AdminUser(userId: string) {
  return a3GetJson<A3AdminApiResponse & { user?: A3AdminUser }>(`/api/admin/users/${detailPathPart(userId)}/`);
}

export function updateA3AdminUserStatus(userId: string, isActive: boolean, reason: string) {
  return a3PostJson<A3AdminApiResponse & { user?: A3AdminUser }>(
    `/api/admin/users/${detailPathPart(userId)}/status/`,
    { isActive, reason: requireReason(reason) },
  );
}

export function revealA3AdminUserIp(userId: string, field: 'last' | 'registration', reason: string) {
  return a3PostJson<A3AdminApiResponse & { ip?: string | null; dataStatus?: string }>(
    `/api/admin/users/${detailPathPart(userId)}/reveal-ip/`,
    { field, reason: requireReason(reason) },
  );
}

export function getA3AdminConversations(params: PageParams & { search?: string; status?: string; userId?: string } = {}) {
  const query = queryString({ search: params.search, status: params.status, userId: params.userId }, params);
  return a3GetJson<A3AdminConversationsResponse>(`/api/admin/conversations/?${query}`);
}

export function getA3AdminConversation(sessionId: string) {
  return a3GetJson<A3AdminApiResponse & { conversation?: A3AdminConversation }>(
    `/api/admin/conversations/${detailPathPart(sessionId)}/`,
  );
}

export function revealA3AdminConversation(sessionId: string, reason: string, pagination: PageParams = {}) {
  const query = queryString({}, pagination);
  return a3PostJson<
    A3AdminApiResponse & { conversationId?: string; messages?: A3AdminConversationMessage[]; pagination?: A3AdminPagination }
  >(`/api/admin/conversations/${detailPathPart(sessionId)}/reveal/?${query}`, { reason: requireReason(reason) });
}

export function getA3AdminCatalogCourses(params: PageParams & { search?: string; active?: boolean } = {}) {
  const query = queryString({ search: params.search, active: params.active }, params);
  return a3GetJson<A3AdminCatalogCoursesResponse>(`/api/admin/catalog/courses/?${query}`);
}

export function updateA3AdminCatalogCourseStatus(courseId: string, isActive: boolean, reason: string) {
  return a3PostJson<A3AdminApiResponse & { course?: { id: string; isActive: boolean } }>(
    `/api/admin/catalog/courses/${detailPathPart(courseId)}/status/`,
    { isActive, reason: requireReason(reason) },
  );
}

export function getA3AdminCatalogResources(
  params: PageParams & { search?: string; status?: string; scope?: string; ownerId?: string } = {},
) {
  const query = queryString(
    { search: params.search, status: params.status, scope: params.scope, ownerId: params.ownerId },
    params,
  );
  return a3GetJson<A3AdminCatalogResourcesResponse>(`/api/admin/catalog/resources/?${query}`);
}

export function updateA3AdminCatalogResourceStatus(
  resourceId: string,
  status: 'published' | 'offline',
  reason: string,
) {
  return a3PostJson<A3AdminApiResponse & { resource?: A3AdminKnowledgeResource }>(
    `/api/admin/catalog/resources/${detailPathPart(resourceId)}/status/`,
    { status, reason: requireReason(reason) },
  );
}

export function reindexA3AdminCatalogResource(resourceId: string, reason: string) {
  return a3PostJson<A3AdminApiResponse & { resource?: { id: string; status: string }; job?: { id: string; kind: string; status: string } }>(
    `/api/admin/catalog/resources/${detailPathPart(resourceId)}/reindex/`,
    { reason: requireReason(reason) },
  );
}

export function getA3AdminTasks(
  params: PageParams & { kind?: A3AdminTaskKind; status?: string; userId?: string; search?: string } = {},
) {
  const query = queryString(
    { kind: params.kind, status: params.status, userId: params.userId, search: params.search },
    params,
  );
  return a3GetJson<A3AdminTasksResponse>(`/api/admin/tasks/?${query}`);
}

export function getA3AdminTask(kind: A3AdminTaskKind, taskId: string) {
  return a3GetJson<A3AdminApiResponse & { task?: A3AdminTask }>(
    `/api/admin/tasks/${kind}/${detailPathPart(taskId)}/`,
  );
}

export function retryA3AdminTask(kind: A3AdminTaskKind, taskId: string, reason: string) {
  return a3PostJson<A3AdminApiResponse & { task?: A3AdminTask }>(
    `/api/admin/tasks/${kind}/${detailPathPart(taskId)}/retry/`,
    { reason: requireReason(reason) },
  );
}

export function cancelA3AdminTask(kind: A3AdminTaskKind, taskId: string, reason: string) {
  return a3PostJson<A3AdminApiResponse & { task?: A3AdminTask }>(
    `/api/admin/tasks/${kind}/${detailPathPart(taskId)}/cancel/`,
    { reason: requireReason(reason) },
  );
}

export function getA3AdminAgentRuns(params: PageParams & { search?: string; status?: string; workflow?: string; userId?: string } = {}) {
  const query = queryString(
    { search: params.search, status: params.status, workflow: params.workflow, userId: params.userId },
    params,
  );
  return a3GetJson<A3AdminAgentRunsResponse>(`/api/admin/agent-runs/?${query}`);
}

export function getA3AdminAgentRun(traceId: string) {
  return a3GetJson<A3AdminApiResponse & { run?: A3AdminAgentRunDetail }>(
    `/api/admin/agent-runs/${detailPathPart(traceId)}/`,
  );
}

export function getA3AdminSecurityEvents(
  params: PageParams & { category?: string; severity?: string; source?: string; reviewStatus?: string } = {},
) {
  const query = queryString(
    { category: params.category, severity: params.severity, source: params.source, reviewStatus: params.reviewStatus },
    params,
  );
  return a3GetJson<A3AdminSecurityEventsResponse>(`/api/admin/security-events/?${query}`);
}

export function reviewA3AdminSecurityEvent(
  eventId: string,
  status: Exclude<A3AdminSecurityReviewStatus, 'pending'>,
  reason: string,
  note = '',
) {
  return a3PostJson<A3AdminApiResponse & { event?: Pick<A3AdminSecurityEvent, 'id' | 'reviewStatus' | 'reviewedAt'> }>(
    `/api/admin/security-events/${detailPathPart(eventId)}/review/`,
    { status, reason: requireReason(reason), note },
  );
}

export function getA3AdminConfiguration() {
  return a3GetJson<A3AdminConfigurationResponse>('/api/admin/configuration/');
}

export function verifyA3AdminConfiguration(check: string, reason: string) {
  return a3PostJson<A3AdminApiResponse & { item?: A3AdminConfigurationCheck }>(
    `/api/admin/configuration/${detailPathPart(check)}/verify/`,
    { reason: requireReason(reason) },
  );
}

export function getA3AdminAuditLogs(
  params: PageParams & { action?: string; targetType?: string; actorId?: string; success?: boolean } = {},
) {
  const query = queryString(
    { action: params.action, targetType: params.targetType, actorId: params.actorId, success: params.success },
    params,
  );
  return a3GetJson<A3AdminAuditLogsResponse>(`/api/admin/audit-logs/?${query}`);
}
