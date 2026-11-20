// Client voor het speelbord van beeldoefeningen (server/imageExercises/playRoutes.js).
// De browser krijgt alleen wat de student mag zien: gevonden kenmerken, en pas na
// afronden alles.
import { authHeaders } from '../lib/authFetch';

export interface PlayListItem {
  id: string;
  number: number;
  imageUrl: string | null;
  status: 'new' | 'active' | 'finished';
  coreDone: boolean;
  found: number;
}

export interface PlayTile {
  id: string;
  core: boolean;
  state: 'none' | 'half' | 'full';
  how: 'self' | 'hint' | null;
  label: string;
  observation?: string;
  interpretation?: string;
}

export type PlayCount = { mode: 'exact'; core: number; extra: number } | { mode: 'approx'; about: number } | { mode: 'none' };

export interface PlayTurn {
  role: 'student' | 'leap';
  text: string;
  code: 'generic' | 'hintGeneric' | 'closingGeneric' | null;
  kind: 'hint' | 'reveal' | 'closing' | null;
}

export interface PlayState {
  exercise: { id: string; number: number; imageUrl: string | null; depth: 'name' | 'describe' | 'interpret' };
  board: {
    tiles: PlayTile[];
    count: PlayCount;
    score: { core: number; extra: number; coreTotal?: number; extraTotal?: number };
    coreDone: boolean;
    allDone: boolean;
  };
  turns: PlayTurn[];
  answersLeft: number;
  finished: boolean;
  description?: string;
  newly?: Array<{ id: string; state: 'half' | 'full' }>;
}

export class PlayError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlayError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

const base = (courseId: string) => `/api/image-exercises/${encodeURIComponent(courseId)}`;
const post = <T>(url: string, body?: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body || {}) });

export const fetchPlayList = (courseId: string) => request<{ exercises: PlayListItem[] }>(base(courseId)).then((r) => r.exercises);
export const startPlay = (courseId: string, id: string) => post<PlayState>(`${base(courseId)}/${id}/start`);
export const restartPlay = (courseId: string, id: string) => post<PlayState>(`${base(courseId)}/${id}/restart`);
export const answerPlay = (courseId: string, id: string, text: string) => post<PlayState>(`${base(courseId)}/${id}/answer`, { text });
export const hintPlay = (courseId: string, id: string) => post<PlayState>(`${base(courseId)}/${id}/hint`);
export const finishPlay = (courseId: string, id: string) => post<PlayState>(`${base(courseId)}/${id}/finish`);
