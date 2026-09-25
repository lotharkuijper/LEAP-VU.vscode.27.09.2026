// Typen voor server/filePurpose.js (gedeeld met de frontend).
export type Purpose = 'course_material' | 'course_info' | 'project' | 'shared' | 'teacher_only';
export type DocumentPurpose = Exclude<Purpose, 'project'>;
export type MaterialKind = 'assignment' | 'data' | 'literature' | 'other';
export type PurposeModule = 'general' | 'chat' | 'explain' | 'quiz' | 'project' | 'concepts';

export interface PurposeRule {
  rag: boolean;
  chat: boolean;
  explain: boolean;
  quiz: boolean;
  concepts: boolean;
  studentVisible: boolean;
}

export interface PurposeSuggestion {
  purpose: Purpose;
  materialKind?: MaterialKind;
  confidence: 'high' | 'medium' | 'low';
  reason: 'answersOrExam' | 'dataFile' | 'courseInfoName' | 'assignmentName' | 'courseInfoText' | 'looksLikeLiterature' | 'textDocument' | 'otherFile';
}

export const PURPOSES: Purpose[];
export const DOCUMENT_PURPOSES: DocumentPurpose[];
export const MATERIAL_KINDS: MaterialKind[];
export const PURPOSE_RULES: Record<Purpose, PurposeRule>;
export function isRagPurpose(p: string | null | undefined): boolean;
export function purposeAllowsModule(purpose: string | null | undefined, module: PurposeModule | string): boolean;
export function suggestPurpose(input?: { filename?: string; title?: string; fileType?: string; textSample?: string }): PurposeSuggestion;
export function effectivePurpose(doc: { purpose?: string | null; bucket?: string | null } | null | undefined, folder?: { folder_type?: string | null } | null): Purpose;
export function looksSensitive(input?: { filename?: string; title?: string }): boolean;
