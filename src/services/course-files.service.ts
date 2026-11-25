// Client voor het cursusmateriaal-beheer met bestandsdoelen (server/documents/courseFiles.js).
import { authHeaders, fileToBase64 } from '../lib/authFetch';
import type { Purpose, MaterialKind, PurposeSuggestion } from '../../server/rag/filePurpose.js';

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
  /** Adres van een webpagina (alleen bij isWeb). */
  url?: string | null;
  /** Websitebron waar deze pagina bij hoort (null = losse pagina of geen migratie). */
  webSourceId?: string | null;
  folderName: string | null;
  purpose: Purpose;
  purposeConfirmed: boolean;
  suggestion: PurposeSuggestion | null;
}

export interface WebSyncSummary {
  total: number;
  imported: number;
  unchanged: number;
  skipped: number;
  errors: number;
  notFound: number;
}

/** Een website als één bron: alle pagina's samen. */
export interface WebSource {
  id: string;
  baseUrl: string;
  title: string;
  purpose: 'course_material' | 'course_info';
  createdAt: string;
  lastSyncedAt: string | null;
  lastSync: WebSyncSummary | null;
  pageCount: number;
  chunkCount: number;
  failedPages: number;
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
  /** Hoe LEAP het begrip uitlegt (definitie). */
  definition: string | null;
  /** Studenten zien het (goedgekeurd). */
  visible: boolean;
  /** Nieuw gevonden, wacht op beoordeling door de docent. */
  review: boolean;
  role: string | null;
  difficulty: string | null;
  evidenceDocuments: number;
  quizReady: boolean;
  itembankSections: number;
}

export type WarningCode =
  | 'unconfirmedPurposes' | 'noCourseMaterial' | 'sensitiveVisible' | 'processingFailed' | 'processingBusy'
  | 'noChunks' | 'singleGiantChunk' | 'conceptsWithoutEvidence' | 'noConcepts' | 'projectWithoutDocuments' | 'docsChanged'
  | 'webSourceProblems' | 'webSourceStale';

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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...(await authHeaders()), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CourseFilesError(body?.error || `HTTP ${res.status}`, body?.code);
  return body as T;
}

export const fetchCourseFiles = (courseId: string) =>
  request<{ files: CourseFile[]; projects: CourseProject[]; webSources?: WebSource[]; unconfirmedCount: number }>(`/api/admin/course-files/${courseId}`);

export const fetchReadiness = (courseId: string) =>
  request<Readiness>(`/api/admin/course-readiness/${courseId}`);

export const changePurpose = (courseId: string, docId: string, d: Omit<PurposeDecision, 'docId'>) =>
  request<{ purpose: Purpose; reprocessing?: boolean }>(`/api/admin/course-files/${courseId}/documents/${docId}`, {
    method: 'PATCH',
    body: JSON.stringify(d),
  });

/** Fragmenten per document van de cursus, geteld in de database (geen limiet van 1000 rijen). */
export const fetchChunkStats = (courseId: string) =>
  request<{ documents: Array<{ id: string; chunks: number; hasPageData: boolean }> }>(`/api/admin/course-files/${courseId}/chunk-stats`);

export interface DeletePreview { files: number; webSources: number; webPages: number; chunks: number; conceptsLosingEvidence: number; needsName: boolean; courseName: string }
export interface DeleteSelection { docIds: string[]; webSourceIds: string[] }

/** Wat er weggaat bij het verwijderen van een selectie (alleen tellen). */
export const previewDeleteCourseFiles = (courseId: string, sel: DeleteSelection) =>
  request<DeletePreview>(`/api/admin/course-files/${courseId}/delete-preview`, { method: 'POST', body: JSON.stringify(sel) });

/** Verwijder een selectie bestanden en websites; boven de drempel met de getypte cursusnaam. */
export const deleteCourseFiles = (courseId: string, sel: DeleteSelection, confirmName: string) =>
  request<{ deleted: number; webSources: number }>(`/api/admin/course-files/${courseId}/delete`, { method: 'POST', body: JSON.stringify({ ...sel, confirmName }) });

