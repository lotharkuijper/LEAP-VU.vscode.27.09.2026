// Feedback bij "Ik leg uit" (2026-10-15): vier vaste blokken, een vaste meetlat
// voor de score en verwante begrippen die alleen uit de cursus komen.
//
// Waarom: de feedback dwaalde af naar andere begrippen ("je zou ook moeten
// zeggen hoe dit verschilt van …") en was zwaar. Nu:
//   ### FEEDBACK   — alleen over DIT begrip en zijn definitie;
//   ### SCORE      — 0–100 volgens een vaste meetlat; verwante begrippen tellen niet mee;
//   ### RELATED    — hoogstens 3 begrippen uit een door de server gegeven lijst
//                    (cursusbegrippen die in dezelfde cursusfragmenten voorkomen);
//   ### FEEDFORWARD — 1–2 concrete vervolgstappen.
// De koppen zijn vaste Engelse tokens (net als het leerdagboek,
// server/journalSections.js); het model schrijft de inhoud in de taal van de student.
// Dit blok voegt de server ALTIJD toe; de (eventueel door de docent aangepaste)
// uitleg-prompt bepaalt alleen de toon.

export const EXPLAIN_HEADINGS = Object.freeze({
  feedback: 'FEEDBACK',
  score: 'SCORE',
  related: 'RELATED',
  feedforward: 'FEEDFORWARD',
});

/** Technische labels in concepts.key_points zijn geen kernpunten. */
export function cleanKeyPoints(keyPoints) {
  return (Array.isArray(keyPoints) ? keyPoints : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim())
    .filter(k => k && !/^course_id:/i.test(k) && !/^\[.*\]$/.test(k));
}

/**
 * Pure: welke andere cursusbegrippen komen in hetzelfde materiaal voor?
 * Telt gedeelde fragmenten (zwaar) en gedeelde documenten (licht).
 * @param {object} p
 * @param {Array<{chunk_id?:string, document_id?:string}>} p.ownEvidence
 * @param {Array<{concept_id:string, chunk_id?:string, document_id?:string}>} p.otherEvidence
 * @param {Map<string,{id:string,name:string}>} p.conceptsById  alleen goedgekeurde cursusbegrippen
 * @param {string} p.conceptId
 * @param {number} [p.limit=8]
 */
export function rankRelatedConcepts({ ownEvidence, otherEvidence, conceptsById, conceptId, limit = 8 }) {
  const chunks = new Set((ownEvidence || []).map(e => e.chunk_id).filter(Boolean));
  const docs = new Set((ownEvidence || []).map(e => e.document_id).filter(Boolean));
  const score = new Map();
  for (const e of otherEvidence || []) {
    if (!e || e.concept_id === conceptId || !conceptsById.has(e.concept_id)) continue;
    const w = (e.chunk_id && chunks.has(e.chunk_id)) ? 3 : (e.document_id && docs.has(e.document_id)) ? 1 : 0;
    if (w) score.set(e.concept_id, (score.get(e.concept_id) || 0) + w);
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || conceptsById.get(a[0]).name.localeCompare(conceptsById.get(b[0]).name))
    .slice(0, limit)
    .map(([id]) => conceptsById.get(id));
}

