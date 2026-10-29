// "Ik leg uit": vier vaste blokken, vaste meetlat, verwante begrippen alleen uit
// de cursus (server/explain/explainFeedback.js). Kalibratie tegen het echte model op
// 2026-10-15 (prospectief cohortonderzoek): uitstekend 100, redelijk 85,
// verward met patiënt-controleonderzoek 40, fout 30.
import { describe, it, expect } from 'vitest';
import { routeSource } from './helpers/serverSource.js';
import {
  cleanKeyPoints, rankRelatedConcepts, explainFormatInstruction, parseExplainFeedback,
  explainFeedbackMarkdown, buildExplainUserMessage,
} from '../explain/explainFeedback.js';

const related = [
  { id: 'r1', name: 'patiënt-controleonderzoek' },
  { id: 'r2', name: 'transversaal onderzoek' },
];

const MODEL = `### FEEDBACK
Je legt goed uit dat je een groep vooruit volgt [1]. De koppeling aan determinanten ontbreekt nog.

### SCORE
85
De kern klopt; één wezenlijk element ontbreekt.

### RELATED
- Patiënt-controleonderzoek: hier kijk je juist terug vanuit de uitkomst.
- Verzonnen begrip: dit staat niet in de lijst.
- transversaal onderzoek: één meetmoment in plaats van follow-up.

### FEEDFORWARD
- Voeg toe dat je uitkomsten koppelt aan determinanten.
- Oefen met een korte quiz.`;

describe('uitlezen van het modelantwoord', () => {
  it('haalt de vier blokken en de score eruit', () => {
    const p = parseExplainFeedback(MODEL, related);
    expect(p.feedback).toMatch(/^Je legt goed uit/);
    expect(p.feedback).not.toMatch(/SCORE/);
    expect(p.score).toBe(85);
    expect(p.scoreReason).toBe('De kern klopt; één wezenlijk element ontbreekt.');
    expect(p.feedforward).toEqual(['Voeg toe dat je uitkomsten koppelt aan determinanten.', 'Oefen met een korte quiz.']);
  });

  it('neemt alleen verwante begrippen uit de cursuslijst over (met de juiste id)', () => {
    const p = parseExplainFeedback(MODEL, related);
    expect(p.related.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(p.related[0].name).toBe('patiënt-controleonderzoek');
  });

  it('score: "85/100" en "Score: 92" werken; buiten 0–100 wordt begrensd', () => {
    expect(parseExplainFeedback('### FEEDBACK\nx\n### SCORE\nScore: 92/100 — prima', []).score).toBe(92);
    expect(parseExplainFeedback('### FEEDBACK\nx\n### SCORE\n140', []).score).toBe(100);
    expect(parseExplainFeedback('### FEEDBACK\nx\n### SCORE\ngeen getal', []).score).toBe(null);
  });

  it('zonder koppen: null (de server bewaart dan de ruwe tekst)', () => {
    expect(parseExplainFeedback('Gewone tekst zonder koppen', [])).toBe(null);
  });

  it('leesbare tekst bevat alle blokken (voor opslag en het leerdagboek)', () => {
    const md = explainFeedbackMarkdown(parseExplainFeedback(MODEL, related), 'nl');
    expect(md).toContain('**Score: 85/100**');
    expect(md).toContain('**Verwante begrippen**');
    expect(md).toContain('**Feed forward**');
  });
});

describe('instructie en context', () => {
  it('het vaste blok legt grenzen en meetlat vast en noemt alleen toegestane begrippen', () => {
    const ins = explainFormatInstruction('nl', ['patiënt-controleonderzoek']);
    expect(ins).toMatch(/NOOIT een tekortkoming/);
    expect(ins).toMatch(/Begin bij 100/);
    expect(ins).toMatch(/70–80 = redelijk goed/);
    expect(ins).toContain('- patiënt-controleonderzoek');
    expect(explainFormatInstruction('en', [])).toMatch(/NEVER a shortcoming/);
  });

  it('technische labels in key_points zijn geen kernpunten', () => {
    expect(cleanKeyPoints(['course_id:abc', '[RAG-geëxtraheerd uit cursusmateriaal]', 'Volgt een groep vooruit'])).toEqual(['Volgt een groep vooruit']);
    const msg = buildExplainUserMessage({
      concept: { name: 'Cohort', definition: 'Def' }, keyPoints: cleanKeyPoints(['course_id:abc']), explanation: 'Mijn uitleg',
    });
    expect(msg).not.toMatch(/course_id|RAG-geëxtraheerd|Kernpunten/);
    expect(msg).toContain('Uitleg van de student:\nMijn uitleg');
  });

  it('verwante begrippen: gedeelde fragmenten wegen zwaarder dan gedeelde documenten', () => {
    const conceptsById = new Map([['a', { id: 'a', name: 'A' }], ['b', { id: 'b', name: 'B' }], ['x', { id: 'x', name: 'X' }]]);
    const out = rankRelatedConcepts({
      conceptId: 'self',
      ownEvidence: [{ chunk_id: 'c1', document_id: 'd1' }],
      otherEvidence: [
        { concept_id: 'b', chunk_id: 'c9', document_id: 'd1' },
        { concept_id: 'a', chunk_id: 'c1', document_id: 'd1' },
        { concept_id: 'z', chunk_id: 'c1', document_id: 'd1' }, // niet goedgekeurd → niet in conceptsById
        { concept_id: 'x', chunk_id: 'c7', document_id: 'd5' }, // niets gedeeld
      ],
      conceptsById,
    });
    expect(out.map(c => c.id)).toEqual(['a', 'b']);
  });
});

describe('server (route)', () => {
  it('de route beoordeelt én slaat op (score komt van de server, niet uit de browser)', () => {
    const route = routeSource("app.post('/api/explain/evaluate'");
    expect(route).toContain("rejectIfFeatureOff(res, auth.user, auth.profile, scopeCourseId, 'explain')");
    expect(route).toContain('explainFormatInstruction(');
    expect(route).toContain("from('student_explanations')");
    expect(route).toMatch(/score: score \|\| \{\}/);
    // Geen leerniveau bij Ik leg uit: je beheerst een begrip of niet.
    expect(route).not.toMatch(/buildLevelInstructionBlock|learningLevel/);
  });
});
