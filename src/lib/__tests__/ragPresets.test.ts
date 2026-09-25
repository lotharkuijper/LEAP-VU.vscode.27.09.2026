import { describe, it, expect } from 'vitest';
import { presetValues, detectPreset, passagesFound, RAG_MODULE_BASE, RAG_PRESETS, type RagModule } from '../ragPresets';

const MODULES: RagModule[] = ['chat', 'explain', 'quiz', 'project'];

describe('ragPresets', () => {
  it('"Gebalanceerd" is precies de bestaande standaard (niets verandert zonder keuze)', () => {
    for (const m of MODULES) expect(presetValues(m, 'balanced')).toEqual(RAG_MODULE_BASE[m]);
  });

  it('Ruim < Gebalanceerd < Streng qua drempel, Ruim neemt meer passages mee', () => {
    for (const m of MODULES) {
      const [b, n, s] = RAG_PRESETS.map(p => presetValues(m, p));
      expect(b.similarity_threshold).toBeLessThan(n.similarity_threshold);
      expect(n.similarity_threshold).toBeLessThan(s.similarity_threshold);
      expect(b.match_count).toBeGreaterThan(n.match_count);
    }
  });

  it('herkent de stand bij de getallen, of "custom"', () => {
    for (const m of MODULES) for (const p of RAG_PRESETS) expect(detectPreset(m, presetValues(m, p))).toBe(p);
    expect(detectPreset('quiz', { similarity_threshold: 0.33, match_count: 12 })).toBe('custom');
  });

  it('rekent uit hoeveel passages een stand oplevert (regressie: Ecologisch onderzoek, kaal 0.610)', () => {
    const scores = [0.61, 0.608, 0.587, 0.502];
    expect(passagesFound('quiz', 'balanced', scores)).toBe(0); // 0.65 → niets
    expect(passagesFound('quiz', 'broad', scores)).toBe(3);    // 0.55 → 0.610, 0.608, 0.587
  });
});
