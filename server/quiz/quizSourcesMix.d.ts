// Typen voor server/quiz/quizSourcesMix.js (gedeeld met de frontend).
export interface SourceMix { pct_rag: number; pct_itembank: number; pct_llm: number }
export interface MixCounts { rag: number; itembank: number; llm: number }
export const DEFAULT_MIX: SourceMix;
export function normalizeMix(mix: Partial<Record<keyof SourceMix, unknown>> | null | undefined): SourceMix;
export function distributeMix(total: number, mix: SourceMix, questionType: 'mcq' | 'open' | 'casus'): MixCounts;
