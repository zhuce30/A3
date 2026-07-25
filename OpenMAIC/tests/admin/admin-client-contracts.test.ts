import { beforeEach, describe, expect, it, vi } from 'vitest';

const { a3GetJson, a3PostJson } = vi.hoisted(() => ({ a3GetJson: vi.fn(), a3PostJson: vi.fn() }));

vi.mock('../../lib/a3/api-client', () => ({ a3GetJson, a3PostJson }));

import {
  cancelA3AdminTask,
  getA3AdminAgentRun,
  getA3AdminAgentRuns,
  getA3AdminAuditLogs,
  getA3AdminCatalogCourses,
  getA3AdminCatalogResources,
  getA3AdminConfiguration,
  getA3AdminConversation,
  getA3AdminConversations,
  getA3AdminOverview,
  getA3AdminSecurityEvents,
  getA3AdminTask,
  getA3AdminTasks,
  getA3AdminUser,
  getA3AdminUsers,
  reindexA3AdminCatalogResource,
  retryA3AdminTask,
  revealA3AdminConversation,
  revealA3AdminUserIp,
  reviewA3AdminSecurityEvent,
  updateA3AdminCatalogCourseStatus,
  updateA3AdminCatalogResourceStatus,
  updateA3AdminUserStatus,
  verifyA3AdminConfiguration,
} from '../../lib/a3/admin-api';

describe('admin typed client contracts', () => {
  beforeEach(() => {
    a3GetJson.mockReset();
    a3PostJson.mockReset();
  });

  it('uses real list routes and bounded pagination accepted by Django', () => {
    getA3AdminOverview('30d');
    getA3AdminUsers({ search: 'Lin', page: 0, pageSize: 99 });
    getA3AdminConversations({});
    getA3AdminCatalogCourses({ page: 3, pageSize: 8, active: true });
    getA3AdminCatalogResources({ pageSize: 2, scope: 'course' });
    getA3AdminTasks({ pageSize: 100, status: 'failed' });
    getA3AdminAgentRuns({ page: 2 });
    getA3AdminSecurityEvents({ page: 2, pageSize: 25, severity: 'warning' });
    getA3AdminConfiguration();
    getA3AdminAuditLogs({ page: 5, pageSize: 12, action: 'user.disable' });

    expect(a3GetJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/admin/overview/?range=30d',
      '/api/admin/users/?search=Lin&page=1&pageSize=50',
      '/api/admin/conversations/?page=1&pageSize=20',
      '/api/admin/catalog/courses/?active=true&page=3&pageSize=20',
      '/api/admin/catalog/resources/?scope=course&page=1&pageSize=20',
      '/api/admin/tasks/?status=failed&page=1&pageSize=50',
      '/api/admin/agent-runs/?page=2&pageSize=20',
      '/api/admin/security-events/?severity=warning&page=2&pageSize=50',
      '/api/admin/configuration/',
      '/api/admin/audit-logs/?action=user.disable&page=5&pageSize=20',
    ]);
  });

  it('uses only detail routes that actually exist and preserves task kind', () => {
    getA3AdminUser('42');
    getA3AdminConversation('conversation-1');
    getA3AdminTask('knowledge_index', 'task-1');
    getA3AdminAgentRun('trace/1');

    expect(a3GetJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/admin/users/42/',
      '/api/admin/conversations/conversation-1/',
      '/api/admin/tasks/knowledge_index/task-1/',
      '/api/admin/agent-runs/trace%2F1/',
    ]);
  });

  it('sends every mutating operation as POST with a normalized reason', () => {
    updateA3AdminUserStatus('42', false, ' 违规处置 ');
    revealA3AdminUserIp('42', 'last', '安全核查');
    revealA3AdminConversation('conversation-1', '审计复核');
    updateA3AdminCatalogCourseStatus('course-1', false, '课程下线');
    updateA3AdminCatalogResourceStatus('resource-1', 'offline', '资源下线');
    reindexA3AdminCatalogResource('resource-1', '索引修复');
    retryA3AdminTask('knowledge_index', 'task-1', '临时故障恢复');
    cancelA3AdminTask('video_composition', 'task-2', '任务不再需要');
    reviewA3AdminSecurityEvent('event-1', 'resolved', '已完成排查', '证据已核实');
    verifyA3AdminConfiguration('model_provider', '配置复核');

    expect(a3PostJson.mock.calls).toEqual([
      ['/api/admin/users/42/status/', { isActive: false, reason: '违规处置' }],
      ['/api/admin/users/42/reveal-ip/', { field: 'last', reason: '安全核查' }],
      ['/api/admin/conversations/conversation-1/reveal/?page=1&pageSize=20', { reason: '审计复核' }],
      ['/api/admin/catalog/courses/course-1/status/', { isActive: false, reason: '课程下线' }],
      ['/api/admin/catalog/resources/resource-1/status/', { status: 'offline', reason: '资源下线' }],
      ['/api/admin/catalog/resources/resource-1/reindex/', { reason: '索引修复' }],
      ['/api/admin/tasks/knowledge_index/task-1/retry/', { reason: '临时故障恢复' }],
      ['/api/admin/tasks/video_composition/task-2/cancel/', { reason: '任务不再需要' }],
      ['/api/admin/security-events/event-1/review/', { status: 'resolved', reason: '已完成排查', note: '证据已核实' }],
      ['/api/admin/configuration/model_provider/verify/', { reason: '配置复核' }],
    ]);
  });

  it('rejects empty mutation reasons before sending a request', () => {
    expect(() => reindexA3AdminCatalogResource('resource-1', '   ')).toThrow('请填写操作原因');
    expect(a3PostJson).not.toHaveBeenCalled();
  });
});
