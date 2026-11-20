// Beeldoefeningen: beschrijvingen opknippen en aan foto's koppelen (2026-11-20).
// Pure functies, zonder database of netwerk, zodat ze los te testen zijn.
//
// De docent levert één document met per foto een kopje. Een regel is een kopje als:
//  - hij (vrijwel) alleen de bestandsnaam van een geüploade foto is ("alzheimer-03.jpg",
//    "Foto: alzheimer-03"), of die naam vóór een dubbele punt staat, of
//  - hij kort is en begint met een woord als Foto/Afbeelding/Figuur/Image + nummer, of
//  - hij alleen uit een nummer bestaat ("3." of "3)").
// Een gewone zin waarin de bestandsnaam voorkomt ("… typerend voor de art nouveau.")
// is géén kopje, en een Markdown-kopje ('#') telt alleen als het ook zo'n kenmerk heeft:
// anders zou een tussenkopje ín een beschrijving ("## Het haar") die beschrijving opknippen.
// Tekst na een dubbele punt op de kopregel ("Foto 3: hersenweefsel …") hoort bij de beschrijving.

const MAX_HEADING_CHARS = 100;
// Woorden voor "foto/afbeelding" in de 20 talen van LEAP (zoals in het vertaalde
// sjabloon imageEx.guide.templateText) plus gangbare varianten.
const IMAGE_WORDS = `(?:${[
  'foto', 'afbeelding', 'figuur', 'fig\\.?', 'beeld', 'plaatje', 'plaat', 'opname', 'image', 'photo', 'picture', 'figure', 'slide',
  'abbildung', 'bild', 'imagen', 'immagine', 'fotografia', 'fotografie', 'fotografija', 'fotoğraf', 'zdjęcie', 'gambar',
  'φωτογραφία', 'εικόνα', 'фото', 'зображення', 'फ़ोटो', 'फोटो', 'चित्र', 'الصورة', 'صورة', '写真', '画像', '사진', '이미지', '照片', '相片', '图片', '圖片',
].join('|')})`;
const WORD_NUMBER_RE = new RegExp(`^${IMAGE_WORDS}\\s*(?:nr\\.?|nummer|no\\.?|#)?\\s*(\\d{1,4})(?!\\d)`, 'iu');
const NUMBER_ONLY_RE = /^(\d{1,4})\s*[.):-]?\s*$/;
const IMAGE_PREFIX_RE = new RegExp(`^${IMAGE_WORDS}\\s*(?:nr\\.?|nummer|no\\.?|#)?\\s*[:：.-]?\\s*`, 'iu');

