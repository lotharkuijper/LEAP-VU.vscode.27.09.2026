// Projectregels in het leerdagboek in dezelfde drie blokken als chat, Ik leg
// uit en quiz (2026-10-09).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { journalFromRubricFeedback, journalFromSynthesis, journalFromPersonaSummary, splitSteps } from '../projectJournal.js';

describe('eindreflectie (rubriek-oordeel)', () => {
  const rf = {
    samenvatting: 'Jullie hebben een helder advies gegeven.',
    per_criterium: [
      { criterium: 'Onderzoeksvraag', oordeel: 'sterk', feedback: 'Scherp afgebakend.' },
      { criterium: 'Analyse', oordeel: 'voldoende', feedback: 'Correct uitgevoerd.' },
      { criterium: 'Bronnen', oordeel: 'aandacht', feedback: 'Te weinig onderbouwd.' },
    ],
    vervolgstappen: '- Zoek twee extra bronnen\n- Herschrijf de discussie',
  };
  it('sterk/voldoende → ging goed, aandacht → kan beter, vervolgstappen als lijst', () => {
    const { sections, content } = journalFromRubricFeedback(rf, { lang: 'nl', groupReflection: 'Wij vonden het leerzaam.' });
    expect(sections.summary).toBe('Jullie hebben een helder advies gegeven.');
    expect(sections.went_well).toEqual(['Onderzoeksvraag: Scherp afgebakend.', 'Analyse: Correct uitgevoerd.']);
    expect(sections.to_improve).toEqual(['Bronnen: Te weinig onderbouwd.']);
    expect(sections.next_steps).toEqual(['Zoek twee extra bronnen', 'Herschrijf de discussie']);
    expect(content).toContain('**Wat ging goed**');
    expect(content).toContain('Wij vonden het leerzaam.'); // reflectie van de groep blijft leesbaar
  });
  it('Engelse oordelen ("needs attention") worden ook herkend', () => {
    const { sections } = journalFromRubricFeedback({ samenvatting: 'x', per_criterium: [{ criterium: 'A', oordeel: 'needs attention', feedback: 'y' }] }, { lang: 'en' });
    expect(sections.to_improve).toEqual(['A: y']);
  });
});

describe('overzicht over alle gesprekken', () => {
  it('overeenstemming → samenvatting, spanningspunten → kan beter, suggesties → vervolgstappen', () => {
    const { sections } = journalFromSynthesis({
      overeenstemming: ['Beide persona’s vinden de vraag relevant.'],
      spanningspunten: ['De wethouder wil snelheid, de epidemioloog zorgvuldigheid.'],
      suggesties: ['Maak een tijdpad.'],
    });
    expect(sections).toMatchObject({
      summary: 'Beide persona’s vinden de vraag relevant.',
      to_improve: ['De wethouder wil snelheid, de epidemioloog zorgvuldigheid.'],
      next_steps: ['Maak een tijdpad.'],
    });
  });
  it('leeg overzicht → geen blokken (dan wordt er niets opgeslagen)', () => {
    expect(journalFromSynthesis({ overeenstemming: [], spanningspunten: [], suggesties: [] }).sections).toBeNull();
  });
});

describe('samenvatting van één gesprek (door de student bewerkt)', () => {
  it('inbreng van de student als samenvatting, reactie van de persona als feedback', () => {
    const { sections, content } = journalFromPersonaSummary({ studentSummary: 'We vroegen naar de data.', personaSummary: 'Begin bij de GGD.', personaName: 'Wethouder Jansen' }, { lang: 'nl' });
    expect(sections.summary).toBe('We vroegen naar de data.');
    expect(sections.feedback).toBe('Reactie van Wethouder Jansen: Begin bij de GGD.');
    expect(content).toContain('**Feedback**');
  });
});

it('splitSteps', () => {
  expect(splitSteps('1. Eerst dit\n2) Dan dat\n\n• En verder')).toEqual(['Eerst dit', 'Dan dat', 'En verder']);
});

describe('de tussenstand-route gebruikt de blokken overal', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("app.post('/api/projects/groups/:groupId/checkpoint'");
  const route = src.slice(start, src.indexOf('\n});\n', start));
  it('elke dagboekregel krijgt sections mee', () => {
    const inserts = route.match(/user_id: m\.user_id,[\s\S]*?activity_type: 'project_reflection'/g) || [];
    expect(inserts.length).toBe(4);
    for (const block of inserts) expect(block).toMatch(/sections: /);
  });
  it('vrije tekst laat het model direct in blokken schrijven', () => {
    expect((route.match(/journalFormatInstruction\(/g) || []).length).toBe(2);
  });
});
