import { describe, it, expect, vi } from 'vitest';
import { backfillDocxPages } from '../pageBackfill.js';

// Regressie 2026-09-27: Word-bronnen die zonder LibreOffice waren ingelezen,
// hadden geen paginanummers; de viewer kon niet naar de juiste pagina.
const PAGE1 = 'Effectmodificatie betekent dat het effect van een determinant verschilt tussen deelgroepen van de onderzoekspopulatie.';
const PAGE2 = 'Voorbeeld: vaccinatie en zorgverleners. We bepalen afzonderlijke effecten voor zorgverleners en niet-zorgverleners en vergelijken die.';

function deps(chunks, pages = [PAGE1, PAGE2]) {
  const saved = new Map();
  return {
    saved,
    loadSourceBytes: vi.fn(async () => Buffer.from('docx')),
    convertToPdf: vi.fn(async () => Buffer.from('pdf')),
    extractPdfPageTexts: vi.fn(async () => pages),
    loadChunks: vi.fn(async () => chunks),
    saveChunkMetadata: vi.fn(async (id, md) => { saved.set(id, md); }),
  };
}

describe('backfillDocxPages', () => {
  it('zet pageStart/pageEnd op bestaande fragmenten en laat de rest van de metadata staan', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: PAGE1, metadata: { source: 'docx' } },
      { id: 'c2', chunk_index: 1, content: PAGE2, metadata: { source: 'docx' } },
    ]);
    const r = await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(r).toMatchObject({ status: 'done', chunks: 2, updated: 2, withoutPage: 0 });
    expect(d.saved.get('c1')).toMatchObject({ source: 'docx', pageStart: 1, pageEnd: 1 });
    expect(d.saved.get('c2')).toMatchObject({ source: 'docx', pageStart: 2, pageEnd: 2 });
  });

  it('laat een fragment zonder betrouwbare treffer zonder paginanummer (liever geen dan een fout nummer)', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: PAGE1, metadata: {} },
      { id: 'c2', chunk_index: 1, content: 'Tekst die nergens in de pdf voorkomt.', metadata: {} },
    ]);
    const r = await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(r).toMatchObject({ updated: 1, withoutPage: 1 });
    expect(d.saved.has('c2')).toBe(false);
  });

  it('doet niets voor andere bestandstypen of als alles al een paginanummer heeft', async () => {
    expect(await backfillDocxPages({ id: 'd', file_type: 'pdf' }, deps([]))).toMatchObject({ status: 'skipped', reason: 'notDocx' });
    const d = deps([{ id: 'c1', chunk_index: 0, content: PAGE1, metadata: { pageStart: 1, pageEnd: 1 } }]);
    expect(await backfillDocxPages({ id: 'd', file_type: 'docx' }, d)).toMatchObject({ status: 'skipped', reason: 'alreadyPaged' });
    expect(d.convertToPdf).not.toHaveBeenCalled();
  });
});

describe('backfillDocxPages — afwijkende tekst tussen officeparser en PDF', () => {
  it('vindt een fragment ook als leestekens/opsommingstekens verschillen', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: '• Effectmodificatie: betekent dat het effect van een determinant verschilt — tussen deelgroepen van de onderzoekspopulatie.', metadata: {} },
    ]);
    const r = await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(r.updated).toBe(1);
    expect(d.saved.get('c1')).toMatchObject({ pageStart: 1 });
    expect(d.saved.get('c1').pageEstimated).toBeUndefined();
  });

  it('schat de pagina van een onvindbaar fragment tussen twee gevonden fragmenten (gemarkeerd)', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: PAGE1, metadata: {} },
      { id: 'c2', chunk_index: 1, content: 'Tabelinhoud die in de pdf anders is opgemaakt.', metadata: {} },
      { id: 'c3', chunk_index: 2, content: PAGE2, metadata: {} },
    ]);
    await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(d.saved.get('c2')).toMatchObject({ pageStart: 1, pageEnd: 2, pageEstimated: true });
  });

  it('schat niet aan de rand van het document', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: 'Onvindbare inleiding.', metadata: {} },
      { id: 'c2', chunk_index: 1, content: PAGE2, metadata: {} },
    ]);
    const r = await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(d.saved.has('c1')).toBe(false);
    expect(r.withoutPage).toBe(1);
  });
});

describe('backfillDocxPages — eindpagina en opnieuw bepalen', () => {
  const P3 = 'Derde pagina met een toelichting over betrouwbaarheidsintervallen en de interpretatie ervan in de praktijk.';

  it('een fragment dat bovenaan de volgende pagina doorloopt, krijgt die pagina als eind (ook zonder overlap)', async () => {
    // c1 begint op p.1; zijn staart (overlap met c2) staat op p.2, maar met een
    // ingevoegd tabel-label dat niet in de pdf staat, dus de staart wordt niet gevonden.
    // Echte fragmenten zijn ~380 tokens; het begin moet langer zijn dan het
    // zoekvenster (160 tekens) zodat alleen de staart onvindbaar is.
    const LONG1 = `${PAGE1} Dit geldt bijvoorbeeld voor leeftijd, geslacht en sociaaleconomische status als mogelijke effectmodificatoren.`;
    const overlap = PAGE2.split(' ').slice(0, 10).join(' ');
    const c1 = `${LONG1} [tabel 3] ${overlap}`;
    const d = deps([
      { id: 'c1', chunk_index: 0, content: c1, metadata: {} },
      { id: 'c2', chunk_index: 1, content: PAGE2, metadata: {} },
    ], [LONG1, PAGE2]);
    await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(d.saved.get('c1')).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it('force: bepaalt pagina’s opnieuw, ook als alles al een paginanummer had', async () => {
    const d = deps([{ id: 'c1', chunk_index: 0, content: P3, metadata: { pageStart: 1, pageEnd: 1 } }], [PAGE1, PAGE2, P3]);
    const r = await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d, { force: true });
    expect(r.status).toBe('done');
    expect(d.saved.get('c1')).toMatchObject({ pageStart: 3, pageEnd: 3 });
  });
});

describe('backfillDocxPages — eind via lengte', () => {
  it('een fragment dat precies op zijn pagina past, wordt niet verlengd', async () => {
    const d = deps([
      { id: 'c1', chunk_index: 0, content: PAGE1, metadata: {} },
      { id: 'c2', chunk_index: 1, content: PAGE2, metadata: {} },
    ]);
    await backfillDocxPages({ id: 'd1', file_type: 'docx' }, d);
    expect(d.saved.get('c1')).toMatchObject({ pageStart: 1, pageEnd: 1 });
  });
});
