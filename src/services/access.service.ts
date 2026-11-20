// Client voor toegangsaanvragen van medewerkers (server/access/accessRequests.js).
import { authHeaders } from '../lib/authFetch';

export type RoleWish = 'teacher' | 'student' | 'unsure';
export interface CatalogCourse { id: string; name: string; description: string }
export interface MyAccess {
  staff: boolean;
  courseCount: number;
  requests: Array<{ id: string; status: 'open' | 'closed'; createdAt: string; wished: string[]; granted: string[] }>;
}
export interface AdminAccessRequest {
  id: string;
  status: 'open' | 'closed';
  message: string;
  role: RoleWish;
  createdAt: string;
  handledAt: string | null;
  user: { id: string; name: string; email: string };
  wished: string[];
  granted: string[];
}

export class AccessError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AccessError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

export const fetchMyAccess = () => request<MyAccess>('/api/access/me');
export const fetchCatalog = () => request<{ courses: CatalogCourse[] }>('/api/access/catalog').then((r) => r.courses);
export const sendAccessRequest = (body: { message: string; courseIds: string[]; role: RoleWish }) =>
  request<{ ok: true; id: string }>('/api/access/requests', { method: 'POST', body: JSON.stringify(body) });

export const fetchAccessRequests = (all = false) =>
  request<{ courses: CatalogCourse[]; requests: AdminAccessRequest[] }>(`/api/admin/access-requests${all ? '?status=all' : ''}`);
export const grantAccess = (id: string, courseId: string, role: 'teacher' | 'student') =>
  request<{ ok: true; granted: string[]; previousRole: 'teacher' | 'student' | null }>(`/api/admin/access-requests/${id}/grant`, { method: 'POST', body: JSON.stringify({ courseId, role }) });
export const closeAccessRequest = (id: string) =>
  request<{ ok: true }>(`/api/admin/access-requests/${id}/close`, { method: 'POST' });

/** Medewerkersadres (spiegel van isStaffEmail in server/courses/enrollment.js): precies vu.nl of amsterdamumc.nl. */
export const STAFF_DOMAINS = ['vu.nl', 'amsterdamumc.nl'];
export function isStaffEmail(email: string): boolean {
  const host = String(email || '').trim().toLowerCase().split('@')[1] || '';
  return STAFF_DOMAINS.includes(host);
}
