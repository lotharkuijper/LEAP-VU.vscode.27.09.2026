// Vult paginanummers aan bij bestaande fragmenten van Word-bronnen (docx/doc/odt)
// die zonder LibreOffice zijn ingelezen. Wijzigt alleen document_chunks.metadata
// (pageStart/pageEnd); tekst, embeddings, chunk-id's en het bronbewijs van
// begrippen blijven ongemoeid. Zie server/pageBackfill.js.
//
// Gebruik:  node scripts/backfill-docx-pages.mjs            (alle Word-bronnen in de RAG)
//           node scripts/backfill-docx-pages.mjs --dry-run  (alleen tellen, niets opslaan)
// Vereist LibreOffice (soffice) — op Windows wordt Program Files automatisch gevonden.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { backfillDocxPages } from '../server/pageBackfill.js';
import { convertOfficeToPdf, resolveSofficeBin } from '../server/documentRender.js';
import { extractPdfPageTexts } from '../server/pdfPageText.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const dryRun = process.argv.includes('--dry-run');
const sb = createClient(process.env.VITE_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log(`LibreOffice: ${resolveSofficeBin()}${dryRun ? '  (dry-run: er wordt niets opgeslagen)' : ''}`);

const { data: docs, error } = await sb.from('documents')
  .select('id, title, filename, file_type, file_path, bucket')
  .eq('bucket', 'rag_sources').in('file_type', ['docx', 'doc', 'odt']);
if (error) { console.error(error.message); process.exit(1); }

const deps = {
  loadSourceBytes: async (doc) => {
    const { data, error: e } = await sb.storage.from(doc.bucket).download(doc.file_path);
    if (e || !data) throw new Error(`bronbestand niet leesbaar: ${e?.message || 'leeg'}`);
    return Buffer.from(await data.arrayBuffer());
  },
  convertToPdf: convertOfficeToPdf,
  extractPdfPageTexts,
  loadChunks: async (docId) => {
    const { data, error: e } = await sb.from('document_chunks').select('id, content, chunk_index, metadata').eq('document_id', docId);
    if (e) throw new Error(e.message);
    return data || [];
  },
  saveChunkMetadata: async (id, metadata) => {
    if (dryRun) return;
    const { error: e } = await sb.from('document_chunks').update({ metadata }).eq('id', id);
    if (e) throw new Error(e.message);
  },
};

let failed = 0;
for (const doc of docs || []) {
  try {
    const r = await backfillDocxPages(doc, deps);
    console.log(`${r.status === 'done' ? '✓' : '·'} ${doc.title}: ${JSON.stringify(r)}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${doc.title}: ${err.message}`);
  }
}
if (failed) process.exitCode = 1;
