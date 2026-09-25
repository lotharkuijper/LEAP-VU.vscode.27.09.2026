import { describe, it, expect } from 'vitest';
import { planPurposeChange, buildReadinessWarnings } from '../courseFiles.js';

describe('planPurposeChange', () => {
  it('leerstof ↔ cursusinformatie: alleen het label, fragmenten blijven; naar cursusinfo vervalt het bewijs', () => {
    expect(planPurposeChange({ from: 'course_material', to: 'course_info', ext: 'pdf' }))
      .toMatchObject({ ok: true, kind: 'relabel', dropEvidence: true });
    expect(planPurposeChange({ from: 'course_info', to: 'course_material', ext: 'pdf' }))
      .toMatchObject({ ok: true, kind: 'relabel', dropEvidence: false });
  });

  it('van leerstof naar delen/alleen-docenten: fragmenten verwijderen (geen AI meer)', () => {
    for (const to of ['shared', 'teacher_only']) {
      expect(planPurposeChange({ from: 'course_material', to, ext: 'pdf' }))
        .toMatchObject({ ok: true, kind: 'toNonRag', dropChunks: true, docChanged: true });
    }
  });

  it('van delen naar leerstof: opnieuw verwerken — maar alleen voor verwerkbare typen', () => {
    expect(planPurposeChange({ from: 'shared', to: 'course_material', ext: 'pdf' }))
      .toMatchObject({ ok: true, kind: 'toRag', reprocess: true });
    expect(planPurposeChange({ from: 'shared', to: 'course_material', ext: 'png' }))
      .toMatchObject({ ok: false, error: 'notProcessable' });
  });

  it('webpagina’s kunnen alleen leerstof of cursusinformatie zijn', () => {
    expect(planPurposeChange({ from: 'course_material', to: 'shared', isWeb: true })).toMatchObject({ ok: false, error: 'webPageOnlyRag' });
    expect(planPurposeChange({ from: 'course_material', to: 'course_info', isWeb: true }).ok).toBe(true);
  });

  it('naar projectmateriaal: verplaatsen naar het project', () => {
    expect(planPurposeChange({ from: 'course_material', to: 'project', ext: 'pdf' }))
      .toMatchObject({ ok: true, kind: 'toProject', dropChunks: true });
  });

  it('zelfde doel = alleen bevestigen; ongeldig doel geweigerd', () => {
    expect(planPurposeChange({ from: 'course_material', to: 'course_material' })).toMatchObject({ ok: true, kind: 'noop' });
    expect(planPurposeChange({ from: 'course_material', to: 'iets' })).toMatchObject({ ok: false, error: 'invalidPurpose' });
  });
});

describe('buildReadinessWarnings', () => {
  const file = (over) => ({
    title: 'x.pdf', filename: 'x.pdf', purpose: 'course_material', purposeConfirmed: true,
    processing_status: 'completed', total_chunks: 10, file_size: 100000, isWeb: false, ...over,
  });
  const codes = (w) => w.map(x => x.code);

  it('een gezonde cursus geeft geen waarschuwingen', () => {
    const w = buildReadinessWarnings({
      files: [file()],
      concepts: [{ name: 'RR', visible: true, quizReady: true }],
      projects: [{ title: 'P', documents: [{}] }],
    });
    expect(w).toEqual([]);
  });

  it('signaleert onbevestigde doelen, zichtbare antwoordbestanden en ontbrekende leerstof', () => {
    const w = buildReadinessWarnings({
      files: [file({ purpose: 'shared', title: 'Antwoordmodel week 1.pdf', filename: 'Antwoordmodel week 1.pdf', purposeConfirmed: false })],
      concepts: [], projects: [],
    });
    expect(codes(w)).toEqual(expect.arrayContaining(['unconfirmedPurposes', 'sensitiveVisible', 'noCourseMaterial']));
  });

  it('antwoordbestand als "alleen voor docenten" is géén probleem', () => {
    const w = buildReadinessWarnings({ files: [file(), file({ purpose: 'teacher_only', title: 'Antwoordmodel.pdf', filename: 'Antwoordmodel.pdf' })], concepts: [], projects: [] });
    expect(codes(w)).not.toContain('sensitiveVisible');
  });

  it('signaleert verwerkingsproblemen, waaronder één reuzenfragment', () => {
    const w = buildReadinessWarnings({
      files: [
        file({ title: 'a', processing_status: 'failed' }),
        file({ title: 'b', total_chunks: 0 }),
        file({ title: 'c', total_chunks: 1, file_size: 900000 }),
      ],
      concepts: [], projects: [],
    });
    expect(codes(w)).toEqual(expect.arrayContaining(['processingFailed', 'noChunks', 'singleGiantChunk']));
  });

  it('signaleert begrippen zonder bronfragment in quiz-materiaal (quiz niet mogelijk)', () => {
    const w = buildReadinessWarnings({
      files: [file()],
      concepts: [{ name: 'Ecologisch onderzoek', visible: true, quizReady: false }, { name: 'Verborgen', visible: false, quizReady: false }],
      projects: [],
    });
    const item = w.find(x => x.code === 'conceptsWithoutEvidence');
    expect(item.items).toEqual(['Ecologisch onderzoek']);
  });
});
