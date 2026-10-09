import { describe, it, expect } from 'vitest';
import { buildConceptProgress, pickPracticeSet, reviewIntervalDays, difficultyForLevel } from '../conceptProgress';

const now = new Date('2026-10-09T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
const topics = [
  { id: 'a', name: 'Confounding' },
  { id: 'b', name: 'Bias' },
  { id: 'c', name: 'Odds ratio' },
  { id: 'd', name: 'Incidentie' },
];
const at = (topic: string, score: number, d: number) => ({ topics: [topic], score_percentage: score, created_at: daysAgo(d) });

describe('voortgang per begrip', () => {
  const attempts = [
    at('Confounding', 40, 1), at('Confounding', 30, 2),   // zwak
    at('Bias', 90, 20),                                  // goed, maar lang geleden → herhalen
    at('Incidentie', 95, 1),                             // goed en recent
  ];
  const p = buildConceptProgress(topics, attempts, now);
  const byId = Object.fromEntries(p.map(x => [x.id, x]));

  it('beheersing = gemiddelde van de laatste pogingen; reden per begrip', () => {
    expect(byId.a).toMatchObject({ mastery: 35, attempts: 2, reason: 'weak' });
    expect(byId.b).toMatchObject({ mastery: 90, reason: 'due', daysSince: 20 });
    expect(byId.c).toMatchObject({ mastery: null, reason: 'new' });
    expect(byId.d).toMatchObject({ mastery: 95, reason: 'ok' });
  });

  it('volgorde: zwak, dan aan herhaling toe / nieuw, en wat goed gaat als laatste', () => {
    expect(p[0].id).toBe('a');
    expect(p[p.length - 1].id).toBe('d');
  });

  it('"Oefen wat je lastig vindt" kiest geen begrippen die goed gaan', () => {
    expect(pickPracticeSet(p, 3).map(x => x.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('alleen de laatste 3 pogingen tellen (wie beter wordt, ziet dat terug)', () => {
    const q = buildConceptProgress([topics[0]], [
      at('Confounding', 100, 1), at('Confounding', 90, 2), at('Confounding', 80, 3), at('Confounding', 0, 4), at('Confounding', 0, 5),
    ], now);
    expect(q[0].mastery).toBe(90);
  });

  it('begripnamen worden herkend ongeacht hoofdletters en accenten', () => {
    const q = buildConceptProgress([{ id: 'x', name: 'Prevalentie' }], [at('prévalentie ', 70, 1)], now);
    expect(q[0].attempts).toBe(1);
  });

  it('alles gaat goed: dan toch iets om te oefenen', () => {
    const q = buildConceptProgress([topics[3]], [at('Incidentie', 95, 1)], now);
    expect(pickPracticeSet(q, 3).map(x => x.id)).toEqual(['d']);
  });
});

describe('herhaaltermijn en moeilijkheid', () => {
  it('termijn groeit met beheersing (1 tot 14 dagen)', () => {
    expect(reviewIntervalDays(0)).toBe(1);
    expect(reviewIntervalDays(100)).toBe(14);
    expect(reviewIntervalDays(50)).toBeCloseTo(7.5);
  });
  it('standaardmoeilijkheid volgt het leerniveau', () => {
    expect(difficultyForLevel(1)).toBe('easy');
    expect(difficultyForLevel(3)).toBe('medium');
    expect(difficultyForLevel(5)).toBe('hard');
  });
});
