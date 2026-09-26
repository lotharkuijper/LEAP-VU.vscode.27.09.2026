import { describe, it, expect } from 'vitest';
import { planPurposeChange, buildReadinessWarnings, docsChangedSinceConcepts, summarizeWebSync, buildWebSourceList } from '../courseFiles.js';

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

describe('docsChangedSinceConcepts', () => {
  it('meldt nieuwe leerstof na de laatste begrippen-run', () => {
    expect(docsChangedSinceConcepts({ lastDocChange: '2026-09-25T10:00:00Z', lastConceptsRun: '2026-09-18T13:26:21Z' })).toBe(true);
    expect(docsChangedSinceConcepts({ lastDocChange: '2026-09-18T12:12:45Z', lastConceptsRun: '2026-09-18T13:26:21Z' })).toBe(false);
    expect(docsChangedSinceConcepts({ lastDocChange: null, lastConceptsRun: null })).toBe(false);
    expect(docsChangedSinceConcepts({ lastDocChange: '2026-09-25T10:00:00Z', lastConceptsRun: null })).toBe(true);
  });
  it('wordt een waarschuwing bij de stap Begrippen (alleen als er al begrippen zijn)', () => {
    const f = { title: 'x', filename: 'x.pdf', purpose: 'course_material', purposeConfirmed: true, processing_status: 'completed', total_chunks: 5, file_size: 1, isWeb: false };
    const w = buildReadinessWarnings({ files: [f], concepts: [{ name: 'A', visible: true, quizReady: true }], projects: [], docsChanged: true });
    expect(w.find(x => x.code === 'docsChanged')).toMatchObject({ step: 'concepts' });
    expect(buildReadinessWarnings({ files: [f], concepts: [], projects: [], docsChanged: true }).some(x => x.code === 'docsChanged')).toBe(false);
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

describe('websitebronnen', () => {
  it('summarizeWebSync telt verdwenen pagina\'s apart binnen de fouten', () => {
    expect(summarizeWebSync([
      { status: 'imported' },
      { status: 'skipped', unchanged: true },
      { status: 'skipped' },
      { status: 'error', notFound: true },
      { status: 'error' },
    ])).toEqual({ total: 5, imported: 1, unchanged: 1, skipped: 1, errors: 2, notFound: 1 });
  });

  it('buildWebSourceList telt pagina\'s en fragmenten per bron', () => {
    const files = [
      { webSourceId: 's1', total_chunks: 4, processing_status: 'completed' },
      { webSourceId: 's1', total_chunks: 2, processing_status: 'failed' },
      { webSourceId: null, total_chunks: 9, processing_status: 'completed' },
    ];
    const [s] = buildWebSourceList([{ id: 's1', base_url: 'https://x.nl/boek/', title: 'x.nl/boek', purpose: 'course_material' }], files);
    expect(s).toMatchObject({ id: 's1', title: 'x.nl/boek', pageCount: 2, chunkCount: 6, failedPages: 1 });
  });

  it('meldt mislukte en verouderde websites in "Klaar voor studenten"', () => {
    const now = new Date('2026-09-26').getTime();
    const w = buildReadinessWarnings({
      files: [], concepts: [], projects: [], now,
      webSources: [
        { title: 'kapot', lastSyncedAt: '2026-09-20', lastSync: { errors: 2 } },
        { title: 'oud', lastSyncedAt: '2026-01-01', lastSync: { errors: 0 } },
      ],
    });
    expect(w.find(x => x.code === 'webSourceProblems')).toMatchObject({ severity: 'warning', items: ['kapot'] });
    expect(w.find(x => x.code === 'webSourceStale')).toMatchObject({ severity: 'info', items: ['oud'] });
  });
});
