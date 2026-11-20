// Beeldoefeningen: beschrijvingsdocument opknippen, aan foto's koppelen, en van
// een vrije beschrijving een kenmerkenlijst maken (zonder iets toe te voegen).
import { describe, it, expect } from 'vitest';
import { normalizeStem, numberInName, readHeading, splitDescriptions, matchDescriptions } from '../imageExercises/descriptions.js';
import { explicitSections, buildFeatureMessages, parseFeatureResponse, cleanTeacherFeatures } from '../imageExercises/features.js';
import fs from 'node:fs';
import path from 'node:path';

describe('het sjabloon voor docenten, in elke taal', () => {
  const dir = path.resolve(__dirname, '../../src/i18n/locales');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`${file}: LEAP leest de kopjes per foto en de kopjes kern/extra van het vertaalde sjabloon`, () => {
      const template = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))['imageEx.guide.templateText'];
      expect(typeof template).toBe('string');
      const { sections } = splitDescriptions(template);
      expect(sections.map((s) => s.number)).toEqual([1, 2]);
      const parts = explicitSections(sections[0].text);
      expect(parts).not.toBeNull();
      expect(parts.core).not.toBe('');
      expect(parts.extra).not.toBe('');
      expect(explicitSections(sections[1].text)).toBeNull();
    });
  }
});

describe('namen en nummers', () => {
  it('vergelijkt bestandsnamen los van hoofdletters, tekens en extensie', () => {
    expect(normalizeStem('Alzheimer-03.JPG')).toBe('alzheimer03');
    expect(numberInName('alzheimer-03.jpg')).toBe(3);
    expect(numberInName('IMG_2024_017.png')).toBe(17);
    expect(numberInName('schist.png')).toBeNull();
  });

  it('herkent kopjes, maar geen gewone zinnen', () => {
    expect(readHeading('# Foto 3')).toMatchObject({ heading: 'Foto 3', number: 3 });
    expect(readHeading('Afbeelding 12: schistbodem met gelaagdheid')).toMatchObject({ heading: 'Afbeelding 12', number: 12, rest: 'schistbodem met gelaagdheid' });
    expect(readHeading('Figure 4')).toMatchObject({ number: 4 });
    expect(readHeading('7.')).toMatchObject({ number: 7 });
    expect(readHeading('alzheimer-03.jpg', ['alzheimer03'])).toMatchObject({ stem: 'alzheimer03' });
    expect(readHeading('Foto 3 laat duidelijk zien hoe de plaques tussen de cellen liggen en de neuronen verdwijnen')).toBeNull();
    expect(readHeading('De cellen zijn klein.')).toBeNull();
    expect(readHeading('')).toBeNull();
  });
});

describe('splitDescriptions', () => {
  it('knipt op kopjes; tekst vóór het eerste kopje is inleiding', () => {
    const doc = 'Beschrijvingen bij practicum 2\n\nFoto 1\nHersenweefsel van een Alzheimerpatiënt.\n\nFoto 2: Schistbodem.\nGelaagd.\n\n# kaart-3.png\nNederzettingen langs de rivier.';
    const { sections, preamble } = splitDescriptions(doc, ['kaart-3.png']);
    expect(preamble).toBe('Beschrijvingen bij practicum 2');
    expect(sections).toEqual([
      { heading: 'Foto 1', number: 1, stem: null, text: 'Hersenweefsel van een Alzheimerpatiënt.' },
      { heading: 'Foto 2', number: 2, stem: null, text: 'Schistbodem.\nGelaagd.' },
      { heading: 'kaart-3.png', number: 3, stem: 'kaart3', text: 'Nederzettingen langs de rivier.' },
    ]);
  });

  it('laat kopjes zonder tekst weg', () => {
    expect(splitDescriptions('Foto 1\n\nFoto 2\nIets.').sections.map((s) => s.heading)).toEqual(['Foto 2']);
  });
});

