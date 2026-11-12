/**
 * Bronnen-mix van de quiz (Task #57): hoeveel vragen uit het cursusmateriaal,
 * de ItemBank en vrij gegenereerd komen. De quiz zelf stelt sinds 2026-11-12 de
 * server samen (server/quiz/quizSession.js), volgens dezelfde verdeling; de
 * browser toont vooraf alleen de verwachte verdeling.
 */

import { supabase } from '../lib/supabase';
import type { QuizSource } from './llm.service';
import { DEFAULT_MIX, type SourceMix } from '../../server/quiz/quizSourcesMix.js';

export { distributeMix } from '../../server/quiz/quizSourcesMix.js';
export type { SourceMix, MixCounts } from '../../server/quiz/quizSourcesMix.js';

export async function fetchSourceMix(courseId: string | null): Promise<SourceMix> {
  if (!courseId) return DEFAULT_MIX;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {};
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
    const res = await fetch(`/api/quiz-sources-mix/${courseId}`, { headers });
    if (!res.ok) return DEFAULT_MIX;
    const data = await res.json();
    return data?.mix || DEFAULT_MIX;
  } catch {
    return DEFAULT_MIX;
  }
}

/** Voortgang voor de wachtbalk tijdens het samenstellen. */
export type QuizProgressPhase = 'writing' | 'checking' | 'repairing' | 'replacing' | 'done';

/** Samenvatting van de kwaliteitscontrole over alle bronnen, voor de UI. */
export interface VerificationSummary {
  accepted: number;
  repaired: number;
  /** Inhoudelijk afgekeurd. */
  rejected: number;
  /** Niet te controleren door een technische fout (niet doorgelaten). */
  failed: number;
  /** Laatste technische foutmelding, voor de "technische details" in de UI. */
  lastError?: string;
}

export const SOURCE_LABELS: Record<QuizSource, string> = {
  rag: 'Cursusmateriaal',
  itembank: 'ItemBank',
  llm: 'LLM-creatief',
};

export const SOURCE_COLORS: Record<QuizSource, string> = {
  rag: 'bg-blue-50 text-blue-700 border-blue-200',
  itembank: 'bg-purple-50 text-purple-700 border-purple-200',
  llm: 'bg-amber-50 text-amber-700 border-amber-200',
};
