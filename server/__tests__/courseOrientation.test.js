// Regressie Microbiologie (2026-10-18): "Waar gaat deze cursus over?" vond geen
// enkele passage, de tutor kende de cursus niet, en Nederlandse vragen over een
// Engels boek vonden de stof slecht ("complementsysteem" 0,31 tegen 0,64).
import { describe, it, expect } from 'vitest';
import { routeSource } from './helpers/serverSource.js';
import { buildCourseOverviewBlock, OVERVIEW_MAX_TITLES } from '../courses/courseOverview.js';
import { detectLanguage, majorityLanguage, needsTranslation, buildTranslationMessages } from '../rag/crossLingual.js';
import { mergeCandidatesByBestScore } from '../../src/services/rag.service';

describe('cursusoverzicht voor de tutor', () => {
  it('noemt de cursus, de opbouw in volgorde van nummering en de begrippen', () => {
    const block = buildCourseOverviewBlock({
      course: { name: 'Microbiologie', description: 'Inleiding in de microbiologie.' },
      documentNames: ['010-2.1-Cell-Morphology.txt', '002-1.1-Introduction.txt', '100-10.2-Something.txt'],
      concepts: ['Gramkleuring', 'Peptidoglycaan'],
    });
    expect(block).toContain('Cursus: Microbiologie');
    expect(block).toContain('Inleiding in de microbiologie.');
    expect(block.indexOf('Introduction')).toBeLessThan(block.indexOf('Cell-Morphology'));
    expect(block).toContain('Kernbegrippen (2): Gramkleuring, Peptidoglycaan');
    expect(block).toMatch(/GEEN bron/);
  });
  it('gebruikt de leerlijn als die er is, en kapt lange lijsten af', () => {
    const units = [{ title: 'B', position: 2 }, { title: 'A', position: 1 }];
    const b = buildCourseOverviewBlock({ course: { name: 'X' }, units, documentNames: ['1-z.txt'] });
    expect(b).toMatch(/1\. A[\s\S]*2\. B/);
    expect(b).not.toContain('Leerstof (');
    const many = Array.from({ length: 155 }, (_, i) => `${i + 1}-hoofdstuk.txt`);
    const c = buildCourseOverviewBlock({ course: { name: 'X' }, documentNames: many });
    expect(c.match(/^- /gm)).toHaveLength(OVERVIEW_MAX_TITLES);
    expect(c).toContain('155 bestanden');
  });
  it('zonder cursusnaam geen blok', () => {
    expect(buildCourseOverviewBlock({ course: null })).toBe('');
  });
  it('de tutorchat krijgt het overzicht mee', () => {
    expect(routeSource("app.post('/api/chat',")).toMatch(/systemContent \+= await courseOverviewBlock\(courseId\)/);
  });
});

describe('zoeken in twee talen', () => {
  it('herkent de taal van vraag en materiaal', () => {
    expect(detectLanguage('Wat doet het complementsysteem in de afweer?')).toBe('nl');
    expect(detectLanguage('What does the complement system do in the immune response?')).toBe('en');
    expect(detectLanguage('Peptidoglycaan')).toBeNull();
    const en = 'The cell wall of bacteria is made of peptidoglycan and it protects the cell from lysis.';
    expect(majorityLanguage([en, en, en, 'De celwand is van peptidoglycaan en die beschermt de cel.'])).toBe('en');
    expect(majorityLanguage(['kort'])).toBeNull();
  });
  it('vertaalt alleen als de talen verschillen', () => {
    expect(needsTranslation('nl', 'en')).toBe(true);
    expect(needsTranslation('nl', 'nl')).toBe(false);
    expect(needsTranslation(null, 'en')).toBe(false);
    const m = buildTranslationMessages('Wat doet het complementsysteem?', 'en');
    expect(m[0].content).toMatch(/into English/);
    expect(m[0].content).toMatch(/do not answer/);
  });
  it('per passage telt de beste score van beide zoekopdrachten', () => {
    const merged = mergeCandidatesByBestScore([
      [{ id: 'a', similarity: 0.31 }, { id: 'b', similarity: 0.2 }],
      [{ id: 'a', similarity: 0.64 }, { id: 'c', similarity: 0.5 }],
    ]);
    expect(merged.map((c) => [c.id, c.similarity])).toEqual([['a', 0.64], ['c', 0.5], ['b', 0.2]]);
  });
});