/** Het vaste blok achter de uitleg-prompt: blokken, grenzen en meetlat. */
export function explainFormatInstruction(lang, relatedNames = []) {
  const H = EXPLAIN_HEADINGS;
  const list = relatedNames.length ? relatedNames.map(n => `- ${n}`).join('\n') : '(geen)';
  if (String(lang || '').toLowerCase() === 'nl') {
    return `\n\nVORM VAN JE ANTWOORD (volg dit STRIKT, ook als hierboven iets anders staat):
Gebruik precies deze vier koppen, in deze volgorde, elk op een eigen regel:
### ${H.feedback}
### ${H.score}
### ${H.related}
### ${H.feedforward}

### ${H.feedback}
- Beoordeel ALLEEN of de student DIT begrip juist uitlegt, dicht bij de definitie. Hoogstens 5 zinnen.
- Begin met wat goed is. Noem daarna alleen wat aan de kern van DIT begrip onjuist of onvolledig is.
- Iets wat bij een ánder begrip hoort (een vergelijking, een verwant onderzoeksdesign, een vervolgonderwerp) is NOOIT een tekortkoming en hoort niet in dit blok.
- Een misconceptie noem je alleen als die over DIT begrip gaat.

### ${H.score}
- Eerste regel: alleen een geheel getal van 0 tot 100. Tweede regel: één korte zin waarom.
- Begin bij 100 en trek alleen af voor fouten of ontbrekende kern van DIT begrip. Geen aftrek voor lengte, stijl, taalfouten of het niet noemen van verwante begrippen.
- Meetlat: 100 = de kern is juist en in eigen woorden uitgelegd (perfectie is niet nodig); 85–95 = juist met een kleine onvolledigheid of onscherpte; 70–80 = redelijk goed: de kern klopt, maar één wezenlijk element ontbreekt of is vaag; 50–65 = deels juist; 25–45 = een belangrijke misconceptie; 0–20 = fout, leeg of over iets anders.
- Een redelijk goede uitleg krijgt dus echt veel punten; een goede uitleg gewoon 100.

### ${H.related}
- Hoogstens 3 begrippen, UITSLUITEND uit deze lijst cursusbegrippen (exact zo gespeld):
${list}
- Per begrip één regel: "- <naam>: <één zin over de relatie met het uitgelegde begrip>".
- Kies alleen begrippen die echt helpen; past er geen, schrijf dan alleen "-". Dit blok telt niet mee voor de score.

### ${H.feedforward}
- 1 of 2 concrete vervolgstappen, als opsomming. Bijvoorbeeld: welk punt van dit begrip aanscherpen, oefenen met een korte quiz, of een verwant begrip uit de lijst zelf uitleggen.

Verwijzingen [1], [2] naar bronnen mogen in FEEDBACK en FEEDFORWARD.`;
  }
  return `\n\nFORM OF YOUR ANSWER (follow STRICTLY, even if something different is said above):
Use exactly these four headings, in this order, each on its own line:
### ${H.feedback}
### ${H.score}
### ${H.related}
### ${H.feedforward}

### ${H.feedback}
- Assess ONLY whether the student explains THIS concept correctly, close to its definition. At most 5 sentences.
- Start with what is good. Then name only what is incorrect or incomplete about the core of THIS concept.
- Anything that belongs to a DIFFERENT concept (a comparison, a related study design, a follow-up topic) is NEVER a shortcoming and does not belong in this block.
- Mention a misconception only if it concerns THIS concept.

### ${H.score}
- First line: only a whole number from 0 to 100. Second line: one short sentence why.
- Start at 100 and deduct only for errors or missing core of THIS concept. No deduction for length, style, language errors or not mentioning related concepts.
- Scale: 100 = the core is correct and explained in own words (perfection is not required); 85–95 = correct with a small gap or vagueness; 70–80 = reasonably good: the core is right but one essential element is missing or vague; 50–65 = partly correct; 25–45 = an important misconception; 0–20 = wrong, empty or about something else.
- So a reasonably good explanation really gets many points; a good one simply gets 100.

### ${H.related}
- At most 3 concepts, ONLY from this list of course concepts (spelled exactly like this):
${list}
- One line per concept: "- <name>: <one sentence on how it relates to the explained concept>".
- Choose only concepts that really help; if none fits, write just "-". This block does not count towards the score.

### ${H.feedforward}
- 1 or 2 concrete next steps, as a list. For example: which point of this concept to sharpen, practising with a short quiz, or explaining a related concept from the list.

Source references [1], [2] are allowed in FEEDBACK and FEEDFORWARD.`;
}

function sectionText(text, heading) {
  const re = new RegExp(`^#{2,4}\\s*${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{2,4}\\s*(?:${Object.values(EXPLAIN_HEADINGS).join('|')})\\b|$(?![\\s\\S]))`, 'mi');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : null;
}

const bullets = (s) => String(s || '').split('\n')
  .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
  .filter(l => l && l !== '-');

/**
 * Pure: modelantwoord → { feedback, score, scoreReason, related, feedforward }.
 * related bevat alleen namen uit `allowed` (hoofdletterongevoelig), hoogstens 3.
 * Zonder herkenbare koppen: null (de aanroeper toont dan de ruwe tekst).
 */
