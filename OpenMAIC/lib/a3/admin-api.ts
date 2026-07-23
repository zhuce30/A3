import { a3GetJson, a3PostJson } from './api-client';
import type { A3AdminOverview, A3AdminUser, A3AdminUsersResponse } from './admin-types';

export function getA3AdminOverview() {
  return a3GetJson<A3AdminOverview>('/api/admin/overview/');
}

export function getA3AdminUsers(params: { search?: string; role?: string; status?: string; page?: number; pageSize?: number }) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  return a3GetJson<A3AdminUsersResponse>(`/api/admin/users/?${query.toString()}`);
}

export function getA3AdminUser(userId: string) {
  return a3GetJson<{ success: boolean; error?: string; user?: A3AdminUser }>(`/api/admin/users/${userId}/`);
}

export function updateA3AdminUserStatus(userId: string, isActive: boolean, reason: string) {
  return a3PostJson<{ success: boolean; error?: string; user?: A3AdminUser }>(
    `/api/admin/users/${userId}/status/`,
    { isActive, reason },
  );
}

export function revealA3AdminUserIp(userId: string, field: 'last' | 'registration', reason: string) {
  return a3PostJson<{ success: boolean; error?: string; ip?: string | null; dataStatus?: string }>(
    `/api/admin/users/${userId}/reveal-ip/`,
    { field, reason },
  );
}
