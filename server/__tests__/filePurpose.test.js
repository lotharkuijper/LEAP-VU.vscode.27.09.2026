import { describe, it, expect } from 'vitest';
import {
  suggestPurpose,
  effectivePurpose,
  purposeAllowsModule,
  isRagPurpose,
  looksSensitive,
  PURPOSES,
  PURPOSE_RULES,
} from '../filePurpose.js';

describe('suggestPurpose', () => {
  it('herkent de colleges van E&B1 als leerstof', () => {
    for (const f of ['1.studiedesigns.pdf', '4.1.Confounding.pptx', '12.likelihood.pdf']) {
      expect(suggestPurpose({ filename: f }).purpose).toBe('course_material');
    }
  });

  it('herkent studiehandleidingen en roosters als cursusinformatie', () => {
    expect(suggestPurpose({ filename: 'Studiehandleiding E&B1 2026.pdf' })).toMatchObject({ purpose: 'course_info', confidence: 'high' });
    expect(suggestPurpose({ filename: 'Rooster blok 2.xlsx' }).purpose).not.toBe('course_material');
    expect(suggestPurpose({ filename: 'Course guide.docx' }).purpose).toBe('course_info');
  });

  it('herkent cursusinformatie ook aan de tekst', () => {
    const textSample = 'De deadline voor de opdracht staat in het rooster. Herkansing in week 8. Het vak is 6 ECTS.';
    expect(suggestPurpose({ filename: 'info-blok.pdf', textSample }).purpose).toBe('course_info');
  });

  it('zet antwoordmodellen en tentamens veilig op "alleen voor docenten"', () => {
    for (const f of ['Antwoordmodel werkgroep 3.pdf', 'Uitwerkingen oefenopgaven.docx', 'Tentamen 2025.pdf', 'answer key week 2.pdf', 'Solutions.pdf']) {
      expect(suggestPurpose({ filename: f }).purpose).toBe('teacher_only');
    }
    expect(looksSensitive({ filename: 'Antwoorden.pdf' })).toBe(true);
    expect(looksSensitive({ filename: 'example.pdf' })).toBe(false);
  });

  it('herkent antwoorden ook aan de tekst', () => {
    const textSample = 'Antwoordmodel. Vraag 1: correct antwoord is B. Puntentelling: 2 punten.';
    expect(suggestPurpose({ filename: 'week3.pdf', textSample }).purpose).toBe('teacher_only');
  });

  it('herkent databestanden en opdrachten als projectmateriaal', () => {
    expect(suggestPurpose({ filename: 'cohortdata.csv' })).toMatchObject({ purpose: 'project', materialKind: 'data' });
    expect(suggestPurpose({ filename: 'analyse.omv' })).toMatchObject({ purpose: 'project', materialKind: 'data' });
    expect(suggestPurpose({ filename: 'Opdrachtbeschrijving onderzoeksproject.pdf' })).toMatchObject({ purpose: 'project', materialKind: 'assignment' });
  });

  it('stelt bij een wetenschappelijk artikel leerstof voor, maar met lage zekerheid', () => {
    const textSample = 'Abstract. Introduction. Methods. Results. Conclusions. References. doi:10.1000/x et al.';
    expect(suggestPurpose({ filename: 'smith2020.pdf', textSample })).toMatchObject({ purpose: 'course_material', confidence: 'low' });
  });

  it('valt voor onbekende bestanden terug op "delen"', () => {
    expect(suggestPurpose({ filename: 'logo.png' }).purpose).toBe('shared');
  });

  it('geeft altijd een geldig doel', () => {
    for (const f of ['a.pdf', 'b.xyz', '', 'Tentamen.csv']) {
      expect(PURPOSES).toContain(suggestPurpose({ filename: f }).purpose);
    }
  });
});

describe('effectivePurpose — niets verandert zolang er niets is bevestigd', () => {
  it('gebruikt het opgeslagen doel', () => {
    expect(effectivePurpose({ purpose: 'course_info', bucket: 'rag_sources' })).toBe('course_info');
  });
  it('leidt het oude gedrag af als er nog geen doel is', () => {
    expect(effectivePurpose({ purpose: null, bucket: 'rag_sources' })).toBe('course_material');
    expect(effectivePurpose({ purpose: null, bucket: 'docs_general' }, { folder_type: 'uploads' })).toBe('shared');
    expect(effectivePurpose({ purpose: null }, { folder_type: 'data' })).toBe('project');
  });
});

describe('purposeAllowsModule', () => {
  it('cursusinformatie alleen voor de chat, nooit voor begrippen/uitleg/quiz', () => {
    expect(purposeAllowsModule('course_info', 'general')).toBe(true);
    for (const m of ['explain', 'quiz', 'concepts']) expect(purposeAllowsModule('course_info', m)).toBe(false);
  });
  it('leerstof voor alles; leeg doel = oud gedrag (leerstof)', () => {
    for (const m of ['general', 'explain', 'quiz', 'concepts']) {
      expect(purposeAllowsModule('course_material', m)).toBe(true);
      expect(purposeAllowsModule(null, m)).toBe(true);
    }
  });
  it('delen en alleen-docenten nooit voor AI', () => {
    for (const p of ['shared', 'teacher_only']) {
      for (const m of ['general', 'explain', 'quiz', 'concepts', 'project']) expect(purposeAllowsModule(p, m)).toBe(false);
    }
    expect(PURPOSE_RULES.teacher_only.studentVisible).toBe(false);
  });
  it('isRagPurpose', () => {
    expect(isRagPurpose('course_material')).toBe(true);
    expect(isRagPurpose('course_info')).toBe(true);
    expect(isRagPurpose('shared')).toBe(false);
  });
});
