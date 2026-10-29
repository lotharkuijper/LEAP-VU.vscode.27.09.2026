// Bijlagen in de chat (2026-10-16, server/chatAttachments.js, docs/plans/chat-bijlagen-plan.html).
//
// LEAP bewaart bijlagen niet. Alles hier leeft in het geheugen van de pagina:
// zodra de student de chat afsluit (ander gesprek, nieuw gesprek, pagina
// verlaten of herladen) zijn ze weg. In de database komt alleen een label
// (soort, naam, grootte, pagina's); de database weigert ingebedde bestanden.

export type AttachmentKind = 'image' | 'file';

/** Wat er bij een studentbericht bewaard wordt: alleen beschrijvende gegevens. */
export interface AttachmentMeta {
  kind: AttachmentKind;
  name: string;
  mime?: string;
  size?: number;
  pages?: number | null;
  /** Gescande PDF: als afbeeldingen meegegeven. */
  scanned?: boolean;
}

/** Een bijlage die klaarstaat (alleen in het geheugen). */
export interface PendingAttachment extends AttachmentMeta {
  id: string;
  /** Afbeelding (verkleind, opnieuw gecodeerd). */
  dataUrl?: string;
  /** Pagina's van een gescande PDF als afbeeldingen. */
  scanImages?: string[];
  /** Tekst uit een bestand. */
  text?: string;
  truncated?: boolean;
}

export interface AttachmentLimits {
  imagesPerMessage: number;
  perConversation: number;
  perDay: number;
  fileMb: number;
  fileChars: number;
  scanPages: number;
  imageMaxSide: number;
}

export const DEFAULT_LIMITS: AttachmentLimits = {
  imagesPerMessage: 3, perConversation: 10, perDay: 20, fileMb: 10, fileChars: 40000, scanPages: 5, imageMaxSide: 1600,
};

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const FILE_EXTENSIONS = ['pdf', 'docx', 'pptx', 'odt', 'odp', 'txt', 'md'];
/** Voor <input type="file" accept>. */
export const ACCEPT = [...IMAGE_TYPES, ...FILE_EXTENSIONS.map(e => `.${e}`)].join(',');

export function extensionOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

export function isImageFile(f: { type?: string; name?: string }): boolean {
  if (f.type && IMAGE_TYPES.includes(f.type)) return true;
  return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extensionOf(f.name || ''));
}

export function isSupportedFile(f: { type?: string; name?: string }): boolean {
  return isImageFile(f) || FILE_EXTENSIONS.includes(extensionOf(f.name || ''));
}

/** Een geplakte schermafbeelding heeft vaak de naam "image.png"; maak er iets herkenbaars van. */
export function pastedImageName(index: number, now = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `schermafbeelding-${hh}${mm}${index > 0 ? `-${index + 1}` : ''}.png`;
}

/** Afbeeldingen uit een plak-actie (Windows+Shift+S zet er één op het klembord). */
export function imagesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items || [])) {
    if (item.kind === 'file' && IMAGE_TYPES.includes(item.type)) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** Verkleint (langste zijde ≤ maxSide) en codeert opnieuw: haalt ook EXIF (zoals GPS) weg. */
export async function downscaleImage(blob: Blob, maxSide: number): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  // PNG houdt tekst scherp (schermafbeeldingen); te groot → JPEG (foto's).
  let dataUrl = canvas.toDataURL('image/png');
  if (dataUrl.length > 3_000_000) dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  return { dataUrl, width, height };
}

export async function fileToBase64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Eerste pagina's van een (gescande) PDF als afbeeldingen, met pdf.js in de browser. */
export async function renderPdfPages(file: Blob, maxPages: number, maxSide: number): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: string[] = [];
  try {
    for (let n = 1; n <= Math.min(pdf.numPages, maxPages); n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, maxSide / Math.max(base.width, base.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      out.push(canvas.toDataURL('image/jpeg', 0.85));
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

export interface AttachmentsConfig {
  available: boolean;
  reason: 'platform_off' | 'course_off' | null;
  platformEnabled: boolean;
  courseOn: boolean;
  isStaff: boolean;
  limits: AttachmentLimits;
  usedToday: number;
}

/** Een bijlage in het verzoek aan /api/chat. */
export type AttachmentPayload =
  | { kind: 'image'; name: string; dataUrl: string; scanOf?: string }
  | { kind: 'file'; name: string; text: string; pages?: number | null; truncated?: boolean; isNew?: boolean };

/**
 * Bijlagen voor één chatbeurt: de nieuwe (afbeeldingen gaan maar één keer
 * mee) plus de tekst van bestanden die eerder in dit gesprek zijn meegegeven.
 */
export function buildPayload(pending: PendingAttachment[], carriedFiles: PendingAttachment[]): AttachmentPayload[] {
  const out: AttachmentPayload[] = [];
  for (const a of pending) {
    if (a.kind === 'image' && a.dataUrl) out.push({ kind: 'image', name: a.name, dataUrl: a.dataUrl });
    else if (a.kind === 'file' && a.scanImages?.length) {
      for (const [i, url] of a.scanImages.entries()) out.push({ kind: 'image', name: `${a.name} p${i + 1}`, dataUrl: url, scanOf: a.name });
    } else if (a.kind === 'file' && typeof a.text === 'string') {
      out.push({ kind: 'file', name: a.name, text: a.text, pages: a.pages ?? null, truncated: a.truncated, isNew: true });
    }
  }
  for (const f of carriedFiles) {
    if (typeof f.text === 'string') out.push({ kind: 'file', name: f.name, text: f.text, pages: f.pages ?? null, truncated: f.truncated });
  }
  return out;
}

/** Label-gegevens om bij het bericht te bewaren (nooit de inhoud). */
export function metaOf(a: PendingAttachment): AttachmentMeta {
  return {
    kind: a.kind,
    name: a.name,
    ...(a.mime ? { mime: a.mime } : {}),
    ...(typeof a.size === 'number' ? { size: a.size } : {}),
    ...(a.pages != null ? { pages: a.pages } : {}),
    ...(a.scanned ? { scanned: true } : {}),
  };
}

/** Labels uit een opgeslagen bericht (retrieved_context.attachments); rommel wordt genegeerd. */
export function metaFromStored(raw: unknown): AttachmentMeta[] {
  const list = (raw as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is AttachmentMeta => !!a && typeof a === 'object' && (a.kind === 'image' || a.kind === 'file') && typeof a.name === 'string')
    .map(a => ({ kind: a.kind, name: a.name.slice(0, 120), ...(a.pages != null ? { pages: Number(a.pages) } : {}), ...(a.scanned ? { scanned: true } : {}) }));
}

/** Zit er een ingebed bestand in deze tekst? Zoiets mag nooit worden opgeslagen. */
export function hasInlineFile(s: unknown): boolean {
  try {
    return /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(typeof s === 'string' ? s : JSON.stringify(s ?? ''));
  } catch {
    return false;
  }
}

/**
 * Extra zoekwoorden voor het cursusmateriaal: het begin van nieuwe
 * bestandstekst, en na een afbeelding de beschrijving die de tutor gaf.
 */
export function searchExtra(pending: PendingAttachment[], previousDescription?: string): string {
  const parts: string[] = [];
  for (const a of pending) if (a.kind === 'file' && a.text) parts.push(a.text.slice(0, 800));
  if (previousDescription) parts.push(previousDescription.slice(0, 600));
  return parts.join('\n').trim();
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
