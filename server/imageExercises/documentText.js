// Tekst uit het beschrijvingsdocument van de docent (Word, pdf, txt of md), met de
// regelovergangen intact: die zijn nodig om de kopjes per foto te herkennen.

export const DESCRIPTION_DOC_EXT = ['docx', 'pdf', 'txt', 'md'];
export const MAX_DESCRIPTION_DOC_BYTES = 10 * 1024 * 1024;
export const MAX_DESCRIPTION_TEXT_CHARS = 200_000;
const MAX_PDF_PAGES = 200;
// Lijkt op extractPdfPageTexts (server/ingestion/pdfPageText.js), maar houdt de
// regelovergangen (hasEOL) vast: die zijn nodig om de kopjes per foto te vinden.

/** @returns {Promise<string>} */
export async function extractDescriptionText(buffer, ext) {
  const e = String(ext || '').toLowerCase();
  let text = '';
  if (e === 'docx') {
    const mammoth = (await import('mammoth')).default;
    const { value } = await mammoth.extractRawText({ buffer });
    text = value || '';
  } else if (e === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true, disableFontFace: true }).promise;
    try {
      const pages = [];
      let chars = 0;
      for (let n = 1; n <= Math.min(pdf.numPages, MAX_PDF_PAGES) && chars < MAX_DESCRIPTION_TEXT_CHARS; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const pageText = content.items.map((it) => (typeof it.str === 'string' ? it.str : '') + (it.hasEOL ? '\n' : '')).join('');
        chars += pageText.length;
        pages.push(pageText);
        page.cleanup();
      }
      text = pages.join('\n');
    } finally {
      await pdf.loadingTask.destroy().catch(() => {});
    }
  } else if (e === 'txt' || e === 'md') {
    text = buffer.toString('utf8');
  } else {
    throw Object.assign(new Error('Dit bestandstype kan niet als beschrijving worden gelezen (docx, pdf, txt, md).'), { status: 400, code: 'badDescriptionType' });
  }
  return text.replace(/\u0000/g, '').slice(0, MAX_DESCRIPTION_TEXT_CHARS);
}
