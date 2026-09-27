// Bereidt bestaande Office-bronnen in de RAG voor op de documentviewer:
//  1. Word (docx/doc/odt): vult paginanummers aan bij de bestaande fragmenten
//     (alleen document_chunks.metadata.pageStart/pageEnd; tekst, embeddings,
//     chunk-id's en het bronbewijs van begrippen blijven ongemoeid);
//  2. Word én PowerPoint: bewaart de PDF-weergaveversie in de opslag, zodat
//     studenten de bron direct kunnen bekijken zonder dat de server hem bij het
//     openen nog hoeft om te zetten.
// Nieuwe uploads krijgen dit automatisch bij het inlezen; dit script is voor
// bestanden die zijn ingelezen op een server zonder LibreOffice.
//
// Gebruik:  node scripts/prepare-office-sources.mjs            (alle Office-bronnen in de RAG)
//           node scripts/prepare-office-sources.mjs --dry-run  (alleen tellen, niets opslaan)
//           node scripts/prepare-office-sources.mjs --force    (paginanummers opnieuw bepalen)
// Vereist LibreOffice (soffice) — op Windows wordt Program Files automatisch gevonden.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { backfillDocxPages } from '../server/pageBackfill.js';
import {
  convertOfficeToPdf, resolveSofficeBin, renditionCachePath, renditionSourceKey, CONVERT_TO_PDF_EXT, normalizeExt,
} from '../server/documentRender.js';
import { extractPdfPageTexts } from '../server/pdfPageText.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force'); // paginanummers opnieuw bepalen, ook als ze er al zijn
const sb = createClient(process.env.VITE_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

console.log(`LibreOffice: ${resolveSofficeBin()}${dryRun ? '  (dry-run: er wordt niets opgeslagen)' : ''}`);

const { data: all, error } = await sb.from('documents')
  .select('id, title, filename, file_type, file_path, bucket')
  .eq('bucket', 'rag_sources');
if (error) { console.error(error.message); process.exit(1); }
const docs = (all || []).filter((d) => CONVERT_TO_PDF_EXT.has(normalizeExt(d.file_type)) && d.file_path);

const loadSourceBytes = async (doc) => {
  const { data, error: e } = await sb.storage.from(doc.bucket).download(doc.file_path);
  if (e || !data) throw new Error(`bronbestand niet leesbaar: ${e?.message || 'leeg'}`);
  return Buffer.from(await data.arrayBuffer());
};
const renditionExists = async (doc) => {
  const p = renditionCachePath(doc.id, renditionSourceKey(doc));
  const { data } = await sb.storage.from(doc.bucket).createSignedUrl(p, 60);
  return !!data?.signedUrl;
};
const storeRendition = async (doc, pdf) => {
  if (dryRun) return;
  const p = renditionCachePath(doc.id, renditionSourceKey(doc));
  const { error: e } = await sb.storage.from(doc.bucket).upload(p, pdf, { contentType: 'application/pdf', upsert: true });
  if (e) throw new Error(`weergaveversie niet opgeslagen: ${e.message}`);
};

let failed = 0;
for (const doc of docs) {
  try {
    let pdfMade = null;
    const deps = {
      loadSourceBytes,
      // Eén omzetting per document: dezelfde PDF levert de paginanummers én de weergaveversie.
      convertToPdf: async (buf, ext) => { pdfMade = await convertOfficeToPdf(buf, ext); return pdfMade; },
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
    const pages = await backfillDocxPages(doc, deps, { force });
    let rendition = 'bestond al';
    if (!(await renditionExists(doc))) {
      const pdf = pdfMade || await convertOfficeToPdf(await loadSourceBytes(doc), normalizeExt(doc.file_type));
      await storeRendition(doc, pdf);
      rendition = dryRun ? 'zou worden gemaakt' : 'gemaakt';
    }
    console.log(`✓ ${doc.title}: pagina's ${JSON.stringify(pages)} · weergaveversie ${rendition}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${doc.title}: ${err.message}`);
  }
}
console.log(`${docs.length} Office-bron(nen) verwerkt, ${failed} mislukt.`);
if (failed) process.exitCode = 1;
