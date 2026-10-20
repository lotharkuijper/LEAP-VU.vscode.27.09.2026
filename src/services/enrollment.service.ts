import { supabase } from '../lib/supabase';

// Toegangsroute per cursus en open registratie (server/enrollment.js).

export type EnrollmentMode = 'closed' | 'canvas' | 'open' | 'canvas_open';
export const ENROLLMENT_MODES: EnrollmentMode[] = ['closed', 'canvas', 'open', 'canvas_open'];
export const allowsOpenRegistration = (m: string | null | undefined) => m === 'open' || m === 'canvas_open';

export interface OpenCourse { id: string; name: string; description: string }

export class EnrollmentError extends Error {
  code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

async function call<T>(url: string, init: RequestInit = {}, withAuth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new EnrollmentError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

/** Cursussen die via open registratie te kiezen zijn (ook zonder login). */
export const fetchOpenCourses = () => call<{ courses: OpenCourse[] }>('/api/courses/open', {}, false).then((r) => r.courses);

/** Open registratie: account aanmaken met gekozen cursussen. */
export const registerOpen = (b: { fullName: string; email: string; password: string; courseIds: string[] }) =>
  call<{ ok: true; needsConfirmation: boolean }>('/api/auth/register', { method: 'POST', body: JSON.stringify(b) }, false);

/** Na inloggen: gekozen cursussen worden lidmaatschappen (idempotent). */
export const activateEnrollments = () =>
  call<{ activated: string[]; waiting?: number }>('/api/me/activate-enrollments', { method: 'POST' }).catch(() => ({ activated: [] as string[] }));

export const joinCourse = (courseId: string) => call<{ ok: true }>(`/api/courses/${courseId}/join`, { method: 'POST' });
export const leaveCourse = (courseId: string) => call<{ ok: true }>(`/api/courses/${courseId}/membership`, { method: 'DELETE' });

/** Alleen beheerder. */
export const setEnrollmentMode = (courseId: string, mode: EnrollmentMode, confirmBoth = false) =>
  call<{ ok: true; mode: EnrollmentMode }>(`/api/admin/courses/${courseId}/enrollment-mode`, { method: 'PUT', body: JSON.stringify({ mode, confirmBoth }) });

/** Pure: VU-adres (vu.nl of subdomein), zoals op de server. */
export function isVuEmail(email: string): boolean {
  const host = String(email || '').trim().toLowerCase().split('@')[1] || '';
  return host === 'vu.nl' || host.endsWith('.vu.nl');
}
