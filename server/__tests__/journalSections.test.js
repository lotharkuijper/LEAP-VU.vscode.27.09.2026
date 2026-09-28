import { describe, it, expect } from 'vitest';
import {
  parseJournalSections, journalFieldsFromModel, sectionsToText, normalizeSections, journalFormatInstruction,
} from '../journalSections.js';

const MODEL_ANSWER = `### SUMMARY
Je hebt het verschil tussen "én" en "gegeven" leren zien door naar de noemer te kijken.
Je redeneerde van $P(A \\mid B)$ naar sensitiviteit.
### WENT_WELL
- Je corrigeerde je fouten actief.
- Je begreep dat bij lagere prevalentie de PPV daalt
  en de NPV stijgt.
### TO_IMPROVE
- Formule-notatie kun je nog sneller afleiden.
### NEXT_STEPS
1. Werk twee 2×2-tabellen uit met $\\frac{a}{a+b}$.
2. Leg zonder hulp uit waarom er fout-positieven zijn.`;

describe('parseJournalSections', () => {
  it('deelt een modelantwoord op in de drie blokken, formules blijven heel', () => {
    const s = parseJournalSections(MODEL_ANSWER);
    expect(s.summary).toBe('Je hebt het verschil tussen "én" en "gegeven" leren zien door naar de noemer te kijken. Je redeneerde van $P(A \\mid B)$ naar sensitiviteit.');
    expect(s.went_well).toEqual([
      'Je corrigeerde je fouten actief.',
      'Je begreep dat bij lagere prevalentie de PPV daalt en de NPV stijgt.',
    ]);
    expect(s.to_improve).toEqual(['Formule-notatie kun je nog sneller afleiden.']);
    expect(s.next_steps[0]).toBe('Werk twee 2×2-tabellen uit met $\\frac{a}{a+b}$.');
    expect(s.next_steps).toHaveLength(2);
  });

  it('verdraagt kleine afwijkingen in de kopjes (vet, dubbelepunt, spatie)', () => {
    const s = parseJournalSections('## **SUMMARY**:\nKort.\n## WENT WELL\n- Goed\n## NEXT STEPS\n- Verder');
    expect(s).toEqual({ summary: 'Kort.', went_well: ['Goed'], to_improve: [], next_steps: ['Verder'] });
  });

  it('geeft null bij vrije tekst zonder de afgesproken kopjes', () => {
    expect(parseJournalSections('Je hebt in dit gesprek duidelijk laten zien…\nSterk is dat…')).toBeNull();
    expect(parseJournalSections('### SUMMARY\nAlleen een samenvatting.')).toBeNull();
    expect(parseJournalSections('')).toBeNull();
  });

  it('begrenst het aantal punten (max 3 volgende stappen)', () => {
    const s = parseJournalSections('### SUMMARY\nx\n### NEXT_STEPS\n- 1\n- 2\n- 3\n- 4\n- 5');
    expect(s.next_steps).toEqual(['1', '2', '3']);
  });
});

describe('journalFieldsFromModel', () => {
  it('bewaart blokken plus een leesbare tekstversie', () => {
    const { content, sections } = journalFieldsFromModel(MODEL_ANSWER, 'nl');
    expect(sections.went_well).toHaveLength(2);
    expect(content).toContain('**Wat heb je gedaan**');
    expect(content).toContain('**Je volgende stap**\n- Werk twee');
  });

  it('valt terug op de oorspronkelijke tekst: een dagboekregel gaat nooit verloren', () => {
    expect(journalFieldsFromModel('  Vrije reflectie.  ', 'nl')).toEqual({ content: 'Vrije reflectie.', sections: null });
  });
});

describe('overig', () => {
  it('sectionsToText neemt ook een losse feedbacktekst mee (oordeel van een beoordelaar)', () => {
    expect(sectionsToText({ summary: '', feedback: 'Goed onderbouwd.', next_steps: ['Werk de discussie uit.'] }, 'en'))
      .toBe('**Feedback**\nGoed onderbouwd.\n\n**Your next step**\n- Werk de discussie uit.');
  });

  it('normalizeSections weigert rommel en lege blokken', () => {
    expect(normalizeSections(null)).toBeNull();
    expect(normalizeSections({ summary: '  ', went_well: [1, ''] })).toBeNull();
    expect(normalizeSections({ summary: 'x', went_well: ['a', 3] })).toEqual({ summary: 'x', went_well: ['a'], to_improve: [], next_steps: [] });
  });

  it('de opmaakinstructie noemt de vaste kopjes in elke taal', () => {
    for (const lang of ['nl', 'en']) {
      const ins = journalFormatInstruction(lang);
      for (const h of ['### SUMMARY', '### WENT_WELL', '### TO_IMPROVE', '### NEXT_STEPS']) expect(ins).toContain(h);
    }
  });
});
