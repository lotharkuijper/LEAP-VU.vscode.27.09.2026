// Zoekstanden in gewone taal voor de RAG-instellingen (herinrichting beheer
// 2026-09-25). Een docent kiest Ruim / Gebalanceerd / Streng in plaats van een
// drempel tussen 0 en 1. "Gebalanceerd" = de bestaande standaardwaarden per
// module, zodat er niets verandert totdat de docent een andere stand kiest.

export type RagModule = 'chat' | 'explain' | 'quiz' | 'project';
export type RagPreset = 'broad' | 'balanced' | 'strict';
export const RAG_PRESETS: RagPreset[] = ['broad', 'balanced', 'strict'];

/** Standaardwaarden per module (gelijk aan RAG_MODULE_DEFAULTS op de server). */
export const RAG_MODULE_BASE: Record<RagModule, { similarity_threshold: number; match_count: number }> = {
  chat: { similarity_threshold: 0.70, match_count: 5 },
  explain: { similarity_threshold: 0.50, match_count: 5 },
  quiz: { similarity_threshold: 0.65, match_count: 5 },
  project: { similarity_threshold: 0.60, match_count: 7 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

export function presetValues(mod: RagModule, preset: RagPreset): { similarity_threshold: number; match_count: number } {
  const base = RAG_MODULE_BASE[mod];
  if (preset === 'broad') {
    return { similarity_threshold: round2(clamp(base.similarity_threshold - 0.10, 0.2, 0.95)), match_count: clamp(base.match_count + 3, 1, 20) };
  }
  if (preset === 'strict') {
    return { similarity_threshold: round2(clamp(base.similarity_threshold + 0.08, 0.2, 0.95)), match_count: base.match_count };
  }
  return { ...base };
}

/** Welke stand past bij de huidige getallen? 'custom' als het geen van de drie is. */
export function detectPreset(mod: RagModule, s: { similarity_threshold: number; match_count: number }): RagPreset | 'custom' {
  for (const p of RAG_PRESETS) {
    const v = presetValues(mod, p);
    if (Math.abs(v.similarity_threshold - s.similarity_threshold) < 0.005 && v.match_count === s.match_count) return p;
  }
  return 'custom';
}

/** Hoeveel passages levert een stand op, gegeven de scores uit de diagnose? */
export function passagesFound(mod: RagModule, preset: RagPreset, scores: number[]): number {
  const v = presetValues(mod, preset);
  return Math.min(v.match_count, scores.filter(x => x >= v.similarity_threshold).length);
}
