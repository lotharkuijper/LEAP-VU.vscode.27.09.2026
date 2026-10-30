import { chunkPlainText } from '../rag/chunking.js';
import {
  CONVERT_TO_PDF_EXT,
  DOCX_PAGED_EXT,
  convertOfficeToPdf,
  normalizeExt,
  queueConversion,
  renditionCachePath,
  renditionSourceKey,
} from '../documents/documentRender.js';
import {
  AZURE_CHAT_READY,
  AZURE_EMBEDDINGS_READY,
  EMBEDDINGS_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  embedTextsServer,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { pgPool, supabaseAdmin } from '../lib/supabase.js';
import { parseOfficeAsync } from '../lib/uploads.js';
import { assignPdfPages } from './pdfPages.js';
import { extractPdfPageTexts } from './pdfPageText.js';
import {
  extractPptxStructured,
  fallbackChunks,
  slideToText,
  splitLongSections,
  validateSections,
} from './pptxExtract.js';
import { ensureCourseRagFolderWith } from '../rag/ragFolder.js';
import {
  processDocxCore as processDocxCoreImpl,
  processPlainRagDocument as processPlainRagDocumentImpl,
  processPptxCore as processPptxCoreImpl,
} from './ragProcessing.js';

// LLM-chunking van één venster dia's. Retourneert genormaliseerde secties of
// null (caller valt dan terug op het deterministische vangnet).
async function chunkSlideWindow(win, openaiKey, lang = 'nl') {
  // Semantische LLM-chunking loopt via Azure-chat. Zonder Azure-config valt de
  // caller terug op het deterministische vangnet (fallbackChunks).
  if (!AZURE_CHAT_READY) return null;
  const minSlide = win[0].slide;
  const maxSlide = win[win.length - 1].slide;
  const deckText = win.map(slideToText).join('\n\n');
  const system = lang === 'en'
    ? 'You segment lecture slides into coherent, self-contained study passages for a retrieval (RAG) index. Group consecutive slides that belong together. Rewrite each group as a flowing Dutch-or-English passage (match the slide language) that preserves the facts, including speaker notes. Never invent content. Respond ONLY with JSON.'
    : 'Je verdeelt college-dia\'s in samenhangende, op zichzelf staande studiepassages voor een zoek-index (RAG). Groepeer opeenvolgende dia\'s die bij elkaar horen. Herschrijf elke groep als lopende tekst in de taal van de dia\'s, met behoud van alle feiten inclusief de sprekersnotities. Verzin niets. Antwoord UITSLUITEND met JSON.';
  const instruction = `Geef JSON in de vorm {"sections":[{"title":"...","slideStart":N,"slideEnd":M,"content":"..."}]}. slideStart/slideEnd verwijzen naar de "Dia N"-nummers hieronder (tussen ${minSlide} en ${maxSlide}). Elke sectie bevat lopende, op zichzelf staande tekst.\n\nDIA'S:\n${deckText}`;

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: instruction },
    ],
    ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
    response_format: { type: 'json_object' },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await openaiChatCompletion(body);
      const data = await resp.json();
      if (!resp.ok) {
        console.warn(`[process-pptx] LLM-chunk venster ${minSlide}-${maxSlide} status=${resp.status}`);
        continue;
      }
      const raw = data?.choices?.[0]?.message?.content;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const sections = parsed ? validateSections(parsed, minSlide, maxSlide) : null;
      if (sections) return sections;
    } catch (err) {
      console.warn(`[process-pptx] LLM-chunk venster ${minSlide}-${maxSlide} fout: ${err.message}`);
    }
  }
  return null;
}

