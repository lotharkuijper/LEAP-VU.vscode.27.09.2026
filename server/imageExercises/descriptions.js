// Beeldoefeningen: beschrijvingen opknippen en aan foto's koppelen (2026-11-20).
// Pure functies, zonder database of netwerk, zodat ze los te testen zijn.
//
// De docent levert één document met per foto een kopje. Een regel is een kopje als:
//  - hij begint met '#' (Markdown), of
//  - hij kort is en de bestandsnaam van een geüploade foto bevat ("alzheimer-03.jpg"), of
//  - hij kort is en begint met een woord als Foto/Afbeelding/Figuur/Image + nummer, of
//  - hij alleen uit een nummer bestaat ("3." of "3)").
// Tekst na een dubbele punt op de kopregel ("Foto 3: hersenweefsel …") hoort bij de beschrijving.

const MAX_HEADING_CHARS = 100;
const IMAGE_WORDS = '(?:foto|afbeelding|figuur|fig\\.?|beeld|plaat|plaatje|opname|image|photo|picture|figure|slide|abbildung|bild|imagen|immagine)';
const WORD_NUMBER_RE = new RegExp(`^${IMAGE_WORDS}\\s*(?:nr\\.?|nummer|no\\.?|#)?\\s*(\\d{1,4})\\b`, 'i');
const NUMBER_ONLY_RE = /^(\d{1,4})\s*[.):-]?\s*$/;

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
  const idx = line.indexOf(':');
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
  const markdown = line.startsWith('#');
  const { heading, rest } = splitHeadingLine(line);
  if (!heading || heading.length > MAX_HEADING_CHARS) return null;
  const norm = normalizeStem(heading);
  const stem = stems.find((s) => s.length >= 3 && norm.includes(s)) || null;
  const wordNum = heading.match(WORD_NUMBER_RE);
  const onlyNum = heading.match(NUMBER_ONLY_RE);
  if (!markdown && !stem && !wordNum && !onlyNum) return null;
  // Een gewone zin die toevallig met "Foto 3 laat zien …" begint, is geen kopje
  // als er geen dubbele punt is en hij lang doorloopt.
  if (!markdown && !stem && !onlyNum && !rest && heading.length > 40) return null;
  const number = wordNum ? Number(wordNum[1]) : onlyNum ? Number(onlyNum[1]) : (markdown ? numberInName(heading) : null);
  return { heading, rest, number, stem };
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
