// Cursusmateriaal als context voor het taalmodel, op de server samengesteld
// (2026-11-12). De browser zoekt de fragmenten en geeft alleen door WELKE het
// zijn; de server leest de tekst zelf. Zo kan niemand eigen "cursustekst" in een
// beoordeling smokkelen (quizvragen, Ik leg uit en de badges daarbij).

import { purposeAllowsModule } from './filePurpose.js';
import { buildContextWithCap } from './contextCap.js';

const MAX_CHUNK_IDS = 60;

/**
 * Alleen fragmenten uit RAG-mappen van deze cursus en uit documenten die voor
 * dit onderdeel mogen (cursusinformatie levert bv. geen quizvragen), in de
 * volgorde van de browser (beste eerst).
 * @param {object} db  supabaseAdmin
 * @param {{courseId: string, chunkIds: string[], courseFolderIds: (courseId: string) => Promise<string[]>, module: 'quiz'|'explain'}} p
 */
export async function loadCourseContext(db, { courseId, chunkIds, courseFolderIds, module }) {
  const empty = { context: '', usedChunks: 0, totalChunks: 0, charTrimmed: false };
  const ids = [...new Set((chunkIds || []).filter(id => typeof id === 'string' && id))].slice(0, MAX_CHUNK_IDS);
  if (!courseId || ids.length === 0) return empty;
  const folders = new Set(await courseFolderIds(courseId));
  if (folders.size === 0) return empty;
  const { data: rows } = await db.from('document_chunks').select('id, content, document_id').in('id', ids);
  const docIds = [...new Set((rows || []).map(r => r.document_id).filter(Boolean))];
  if (docIds.length === 0) return empty;
  const { data: docs } = await db.from('documents').select('id, title, filename, folder_id, purpose').in('id', docIds);
  const docById = new Map((docs || []).filter(d => folders.has(d.folder_id) && purposeAllowsModule(d.purpose, module)).map(d => [d.id, d]));
  const byId = new Map((rows || []).map(r => [r.id, r]));
  const chunks = ids
    .map(id => byId.get(id))
    .filter(r => r && docById.has(r.document_id) && String(r.content || '').trim())
    .map(r => ({ id: r.id, content: r.content, documentTitle: docById.get(r.document_id).title || docById.get(r.document_id).filename || 'Cursusmateriaal' }));
  const built = buildContextWithCap(chunks);
  return { context: built.context, usedChunks: built.usedChunks, totalChunks: built.totalChunks, charTrimmed: built.charTrimmed };
}
