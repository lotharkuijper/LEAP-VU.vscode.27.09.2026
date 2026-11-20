// Client voor beeldoefeningen, docentkant (server/imageExercises/routes.js).
import { authHeaders, fileToBase64 } from '../lib/authFetch';

export type MatchSource = 'name' | 'number' | 'order' | 'suggested' | 'manual' | 'typed';
export type Depth = 'name' | 'describe' | 'interpret';
export type CountDisplay = 'exact' | 'approx' | 'none';

export interface ImageFeature {
  id?: string;
  label: string;
  observation: string;
  interpretation: string;
  is_core: boolean;
  open_interpretation: boolean;
  source?: 'auto' | 'teacher';
}

export interface ImageExercise {
  id: string;
  filename: string;
  position: number;
  imageUrl: string | null;
  description: string;
  matchSource: MatchSource | null;
  confirmed: boolean;
  depth: Depth;
  countDisplay: CountDisplay;
  featuresStatus: 'none' | 'pending' | 'ready' | 'failed';
  featuresUncertain: boolean;
  featuresNote: string;
  featuresReviewed: boolean;
  features: ImageFeature[];
}

export interface DescriptionResult {
  sections: number;
  matched: Array<{ id: string; source: MatchSource }>;
  unmatchedSections: Array<{ heading: string; text: string }>;
  alreadyConfirmed: number;
}

export class ImageExerciseError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ImageExerciseError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

const base = (courseId: string) => `/api/admin/image-exercises/${encodeURIComponent(courseId)}`;

export const fetchImageExercises = (courseId: string) =>
  request<{ exercises: ImageExercise[] }>(base(courseId)).then((r) => r.exercises);

export async function uploadImageExercisePhoto(courseId: string, file: File) {
  return request<{ id: string }>(`${base(courseId)}/photos`, {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, data: await fileToBase64(file) }),
  });
}

export async function uploadDescriptions(courseId: string, input: { file: File } | { text: string }) {
  const body = 'file' in input
    ? { filename: input.file.name, data: await fileToBase64(input.file) }
    : { text: input.text };
  return request<DescriptionResult>(`${base(courseId)}/descriptions`, { method: 'POST', body: JSON.stringify(body) });
}

export const suggestImageMatches = (courseId: string, sections: string[]) =>
  request<{ suggestions: Array<{ id: string; section: number; confidence: 'high' | 'low' }> }>(`${base(courseId)}/suggest`, {
    method: 'POST',
    body: JSON.stringify({ sections }),
  });

export const confirmImageExercises = (courseId: string, ids: string[]) =>
  request<{ confirmed: string[] }>(`${base(courseId)}/confirm`, { method: 'POST', body: JSON.stringify({ ids }) });

export const updateImageExercise = (
  courseId: string,
  id: string,
  patch: { description?: string; matchSource?: MatchSource; depth?: Depth; countDisplay?: CountDisplay },
) => request<{ ok: true }>(`${base(courseId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const regenerateFeatures = (courseId: string, id: string) =>
  request<{ ok: true }>(`${base(courseId)}/${id}/regenerate`, { method: 'POST' });

export const saveImageFeatures = (courseId: string, id: string, features: ImageFeature[]) =>
  request<{ ok: true; count: number }>(`${base(courseId)}/${id}/features`, { method: 'PUT', body: JSON.stringify({ features }) });

export const setImageFeatureCore = (courseId: string, featureId: string, isCore: boolean) =>
  request<{ ok: true }>(`${base(courseId)}/features/${featureId}`, { method: 'PATCH', body: JSON.stringify({ isCore }) });

export const deleteImageExercise = (courseId: string, id: string) =>
  request<{ ok: true }>(`${base(courseId)}/${id}`, { method: 'DELETE' });