/** "Alzheimer-03.JPG" → "alzheimer03": voor vergelijken van namen. */
export function normalizeStem(name) {
  return String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Laatste getal in een bestandsnaam ("alzheimer-03.jpg" → 3), anders null. */
export function numberInName(name) {
  const m = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').match(/(\d{1,4})(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

function cleanHeading(line) {
  return line.replace(/^#+\s*/, '').replace(/^\*\*(.*?)\*\*/, '$1').trim();
}

// Splitst een kopregel in het kopje zelf en eventuele tekst na de dubbele punt.
function splitHeadingLine(raw) {
  const line = cleanHeading(raw);
  const idx = line.search(/[:：]/);
  if (idx > 0 && idx < MAX_HEADING_CHARS) {
    return { heading: line.slice(0, idx).trim(), rest: line.slice(idx + 1).trim() };
  }
  return { heading: line, rest: '' };
}

/**
 * Herkent of een regel een kopje is. Geeft { heading, rest, number, stem } of null.
 * `stems` zijn de genormaliseerde bestandsnamen van de foto's (langste eerst).
 */
export function readHeading(rawLine, stems = []) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  // De hele regel is de bestandsnaam (eventueel met "Foto:" ervoor).
  const whole = cleanHeading(line);
  const wholeStem = whole.length <= MAX_HEADING_CHARS ? stemOfLine(whole, stems) : null;
  if (wholeStem) return { heading: whole, rest: '', number: numberInName(whole), stem: wholeStem };

  const { heading, rest } = splitHeadingLine(line);
  if (!heading || heading.length > MAX_HEADING_CHARS) return null;
  const stem = rest ? stemOfLine(heading, stems) : null;
  const wordNum = heading.match(WORD_NUMBER_RE);
  const onlyNum = heading.match(NUMBER_ONLY_RE);
  if (!stem && !wordNum && !onlyNum) return null;
  // Een gewone zin die toevallig met "Foto 3 laat zien …" begint, is geen kopje
  // als er geen dubbele punt is en hij lang doorloopt.
  if (!stem && !onlyNum && !rest && heading.length > 40) return null;
  const number = wordNum ? Number(wordNum[1]) : onlyNum ? Number(onlyNum[1]) : null;
  return { heading, rest, number, stem };
}

// Is deze tekst (vrijwel) alleen de bestandsnaam van een foto? Een woord als "Foto"
// ervoor mag; een zin waarin de naam toevallig voorkomt telt niet.
function stemOfLine(text, stems) {
  const n = normalizeStem(String(text).replace(IMAGE_PREFIX_RE, ''));
  return stems.find((s) => s.length >= 3 && n === s) || null;
}

/**
 * Knipt een beschrijvingsdocument op kopjes. Tekst vóór het eerste kopje is een
 * inleiding en hoort bij geen enkele foto.
 * @returns {{ sections: Array<{heading: string, number: number|null, stem: string|null, text: string}>, preamble: string }}
 */
export function splitDescriptions(text, imageNames = []) {
  const stems = [...new Set(imageNames.map(normalizeStem).filter(Boolean))].sort((a, b) => b.length - a.length);
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const line of lines) {
    const h = readHeading(line, stems);
    if (h) {
      cur = { heading: h.heading, number: h.number, stem: h.stem, lines: h.rest ? [h.rest] : [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    sections: sections
      .map(({ lines: ls, ...s }) => ({ ...s, text: ls.join('\n').replace(/\n{3,}/g, '\n\n').trim() }))
      .filter((s) => s.text.length > 0),
    preamble: preamble.join('\n').trim(),
  };
}

/**
 * Bepaalt hoe een geüpload document aan de foto's gekoppeld wordt. LEAP probeert,
 * in deze volgorde, en weigert nooit een document:
 *  1. 'headings'  kopjes per foto (nummer of bestandsnaam);
 *  2. 'mentions'  alinea's waarin de bestandsnaam van een foto staat;
 *  3. 'filename'  de naam van het document zelf hoort bij een foto (art-nouveau.docx ↔ art-nouveau.png);
 *  4. 'single'    er wacht maar één foto op een beschrijving: de hele tekst is een voorstel daarvoor;
 *  5. 'ask'       anders: de hele tekst als één los stuk; de docent kiest de foto.
 * De docent bevestigt altijd zelf.
 * @param {string} text
 * @param {{ filename?: string, images: Array<{id: string, filename: string}>, open: Array<{id: string, filename: string, description?: string|null}> }} p
 */
export function planDocument(text, { filename = '', images, open }) {
  const names = images.map((i) => i.filename);
  let method = 'headings';
  let { sections } = splitDescriptions(text, names);
  if (!sections.length) { method = 'mentions'; ({ sections } = splitByMentions(text, names)); }
  if (sections.length) return { method, sections, ...matchDescriptions(open, sections) };

  const whole = String(text || '').trim();
  if (!whole) return { method: 'empty', sections: [], matches: [], unmatchedSections: [], unmatchedImages: open.map((o) => o.id) };
  const docName = String(filename || '');
  const section = { heading: docName, number: docName ? numberInName(docName) : null, stem: docName ? normalizeStem(docName) : null, text: whole };
  if (docName) {
    const byName = matchDescriptions(open, [section]);
    if (byName.matches.length && byName.matches[0].source !== 'order') return { method: 'filename', sections: [section], ...byName };
  }
  const waiting = open.filter((o) => !(o.description || '').trim());
  const only = waiting.length === 1 ? waiting[0] : open.length === 1 ? open[0] : null;
  if (only) {
    return { method: 'single', sections: [section], matches: [{ imageId: only.id, section: 0, source: 'suggested' }], unmatchedSections: [], unmatchedImages: open.filter((o) => o.id !== only.id).map((o) => o.id) };
  }
  return { method: 'ask', sections: [section], matches: [], unmatchedSections: [0], unmatchedImages: open.map((o) => o.id) };
}

/**
 * Geen kopjes? Dan zoekt LEAP naar alinea's waarin de volledige bestandsnaam van een
 * foto staat (met extensie, bv. "… zie alzheimer-03.jpg …"). Zo'n alinea begint de
 * beschrijving van die foto; alinea's zonder naam erna horen er nog bij. Een
 * bestandsnaam mét extensie is een duidelijke verwijzing, anders dan een los woord.
 * @returns {{ sections: Array<{heading: string, number: number|null, stem: string|null, text: string}>, preamble: string }}
 */
export function splitByMentions(text, imageNames = []) {
  const names = [...new Set(imageNames.filter((n) => /\.[a-z0-9]{2,5}$/i.test(n || '')))]
    .sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = names.map((n) => ({ name: n, re: new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, 'iu') }));
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const sections = [];
  const preamble = [];
  let cur = null;
  for (const p of paragraphs) {
    const hit = res.find((r) => r.re.test(p));
    if (hit && (!cur || cur.name !== hit.name)) {
      cur = { name: hit.name, parts: [p] };
      sections.push(cur);
    } else if (cur) {
      cur.parts.push(p);
    } else {
      preamble.push(p);
    }
  }
  return {
    sections: sections.map((s) => ({ heading: s.name, number: numberInName(s.name), stem: normalizeStem(s.name), text: s.parts.join('\n\n').trim() })).filter((s) => s.text),
    preamble: preamble.join('\n\n').trim(),
  };
}

/**
 * Koppelt beschrijvingen aan foto's: eerst op naam, dan op nummer, dan (alleen als
 * geen enkel overgebleven stuk een naam of nummer heeft en de aantallen gelijk zijn)
 * op volgorde. De docent bevestigt altijd zelf.
 * @param {Array<{id: string, filename: string}>} images  in de volgorde van de lijst
 * @param {Array<{number: number|null, stem: string|null}>} sections
 * @returns {{ matches: Array<{imageId: string, section: number, source: 'name'|'number'|'order'}>, unmatchedSections: number[], unmatchedImages: string[] }}
 */
export function matchDescriptions(images, sections) {
  const matches = [];
  const usedImg = new Set();
  const usedSec = new Set();
  const stemOf = new Map(images.map((im) => [im.id, normalizeStem(im.filename)]));

  sections.forEach((s, i) => {
    if (!s.stem) return;
    const hits = images.filter((im) => !usedImg.has(im.id) && stemOf.get(im.id) === s.stem);
    if (hits.length === 1) { matches.push({ imageId: hits[0].id, section: i, source: 'name' }); usedImg.add(hits[0].id); usedSec.add(i); }
  });

  const numCount = new Map();
  for (const im of images) {
    const n = numberInName(im.filename);
    if (n != null) numCount.set(n, (numCount.get(n) || 0) + 1);
  }
  sections.forEach((s, i) => {
    if (usedSec.has(i) || s.number == null) return;
    const hits = images.filter((im) => !usedImg.has(im.id) && numberInName(im.filename) === s.number);
    if (hits.length === 1 && numCount.get(s.number) === 1) {
      matches.push({ imageId: hits[0].id, section: i, source: 'number' }); usedImg.add(hits[0].id); usedSec.add(i);
    }
  });

  const restSec = sections.map((_, i) => i).filter((i) => !usedSec.has(i));
  const restImg = images.filter((im) => !usedImg.has(im.id));
  const keyless = restSec.every((i) => sections[i].number == null && !sections[i].stem);
  if (restSec.length > 0 && restSec.length === restImg.length && keyless) {
    restSec.forEach((secIdx, k) => { matches.push({ imageId: restImg[k].id, section: secIdx, source: 'order' }); usedImg.add(restImg[k].id); usedSec.add(secIdx); });
  }

  return {
    matches,
    unmatchedSections: sections.map((_, i) => i).filter((i) => !usedSec.has(i)),
    unmatchedImages: images.filter((im) => !usedImg.has(im.id)).map((im) => im.id),
  };
}
