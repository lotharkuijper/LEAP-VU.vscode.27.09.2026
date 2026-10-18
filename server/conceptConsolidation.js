// Begrippenextractie over de HELE cursus, met samenvoegen van dubbelingen.
//
// Waarom (gemeten op E&B1, 2026-09-28): de oude extractie gaf het taalmodel
// maximaal 80 fragmenten in willekeurige volgorde en daarvan alleen de eerste
// 14.000 tekens — 5% van het materiaal, uit 3 van de 16 documenten. Kern-
// begrippen uit o.a. toetsen, schatten en de centrale limietstelling kwamen
// daardoor nooit voorbij. En dubbelingen werden alleen op naam-gelijkenis
// samengevoegd, wat voor synoniemen, afkortingen en vertalingen niet werkt
// (RCT ↔ Randomized Controlled Trial scoort 0,53; parametrisch ↔
// non-parametrisch, juist verschillend, 0,80).
//
// Aanpak (pure functies, getest in server/__tests__/conceptConsolidation.test.js):
//  1. buildDocumentWindows — alle fragmenten per document, in volgorde, in
//     stukken van hooguit ~12.000 tekens: elk document wordt gelezen.
//  2. conceptKey / mergeByKey — spellingvarianten (hoofdletters, koppeltekens,
//     spaties, buigingen) zijn ZEKER hetzelfde en worden automatisch één.
//  3. Synoniemen, afkortingen en vertalingen: een samenvoegstap met het
//     taalmodel (buildSynonymPrompt / parseSynonymGroups / applySynonymGroups);
//     de andere namen blijven bewaard als alias.
//  4. selectConcepts — minimum en maximum: hoge match en lage overlap gaan
//     voor (één voor één gekozen), met een kleine bonus voor documenten die
//     nog geen begrip hebben; onder het minimum alleen aanvullen met bewijs.

export const WINDOW_CHARS = 12000;

/** Pure: fragmenten → vensters per document (volgorde: document, dan chunk_index). */
export function buildDocumentWindows(chunks, maxChars = WINDOW_CHARS) {
  const byDoc = new Map();
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!c || !c.document_id || typeof c.content !== 'string' || !c.content.trim()) continue;
    if (!byDoc.has(c.document_id)) byDoc.set(c.document_id, []);
    byDoc.get(c.document_id).push(c);
  }
  const windows = [];
  for (const [documentId, list] of byDoc) {
    list.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
    let buf = [];
    let len = 0;
    const flush = () => { if (buf.length) windows.push({ documentId, text: buf.join('\n\n---\n\n') }); buf = []; len = 0; };
    for (const c of list) {
      const text = c.content.length > maxChars ? c.content.slice(0, maxChars) : c.content;
      if (len && len + text.length + 7 > maxChars) flush();
      buf.push(text);
      len += text.length + 7;
    }
    flush();
  }
  return windows;
}

// Nederlandse buigingen die we als "zelfde woord" behandelen (geneste/genest,
// verdelingen/verdeling, controles/controle, patiënten/patiënt).
// "'s" vóór "s": anders blijft van "risico's" "risico'" over.
const SUFFIXES = ["'s", 'en', 'e', 's'];
// Herhaald afknippen (hooguit twee keer) zodat de sleutel stabiel is:
// "controles" → "controle" → "control" en "controle" → "control".
function stemWord(w) {
  for (let round = 0; round < 2; round++) {
    const s = SUFFIXES.find((suf) => w.length - suf.length >= 4 && w.endsWith(suf));
    if (!s) break;
    w = w.slice(0, -s.length);
  }
  return w;
}

/**
 * Pure: sleutel waarop spellingvarianten samenvallen. Hoofdletters, accenten,
 * leestekens, koppeltekens en spaties tellen niet; Nederlandse buigingen per
 * woord ook niet. "Geneste Patiënt-Controleonderzoek" = "genest patiënt
 * controleonderzoek". Bewust NIET: "non-parametrisch" ≠ "parametrisch" (het
 * voorvoegsel blijft), "eerste kwartiel" ≠ "kwartiel" (extra woord).
 */
