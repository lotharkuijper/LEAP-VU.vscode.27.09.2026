// Paginanummers aanvullen bij BESTAANDE fragmenten van Word-bronnen.
//
// Aanleiding (2026-09-27): op een server zonder LibreOffice slaat het inlezen
// van .docx de pagina-toewijzing stil over (Task #377 heeft LibreOffice→PDF
// nodig). Die fragmenten hebben dan geen pageStart, en de viewer kan niet naar
// de juiste pagina springen. Opnieuw inlezen zou nieuwe chunk-id's en
// embeddings geven en het bronbewijs van begrippen (concept_evidence.chunk_id)
// laten verweesen. Deze functie zet alleen metadata.pageStart/pageEnd op de
// bestaande rijen: tekst, embedding en id blijven gelijk.
//
// Afhankelijkheden worden ingevoegd zodat de logica zonder DB/LibreOffice
// testbaar is.

import { assignPdfPages } from './pdfPages.js';
import { DOCX_PAGED_EXT, normalizeExt } from './documentRender.js';

/**
 * @param {{ id: string, file_type?: string, filename?: string }} doc
 * @param {{
 *   loadSourceBytes: (doc) => Promise<Buffer>,
 *   convertToPdf: (buf: Buffer, ext: string) => Promise<Buffer>,
 *   extractPdfPageTexts: (pdf: Buffer) => Promise<string[]>,
 *   loadChunks: (docId: string) => Promise<Array<{ id: string, content: string, chunk_index: number, metadata: object | null }>>,
 *   saveChunkMetadata: (chunkId: string, metadata: object) => Promise<void>,
 * }} deps
 * @returns {Promise<{ status: 'skipped' | 'done', reason?: string, chunks?: number, updated?: number, withoutPage?: number }>}
 */
export async function backfillDocxPages(doc, deps) {
  const ext = normalizeExt(doc.file_type || String(doc.filename || '').split('.').pop());
  if (!DOCX_PAGED_EXT.has(ext)) return { status: 'skipped', reason: 'notDocx' };

  const chunks = (await deps.loadChunks(doc.id)).slice().sort((a, b) => a.chunk_index - b.chunk_index);
  if (chunks.length === 0) return { status: 'skipped', reason: 'noChunks' };
  if (chunks.every((c) => c.metadata && c.metadata.pageStart != null)) {
    return { status: 'skipped', reason: 'alreadyPaged', chunks: chunks.length };
  }

  const pdf = await deps.convertToPdf(await deps.loadSourceBytes(doc), ext);
  const pageTexts = await deps.extractPdfPageTexts(pdf);
  if (!Array.isArray(pageTexts) || pageTexts.join('').trim().length === 0) {
    return { status: 'skipped', reason: 'noPageText', chunks: chunks.length };
  }

  const objs = chunks.map((c) => ({ id: c.id, text: c.content, metadata: { ...(c.metadata || {}) } }));
  assignPdfPages(pageTexts, objs);

  let updated = 0;
  let withoutPage = 0;
  for (let i = 0; i < objs.length; i++) {
    const before = chunks[i].metadata || {};
    const after = objs[i].metadata;
    if (after.pageStart == null) { withoutPage++; continue; }
    if (before.pageStart === after.pageStart && before.pageEnd === after.pageEnd) continue;
    await deps.saveChunkMetadata(objs[i].id, after);
    updated++;
  }
  return { status: 'done', chunks: chunks.length, updated, withoutPage };
}
