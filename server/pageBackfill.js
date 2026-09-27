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
export async function backfillDocxPages(doc, deps, { force = false } = {}) {
  const ext = normalizeExt(doc.file_type || String(doc.filename || '').split('.').pop());
  if (!DOCX_PAGED_EXT.has(ext)) return { status: 'skipped', reason: 'notDocx' };

  const chunks = (await deps.loadChunks(doc.id)).slice().sort((a, b) => a.chunk_index - b.chunk_index);
  if (chunks.length === 0) return { status: 'skipped', reason: 'noChunks' };
  if (!force && chunks.every((c) => c.metadata && c.metadata.pageStart != null)) {
    return { status: 'skipped', reason: 'alreadyPaged', chunks: chunks.length };
  }

  const pdf = await deps.convertToPdf(await deps.loadSourceBytes(doc), ext);
  const pageTexts = await deps.extractPdfPageTexts(pdf);
  if (!Array.isArray(pageTexts) || pageTexts.join('').trim().length === 0) {
    return { status: 'skipped', reason: 'noPageText', chunks: chunks.length };
  }

  // Bij `force` opnieuw bepalen vanaf nul (oude paginavelden eruit).
  const strip = ({ pageStart, pageEnd, pageNumber, pageEstimated, ...rest }) => rest;
  const objs = chunks.map((c) => ({ id: c.id, text: c.content, metadata: force ? strip(c.metadata || {}) : { ...(c.metadata || {}) } }));
  // Ronde 1: zoals bij het inlezen (witruimte-ongevoelig).
  assignPdfPages(pageTexts, objs);
  // Ronde 2: de bestaande fragmenten komen uit officeparser, de pagina's uit de
  // PDF; opsommingstekens, formules en leestekens verschillen dan vaak. Vergelijk
  // voor de nog niet gevonden fragmenten alleen letters en cijfers.
  const lettersOnly = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const missing = objs.filter((o) => o.metadata.pageStart == null);
  if (missing.length) {
    const loose = missing.map((o) => ({ text: lettersOnly(o.text), metadata: o.metadata }));
    assignPdfPages(pageTexts.map(lettersOnly), loose);
  }
  // Ronde 3: een fragment dat nog steeds niet gevonden is maar tussen twee
  // gevonden fragmenten ligt, staat (fragmenten zijn op volgorde) op de pagina's
  // daartussen. Gemarkeerd als schatting.
  for (let i = 0; i < objs.length; i++) {
    const md = objs[i].metadata;
    if (md.pageStart != null) continue;
    let p = i - 1; while (p >= 0 && objs[p].metadata.pageStart == null) p--;
    let n = i + 1; while (n < objs.length && objs[n].metadata.pageStart == null) n++;
    const prev = p >= 0 ? objs[p].metadata : null;
    const next = n < objs.length ? objs[n].metadata : null;
    if (!prev || !next) continue; // aan de rand: liever geen dan een fout nummer
    const start = prev.pageEnd ?? prev.pageStart;
    const end = Math.max(start, next.pageStart);
    if (end - start > 2) continue; // te grote sprong: te onzeker
    md.pageStart = start;
    md.pageEnd = end;
    md.pageNumber = start;
    md.pageEstimated = true;
  }
  // Ronde 4: als het eind van een fragment niet letterlijk terug te vinden is,
  // zet assignPdfPages pageEnd op de beginpagina, terwijl het fragment vaak
  // doorloopt op de volgende pagina (gecontroleerd tegen de PDF: 12 van 115).
  // Schat het eind daarom via de lengte: zoek het begin van het fragment in de
  // PDF-tekst en tel de lengte van het fragment erbij op. Werkt met én zonder
  // overlap tussen fragmenten. Alleen verlengen, nooit inkorten.
  const pagesLoose = pageTexts.map((t) => lettersOnly(t).replace(/\s+/g, ' ').trim());
  const bounds = [];
  let full = '';
  pagesLoose.forEach((t, i) => {
    if (!t) return;
    const start = full ? full.length + 1 : 0;
    full += (full ? ' ' : '') + t;
    bounds.push({ page: i + 1, start, end: full.length });
  });
  const pageAtPos = (pos) => (bounds.find((b) => pos >= b.start && pos < b.end) || bounds[bounds.length - 1])?.page ?? null;
  let from = 0;
  for (const o of objs) {
    const md = o.metadata;
    if (md.pageStart == null || md.pageEstimated) continue;
    const text = lettersOnly(o.text).replace(/\s+/g, ' ').trim();
    const head = text.slice(0, 80);
    if (head.length < 40) continue;
    let pos = full.indexOf(head, from);
    if (pos === -1) pos = full.indexOf(head);
    if (pos === -1) continue;
    from = pos + 1;
    const endPage = pageAtPos(Math.min(full.length - 1, pos + text.length - 1));
    const end = md.pageEnd ?? md.pageStart;
    if (endPage != null && endPage > end && endPage - md.pageStart <= 2) md.pageEnd = endPage;
  }

  let updated = 0;
  let withoutPage = 0;
  for (let i = 0; i < objs.length; i++) {
    const before = chunks[i].metadata || {};
    const after = objs[i].metadata;
    if (after.pageStart == null) { withoutPage++; continue; }
    if (before.pageStart === after.pageStart && before.pageEnd === after.pageEnd && !!before.pageEstimated === !!after.pageEstimated) continue;
    await deps.saveChunkMetadata(objs[i].id, after);
    updated++;
  }
  return { status: 'done', chunks: chunks.length, updated, withoutPage };
}
