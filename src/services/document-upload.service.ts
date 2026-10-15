import { supabase } from '../lib/supabase';
import { tStatic } from '../i18n/translations';
import { getActiveLang } from '../i18n/activeLang';

export interface UploadProgress {
  stage: 'uploading' | 'processing' | 'generating' | 'saving' | 'completed' | 'error';
  progress: number;
  message: string;
  currentChunk?: number;
  totalChunks?: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

// Duidelijke NL-melding bij een verlopen/ongeldige sessie (bijv. na een Supabase
// API-key-rotatie): de server geeft dan 401 terug. Zo ziet de docent niet langer
// een cryptische "new row violates row-level security policy"-fout, maar een
// begrijpelijke instructie om opnieuw in te loggen.
/** Melding bij een verlopen sessie, in de actieve taal. */
export const sessionExpiredMessage = () =>
  tStatic(getActiveLang(), 'services.upload.sessionExpired');

// Vertaalt een mislukte server-respons naar een leesbare melding: 401 → opnieuw
// inloggen, anders de server-boodschap (of een generieke fallback).
function mapApiError(status: number, serverMessage?: string): string {
  if (status === 401) return sessionExpiredMessage();
  return serverMessage || `Bewerking mislukt (${status})`;
}

function isPptx(fileName: string): boolean {
  return fileName.split('.').pop()?.toLowerCase() === 'pptx';
}

// Pagineerbare Word-bronnen worden server-side verwerkt (Task #377): LibreOffice
// converteert .docx → PDF en per-pagina tekstextractie koppelt elke chunk aan
// zijn paginanummer(s), net zoals bij PDF's.
const DOCX_PAGED_EXT = new Set(['docx', 'doc', 'odt']);
function isDocx(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return DOCX_PAGED_EXT.has(ext);
}

// PowerPoint wordt server-side verwerkt: dia's + sprekersnotities worden
// uitgelezen en semantisch gechunkt (LLM) op de server. De server haalt het
// bestand zelf uit storage op basis van het document-id.
async function processPptxOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error(tStatic(getActiveLang(), 'services.upload.notAuthenticated'));

  const res = await fetch('/api/admin/process-pptx', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(mapApiError(res.status, data?.error));
  }
  return data.totalChunks ?? 0;
}

// Algemene RAG-bron (pdf/txt e.d.) server-side verwerken op document-id. De server
// haalt het bestand zelf uit storage, extraheert tekst (PDF per pagina via pdf.js →
// paginanummers), chunkt, embeddt en vervangt de fragmenten ATOMISCH (delete+insert+
// status in één transactie). Zo raakt een document nooit zijn fragmenten kwijt door
// een crash of snelheidslimiet halverwege — identiek aan het Word/PowerPoint-pad.
async function processRagDocOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error(tStatic(getActiveLang(), 'services.upload.notAuthenticated'));

  const res = await fetch('/api/admin/process-rag-document', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(mapApiError(res.status, data?.error));
  }
  return data.totalChunks ?? 0;
}

// Word-document (.docx/.doc/.odt) server-side verwerken met paginanummers. De
// server haalt het bestand zelf uit storage op basis van het document-id.
async function processDocxOnServer(documentId: string): Promise<number> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error(tStatic(getActiveLang(), 'services.upload.notAuthenticated'));

  const res = await fetch('/api/admin/process-docx', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ documentId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(mapApiError(res.status, data?.error));
  }
  return data.totalChunks ?? 0;
}

