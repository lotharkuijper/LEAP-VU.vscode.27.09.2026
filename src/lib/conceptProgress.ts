// Jouw voortgang per begrip, en wat je het best kunt oefenen (2026-10-09).
//
// Alleen voor de student zelf: rekent met de eigen quizpogingen in de browser,
// niets gaat naar de server of naar een docent.
//
// Gespreide herhaling, eenvoudig en uitlegbaar:
//  * beheersing = gemiddelde van je laatste 3 pogingen op dit begrip;
//  * hoe beter je het beheerst, hoe langer je kunt wachten met herhalen:
//    de herhaaltermijn loopt van 1 dag (0%) tot 14 dagen (100%);
//  * volgorde: eerst wat je nog lastig vindt (onder 60%), dan wat aan herhaling
//    toe is, dan wat je nog nooit hebt geoefend, en als laatste wat goed gaat;
//    binnen elke groep: wat je minder beheerst en langer niet deed eerst.

export interface ProgressTopic { id: string; name: string }
export interface ProgressAttempt { topics: string[] | null; score_percentage: number | null; created_at: string }

export type ProgressReason = 'weak' | 'due' | 'new' | 'ok';

export interface ConceptProgress {
  id: string;
  name: string;
  attempts: number;
  /** Gemiddelde van de laatste 3 pogingen (0–100), of null als nooit geoefend. */
  mastery: number | null;
  lastPractisedAt: string | null;
  /** Dagen sinds de laatste poging (afgerond), of null. */
  daysSince: number | null;
  priority: number;
  reason: ProgressReason;
}

const DAY = 24 * 3600 * 1000;
const RECENT = 3;
export const WEAK_BELOW = 60;
const NEW_PRIORITY = 0.5;
const TIER: Record<ProgressReason, number> = { weak: 3, due: 2, new: 1, ok: 0 };

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Herhaaltermijn in dagen bij een beheersing van 0–100. */
export function reviewIntervalDays(mastery: number): number {
  return 1 + 13 * Math.max(0, Math.min(100, mastery)) / 100;
}

export function buildConceptProgress(topics: ProgressTopic[], attempts: ProgressAttempt[], now: Date = new Date()): ConceptProgress[] {
  const sorted = [...attempts]
    .filter(a => typeof a.score_percentage === 'number' && Array.isArray(a.topics))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)); // nieuwste eerst
  return topics.map((t) => {
    const key = norm(t.name);
    const mine = sorted.filter(a => (a.topics || []).some(x => norm(x) === key));
    if (mine.length === 0) {
      return { id: t.id, name: t.name, attempts: 0, mastery: null, lastPractisedAt: null, daysSince: null, priority: NEW_PRIORITY, reason: 'new' as const };
    }
    const recent = mine.slice(0, RECENT);
    const mastery = Math.round(recent.reduce((s, a) => s + (a.score_percentage as number), 0) / recent.length);
    const last = mine[0].created_at;
    const days = Math.max(0, (now.getTime() - new Date(last).getTime()) / DAY);
    const overdue = days / reviewIntervalDays(mastery);
    const priority = (1 - mastery / 100) + 0.5 * Math.min(overdue, 2);
    const reason: ProgressReason = mastery < WEAK_BELOW ? 'weak' : overdue >= 1 ? 'due' : 'ok';
    return { id: t.id, name: t.name, attempts: mine.length, mastery, lastPractisedAt: last, daysSince: Math.floor(days), priority, reason };
  }).sort((a, b) => (TIER[b.reason] - TIER[a.reason]) || (b.priority - a.priority) || a.name.localeCompare(b.name));
}

/**
 * De begrippen om nu te oefenen: eerst zwak, dan aan herhaling toe, dan nieuw.
 * Begrippen die je goed beheerst en die nog niet aan de beurt zijn, alleen als
 * er niets anders is.
 */
export function pickPracticeSet(progress: ConceptProgress[], n = 3): ConceptProgress[] {
  const needed = progress.filter(p => p.reason !== 'ok');
  return (needed.length > 0 ? needed : progress).slice(0, n);
}

/** Standaardmoeilijkheid bij een leerniveau (1–5): de student kan altijd zelf kiezen. */
export function difficultyForLevel(level: number | null | undefined): 'easy' | 'medium' | 'hard' {
  if (!level || level <= 2) return 'easy';
  if (level === 3) return 'medium';
  return 'hard';
}
