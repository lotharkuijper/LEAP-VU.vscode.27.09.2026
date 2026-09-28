// Antwoord van de server op "klaar voor een hoger niveau?" (zie server/readiness.js).
export interface ReadinessResult {
  verdict: 'ready' | 'almost' | 'not_yet' | null;
  /** Telt dit oordeel voor het feest + achievement? (server beslist) */
  eligible: boolean;
  reason: 'not_ready' | 'no_verdict' | 'max_level' | 'too_short' | null;
  currentLevel: number;
  nextLevel: number;
  /** Onderwerp (goedgekeurd begrip uit de cursus) of null = hele cursus. */
  topic: string | null;
  achievement: { id: string; isNew: boolean; earnedAt: string } | null;
}

/** Feest tonen? Alleen bij een positief én geldig oordeel. */
export const shouldCelebrate = (r: ReadinessResult | null | undefined): boolean =>
  !!r && r.verdict === 'ready' && r.eligible;