export function conceptKey(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'");
  const words = base.split(/[^a-z0-9']+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean).map(stemWord);
  return words.join('');
}

/**
 * Pure: is dit een bruikbare begripsnaam? Nee voor losse letters/symbolen
 * ("n", "x", "z") en formules ("t=0", "z = 1.96"); afkortingen van ≥2
 * letters (RCT, OR, SD) mogen wel.
 */
export function isUsableConceptName(name) {
  const n = String(name || '').trim();
  if (/[=<>]/.test(n)) return false;
  const letters = (n.match(/\p{L}/gu) || []).length;
  return letters >= 2;
}

/**
 * Pure: kandidaten met dezelfde sleutel samenvoegen. De langste definitie
 * blijft; documenten en alternatieve namen worden verenigd.
 * Invoer: [{ name, definition, documentIds?: string[], aliases?: string[], ... }]
 */
export function mergeByKey(candidates) {
  const byKey = new Map();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const key = conceptKey(c?.name);
    if (!key) continue;
    const docs = new Set(c.documentIds || []);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c, documentIds: [...docs], aliases: [...new Set(c.aliases || [])] });
      continue;
    }
    const keepThis = (c.definition || '').length > (prev.definition || '').length;
    const base = keepThis ? { ...c } : prev;
    const other = keepThis ? prev : c;
    const aliases = new Set([...(prev.aliases || []), ...(c.aliases || [])]);
    if (other.name && other.name !== base.name) aliases.add(other.name);
    aliases.delete(base.name);
    byKey.set(key, {
      ...base,
      documentIds: [...new Set([...(prev.documentIds || []), ...docs])],
      aliases: [...aliases],
    });
  }
  return [...byKey.values()];
}

