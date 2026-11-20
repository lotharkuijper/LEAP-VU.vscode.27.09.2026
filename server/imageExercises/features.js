// Beeldoefeningen: van een vrije beschrijving een lijst kenmerken maken (2026-11-20).
// Elk kenmerk heeft een kort label, een waarneming (wat je ziet) en een duiding
// (wat het betekent), en is kern of extra. Alles komt UITSLUITEND uit de tekst van
// de docent: het taalmodel voegt niets toe uit eigen kennis.
//
// Heeft de docent zelf "Kern:" en "Extra:" als kopjes gebruikt, dan neemt LEAP die
// indeling letterlijk over (niet het taalmodel beslist, maar de tekst).

// MAX_CORE: zonder kopjes van de docent houdt LEAP hooguit zoveel kenmerken als kern,
// zodat het speelbord voor de student te overzien blijft. Met "Kern:" beslist de docent zelf.
export const FEATURE_LIMITS = { MAX_FEATURES: 40, MAX_CORE: 8, MAX_LABEL: 120, MAX_TEXT: 600, MAX_DESCRIPTION: 20_000 };

// De woorden voor "Kern" en "Extra" in de 20 talen van LEAP (zoals ze in het
// vertaalde sjabloon staan, imageEx.guide.templateText) plus gangbare varianten.
// De test imageExerciseDescriptions.test.js leest het sjabloon van elke taal.
const CORE_WORDS = [
  'kern', 'kernkenmerken', 'core', 'essentieel', 'essential', 'essentiel', 'essenziale', 'contenuto essenziale',
  'núcleo', 'nucleo', 'βασικά', 'मुख्य', 'jezgra', 'inti', '主要ポイント', '핵심', 'część główna', 'esențial',
  'temel', 'основне', '核心', 'الأساس', 'أساسي',
];
const EXTRA_WORDS = [
  'extra', 'bonus', 'aanvullend', 'optioneel', 'optional', 'zusatz', 'zusätzlich', 'compléments', 'complément',
  'επιπλέον', 'अतिरिक्त', 'dodatno', 'tambahan', '補足', '추가', 'dodatkowe informacje', 'dodatkowe', 'suplimentar',
  'ekstra', 'додаткове', '額外', '额外', 'إضافي',
];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Een kopje is het woord alleen op een regel ("Kern"), of gevolgd door een dubbele punt ("Kern: plaques").
const headRe = (words) => new RegExp(`^\\s*(?:#+\\s*)?(?:\\*\\*)?\\s*(?:${words.map(esc).join('|')})\\s*(?:\\*\\*)?\\s*(?:[:：]\\s*(.*))?$`, 'iu');
const CORE_HEAD_RE = headRe(CORE_WORDS);
const EXTRA_HEAD_RE = headRe(EXTRA_WORDS);

/**
 * Splitst een beschrijving op de kopjes "Kern:" en "Extra:" als de docent die
 * gebruikt. Zonder zulke kopjes: null.
 * @returns {{ intro: string, core: string, extra: string } | null}
 */
export function explicitSections(description) {
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n');
  const parts = { intro: [], core: [], extra: [] };
  let cur = 'intro';
  let found = false;
  for (const line of lines) {
    const c = line.match(CORE_HEAD_RE);
    const e = line.match(EXTRA_HEAD_RE);
    // Een zin die met "extra" begint ("Extra veel plaques …") is geen kopje: die heeft geen dubbele punt.
    if (c) { cur = 'core'; found = true; if (c[1]) parts.core.push(c[1]); continue; }
    if (e) { cur = 'extra'; found = true; if (e[1]) parts.extra.push(e[1]); continue; }
    parts[cur].push(line);
  }
  if (!found) return null;
  const j = (a) => a.join('\n').trim();
  return { intro: j(parts.intro), core: j(parts.core), extra: j(parts.extra) };
}

const RULES = `Je zet de beschrijving die een docent bij een afbeelding schreef om in een lijst kenmerken: dingen die een student op de afbeelding kan zien, beschrijven en duiden. De beschrijving kan van elk vakgebied zijn.

Regels:
- Gebruik UITSLUITEND wat in de tekst van de docent staat. Voeg niets toe uit eigen kennis, ook niet als het voor de hand ligt of als je denkt dat het ontbreekt.
- Eén kenmerk per waarneming die de docent noemt. Voeg niet samen wat de docent apart noemt; splits niet wat één waarneming is.
- label: kort (hooguit 8 woorden), in de taal van de beschrijving, zoals de docent het zou noemen.
- observation: wat je op de afbeelding ziet: wat, waar, hoe het eruitziet. Alleen voor zover de tekst dat zegt, anders een lege string.
- interpretation: wat het betekent of waar het op wijst. Alleen voor zover de tekst dat zegt, anders een lege string.
- open: true alleen als de tekst zelf aangeeft dat meer dan één duiding verdedigbaar is; anders false.
- Is de beschrijving maar één zin (bijvoorbeeld alleen wat het is), dan is dat één kenmerk.
- Een algemene opsomming of conclusie die terugslaat op waarnemingen die al beschreven zijn (bijvoorbeeld "typische kenmerken van … die zichtbaar zijn", of een samenvattende slotzin), is geen nieuwe waarneming: zet die als interpretation bij de waarneming(en) waar ze over gaat. Alleen een conclusie die bij geen enkele waarneming past, wordt een eigen kenmerk.
- Een tussenkopje in de tekst (zoals "Het haar" of "De achtergrond") is geen kenmerk; het geeft alleen aan waar de waarnemingen eronder over gaan.
Antwoord uitsluitend met JSON.`;