export function parseExplainFeedback(text, allowed = []) {
  const H = EXPLAIN_HEADINGS;
  const feedback = sectionText(text, H.feedback);
  const scoreBlock = sectionText(text, H.score);
  if (feedback == null && scoreBlock == null) return null;
  let score = null;
  let scoreReason = '';
  if (scoreBlock) {
    const m = scoreBlock.match(/-?\d{1,3}(?:[.,]\d+)?/);
    if (m) score = Math.max(0, Math.min(100, Math.round(Number(m[0].replace(',', '.')))));
    scoreReason = scoreBlock.replace(/^[^\n]*?-?\d{1,3}(?:[.,]\d+)?\s*(?:\/\s*100)?[^\n]*\n?/, '').trim()
      || scoreBlock.replace(/-?\d{1,3}(?:[.,]\d+)?\s*(?:\/\s*100)?/, '').replace(/^[\s:–-]+/, '').trim();
  }
  const byName = new Map(allowed.map(c => [String(c.name).toLowerCase(), c]));
  const related = [];
  for (const line of bullets(sectionText(text, H.related))) {
    // Eerst splitsen op de dubbele punt (namen bevatten vaak een koppelteken,
    // bv. patiënt-controleonderzoek); anders op een los streepje met spaties.
    const m = line.match(/^\**([^:*]+?)\**\s*:\s*(.+)$/) || line.match(/^\**(.+?)\**\s+[–—-]\s+(.+)$/);
    if (!m) continue;
    const c = byName.get(m[1].trim().toLowerCase());
    if (c && !related.some(r => r.id === c.id)) related.push({ id: c.id, name: c.name, relation: m[2].trim() });
    if (related.length === 3) break;
  }
  return {
    feedback: feedback || '',
    score,
    scoreReason,
    related,
    feedforward: bullets(sectionText(text, H.feedforward)).slice(0, 3),
  };
}

/** Leesbare tekst (markdown) van de blokken, voor opslag en het leerdagboek. */
export function explainFeedbackMarkdown(p, lang) {
  const nl = String(lang || '').toLowerCase() === 'nl';
  const out = [`**${nl ? 'Feedback' : 'Feedback'}**`, p.feedback];
  if (p.score != null) out.push('', `**Score: ${p.score}/100**${p.scoreReason ? ` — ${p.scoreReason}` : ''}`);
  if (p.related.length) {
    out.push('', `**${nl ? 'Verwante begrippen' : 'Related concepts'}**`);
    for (const r of p.related) out.push(`- ${r.name}: ${r.relation}`);
  }
  if (p.feedforward.length) {
    out.push('', `**Feed forward**`);
    for (const f of p.feedforward) out.push(`- ${f}`);
  }
  return out.join('\n').trim();
}

const RAG_STRICT_NL = 'STRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."';

/**
 * Het te beoordelen bericht: begrip, definitie, (echte) kernpunten,
 * cursusfragmenten, de uitleg en de verwijsregels. Voorheen bouwde de browser
 * dit; nu de server, zodat de beoordeling op één plek vastligt.
 */
export function buildExplainUserMessage({ concept, keyPoints = [], context = '', sources = [], ragStrictMode = false, explanation }) {
  const parts = [`Begrip: "${concept.name}"`, '', `Officiële definitie:\n${concept.definition || '(geen definitie)'}`];
  if (keyPoints.length) parts.push('', `Kernpunten van dit begrip:\n${keyPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  if (context) {
    parts.push('', `Relevante informatie uit cursusmateriaal (achtergrond; fragmenten kunnen ook over andere begrippen gaan — beoordeel alleen het begrip hierboven):\n${context}`);
    if (ragStrictMode) parts.push('', RAG_STRICT_NL);
  } else if (ragStrictMode) {
    parts.push('', RAG_STRICT_NL, 'Er zijn geen relevante cursusteksten gevonden voor dit begrip. Geef dit duidelijk aan in je feedback.');
  }
  parts.push('', `Uitleg van de student:\n${explanation}`);
  const titles = sources.map(s => (s && typeof s.title === 'string' ? s.title : '')).filter(Boolean);
  if (titles.length) {
    parts.push('', `Bronnen uit het cursusmateriaal die je tot je beschikking hebt:\n${titles.map((t, i) => `[${i + 1}] ${t}`).join('\n')}`,
      '', 'Verwijsregels (volg deze STRIKT):',
      '- Verwijs naar een bron met exact de notatie [1], [2] of [3] direct na de zin waar je die bron gebruikt.',
      '- Gebruik géén andere verwijsvormen (geen titels, geen URL\'s, geen voetnoten, geen DOI\'s).',
      '- Informatie die NIET uit deze bronnen komt maar uit algemene kennis, markeer je met "(buiten cursusmateriaal)" aan het einde van die zin.');
  } else {
    parts.push('', 'Er zijn geen cursusbronnen om naar te verwijzen: gebruik GEEN [1], [2] of URL\'s. Markeer zinnen die op algemene kennis steunen met "(buiten cursusmateriaal)".');
  }
  parts.push('', 'Aanspraakvorm: spreek de student direct aan met "je" / "jij" / "jouw". Gebruik NOOIT "de student" of "deze student".');
  return parts.join('\n');
}