/** Mislukt ingelezen leerstof opnieuw in de wachtrij; zonder docIds alle mislukte van de cursus. */
export const reprocessFailedFiles = (courseId: string, docIds?: string[]) =>
  request<{ queued: number }>(`/api/admin/course-files/${courseId}/reprocess`, {
    method: 'POST',
    body: JSON.stringify(docIds ? { docIds } : {}),
  });

export const changeWebSourcePurpose = (courseId: string, sourceId: string, purpose: WebSource['purpose']) =>
  request<{ purpose: WebSource['purpose']; pages: number; failed: number }>(`/api/admin/course-files/${courseId}/web-sources/${sourceId}`, {
    method: 'PATCH',
    body: JSON.stringify({ purpose }),
  });

export const deleteWebSource = (courseId: string, sourceId: string) =>
  request<{ deleted: number }>(`/api/admin/course-files/${courseId}/web-sources/${sourceId}`, { method: 'DELETE' });

export interface YouTubeImportResult {
  title: string;
  author: string | null;
  documentId: string;
  chunks: number;
  /** Fragmenten waarin de spreker naar het beeld verwijst. */
  visualRefs: number;
  /** De video stond al in de cursus en is bijgewerkt. */
  updated: boolean;
}

/** Een YouTube-video als bron: link + geplakt transcript (server/ingestion/youtubeRoutes.js). */
export const importYouTubeVideo = (courseId: string, url: string, transcript: string, title?: string) =>
  request<YouTubeImportResult>('/api/admin/import-youtube', {
    method: 'POST',
    body: JSON.stringify({ courseId, url, transcript, ...(title ? { title } : {}) }),
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

export interface SearchScope {
  /** Leerstof waarin begrippen gezocht kunnen worden; isNew = nieuw of gewijzigd sinds de laatste zoektocht. */
  documents: Array<{ id: string; title: string; isNew: boolean }>;
  lastSearchAt: string | null;
  /** Begrippen die de docent verwijderde en die bij zoeken worden overgeslagen. */
  removedCount: number;
}

export const fetchConceptSearchScope = (courseId: string) =>
  request<SearchScope>(`/api/admin/concepts/search-scope?courseId=${encodeURIComponent(courseId)}`);

export const resetRemovedConcepts = (courseId: string) =>
  request<{ ok: boolean }>('/api/admin/concepts/removed-reset', { method: 'POST', body: JSON.stringify({ courseId }) });

/** De docent past aan hoe LEAP een begrip uitlegt. */
export const updateConceptDefinition = (courseId: string, conceptId: string, definition: string) =>
  request<{ id: string; definition: string }>(`/api/admin/concepts/${conceptId}`, {
    method: 'PATCH',
    body: JSON.stringify({ courseId, definition }),
  });

export async function uploadCourseFile(
  courseId: string,
  file: File,
  d: { purpose: Purpose; projectId?: string; materialKind?: MaterialKind },
) {
  return request<{ purpose: Purpose; documentId?: string; processing?: boolean; warning?: string }>(
    `/api/admin/course-files/${courseId}/upload`,
    {
      method: 'POST',
      body: JSON.stringify({ filename: file.name, mimeType: file.type || undefined, data: await fileToBase64(file), ...d }),
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

// ── Leerlijn: volgorde van de stof (server/courses/courseUnits.js) ──────────────────
export interface LeerlijnUnit { id: string; title: string; position: number }
export interface Leerlijn { available: boolean; units: LeerlijnUnit[]; documents: Array<{ documentId: string; unitId: string }> }
export interface LeerlijnProposal { units: Array<{ title: string; position: number; documentIds: string[] }>; unplaced: string[] }

export const fetchLeerlijn = (courseId: string) =>
  request<Leerlijn>(`/api/courses/${courseId}/leerlijn`);

export const fetchLeerlijnProposal = (courseId: string) =>
  request<LeerlijnProposal>(`/api/admin/courses/${courseId}/leerlijn/proposal`);

export const saveLeerlijn = (courseId: string, body: { units: Array<{ key: string; title: string; position: number }>; assignments: Array<{ documentId: string; unitKey: string }> }) =>
  request<{ ok: true }>(`/api/admin/courses/${courseId}/leerlijn`, { method: 'PUT', body: JSON.stringify(body) });
