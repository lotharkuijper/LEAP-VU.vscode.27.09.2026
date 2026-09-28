import { describe, it, expect } from 'vitest';
import {
  extractReadiness, evaluateReadiness, countPriorStudentMessages, matchTopic,
  buildReadinessInstruction, topicKey, levelName, MIN_STUDENT_MESSAGES,
} from '../readiness.js';

const topics = [{ id: 'c1', name: 'Patiënt-controleonderzoek' }, { id: 'c2', name: 'Cohortonderzoek' }];

describe('extractReadiness', () => {
  it('haalt het onzichtbare label uit het antwoord (de student ziet het nooit)', () => {
    const r = extractReadiness('Je bent er klaar voor!\n\n[[LEAP_READINESS verdict=ready topic="Cohortonderzoek"]]');
    expect(r).toEqual({ text: 'Je bent er klaar voor!', verdict: 'ready', topic: 'Cohortonderzoek', hadMarker: true });
  });

  it('verdraagt aanhalingstekens, hoofdletters en NONE', () => {
    expect(extractReadiness('x [[leap_readiness verdict="almost" topic=NONE]]')).toMatchObject({ verdict: 'almost', topic: null, text: 'x' });
  });

  it('onbekend oordeel telt niet; tekst zonder label blijft ongewijzigd', () => {
    expect(extractReadiness('a [[LEAP_READINESS verdict=super]]').verdict).toBeNull();
    expect(extractReadiness('Gewoon antwoord.')).toEqual({ text: 'Gewoon antwoord.', verdict: null, topic: null, hadMarker: false });
  });
});

describe('evaluateReadiness — wanneer mag het feest?', () => {
  const base = { topics, priorStudentMessages: 4, currentLevel: 2 };

  it('positief oordeel na een echt gesprek → feest + volgend niveau + onderwerp uit de cursus', () => {
    const r = evaluateReadiness({ ...base, verdict: 'ready', topic: 'patiënt-controleonderzoek' });
    expect(r).toMatchObject({ eligible: true, reason: null, currentLevel: 2, nextLevel: 3 });
    expect(r.concept).toEqual(topics[0]);
  });

  it('"bijna" of "nog niet" → geen feest', () => {
    expect(evaluateReadiness({ ...base, verdict: 'almost', topic: null })).toMatchObject({ eligible: false, reason: 'not_ready' });
    expect(evaluateReadiness({ ...base, verdict: 'not_yet', topic: null })).toMatchObject({ eligible: false, reason: 'not_ready' });
    expect(evaluateReadiness({ ...base, verdict: null, topic: null })).toMatchObject({ eligible: false, reason: 'no_verdict' });
  });

  it('te kort gesprek telt niet, ook al zegt het model "ready" (tegen trucjes)', () => {
    const r = evaluateReadiness({ ...base, priorStudentMessages: MIN_STUDENT_MESSAGES - 1, verdict: 'ready', topic: null });
    expect(r).toMatchObject({ eligible: false, reason: 'too_short' });
  });

  it('op Expert valt niets meer te verdienen', () => {
    expect(evaluateReadiness({ ...base, currentLevel: 5, verdict: 'ready', topic: null })).toMatchObject({ eligible: false, reason: 'max_level', nextLevel: 5 });
  });

  it('een onderwerp dat niet in de cursus staat wordt geen verzonnen onderwerp (→ hele cursus)', () => {
    const r = evaluateReadiness({ ...base, verdict: 'ready', topic: 'Quantumfysica' });
    expect(r.eligible).toBe(true);
    expect(r.concept).toBeNull();
    expect(topicKey(r.concept)).toBe('');
  });
});

describe('hulpjes', () => {
  it('telt alleen eigen, inhoudelijke berichten vóór de readiness-vraag', () => {
    const msgs = [
      { role: 'user', content: 'Wat is een cohortonderzoek precies?' },
      { role: 'assistant', content: '…' },
      { role: 'user', content: 'ok' },
      { role: 'user', content: 'En waarom is een OR bij zeldzame ziekten ongeveer het RR?' },
      { role: 'user', content: 'Ben ik klaar voor een hoger niveau?' },
    ];
    expect(countPriorStudentMessages(msgs)).toBe(2);
  });

  it('matchTopic negeert hoofdletters en extra spaties', () => {
    expect(matchTopic('  cohortonderzoek ', topics)?.id).toBe('c2');
    expect(matchTopic(null, topics)).toBeNull();
  });

  it('de instructie noemt het volgende niveau en de begrippenlijst', () => {
    const ins = buildReadinessInstruction({ topics, currentLevel: 2, lang: 'nl' });
    expect(ins).toContain('next level is 3 ("Intermediate")');
    expect(ins).toContain('- Cohortonderzoek');
    expect(ins).toContain('[[LEAP_READINESS verdict=');
  });

  it('niveaunamen gelijk aan de app', () => {
    expect(levelName(3, 'nl')).toBe('Gemiddeld');
    expect(levelName(1, 'en')).toBe('New');
  });
});