// Orkestreert semantische chunking over het hele deck met char-vensters.
// Faalt een venster, dan valt enkel dat venster terug op fallbackChunks.
async function semanticChunkDeck(slides, openaiKey, lang = 'nl') {
  const windows = [];
  let cur = [];
  let curChars = 0;
  for (const s of slides) {
    const t = slideToText(s);
    if (cur.length && curChars + t.length > 14000) {
      windows.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(s);
    curChars += t.length + 2;
  }
  if (cur.length) windows.push(cur);

  const all = [];
  let llmWindows = 0;
  let fallbackWindows = 0;
  for (const win of windows) {
    const sections = await chunkSlideWindow(win, openaiKey, lang);
    if (sections) {
      llmWindows++;
      all.push(...sections);
    } else {
      fallbackWindows++;
      all.push(...fallbackChunks(win));
    }
  }
  all.sort((a, b) => a.slideStart - b.slideStart || a.slideEnd - b.slideEnd);
  let mode = 'llm';
  if (fallbackWindows > 0) mode = llmWindows > 0 ? 'mixed' : 'fallback';
  return { sections: all, mode };
}

// chunkPlainText/buildEmbedInput leven nu in ./chunking.js (één bron van waarheid,
// gedeeld met onderhoudsscripts voor her-ingestie). Zie Task #394.

// Kernverwerking voor .pptx: download, extractie van dia's + sprekersnotities,
// semantische chunking (LLM met vangnet), embeddings en persistentie. Zet de
// document-status zelf (failed bij fout, completed bij succes). Gooit bij fout
// een Error met optionele `.status` voor de HTTP-respons van de caller.
// Thin wrapper: de kernlogica leeft in ./ragProcessing.js (testbaar via
// dependency injection). Hier injecteren we de echte server-afhankelijkheden.
export async function processPptxCore(doc, openaiKey, lang = 'nl') {
  const result = await processPptxCoreImpl(doc, openaiKey, lang, {
    supabaseAdmin,
    pgPool,
    extractPptxStructured,
    semanticChunkDeck,
    splitLongSections,
    fallbackChunks,
    embedTextsServer,
    log: (...a) => console.log(...a),
  });
  // Dia's worden zonder PDF ingelezen; maak de weergaveversie daarna op de
  // achtergrond, zodat studenten de presentatie direct kunnen bekijken.
  prerenderRenditionInBackground(doc);
  return result;
}

// ── Weergaveversies (PDF) van Office-bronnen ─────────────────────────────────
// Opgeslagen in de bucket van de bron onder __renditions__/, met een sleutel die
// het bronbestand volgt (renditionSourceKey). Gemaakt bij het inlezen; /view
// maakt ze alleen nog zelf als ze ontbreken (bv. bij oudere bestanden).
export async function storeRendition(doc, pdfBuffer) {
  const bucket = doc.bucket || 'rag_sources';
  const renditionPath = renditionCachePath(doc.id, renditionSourceKey(doc));
  const { error } = await supabaseAdmin.storage.from(bucket)
    .upload(renditionPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(`opslaan mislukt: ${error.message}`);
  return renditionPath;
}

function prerenderRenditionInBackground(doc) {
  const ext = normalizeExt(doc.file_type || String(doc.filename || '').split('.').pop());
  if (!CONVERT_TO_PDF_EXT.has(ext) || !doc.file_path || !doc.bucket) return;
  (async () => {
    const { data, error } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
    if (error || !data) throw new Error(`bronbestand niet leesbaar: ${error?.message || 'leeg'}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    const pdf = await queueConversion(() => convertOfficeToPdf(bytes, ext));
    await storeRendition(doc, pdf);
    console.log(`[rendition] doc=${doc.id} weergaveversie gemaakt`);
  })().catch((e) => console.warn(`[rendition] doc=${doc.id} niet gemaakt (de viewer valt terug op tekst): ${e.message}`));
}

// Kernverwerking voor platte-tekstbronnen (.pdf/.docx/.txt/.xlsx/...): download,
// tekstextractie (officeparser voor kantoorformaten, utf8 voor tekst), chunking,
// embeddings en persistentie. Zet de document-status zelf.
function processPlainRagDocument(doc, openaiKey) {
  return processPlainRagDocumentImpl(doc, openaiKey, {
    supabaseAdmin,
    pgPool,
    parseOfficeAsync,
    extractPdfPageTexts,
    assignPdfPages,
    chunkPlainText,
    embedTextsServer,
    log: (...a) => console.log(...a),
  });
}

// Pagina-bewuste verwerking voor Word-bronnen (.docx/.doc/.odt): converteert via
// LibreOffice naar PDF, extraheert per-pagina tekst en koppelt elke chunk aan
// zijn paginanummer(s) zodat bronkaarten "p. 12" tonen en de viewer naar de
// juiste pagina springt (Task #377). Thin wrapper rond de kern in ragProcessing.
// De PDF die hier voor de paginanummers wordt gemaakt, bewaren we meteen als
// weergaveversie: zo opent de viewer de bron direct, zonder dat LibreOffice op
// het moment van bekijken nodig is.
export function processDocxCore(doc, openaiKey) {
  return processDocxCoreImpl(doc, openaiKey, {
    supabaseAdmin,
    pgPool,
    convertToPdf: async (buf, ext) => {
      const pdf = await queueConversion(() => convertOfficeToPdf(buf, ext));
      storeRendition(doc, pdf).catch((e) => console.warn(`[rendition] doc=${doc.id} niet opgeslagen: ${e.message}`));
      return pdf;
    },
    extractPdfPageTexts,
    chunkPlainText,
    assignPdfPages,
    embedTextsServer,
    parseOfficeAsync,
    log: (...a) => console.log(...a),
  });
}

// Dispatcher: verwerkt een RAG-document op basis van het bestandstype. Wordt
// gebruikt door de admin-folder-upload-route zodat elk geüpload RAG-bestand
// automatisch chunks + embeddings krijgt en niet op 'pending' blijft hangen.
export async function processRagDocumentById(documentId, lang = 'nl') {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const { data: doc, error: docErr } = await supabaseAdmin
    .from('documents')
    .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
    .eq('id', documentId)
    .maybeSingle();
  // Een echte query-fout (transiënt PostgREST-probleem of verouderde schema-cache)
  // NIET als "document niet gevonden" behandelen: anders markeren we een bestaand
  // document onterecht als 'failed' of embedden we onnodig opnieuw. Surface de fout.
  if (docErr) throw new Error(`Kon document niet opzoeken: ${docErr.message}`);
  if (!doc) throw new Error('Document niet gevonden');
  const ext = (doc.file_type || '').toLowerCase().replace(/^\./, '');
  if (ext === 'pptx') return processPptxCore(doc, null, lang);
  if (DOCX_PAGED_EXT.has(ext)) return processDocxCore(doc, null);
  return processPlainRagDocument(doc, null);
}

// Zorgt dat er een RAG-map (`RAG - <cursusnaam>`) bestaat, met permissies en
// een koppeling aan de cursus (server/rag/ragFolder.js). Gebruikt bij uploaden als
// leerstof/cursusinformatie en bij de web-import. Retourneert { folderId, created }.
export async function ensureCourseRagFolder(courseId, courseName, userId) {
  return ensureCourseRagFolderWith(supabaseAdmin, courseId, courseName, userId);
}
