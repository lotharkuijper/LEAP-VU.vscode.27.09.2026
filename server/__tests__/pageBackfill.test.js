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
