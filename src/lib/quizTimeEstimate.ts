import type { QuestionType } from '../services/llm.service';

// Schatting van de wachttijd voor het genereren van een quiz.
//
// Basis: live gemeten op 2026-09-25 (gpt-5.2 via VU-Azure, genereren +
// blind oplossen + vergelijken, bronnenmix 50/50):
//   mcq   n=1:  7s   n=5: 11s
//   open  n=1: 11s   n=3: 38s (2 van 3 met verbeterronde)
//   casus n=1: 15s   n=3: 15s
// Vragen worden parallel gecontroleerd, dus de tijd groeit minder dan
// evenredig; verbeterrondes geven uitschieters. Vandaar een bandbreedte
// (laag = alles in één keer goed, hoog = met verbeteringen) plus ~3s voor het
// ophalen van cursusmateriaal.
//
// De schatting leert bij: na elke quiz wordt de verhouding werkelijke/geschatte
// tijd per vraagvorm bijgehouden (voortschrijdend gemiddelde in localStorage).

// Volgorde mcq < open < casus blijft voor elk aantal gelden (zelfde perExtra
// voor open en casus); de live-kalibratie stelt de absolute waarden bij.
const MODEL: Record<QuestionType, { base: number; perExtra: number }> = {
  mcq: { base: 7, perExtra: 1 },
  open: { base: 11, perExtra: 3 },
  casus: { base: 14, perExtra: 3 },
};
const RETRIEVAL_SECONDS = 3;
const HIGH_FACTOR = 1.8;
const STORAGE_KEY = 'leapvu:quiz-time-calibration';
const EMA_WEIGHT = 0.3;
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;

type Calibration = Partial<Record<QuestionType, number>>;

function readCalibration(): Calibration {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Kale modelschatting in seconden (zonder kalibratie). */
export function baseEstimateSeconds(type: QuestionType, n: number): number {
  const m = MODEL[type];
  return RETRIEVAL_SECONDS + m.base + m.perExtra * Math.max(0, n - 1);
}

export interface TimeEstimate {
  /** Verwachte duur (voor de voortgangsbalk). */
  expected: number;
  low: number;
  high: number;
}

export function estimateQuizSeconds(type: QuestionType, n: number): TimeEstimate {
  const factor = readCalibration()[type] ?? 1;
  const expected = baseEstimateSeconds(type, Math.max(1, n)) * factor;
  return { expected, low: expected, high: expected * HIGH_FACTOR };
}

/** Werk de kalibratie bij met een gemeten duur (alleen succesvolle quizzen). */
export function recordQuizDuration(type: QuestionType, n: number, seconds: number): void {
  if (!(seconds > 0)) return;
  try {
    const cal = readCalibration();
    const ratio = seconds / baseEstimateSeconds(type, Math.max(1, n));
    const prev = cal[type] ?? 1;
    const next = prev * (1 - EMA_WEIGHT) + ratio * EMA_WEIGHT;
    cal[type] = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, next));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  } catch { /* localStorage niet beschikbaar */ }
}

/** Rond af naar een vriendelijke waarde: op 5 seconden, of op halve minuten boven 1,5 minuut. */
export function roundSeconds(s: number): number {
  if (s >= 90) return Math.round(s / 30) * 30;
  return Math.max(5, Math.round(s / 5) * 5);
}