const CORE_RULE = `- core: true voor een hoofdzaak die een student moet zien; false voor een detail of extra. Kijk naar volgorde (het eerste is meestal het belangrijkste) en nadruk: "kenmerkend", "typisch", "let vooral op", "het oog wordt getrokken naar", "altijd" wijzen op kern; "soms", "eventueel", "ook", "daarnaast", "bijkomend" op extra.
- Zet hooguit ${FEATURE_LIMITS.MAX_CORE} kenmerken op core: true: alleen wat een student echt moet zien. De rest is extra, hoe mooi ook.
- Zet de kenmerken in volgorde van belang: eerst de kern (belangrijkste bovenaan), dan de extra's.
- uncertain: true als de tekst te vaag, te kort of tegenstrijdig is om goed in te delen, of als niet duidelijk is wat kern en wat extra is. note: één korte zin waarom (of een lege string).
JSON: {"features":[{"label":"","observation":"","interpretation":"","core":true,"open":false}],"uncertain":false,"note":""}`;

const SECTION_RULE = `- De docent heeft de tekst zelf verdeeld in KERN en EXTRA. Geef bij elk kenmerk "from": "kern" of "extra", naar het deel waar het staat. Kenmerken uit de inleiding krijgen "from": "kern".
- uncertain: true als de tekst te vaag of tegenstrijdig is om goed in te delen. note: één korte zin waarom (of een lege string).
JSON: {"features":[{"label":"","observation":"","interpretation":"","from":"kern","open":false}],"uncertain":false,"note":""}`;

/** Berichten voor het taalmodel. */
export function buildFeatureMessages(description) {
  const text = String(description || '').slice(0, FEATURE_LIMITS.MAX_DESCRIPTION);
  const sections = explicitSections(text);
  if (sections) {
    const user = `INLEIDING:\n${sections.intro || '(geen)'}\n\nKERN:\n${sections.core || '(leeg)'}\n\nEXTRA:\n${sections.extra || '(leeg)'}`;
    return { explicit: true, messages: [{ role: 'system', content: `${RULES}\n${SECTION_RULE}` }, { role: 'user', content: user }] };
  }
  return { explicit: false, messages: [{ role: 'system', content: `${RULES}\n${CORE_RULE}` }, { role: 'user', content: `BESCHRIJVING VAN DE DOCENT:\n${text}` }] };
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Controleert en normaliseert het antwoord van het taalmodel.
 * @returns {{ features: Array<{label: string, observation: string, interpretation: string, is_core: boolean, open_interpretation: boolean}>, uncertain: boolean, note: string } | null}
 */
export function parseFeatureResponse(raw, { explicit = false } = {}) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || !Array.isArray(data.features)) return null;
  const seen = new Set();
  const features = [];
  for (const f of data.features) {
    const label = str(f?.label, FEATURE_LIMITS.MAX_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    features.push({
      label,
      observation: str(f?.observation, FEATURE_LIMITS.MAX_TEXT),
      interpretation: str(f?.interpretation, FEATURE_LIMITS.MAX_TEXT),
      is_core: explicit ? String(f?.from || '').toLowerCase() !== 'extra' : f?.core !== false,
      open_interpretation: f?.open === true,
    });
    if (features.length >= FEATURE_LIMITS.MAX_FEATURES) break;
  }
  if (features.length === 0) return null;
  // Houdt het taalmodel zich niet aan het maximum, dan blijven de eerste (belangrijkste) kern.
  if (!explicit) {
    let core = 0;
    for (const f of features) if (f.is_core && ++core > FEATURE_LIMITS.MAX_CORE) f.is_core = false;
  }
  return { features, uncertain: data.uncertain === true, note: str(data.note, 300) };
}

/**
 * Normaliseert een door de docent aangepaste lijst (zelfde grenzen als hierboven).
 * Lege labels vallen weg; volgorde blijft zoals de docent hem gaf.
 */
export function cleanTeacherFeatures(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => ({
      label: str(f?.label, FEATURE_LIMITS.MAX_LABEL),
      observation: str(f?.observation, FEATURE_LIMITS.MAX_TEXT),
      interpretation: str(f?.interpretation, FEATURE_LIMITS.MAX_TEXT),
      is_core: f?.is_core !== false,
      open_interpretation: f?.open_interpretation === true,
    }))
    .filter((f) => f.label)
    .slice(0, FEATURE_LIMITS.MAX_FEATURES);
}