/** Prompt voor de samenvoegstap (synoniemen/afkortingen/vertalingen). */
export function buildSynonymPrompt(items) {
  const lines = items.map((it, i) => `${i + 1}. ${it.name}${it.definition ? ` — ${String(it.definition).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n');
  return `Below is a list of subject terms from one university course (with a short definition where available).
Find terms that mean EXACTLY the same thing and should therefore be one concept:
- synonyms (e.g. "klinker" and "vocaal"),
- abbreviations and their full form (e.g. "VOC" and "Verenigde Oost-Indische Compagnie"),
- translations (e.g. "supply and demand" and "vraag en aanbod"),
- spelling or inflection variants.
Do NOT group:
- opposites or negations (e.g. "regelmatig werkwoord" vs "onregelmatig werkwoord"),
- a broader and a narrower term (e.g. "revolutie" vs "Franse Revolutie", "cel" vs "zenuwcel"),
- related but different concepts (e.g. "inflatie" vs "deflatie", "mitose" vs "meiose").
When in doubt, do not group.

Return ONLY JSON, no explanation: an array of groups, each with the preferred name (the common term in the course language, copied exactly from the list) and the other members copied exactly from the list. Only include groups with at least two members.
[{"preferred": "Verenigde Oost-Indische Compagnie", "others": ["VOC"]}]

TERMS:
${lines}`;
}

/** Pure: antwoord van de samenvoegstap → [{ preferred, others[] }] met alleen namen uit `allowedNames`. */
export function parseSynonymGroups(raw, allowedNames) {
  const norm = (s) => String(s || '').replace(/^\s*\[[CME]\]\s*/, '').toLowerCase().trim();
  const allowed = new Map((allowedNames || []).map((n) => [norm(n), n]));
  let parsed = [];
  try {
    const m = String(raw || '').match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  } catch { return []; }
  const used = new Set();
  const out = [];
  for (const g of Array.isArray(parsed) ? parsed : []) {
    const pref = allowed.get(norm(g?.preferred));
    if (!pref || used.has(pref)) continue;
    const others = [...new Set((Array.isArray(g?.others) ? g.others : [])
      .map((o) => allowed.get(norm(o)))
      .filter((o) => o && o !== pref && !used.has(o)))];
    if (!others.length) continue;
    used.add(pref); others.forEach((o) => used.add(o));
    out.push({ preferred: pref, others });
  }
  return out;
}

/**
 * Pure: pas synoniemgroepen toe op nieuwe kandidaten, rekening houdend met
 * begrippen die al in de cursus staan. Een bestaand begrip wint altijd (zijn
 * beoordeling en bewijs blijven intact); nieuwe kandidaten in zo'n groep
 * worden niet ingevoegd maar als alias + bron-documenten aan het bestaande
 * begrip toegevoegd.
 * Retour: { kept, toExisting: Map(bestaande naam → { aliases, documentIds }), mergedAway }
 */
export function applySynonymGroups(candidates, existingNames, groups) {
  const existing = new Map((existingNames || []).map((n) => [String(n).toLowerCase().trim(), n]));
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const toExisting = new Map();
  const drop = new Set();
  const mergedAway = [];
  const extra = new Map(); // naam van gekozen kandidaat → { aliases, docs }

  for (const g of groups || []) {
    const members = [g.preferred, ...g.others];
    const existingMember = members.find((m) => existing.has(m.toLowerCase().trim()));
    if (existingMember) {
      const target = existing.get(existingMember.toLowerCase().trim());
      const entry = toExisting.get(target) || { aliases: new Set(), documentIds: new Set() };
      for (const m of members) {
        const cand = byName.get(m);
        if (m !== target) entry.aliases.add(m);
        if (cand) {
          (cand.aliases || []).forEach((a) => entry.aliases.add(a));
          (cand.documentIds || []).forEach((d) => entry.documentIds.add(d));
          drop.add(m);
          mergedAway.push({ name: m, into: target });
        }
      }
      toExisting.set(target, entry);
      continue;
    }
    // Alleen nieuwe kandidaten: de voorkeursnaam blijft, de rest wordt alias.
    const keep = byName.get(g.preferred) ? g.preferred : members.find((m) => byName.get(m));
    if (!keep) continue;
    const e = extra.get(keep) || { aliases: new Set(), docs: new Set() };
    for (const m of members) {
      if (m === keep) continue;
      e.aliases.add(m);
      const cand = byName.get(m);
      if (cand) {
        (cand.aliases || []).forEach((a) => e.aliases.add(a));
        (cand.documentIds || []).forEach((d) => e.docs.add(d));
        drop.add(m);
        mergedAway.push({ name: m, into: keep });
      }
    }
    extra.set(keep, e);
  }

  const kept = candidates.filter((c) => !drop.has(c.name)).map((c) => {
    const e = extra.get(c.name);
    if (!e) return c;
    return {
      ...c,
      aliases: [...new Set([...(c.aliases || []), ...e.aliases])].filter((a) => a !== c.name),
      documentIds: [...new Set([...(c.documentIds || []), ...e.docs])],
    };
  });
  const toExistingPlain = new Map([...toExisting].map(([k, v]) => [k, { aliases: [...v.aliases], documentIds: [...v.documentIds] }]));
  return { kept, toExisting: toExistingPlain, mergedAway };
}

// ── Selectie: hoge match, lage overlap (2026-10-16) ──────────────────────────
// De docent stelt in de Begrippen-stap een minimum en een maximum in. Boven het
// maximum kiest LEAP de begrippen één voor één (greedy, "maximal marginal
// relevance"): steeds het begrip met de beste combinatie van
//   match   = hoe sterk het in het cursusmateriaal is teruggevonden
//             (hoogste overeenkomst, aantal bewijsfragmenten, en of het een
//             vakbegrip is dat in meerdere documenten terugkomt), min
//   overlap = hoe sterk het in betekenis lijkt op een al gekozen begrip
//             (cosine van de naam-embeddings).
// Zo krijgen goed onderbouwde begrippen die iets NIEUWS toevoegen voorrang
// boven varianten van wat er al is. Een kleine bonus voor een document dat nog
// geen begrip heeft houdt elke module vertegenwoordigd; voorbeelden uit
// casussen (example_instance) komen achteraan.

export const SELECTION_WEIGHTS = Object.freeze({
  relevance: 0.6, evidence: 0.25, breadth: 0.15, overlap: 0.5, newDocument: 0.1, example: 0.1,
});
const CORE_ROLES_SELECT = new Set(['main_course_concept', 'method_term', 'definition_term']);

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

/**
 * Match-score 0..1 per kandidaat. De RAG-overeenkomst op een vaste schaal
 * (0,40 → 0, 0,90 → 1): relatief binnen de lijst rekenen zou kleine
 * verschillen (0,90 tegen 0,84) opblazen tot 1 tegen 0.
 */
export function matchScores(list, w = SELECTION_WEIGHTS) {
  return list.map((r) => {
    const relevance = Math.min(1, Math.max(0, ((Number(r?.maxScore) || 0) - 0.4) / 0.5));
    const evidence = Math.min(1, (Number(r?.matchedCount) || 0) / 5);
    const docs = (r?.concept?.documentIds || []).length;
    const breadth = CORE_ROLES_SELECT.has(r?.concept?.concept_role) ? Math.min(1, Math.max(0, docs - 1) / 2) : 0;
    return w.relevance * relevance + w.evidence * evidence + w.breadth * breadth;
  });
}

/** Overlap-straf 0..1: cosine 0,5 of lager telt niet, 0,95 of hoger telt volledig. */
export function overlapPenalty(cos) {
  return Math.min(1, Math.max(0, (cos - 0.5) / 0.45));
}

/**
 * Pure: kies begrippen met hoge match en lage overlap, binnen [min, max].
 *   accepted — kandidaten die de RAG-verificatie haalden
 *   reserve  — kandidaten met WEL bewijs (≥1 fragment) maar minder dan de
 *              ingestelde minimale bewijsdrempel; alleen gebruikt om een
 *              minimum te halen, en dan gemarkeerd als topUp (te beoordelen).
 *              Nooit begrippen zonder bewijs.
 * Zonder max blijven alle geaccepteerde begrippen staan (in selectievolgorde).
 * Retour: { kept, cutOff, toppedUp, shortBy }.
 */
export function selectConcepts(accepted, { min = null, max = null, reserve = [], weights = SELECTION_WEIGHTS } = {}) {
  const list = Array.isArray(accepted) ? accepted : [];
  const maxN = Number(max) > 0 ? Number(max) : Infinity;
  const minN = Number(min) > 0 ? Math.min(Number(min), maxN) : 0;
  const selected = [];
  const usedDocs = new Set();

  const pick = (pool, limit) => {
    const match = matchScores(pool, weights);
    const open = pool.map((r, i) => ({ r, match: match[i] }));
    while (selected.length < limit && open.length > 0) {
      let best = -1;
      let bestValue = -Infinity;
      for (let i = 0; i < open.length; i++) {
        const { r, match: m } = open[i];
        let maxCos = 0;
        for (const s of selected) maxCos = Math.max(maxCos, cosine(r.embedding, s.embedding));
        const docs = r?.concept?.documentIds || [];
        const newDoc = docs.length > 0 && !docs.some((d) => usedDocs.has(d));
        const value = m
          - weights.overlap * overlapPenalty(maxCos)
          + (newDoc ? weights.newDocument : 0)
          - (r?.concept?.concept_role === 'example_instance' ? weights.example : 0);
        if (value > bestValue) { bestValue = value; best = i; }
      }
      const [{ r }] = open.splice(best, 1);
      selected.push(r);
      for (const d of r?.concept?.documentIds || []) usedDocs.add(d);
    }
    return open.map((o) => o.r);
  };

  const cutOff = pick(list, maxN);
  let toppedUp = [];
  if (selected.length < minN && Array.isArray(reserve) && reserve.length > 0) {
    const grounded = reserve.filter((r) => (Number(r?.matchedCount) || 0) >= 1);
    const before = selected.length;
    pick(grounded, minN);
    toppedUp = selected.slice(before).map((r) => ({ ...r, topUp: true }));
    selected.splice(before, toppedUp.length, ...toppedUp);
  }
  return { kept: selected, cutOff, toppedUp, shortBy: Math.max(0, minN - selected.length) };
}

const STATUS_RANK = { approved: 3, needs_review: 2, rejected: 1 };

const docCountOf = (r) => (Number.isFinite(r?.docCount) ? r.docCount : (r?.source_document_ids || []).length);

/**
 * Pure: ZEKERE samenvoegingen in de bestaande lijst. Zeker is:
 * - dezelfde conceptKey (spellingvariant), of
 * - de naam van het ene begrip staat als alias bij het andere ("z-verdeling"
 *   los én als alias van "standaardnormale verdeling"): LEAP heeft ze dan al
 *   eerder gelijkgesteld.
 * Het begrip dat blijft: goedgekeurd > te beoordelen > afgewezen, dan het
 * begrip dat de ander als alias heeft, dan het meeste documenten
 * (`docCount` of `source_document_ids`), dan de langste definitie.
 * Retour: [{ keepId, keepName, dupIds, dupNames }].
 */
export function planSureMerges(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => conceptKey(r?.name));
  // Union-find over de begrippen.
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const byNameKey = new Map();
  list.forEach((r, i) => {
    const k = conceptKey(r.name);
    if (byNameKey.has(k)) union(byNameKey.get(k), i); else byNameKey.set(k, i);
  });
  const owners = new Set(); // index van begrippen die een ander begrip als alias hebben
  list.forEach((r, i) => {
    for (const a of r.aliases || []) {
      const j = byNameKey.get(conceptKey(a));
      if (j === undefined || find(j) === find(i)) continue;
      union(i, j);
      owners.add(i);
    }
  });
  const groups = new Map();
  list.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });
  const plans = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) =>
      (STATUS_RANK[list[b].review_status] || 0) - (STATUS_RANK[list[a].review_status] || 0)
      || (owners.has(b) ? 1 : 0) - (owners.has(a) ? 1 : 0)
      || docCountOf(list[b]) - docCountOf(list[a])
      || (list[b].definition || '').length - (list[a].definition || '').length);
    const [keep, ...dups] = sorted.map((i) => list[i]);
    plans.push({ keepId: keep.id, keepName: keep.name, dupIds: dups.map((d) => d.id), dupNames: dups.map((d) => d.name) });
  }
  return plans;
}

