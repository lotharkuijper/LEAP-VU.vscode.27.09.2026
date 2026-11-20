// Beeldoefeningen: beschrijvingsdocument opknippen, aan foto's koppelen, en van
// een vrije beschrijving een kenmerkenlijst maken (zonder iets toe te voegen).
import { describe, it, expect } from 'vitest';
import { normalizeStem, numberInName, readHeading, splitDescriptions, matchDescriptions, splitByMentions, planDocument } from '../imageExercises/descriptions.js';

describe('koppelen zonder kopjes', () => {
  const images = [{ id: 'a', filename: 'alzheimer-01.jpg' }, { id: 'b', filename: 'alzheimer-02.jpg' }];

  it('alinea’s waarin de bestandsnaam staat, horen bij die foto; alinea’s erna ook', () => {
    const text = 'Inleiding.\n\nOp alzheimer-02.jpg zie je plaques.\n\nDaarnaast neuronverlies.\n\nDe coupe (alzheimer-01.jpg) is gezond.';
    const { sections, preamble } = splitByMentions(text, images.map((i) => i.filename));
    expect(preamble).toBe('Inleiding.');
    expect(sections.map((s) => [s.heading, s.text])).toEqual([
      ['alzheimer-02.jpg', 'Op alzheimer-02.jpg zie je plaques.\n\nDaarnaast neuronverlies.'],
      ['alzheimer-01.jpg', 'De coupe (alzheimer-01.jpg) is gezond.'],
    ]);
    const plan = planDocument(text, { images, open: images });
    expect(plan.method).toBe('mentions');
    expect(plan.matches.map((m) => [m.imageId, m.source])).toEqual([['b', 'name'], ['a', 'name']]);
  });

  it('een losse naam zonder extensie telt niet als verwijzing', () => {
    expect(splitByMentions('Een typische art-nouveaucompositie.', ['art-nouveau.png']).sections).toEqual([]);
  });

  it('volgorde: kopjes, verwijzingen, documentnaam, één wachtende foto, anders vragen', () => {
    expect(planDocument('Foto 2\nIets.', { images, open: images }).method).toBe('headings');
    expect(planDocument('Tekst.', { filename: 'alzheimer-02.docx', images, open: images })).toMatchObject({ method: 'filename', matches: [{ imageId: 'b', source: 'name' }] });
    expect(planDocument('Tekst.', { filename: 'x.docx', images, open: [images[0], { ...images[1], description: 'al iets' }] })).toMatchObject({ method: 'single', matches: [{ imageId: 'a', source: 'suggested' }] });
    expect(planDocument('Tekst.', { filename: 'x.docx', images, open: images })).toMatchObject({ method: 'ask', unmatchedSections: [0] });
    expect(planDocument('  ', { images, open: images }).method).toBe('empty');
  });
});
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

  // Bug 2026-11-20: bij een foto "Art-nouveau.png" werd elke korte zin met "art nouveau"
  // een kopje, en viel het grootste deel van de beschrijving weg.
  it('een zin waarin de bestandsnaam voorkomt, is geen kopje', () => {
    const doc = [
      'Art-nouveau.png',
      'Dit is een typische art-nouveaucompositie, als potloodtekening.',
      'Het haar',
      'Het haar stroomt in golven naar beneden.',
      'Deze omlijsting bestaat uit gebogen lijnen die typerend zijn voor de art nouveau.',
      'Typische art-nouveaukenmerken die zichtbaar zijn',
      'S-vormige en zweepachtige lijnen.',
    ].join('\n');
    const { sections, preamble } = splitDescriptions(doc, ['Art-nouveau.png']);
    expect(preamble).toBe('');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ heading: 'Art-nouveau.png', stem: 'artnouveau' });
    expect(sections[0].text).toContain('Het haar stroomt');
    expect(sections[0].text).toContain('S-vormige en zweepachtige lijnen.');
  });

  it('de bestandsnaam met "Foto" ervoor of vóór een dubbele punt is wél een kopje', () => {
    expect(readHeading('Foto: art-nouveau', ['artnouveau'])).toMatchObject({ stem: 'artnouveau', rest: '' });
    expect(readHeading('art-nouveau.png: een tekening', ['artnouveau'])).toMatchObject({ stem: 'artnouveau', rest: 'een tekening' });
    expect(readHeading('Art nouveau is een stroming', ['artnouveau'])).toBeNull();
  });

  it('een Markdown-tussenkopje ín een beschrijving knipt die niet op', () => {
    const { sections } = splitDescriptions('# Foto 1\nEen tekening.\n## Het haar\nGolvend haar.\n# Foto 2\nEen kaart.');
    expect(sections.map((s) => s.heading)).toEqual(['Foto 1', 'Foto 2']);
    expect(sections[0].text).toContain('## Het haar\nGolvend haar.');
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

  it('"Afbeelding 1/2" bij foto’s zonder nummer in de naam: op volgorde van toevoegen', () => {
    const imgs = [{ id: 'p', filename: 'Art-nouveau.png' }, { id: 'q', filename: 'libel.png' }];
    const r = matchDescriptions(imgs, [{ stem: null, number: 2 }, { stem: null, number: 1 }]);
    expect(r.matches).toEqual([
      { imageId: 'p', section: 1, source: 'order' },
      { imageId: 'q', section: 0, source: 'order' },
    ]);
    // dubbele nummers of een ander aantal: niet raden
    expect(matchDescriptions(imgs, [{ stem: null, number: 1 }, { stem: null, number: 1 }]).matches).toEqual([]);
    expect(matchDescriptions(imgs, [{ stem: null, number: 1 }]).matches).toEqual([]);
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

  it('zonder kopjes van de docent hooguit 8 kern; met kopjes beslist de docent', () => {
    const many = { features: Array.from({ length: 12 }, (_, i) => ({ label: `K${i}`, core: true, from: 'kern' })) };
    expect(parseFeatureResponse(many).features.filter((f) => f.is_core).map((f) => f.label)).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7']);
    expect(parseFeatureResponse(many, { explicit: true }).features.every((f) => f.is_core)).toBe(true);
  });

  it('vraagt het taalmodel om algemene opsommingen als duiding te gebruiken en tussenkopjes over te slaan', () => {
    const sys = buildFeatureMessages('Een tekening.').messages[0].content;
    expect(sys).toContain('interpretation bij de waarneming');
    expect(sys).toContain('tussenkopje');
    expect(sys).toContain('hooguit 8');
  });

  it('maakt een lijst van de docent schoon', () => {
    expect(cleanTeacherFeatures([{ label: '  Plaques ', is_core: false, open_interpretation: true }, { label: '' }, null])).toEqual([
      { label: 'Plaques', observation: '', interpretation: '', is_core: false, open_interpretation: true },
    ]);
    expect(cleanTeacherFeatures('x')).toEqual([]);
  });
});