describe('matchDescriptions', () => {
  const images = [
    { id: 'a', filename: 'alzheimer-01.jpg' },
    { id: 'b', filename: 'alzheimer-02.jpg' },
    { id: 'c', filename: 'schist.png' },
  ];

  it('koppelt op naam, dan op nummer', () => {
    const sections = [{ stem: 'schist', number: null }, { stem: null, number: 2 }, { stem: null, number: 1 }];
    const r = matchDescriptions(images, sections);
    expect(r.matches).toEqual([
      { imageId: 'c', section: 0, source: 'name' },
      { imageId: 'b', section: 1, source: 'number' },
      { imageId: 'a', section: 2, source: 'number' },
    ]);
    expect(r.unmatchedSections).toEqual([]);
  });

  it('een nummer dat bij twee foto’s past, koppelt niet', () => {
    const r = matchDescriptions([{ id: 'x', filename: 'a-1.jpg' }, { id: 'y', filename: 'b-1.jpg' }], [{ stem: null, number: 1 }]);
    expect(r.matches).toEqual([]);
    expect(r.unmatchedSections).toEqual([0]);
  });

  it('koppelt op volgorde alleen als niets een naam of nummer heeft en de aantallen gelijk zijn', () => {
    const imgs = [{ id: 'p', filename: 'eerste.jpg' }, { id: 'q', filename: 'tweede.jpg' }];
    expect(matchDescriptions(imgs, [{ stem: null, number: null }, { stem: null, number: null }]).matches.map((m) => m.source)).toEqual(['order', 'order']);
    expect(matchDescriptions(imgs, [{ stem: null, number: null }]).matches).toEqual([]);
    expect(matchDescriptions(imgs, [{ stem: null, number: 9 }, { stem: null, number: null }]).matches).toEqual([]);
  });
});

describe('kenmerken', () => {
  it('herkent de kopjes Kern en Extra van de docent', () => {
    expect(explicitSections('Hersenweefsel.\nKern:\nplaques\nneuronverlies\nExtra: gliose')).toEqual({ intro: 'Hersenweefsel.', core: 'plaques\nneuronverlies', extra: 'gliose' });
    expect(explicitSections('Extra veel plaques tussen de cellen, wat typerend is voor de ziekte van Alzheimer in een later stadium.')).toBeNull();
    expect(explicitSections('Gewone beschrijving.')).toBeNull();
  });

  it('vraagt het taalmodel om niets toe te voegen, en gebruikt de indeling van de docent als die er is', () => {
    const free = buildFeatureMessages('Dit is hersenweefsel.');
    expect(free.explicit).toBe(false);
    expect(free.messages[0].content).toContain('UITSLUITEND');
    const split = buildFeatureMessages('Kern:\nplaques\nExtra:\ngliose');
    expect(split.explicit).toBe(true);
    expect(split.messages[1].content).toContain('KERN:\nplaques');
  });

  it('controleert het antwoord: lege en dubbele labels vallen weg; kern komt uit de indeling van de docent', () => {
    const raw = JSON.stringify({ features: [
      { label: 'Plaques', observation: 'donkere vlekken tussen de cellen', interpretation: 'amyloïd', from: 'kern', open: false },
      { label: 'plaques', observation: 'dubbel' },
      { label: '', observation: 'leeg' },
      { label: 'Gliose', from: 'extra', core: true },
    ], uncertain: true, note: 'kort' });
    const r = parseFeatureResponse(raw, { explicit: true });
    expect(r.features.map((f) => [f.label, f.is_core])).toEqual([['Plaques', true], ['Gliose', false]]);
    expect(r).toMatchObject({ uncertain: true, note: 'kort' });
    expect(parseFeatureResponse('geen json')).toBeNull();
    expect(parseFeatureResponse({ features: [] })).toBeNull();
  });

  it('zonder indeling beslist "core", standaard kern', () => {
    const r = parseFeatureResponse({ features: [{ label: 'A' }, { label: 'B', core: false }] });
    expect(r.features.map((f) => f.is_core)).toEqual([true, false]);
  });

  it('maakt een lijst van de docent schoon', () => {
    expect(cleanTeacherFeatures([{ label: '  Plaques ', is_core: false, open_interpretation: true }, { label: '' }, null])).toEqual([
      { label: 'Plaques', observation: '', interpretation: '', is_core: false, open_interpretation: true },
    ]);
    expect(cleanTeacherFeatures('x')).toEqual([]);
  });
});
