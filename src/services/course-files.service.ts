// Client voor het cursusmateriaal-beheer met bestandsdoelen (server/courseFiles.js).
import { supabase } from '../lib/supabase';
import type { Purpose, MaterialKind, PurposeSuggestion } from '../../server/filePurpose.js';

export type { Purpose, MaterialKind, PurposeSuggestion };

export interface CourseFile {
  id: string;
  title: string;
  filename: string | null;
  file_type: string | null;
  file_size: number | null;
  created_at: string;
  processing_status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  total_chunks: number | null;
  isWeb: boolean;
  folderName: string | null;
  purpose: Purpose;
  purposeConfirmed: boolean;
  suggestion: PurposeSuggestion | null;
}

export interface ProjectDocument {
  id: string;
  project_id: string;
  filename: string;
  byte_size: number | null;
  mime_type: string | null;
  material_kind: MaterialKind | null;
  is_visible_to_students: boolean;
  created_at: string;
}

export interface CourseProject {
  id: string;
  title: string;
  documents: ProjectDocument[];
}

export interface ReadinessConcept {
  id: string;
  name: string;
  visible: boolean;
  role: string | null;
  difficulty: string | null;
  evidenceDocuments: number;
  quizReady: boolean;
  itembankSections: number;
}

export type WarningCode =
  | 'unconfirmedPurposes' | 'noCourseMaterial' | 'sensitiveVisible' | 'processingFailed' | 'processingBusy'
  | 'noChunks' | 'singleGiantChunk' | 'conceptsWithoutEvidence' | 'noConcepts' | 'projectWithoutDocuments';

export interface ReadinessWarning {
  code: WarningCode;
  severity: 'error' | 'warning' | 'info';
  step: 'files' | 'processing' | 'concepts' | 'ready';
  count: number;
  items: string[];
}

export interface Readiness {
  counts: Partial<Record<Purpose, number>>;
  concepts: ReadinessConcept[];
  projects: CourseProject[];
  warnings: ReadinessWarning[];
}

export interface PurposeDecision {
  docId: string;
  purpose: Purpose;
  projectId?: string;
  materialKind?: MaterialKind;
}

export class CourseFilesError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

async function authHeaders(json = true): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (session?.access_token) h.Authorization = `Bearer ${session.access_token}`;
  return h;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CourseFilesError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

export const fetchCourseFiles = (courseId: string) =>
  request<{ files: CourseFile[]; projects: CourseProject[]; unconfirmedCount: number }>(`/api/admin/course-files/${courseId}`);

export const fetchReadiness = (courseId: string) =>
  request<Readiness>(`/api/admin/course-readiness/${courseId}`);

export const changePurpose = (courseId: string, docId: string, d: Omit<PurposeDecision, 'docId'>) =>
  request<{ purpose: Purpose; reprocessing?: boolean }>(`/api/admin/course-files/${courseId}/documents/${docId}`, {
    method: 'PATCH',
    body: JSON.stringify(d),
  });

export const applyReview = (courseId: string, decisions: PurposeDecision[]) =>
  request<{ ok: boolean; results: Array<{ docId: string; ok: boolean; error?: string }> }>(`/api/admin/course-files/${courseId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decisions }),
  });

export const setConceptVisibility = (courseId: string, conceptId: string, visible: boolean) =>
  request<{ id: string; visible: boolean }>(`/api/admin/course-files/${courseId}/concepts/${conceptId}/visibility`, {
    method: 'POST',
    body: JSON.stringify({ visible }),
  });

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadCourseFile(
  courseId: string,
  file: File,
  d: { purpose: Purpose; projectId?: string; materialKind?: MaterialKind },
) {
  return request<{ purpose: Purpose; documentId?: string; processing?: boolean; warning?: string }>(
    `/api/admin/course-files/${courseId}/upload`,
    {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, mimeType: file.type || undefined, data: await toBase64(file), ...d }),
    },
  );
}

export async function updateProjectDocument(projectId: string, docId: string, patch: { material_kind?: MaterialKind | null; is_visible_to_students?: boolean }) {
  return request<{ document: unknown }>(`/api/projects/${projectId}/documents/${docId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function downloadCourseFile(docId: string, filename: string) {
  const res = await fetch(`/api/admin/documents/${docId}/download`, { headers: await authHeaders(false) });
  if (!res.ok) throw new CourseFilesError(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const { url } = await res.json();
    if (url) window.open(url, '_blank', 'noopener');
    return;
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export async function deleteCourseFile(docId: string) {
  return request<unknown>(`/api/admin/documents/${docId}`, { method: 'DELETE' });
}