export async function retryFailedDocument(documentId: string, onProgress?: ProgressCallback): Promise<void> {
  // De status van vóór deze poging onthouden zodat we bij een fout de oude staat
  // herstellen i.p.v. een nog-intact document onterecht op 'failed' te zetten. Alle
  // verwerking loopt nu server-side en ATOMISCH (de bestaande fragmenten blijven
  // staan als het faalt), dus een mislukte herverwerking is nooit destructief.
  let originalStatusForRestore: string | null = null;
  try {
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !doc) {
      throw new Error('Document not found');
    }

    originalStatusForRestore = doc.processing_status || 'completed';

    // PowerPoint server-side opnieuw verwerken (server ruimt oude chunks op,
    // leest dia's + notities en zet de status zelf).
    if ((doc.file_type || '').toLowerCase() === 'pptx' || isPptx(doc.file_path || '')) {
      await supabase
        .from('documents')
        .update({ processing_status: 'processing' })
        .eq('id', documentId);
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: tStatic(getActiveLang(), 'services.upload.processingPptx'),
      });
      try {
        const totalChunks = await processPptxOnServer(documentId);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: tStatic(getActiveLang(), 'services.upload.pptxDone'),
          totalChunks,
        });
        return;
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', documentId);
        onProgress?.({
          stage: 'error',
          progress: 0,
          message: err instanceof Error ? err.message : 'Unknown error occurred',
        });
        throw err;
      }
    }

    // Word server-side opnieuw verwerken (server ruimt oude chunks op, converteert
    // naar PDF voor paginanummers en zet de status zelf).
    if (DOCX_PAGED_EXT.has((doc.file_type || '').toLowerCase()) || isDocx(doc.file_path || '')) {
      await supabase
        .from('documents')
        .update({ processing_status: 'processing' })
        .eq('id', documentId);
      onProgress?.({
        stage: 'generating',
        progress: 50,
        message: tStatic(getActiveLang(), 'services.upload.processingDocx'),
      });
      try {
        const totalChunks = await processDocxOnServer(documentId);
        onProgress?.({
          stage: 'completed',
          progress: 100,
          message: tStatic(getActiveLang(), 'services.upload.docxDone'),
          totalChunks,
        });
        return;
      } catch (err) {
        await supabase
          .from('documents')
          .update({ processing_status: 'failed' })
          .eq('id', documentId);
        onProgress?.({
          stage: 'error',
          progress: 0,
          message: err instanceof Error ? err.message : 'Unknown error occurred',
        });
        throw err;
      }
    }

    // PDF/txt en overige RAG-bronnen server-side opnieuw verwerken. De server
    // extraheert tekst (PDF per pagina → paginanummers), chunkt, embeddt en vervangt
    // de fragmenten ATOMISCH (delete+insert+status in één transactie). Faalt het
    // embedden of de snelheidslimiet, dan blijven de bestaande fragmenten staan —
    // er is geen niet-atomisch venster meer waarin het document leeg kan raken.
    await supabase
      .from('documents')
      .update({ processing_status: 'processing' })
      .eq('id', documentId);

    onProgress?.({
      stage: 'generating',
      progress: 50,
      message: tStatic(getActiveLang(), 'services.upload.processingDoc'),
    });

    try {
      const totalChunks = await processRagDocOnServer(documentId);
      onProgress?.({
        stage: 'completed',
        progress: 100,
        message: tStatic(getActiveLang(), 'services.upload.docDone'),
        totalChunks,
      });
      return;
    } catch (err) {
      await supabase
        .from('documents')
        .update({ processing_status: 'failed' })
        .eq('id', documentId);
      onProgress?.({
        stage: 'error',
        progress: 0,
        message: err instanceof Error ? err.message : 'Unknown error occurred',
      });
      throw err;
    }
  } catch (error) {
    // Alle verwerking loopt nu server-side en ATOMISCH: bij een fout blijven de
    // bestaande fragmenten staan. Herstel daarom de oorspronkelijke status, zodat een
    // eerder voltooid document niet onterecht als 'failed' blijft staan terwijl het
    // zijn fragmenten gewoon behoudt. Was er geen oude status, dan is 'failed' terecht.
    const restoreStatus = originalStatusForRestore || 'failed';
    await supabase
      .from('documents')
      .update({
        processing_status: restoreStatus,
      })
      .eq('id', documentId);

    onProgress?.({
      stage: 'error',
      progress: 0,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });

    throw error;
  }
}