const CLASS_TAG = { course: 'C', module: 'M', example: 'E' };
const CLASS_RANK = { course: 3, module: 2, example: 1 };

/**
 * Prompt voor "Zoek dubbelingen" (voorstellen aan de docent, nooit automatisch).
 * Bewust RUIMER dan buildSynonymPrompt: ook varianten met een toevoeging
 * tellen mee ("95% betrouwbaarheidsinterval" ↔ "betrouwbaarheidsinterval"),
 * want de docent beslist per paar. Elk begrip draagt zijn klasse
 * ([C] cursusconcept, [M] moduleconcept, [E] voorbeeld), zodat het model
 * gericht kan zoeken naar moduleconcepten die al als cursusconcept bestaan.
 */
export function buildDuplicateSuggestionPrompt(items) {
  const lines = items.map((it, i) => `${i + 1}. [${CLASS_TAG[it.cls] || 'M'}] ${it.name}${it.definition ? ` — ${String(it.definition).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n');
  return `Below is the concept list of one university course, as a teacher sees it. Each term is tagged:
[C] = course concept (appears in several modules), [M] = module concept (one module), [E] = example.
The list should contain every concept only ONCE. Find terms that a teacher would consider the same concept, so that they should be merged into one entry:
- synonyms, abbreviations and their full form, translations, spelling or inflection variants;
- the same concept with a qualifier, specification or wording variant (e.g. "klassieke conditionering volgens Pavlov" and "klassieke conditionering", "Franse Revolutie van 1789" and "Franse Revolutie", "geplande economie" and "planeconomie").
Check EVERY [M] term against the [C] terms in particular: a module concept that is also listed as a course concept is a duplicate.
Do NOT group:
- opposites or negations (e.g. "regelmatig werkwoord" vs "onregelmatig werkwoord", "import" vs "export");
- related but clearly different concepts (e.g. "inflatie" vs "deflatie", "mitose" vs "meiose", "metafoor" vs "metonymie");
- a thing and a different thing that shares a word (e.g. "cel" in biology vs "cel" in a prison, "stam" of a word vs "stam" as a people).

Return ONLY JSON, no explanation: an array of groups. "preferred" is the name to keep: the [C] term if the group has one, otherwise the most common term. Copy all names exactly from the list, without the tag. Only include groups with at least two members.
[{"preferred": "Franse Revolutie", "others": ["Franse Revolutie van 1789"]}]

TERMS:
${lines}`;
}

/**
 * Pure: groepen uit het taalmodel → voorstellen voor de docent.
 * rows: [{ id, name, review_status, cls: 'course'|'module'|'example' }].
 * Het begrip dat blijft: goedgekeurd > te beoordelen > afgewezen, dan een
 * cursusconcept boven een moduleconcept (een begrip hoort maar één keer in
 * de lijst, en dan onder Cursusconcepten), dan de voorkeursnaam van het model.
 * kind 'crossClass' = moduleconcept(en) die al als cursusconcept bestaan.
 * dismissed: Set met handtekeningen (gesorteerde id's, '|') van weggeklikte voorstellen.
 */
export function buildMergeSuggestions(groups, rows, dismissed = new Set()) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  const out = [];
  for (const g of groups || []) {
    const members = [...new Set([g.preferred, ...g.others])].map((n) => byName.get(n)).filter(Boolean);
    if (members.length < 2) continue;
    if (dismissed.has(members.map((m) => m.id).sort().join('|'))) continue;
    const keep = [...members].sort((a, b) =>
      (STATUS_RANK[b.review_status] || 0) - (STATUS_RANK[a.review_status] || 0)
      || (CLASS_RANK[b.cls] || 0) - (CLASS_RANK[a.cls] || 0)
      || (b.name === g.preferred ? 1 : 0) - (a.name === g.preferred ? 1 : 0))[0];
    const others = members.filter((m) => m.id !== keep.id);
    const crossClass = keep.cls === 'course' && others.some((m) => m.cls !== 'course');
    out.push({
      kind: crossClass ? 'crossClass' : 'same',
      keep: { id: keep.id, name: keep.name, reviewStatus: keep.review_status, cls: keep.cls },
      others: others.map((m) => ({ id: m.id, name: m.name, reviewStatus: m.review_status, cls: m.cls })),
    });
  }
  // Moduleconcepten die al als cursusconcept bestaan eerst: daar ging het om.
  return out.sort((a, b) => (a.kind === 'crossClass' ? 0 : 1) - (b.kind === 'crossClass' ? 0 : 1));
}

/** Kleine hulp: async map met beperkte gelijktijdigheid (volgorde blijft). */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        // Na een fout geen nieuwe items meer oppakken: anders werken de andere
        // workers door voor een resultaat dat niemand meer gebruikt.
        next = items.length;
        throw err;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
