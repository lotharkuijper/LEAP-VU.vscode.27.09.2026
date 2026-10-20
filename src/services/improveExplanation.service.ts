// "Verbeter deze uitleg" (server/flawedExplanations.js): de server maakt een
// uitleg met één of meer fouten, beoordeelt het antwoord en maakt op verzoek een
// reflectie voor het dagboek. De browser houdt alleen het versleutelde pakketje vast.
import { supabase } from '../lib/supabase';
import { getActiveLang } from '../i18n/activeLang';

export interface ImproveExercise {
  text: string;
  token: string;
}

export interface ImproveFeedback {
  found: number | null;
  total: number;
  foundDetail: string;
  reasoning: string;
  wronglyFlagged: string;
  nextStep: string;
}

export interface ImproveReveal {
  correct: string;
  errors: Array<{ sentence: string; type: string; why: string; correct: string; source: number }>;
  sources: Array<{ index: number; title: string; documentId: string | null; excerpt: string }>;
}

export class ImproveError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ lang: getActiveLang(), ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ImproveError(data.error || `HTTP ${res.status}`, res.status, data.code);
  return data as T;
}

export function createImproveExercise(conceptId: string, courseId: string | null): Promise<ImproveExercise> {
  return post('/api/explain/improve/create', { conceptId, courseId });
}

export function evaluateImproveAnswer(token: string, answer: string): Promise<{ feedback: ImproveFeedback; reveal: ImproveReveal }> {
  return post('/api/explain/improve/evaluate', { token, answer });
}

export function saveImproveReflection(token: string, answer: string, feedback: ImproveFeedback): Promise<{ journalEntryId: string }> {
  return post('/api/explain/improve/reflect', { token, answer, feedback });
}
