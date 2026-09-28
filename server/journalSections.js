// Leerdagboek in drie blokken: samenvatting (wat heb je gedaan?), feedback
// (wat ging goed / wat kan beter?) en feed-forward (je volgende stap).
//
// Het taalmodel levert de blokken als platte tekst met VASTE kopjes
// (### SUMMARY enz.). Bewust geen JSON: in JSON zou LaTeX als `\frac` of
// `\beta` stilletjes kapotgaan (\f en \b zijn JSON-escapes). De kopjes zijn
// taalonafhankelijk; de inhoud is in de taal van de student.
//
// Opslag: learning_journal_entries.sections (jsonb) met
//   { summary: string, went_well: string[], to_improve: string[],
//     feedback?: string, next_steps: string[] }
// Daarnaast blijft `content` gevuld (leesbare tekst), zodat oude weergaven,
// zoeken en exporteren blijven werken. Lukt het opdelen niet, dan bewaren we
// de tekst zoals hij is: een dagboekregel gaat nooit verloren.

const MARKERS = {
  SUMMARY: 'summary',
  WENT_WELL: 'went_well',
  TO_IMPROVE: 'to_improve',
  NEXT_STEPS: 'next_steps',
};
const MARKER_RE = /^\s*#{1,4}\s*\**\s*(SUMMARY|WENT[_ ]WELL|TO[_ ]IMPROVE|NEXT[_ ]STEPS)\s*\**\s*:?\s*$/i;
const BULLET_RE = /^\s*(?:[-*•–]|\d+[.)])\s+/;
const LIMITS = { summaryChars: 900, items: 4, nextSteps: 3, itemChars: 400 };

/** Instructie die achter elke reflectieprompt komt. Gaat vóór eerdere opmaak-aanwijzingen. */
export function journalFormatInstruction(lang = 'nl') {
  if (lang === 'nl') {
    return `

OPMAAK VAN JE ANTWOORD (dit gaat vóór eerdere aanwijzingen over kopjes, opmaak en aantal regels):
Gebruik precies deze vier kopjes, elk op een eigen regel, in deze volgorde en letterlijk zo geschreven (in het Engels, hoofdletters):
### SUMMARY
2 à 3 zinnen lopende tekst: wat heb je gedaan en laten zien.
### WENT_WELL
2 à 3 korte punten, elk op een regel die begint met "- ": wat ging goed.
### TO_IMPROVE
2 à 3 korte punten, elk beginnend met "- ": wat kan beter.
### NEXT_STEPS
1 à 3 concrete, haalbare vervolgstappen, elk beginnend met "- ". Verwijs alleen naar cursusbronnen die hierboven genoemd worden.
Zet niets vóór het eerste kopje en niets na het laatste blok. Formules mogen in LaTeX tussen $…$.`;
  }
  return `

FORMAT OF YOUR ANSWER (this overrides earlier instructions about headings, formatting and number of lines):
Use exactly these four headings, each on its own line, in this order and written literally like this (in English, capitals):
### SUMMARY
2 to 3 sentences of running text: what you did and demonstrated.
### WENT_WELL
2 to 3 short points, each on a line starting with "- ": what went well.
### TO_IMPROVE
2 to 3 short points, each starting with "- ": what can be improved.
### NEXT_STEPS
1 to 3 concrete, achievable next steps, each starting with "- ". Only refer to course sources mentioned above.
Put nothing before the first heading and nothing after the last block. Formulas may be written in LaTeX between $…$. Keep the headings in English, but write the content in the language requested.`;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function toItems(lines) {
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (BULLET_RE.test(line) || items.length === 0) items.push(line.replace(BULLET_RE, '').trim());
    else items[items.length - 1] += ` ${line}`;
  }
  return items.filter(Boolean);
}

/**
 * Pure: haalt de blokken uit het antwoord van het taalmodel. Geeft `null` als
 * het antwoord niet de afgesproken vorm heeft (dan bewaart de aanroeper de
 * tekst ongewijzigd).
 */
export function parseJournalSections(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const buckets = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(MARKER_RE);
    if (m) {
      current = MARKERS[m[1].toUpperCase().replace(' ', '_')];
      buckets[current] = buckets[current] || [];
      continue;
    }
    if (current) buckets[current].push(line);
  }
  if (!buckets.summary) return null;
  const summary = clip(buckets.summary.map(l => l.trim()).filter(Boolean).join(' ').replace(BULLET_RE, ''), LIMITS.summaryChars);
  const list = (k, max) => toItems(buckets[k] || []).slice(0, max).map(s => clip(s, LIMITS.itemChars));
  const out = {
    summary,
    went_well: list('went_well', LIMITS.items),
    to_improve: list('to_improve', LIMITS.items),
    next_steps: list('next_steps', LIMITS.nextSteps),
  };
  if (!out.summary || (out.went_well.length + out.to_improve.length + out.next_steps.length) === 0) return null;
  return out;
}

const HEADINGS = {
  nl: { summary: 'Wat heb je gedaan', wentWell: 'Wat ging goed', toImprove: 'Wat kan beter', feedback: 'Feedback', next: 'Je volgende stap' },
  en: { summary: 'What you did', wentWell: 'What went well', toImprove: 'What can be improved', feedback: 'Feedback', next: 'Your next step' },
};

/** Pure: leesbare tekstversie van de blokken (voor het `content`-veld). */
export function sectionsToText(sections, lang = 'nl') {
  const h = HEADINGS[lang] || HEADINGS.en;
  const parts = [];
  if (sections.summary) parts.push(`**${h.summary}**\n${sections.summary}`);
  const bullets = (arr) => arr.map(s => `- ${s}`).join('\n');
  if (sections.went_well?.length) parts.push(`**${h.wentWell}**\n${bullets(sections.went_well)}`);
  if (sections.to_improve?.length) parts.push(`**${h.toImprove}**\n${bullets(sections.to_improve)}`);
  if (sections.feedback) parts.push(`**${h.feedback}**\n${sections.feedback}`);
  if (sections.next_steps?.length) parts.push(`**${h.next}**\n${bullets(sections.next_steps)}`);
  return parts.join('\n\n');
}

/**
 * Van modelantwoord naar de velden voor learning_journal_entries:
 * { content, sections }. Niet op te delen → { content: tekst, sections: null }.
 */
export function journalFieldsFromModel(text, lang = 'nl') {
  const sections = parseJournalSections(text);
  if (!sections) return { content: String(text || '').trim(), sections: null };
  return { content: sectionsToText(sections, lang), sections };
}

/** Controle van opgeslagen/aangeleverde blokken (voor lezen en de eenmalige omzetting). */
export function normalizeSections(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const str = (v, n) => (typeof v === 'string' ? clip(v.trim(), n) : '');
  const arr = (v, max) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, max).map(x => clip(x.trim(), LIMITS.itemChars)) : []);
  const out = {
    summary: str(input.summary, LIMITS.summaryChars),
    went_well: arr(input.went_well, LIMITS.items),
    to_improve: arr(input.to_improve, LIMITS.items),
    next_steps: arr(input.next_steps, LIMITS.nextSteps),
  };
  const feedback = str(input.feedback, 4000);
  if (feedback) out.feedback = feedback;
  const filled = out.summary || out.feedback || out.went_well.length || out.to_improve.length || out.next_steps.length;
  return filled ? out : null;
}
