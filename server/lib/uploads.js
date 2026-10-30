import multer from 'multer';
import officeParserPkg from 'officeparser';

function normalizeOfficeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => normalizeOfficeText(item))
      .filter(Boolean)
      .join('\n\n');
    return joined.trim();
  }
  if (typeof value === 'object') {
    if (typeof value.toText === 'function') {
      const converted = normalizeOfficeText(value.toText());
      if (converted) return converted;
    }
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (Array.isArray(value.content)) {
      const joined = value.content
        .map((item) => normalizeOfficeText(item))
        .filter(Boolean)
        .join('\n\n');
      if (joined) return joined.trim();
    }
    try {
      return JSON.stringify(value).trim();
    } catch {
      return '';
    }
  }
  return String(value).trim();
}

// officeparser 8 geeft een AST zonder toText(); de tekst komt uit
// `await ast.to('text')`. Zonder dat viel normalizeOfficeText bij tabellen en
// dia's terug op JSON.stringify en kwam er ruwe AST-code in de fragmenten.
// preserveLayout: false = platte tekst (één tabelcel per regel, geen
// opgevulde rasters), zoals officeparser 6 die gaf.
async function officeAstToText(data) {
  if (data && typeof data.to === 'function') {
    const { value } = await data.to('text', { includeImages: false, textConfig: { preserveLayout: false } });
    return normalizeOfficeText(value);
  }
  return normalizeOfficeText(data);
}

export const parseOfficeAsync = (buffer) => new Promise((resolve, reject) => {
  officeParserPkg.parseOffice(buffer, (data, err) => {
    if (err) reject(err);
    else officeAstToText(data).then(resolve, reject);
  });
});

// 15 MB ruwe upload-cap; tekstextractie kan kleiner uitkomen en wordt
// daarna nog eens beperkt door MAX_DOC_CHARS.
export const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

export function getFileMimeType(ext) {
  const map = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', omv: 'application/octet-stream', sav: 'application/octet-stream', jasp: 'application/octet-stream', rdata: 'application/octet-stream' };
  return map[ext] || 'application/octet-stream';
}

// POST /api/projects/:projectId/personas/:personaId/documents — upload bestand
// als multipart/form-data. Velden: file (binary), groupId. Ondersteunde
// formaten: tekst (.txt/.md/.csv/.tsv/.json) en kantoor-formaten (.pdf,
// .docx, .pptx, .xlsx, .odt, .ods, .odp). Voor kantoor-formaten wordt de
// platte tekst geëxtraheerd via officeparser.
export const MAX_DOC_CHARS = 200000;

const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|log)$/i;

const OFFICE_EXT_RE = /\.(pdf|docx|pptx|xlsx|odt|ods|odp)$/i;

export async function extractTextFromUpload(file) {
  const name = file.originalname || 'upload';
  if (TEXT_EXT_RE.test(name) || (file.mimetype || '').startsWith('text/')) {
    return file.buffer.toString('utf8');
  }
  if (OFFICE_EXT_RE.test(name)) {
    // officeparser herkent het type aan de inhoud van de buffer.
    const text = await parseOfficeAsync(file.buffer);
    return normalizeOfficeText(text);
  }
  throw new Error('Bestandstype niet ondersteund — kies .txt, .md, .csv, .tsv, .json, .pdf, .docx, .pptx, .xlsx, .odt, .ods of .odp');
}

// Binaire bestandstypes die wel gedownload mogen worden door studenten,
// maar NIET als chat-context worden geïnjecteerd (geen tekst-extractie).
// Jamovi (.omv) is hierin de eerste use-case.
export const BINARY_DOWNLOAD_EXT_RE = /\.(omv|omt|sav|jasp|rdata|rds|sps|do|dta)$/i;
