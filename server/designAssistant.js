// Ontwerphulp — een optionele chatbot in het beheer die docenten helpt hun
// cursusdoelen te vertalen naar keuzes in LEAP (constructive alignment,
// scaffolding, activerend leren). Experiment sinds 2026-10-07; terug naar de
// stand daarvoor: git-tag `pre-ontwerphulp-2026-10-07`, of de schakelaar uit.
//
// Ontwerpregel: de bot leert LEAP NIET uit een vaste tekst, maar bij elke
// vraag uit de levende bronnen, zodat hij meebeweegt als de engine verandert:
//   1. ADMIN_SECTIONS hieronder: welke onderdelen het beheer heeft, waar ze
//      staan en wie ze mag gebruiken. Een test vergelijkt dit met de echte
//      tabbladen in src/pages/AdminPage.tsx (verandert daar iets — bv. wat
//      docenten wel/niet mogen — dan faalt de test tot dit is bijgewerkt);
//   2. de hulpteksten (help.<onderwerp>.title/body in nl.json): die horen bij
//      een FUNCTIE en worden bij elke wijziging in het beheer bijgewerkt;
//   3. de handleiding (docs/handleiding/handleiding.html), voor het waarom, en
//      het stappenplan "Een project inrichten" (docs/handleiding/
//      Stappenplan-project-LEAP.docx, rechtstreeks uit het Word-bestand, zodat
//      een aanpassing in Word meteen meetelt);
//   4. de actuele stand van de cursus, via dezelfde routes die het beheer
//      zelf gebruikt (met het token van de docent, dus met diens rechten).
// Besluit 2026-10-16: GEEN externe bronnen (ook geen vu.nl-pagina's). De
// onderwijskundige werkwijze (constructive alignment, scaffolding, blended en
// activerend onderwijs, variatie in toetsvormen, de VU-waarden) staat in de
// instructie van de bot. Deze kennis is 100% gescheiden van cursusmateriaal:
// ze komt uit bestanden in de repo, nooit uit documents/document_chunks, en
// niets anders in LEAP leest haar. Docenten kunnen er niets aan veranderen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { COURSE_FEATURES, normalizeCourseFeatures } from './courseFeatures.js';

const FEATURE_NL = { chat: 'Chat', explain: 'Ik leg uit', quiz: 'Quiz', projects: 'Projecten', journal: 'Leerdagboek', studiecafe: 'Studiecafé' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * De onderdelen van het beheer, in de volgorde van het menu (sinds 2026-10-26 in
 * de volgorde van inrichten: Inhoud, AI-tutor, Quiz, Openstellen, Volgen; Systeem).
 * `audience`: 'all' = docent en beheerder,
 * 'admin' = alleen beheerder. `helpGroups`: groepen hulpteksten (help.<groep>.*)
 * die bij dit onderdeel horen. `tab`: waarde van ?tab= in /admin.
 */
export const ADMIN_SECTIONS = [
  { tab: 'material', labelKey: 'admin.tabs.material', audience: 'all', helpGroups: ['material', 'concepts'],
    what: 'Bestanden en websites toevoegen met een doel (leerstof, cursusinformatie, projectmateriaal, alleen delen, alleen docenten), verwerking controleren, begrippen (kernbegrippen, dubbelingen, maximum) en de controle "Klaar voor studenten".' },
  { tab: 'projects_admin', labelKey: 'admin.tabs.projects', audience: 'all', helpGroups: ['projects', 'personas'],
    what: 'Groepsprojecten met persona\'s in drie rollen: begeleider, beoordelaar (rubric, feedbackrondes per product) en rolspeler (simulatie, eventueel met verstandhouding en gedragsregels). Ook persona-sjablonen en inleveren.' },
  { tab: 'prompts', labelKey: 'admin.tabs.prompts', audience: 'all', helpGroups: ['chatInstructions'],
    what: 'Tutor-instructies: toon en aanpak van de tutor in de chat en bij Ik leg uit, eventueel per cursus.' },
  { tab: 'rag_settings', labelKey: 'admin.tabs.ragSettings', audience: 'all', helpGroups: ['searchSensitivity'],
    what: 'Zoekgevoeligheid: hoe ruim de AI passages uit het materiaal meeneemt (Ruim/Gebalanceerd/Streng of eigen drempel), per onderdeel en per cursus.' },
  { tab: 'quiz_sources', labelKey: 'admin.tabs.quizSources', audience: 'all', helpGroups: ['quizSources'],
    what: 'Waar quizvragen vandaan komen: cursusmateriaal (RAG), een vraagbank (ShareStats/CSV) of vrij door de AI, met dekking per begrip.' },
  { tab: 'imports', labelKey: 'admin.tabs.imports', audience: 'all', helpGroups: [],
    what: 'Vraagbanken importeren (onder andere ShareStats).' },
  { tab: 'course_features', labelKey: 'admin.tabs.courseFeatures', audience: 'all', helpGroups: ['courseFeatures'],
    what: 'Onderdelen aan/uit: onderdelen voor studenten per cursus aan- of uitzetten: chat, Ik leg uit, quiz, projecten, leerdagboek en studiecafé. Uitgezet = verdwenen uit menu en overzicht van studenten (docent ziet het nog met een label); er wordt niets gewist. Zonder chat geen leerniveau (kiezen of verdienen); zonder leerdagboek geen nieuwe dagboekregels en staan projectbeoordelingen alleen in de projectruimte. Apart: bijlagen in de chat (afbeeldingen plakken, bestanden meegeven) staan standaard UIT en gaan pas aan na een waarschuwing en een dubbele bevestiging; alleen als de beheerder het platformbreed toestaat. Bijlagen worden niet bewaard.' },
  { tab: 'add_users', labelKey: 'admin.tabs.addUsers', audience: 'all', helpGroups: [],
    what: 'Studenten uitnodigen met hun e-mailadres (één, een paar, of een lijst/bestand), voor een cursus waarvan je docent bent. Bestaand account: direct student in de cursus, met een mail. Geen account: LEAP maakt het aan en stuurt een persoonlijke uitnodiging (naam docent + cursus); na activeren zit de student in de cursus. Werkt in elke cursus, ook Canvas of gesloten, en ook met een VU-adres (voor uitzonderingen naast de Canvas-link). Uitnodiging 30 dagen geldig; niet geactiveerd = account weer verwijderd. In Cursussen beheren → Beheer leden: status, opnieuw sturen, intrekken; daar ook iemand verwijderen of docent maken. Hoogstens 300 uitnodigingen per docent per dag; mails gaan op de achtergrond (ca. 80 per uur).' },
  { tab: 'analytics', labelKey: 'admin.tabs.analytics', audience: 'all', helpGroups: ['analytics', 'learningLevels'],
    what: 'Analytics, alleen in totalen (cijfers op minder dan 5 studenten blijven verborgen). Docent: begrippen-thermometer met gemiddelde quizscore per begrip en chatvragen waarvoor de chat geen goed bewijs in het materiaal vond. Beheerder: ook gezondheid en kosten (fouten, responstijd, tokens, inleesproblemen). Onderaan: de leerniveaus, hoeveel studenten op welk niveau werken (alleen de verdeling, nooit per student).' },
  { tab: 'users', labelKey: 'admin.tabs.users', audience: 'admin', helpGroups: [],
    what: 'Alle gebruikers van LEAP en hun rol.' },
  { tab: 'messages', labelKey: 'admin.tabs.messages', audience: 'admin', helpGroups: ['systemMessages'],
    what: 'Systeemberichten aan alle gebruikers, alle studenten, alle docenten of de leden van één cursus. Ze staan op het Dashboard tot iemand ze wegklikt of tot de einddatum; bij "Dashboard" in het menu staat zolang een rood uitroepteken. Eenrichtingsverkeer; de beheerder ziet alleen totalen (ontvangers, weggeklikt).' },
  { tab: 'settings', labelKey: 'admin.tabs.settings', audience: 'admin', helpGroups: ['chatAttachments'],
    what: 'Systeeminstellingen van LEAP, waaronder de hoofdschakelaar voor bijlagen in de chat (afbeeldingen en bestanden; standaard uit, noodrem voor alle cursussen).' },
];

/** Buiten de tabbladen van /admin, maar wel relevant voor het inrichten. */
export const OTHER_PAGES = [
  { path: '(zijpaneel in heel Beheer)', label: 'Ontwerphulp', helpGroups: ['designAssistant'],
    what: 'Dit gesprek zelf: een zijpaneel dat open blijft terwijl de docent tussen onderdelen wisselt. Links in je antwoorden openen het onderdeel achter het paneel.' },
  { path: '/quiz', label: 'Quiz (studentkant)', helpGroups: ['quiz'],
    what: 'Studenten zien per begrip hun eigen voortgang (alleen voor henzelf) en kunnen "Oefen wat je lastig vindt" kiezen: gespreide herhaling op basis van hun eigen quizscores. De standaardmoeilijkheid volgt hun leerniveau; na "Ik leg uit" kunnen ze direct een quiz over dat begrip starten.' },
  { path: '/chat, /explain, /feedback, /my-data', label: 'Studentenkant: uitleg bij knoppen', helpGroups: ['student'],
    what: 'Bij knoppen waarvan het gevolg niet vanzelf spreekt, staat voor studenten een vraagteken: wat er gebeurt, wat bewaard wordt en wie het ziet. In de chat: leerniveau, Klaar voor een hoger niveau?, Doel (optioneel eigen doel voor een gesprek), Ik werk aan, bijlagen en afsluiten. In Ik leg uit: de twee manieren van oefenen (Leg zelf uit, Verbeter deze uitleg). Verder de prijzenkast en account verwijderen.' },
  { path: '/admin/courses', label: 'Cursussen beheren', helpGroups: ['courses'], what: 'Cursussen aanmaken, leden beheren (docenten kunnen zelf studenten toevoegen en tot docent bevorderen), beschikbaar maken voor studenten. Per cursus de knop Cursus-info: het blok bovenaan het Dashboard van studenten (tekst, banner, bestanden om te downloaden). De toegangsroute (gesloten, Canvas, open registratie, of Canvas + open) stelt alleen de beheerder in.' },
  { path: '/projects', label: 'Projectruimte', what: 'De werkplek van een groep. Alleen de groepsleden zien wat daar gebeurt; docenten niet (privacy). Docenten zien in Projecten alleen wie in welke groep zit. Het contact met een rolspeler herstellen en extra gesprekken toekennen kan alleen een beheerder.' },
];

// ── Bronnen inlezen (met cache op wijzigingstijd) ─────────────────────────────
const fileCache = new Map();
function readCached(rel, convert = (buf) => buf.toString('utf8')) {
  const p = path.join(ROOT, rel);
  try {
    const st = fs.statSync(p);
    const hit = fileCache.get(p);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    const text = convert(fs.readFileSync(p));
    fileCache.set(p, { mtime: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
}

/**
 * De documenten die de bot ALTIJD helemaal leest (geen zoekstap). Elk document
 * moet binnen KNOWLEDGE_DOC_LIMIT tekens blijven; een test bewaakt dat, zodat
 * er nooit stil iets wordt afgekapt. Wordt een document te lang, splits het of
 * kort het in (of stap dan over op zoeken per sectie).
 */
export const KNOWLEDGE_DOC_LIMIT = 60000;
export const KNOWLEDGE_DOCS = [
  { file: 'docs/handleiding/handleiding.html', title: 'Handleiding voor docenten (achtergrond en werkwijze)', toText: (buf) => htmlToText(buf.toString('utf8')) },
  // Het Word-bestand zelf is de bron: past de docent/beheerder het aan in Word, dan leest de bot de nieuwe versie.
  { file: 'docs/handleiding/Stappenplan-project-LEAP.docx', title: 'Stappenplan: een project inrichten (expert-persona\'s, tussentijdse feedback, voorbeoordeling van het eindrapport)', toText: (buf) => fromFirstHeading(docxToText(buf)) },
];

/** De inhoudsopgave en titelpagina weglaten: begin bij de eerste kop. */
function fromFirstHeading(text) {
  const i = text.indexOf('## ');
  return i > 0 ? text.slice(i) : text;
}

/** Tekst van de vaste kennisdocumenten (ontbrekend bestand = overgeslagen). */
export function loadKnowledgeDocs() {
  return KNOWLEDGE_DOCS.map((d) => ({ title: d.title, text: readCached(d.file, d.toText) || '' })).filter((d) => d.text);
}

/** Pure: HTML van de handleiding → platte tekst met koppen op eigen regels. */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<section class="cover"[\s\S]*?<\/section>/i, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '')
    .replace(/<h[1-3][^>]*>/gi, '\n\n## ')
    .replace(/<\/(h[1-3]|p|li|tr|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Pure: Word-bestand (.docx) → platte tekst; koppen als "## ", lijsten als "- ", een tabelrij als "| a | b". */
export function docxToText(bytes) {
  if (!bytes) return '';
  let xml;
  try { xml = strFromU8(unzipSync(new Uint8Array(bytes), { filter: (f) => f.name === 'word/document.xml' })['word/document.xml']); } catch { return ''; }
  if (!xml) return '';
  const dec = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const textOf = (x) => dec((x.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim();
  const out = [];
  for (const block of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    if (block.startsWith('<w:tbl>')) {
      for (const row of block.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [])
          .map((c) => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map(textOf).filter(Boolean).join(' '));
        if (cells.some(Boolean)) out.push(`| ${cells.join(' | ')}`);
      }
      continue;
    }
    const text = textOf(block);
    if (!text) continue;
    if (/<w:pStyle w:val="Heading\d"/.test(block)) out.push('', `## ${text}`);
    else if (/<w:numPr>/.test(block)) out.push(`- ${text}`);
    else out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Pure: hulpteksten per groep uit een locale-object. */
export function helpTextsByGroup(locale) {
  const groups = {};
  for (const [k, v] of Object.entries(locale || {})) {
    // Ook ids met meer niveaus (material.step.files, student.chat.goal).
    const m = k.match(/^help\.([^.]+)\.(.+)\.(title|body)$/);
    if (!m) continue;
    const g = (groups[m[1]] ||= {});
    const topic = (g[m[2]] ||= {});
    topic[m[3]] = v;
  }
  return groups;
}

/**
 * Pure: de LEAP-kennis voor de bot. `role` = 'admin' | 'docent' bepaalt wat
 * de gebruiker zelf mag; onderdelen die alleen de beheerder kan, worden wél
 * genoemd maar als "alleen beheerder" gemarkeerd.
 */
export function buildLeapKnowledge({ locale, handbookText, extraDocs = [], role }) {
  const help = helpTextsByGroup(locale);
  const label = (key) => (locale && locale[key]) || key;
  const lines = ['# LEAP — onderdelen van het beheer (actueel)'];
  lines.push(`De gebruiker is ${role === 'admin' ? 'BEHEERDER (mag alles)' : 'DOCENT (onderdelen gemarkeerd "alleen beheerder" kan deze gebruiker niet zelf; verwijs dan naar de beheerder)'}.`);
  lines.push('Link naar een onderdeel altijd als markdown-link met precies dit adres, bijvoorbeeld [Bronnen van quizvragen](/admin?tab=quiz_sources).');
  for (const s of ADMIN_SECTIONS) {
    const who = s.audience === 'admin' ? ' — ALLEEN BEHEERDER' : '';
    lines.push('', `## ${label(s.labelKey)} (/admin?tab=${s.tab})${who}`, s.what);
    for (const g of s.helpGroups) {
      for (const t of Object.values(help[g] || {})) {
        if (t.title && t.body) lines.push(`- ${t.title}: ${t.body}`);
      }
    }
  }
  for (const p of OTHER_PAGES) {
    lines.push('', `## ${p.label} (${p.path})`, p.what);
    for (const g of p.helpGroups || []) {
      for (const t of Object.values(help[g] || {})) if (t.title && t.body) lines.push(`- ${t.title}: ${t.body}`);
    }
  }
  const docs = [...(handbookText ? [{ title: 'Handleiding voor docenten (achtergrond en werkwijze)', text: handbookText }] : []), ...(extraDocs || [])];
  for (const d of docs) {
    if (d.text.length > KNOWLEDGE_DOC_LIMIT) console.warn(`[ontwerphulp] "${d.title}" is langer dan ${KNOWLEDGE_DOC_LIMIT} tekens en wordt afgekapt`);
    lines.push('', `# ${d.title}`, d.text.slice(0, KNOWLEDGE_DOC_LIMIT));
  }
  return lines.join('\n');
}

function loadLocale() {
  const raw = readCached('src/i18n/locales/nl.json');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function loadLeapKnowledge(role) {
  return buildLeapKnowledge({ locale: loadLocale(), extraDocs: loadKnowledgeDocs(), role });
}

// ── De cursus op dit moment ───────────────────────────────────────────────────
const PURPOSE_NL = {
  course_material: 'leerstof', course_info: 'cursusinformatie', project: 'projectmateriaal',
  share_only: 'alleen delen', teacher_only: 'alleen voor docenten', unconfirmed: 'nog geen doel',
};
const ROLE_NL = { conversational: 'begeleider', evaluator: 'beoordelaar', roleplayer: 'rolspeler' };

/**
 * Pure: compacte, leesbare samenvatting van de cursus voor de bot. `snap` is
 * wat de bestaande beheerroutes teruggeven; ontbrekende delen worden
 * overgeslagen (de bot moet dan doorvragen in plaats van gokken).
 */
export function summarizeCourse(snap, locale = {}) {
  const s = snap || {};
  const out = [`# De cursus van deze docent (actueel): ${s.course?.name || '(onbekend)'}`];
  if (s.course) {
    out.push(`- Beschrijving: ${s.course.description || '(geen)'}`);
    out.push(`- Beschikbaar voor studenten: ${s.course.student_visible === false ? 'nee' : 'ja'}; actief: ${s.course.is_active === false ? 'nee' : 'ja'}`);
    // Onderdelen per cursus (server/courseFeatures.js): adviseer niets wat uit staat zonder dat te zeggen.
    const f = normalizeCourseFeatures(s.course.features);
    const off = COURSE_FEATURES.filter(k => !f[k]).map(k => FEATURE_NL[k]);
    out.push(`- Onderdelen voor studenten: ${off.length ? `uit: ${off.join(', ')} (aan te zetten in Onderdelen aan/uit)` : 'alles aan'}`);
  }
  const r = s.readiness;
  if (r) {
    const counts = Object.entries(r.counts || {}).map(([k, n]) => `${PURPOSE_NL[k] || k}: ${n}`).join(', ');
    out.push(`- Materiaal per doel: ${counts || 'nog niets'}`);
    const concepts = r.concepts || [];
    const visible = concepts.filter(c => c.visible);
    const course = visible.filter(c => c.evidenceDocuments > 1 && c.role !== 'example_instance').length;
    const quizReady = visible.filter(c => c.quizReady).length;
    const itembank = visible.filter(c => c.itembankSections > 0).length;
    out.push(`- Begrippen: ${concepts.length} totaal, ${visible.length} zichtbaar voor studenten; ${course} cursusconcepten (in meerdere documenten); ${quizReady} met quizbewijs; ${itembank} gekoppeld aan de vraagbank.`);
    if (visible.length) out.push(`  Voorbeelden van begrippen: ${visible.slice(0, 25).map(c => c.name).join(', ')}${visible.length > 25 ? ', …' : ''}`);
    // Dezelfde teksten die de docent bij "Klaar voor studenten" ziet.
    const warnings = (r.warnings || []).map(w => {
      if (typeof w === 'string') return w;
      const title = locale[`material.warning.${w.code}.title`];
      const desc = locale[`material.warning.${w.code}.desc`];
      const head = title ? title.replace('{n}', String(w.count ?? '')) : w.code;
      const items = Array.isArray(w.items) && w.items[0] !== '—' ? ` (${w.items.slice(0, 5).join(', ')})` : '';
      return `${head}${items}${desc ? ` — ${desc}` : ''}`;
    });
    if (warnings.length) out.push(`- Openstaande punten uit "Klaar voor studenten": ${warnings.join('; ')}`);
  }
  if (s.quizMix) out.push(`- Quizbronnen: ${s.quizMix.pct_rag}% cursusmateriaal, ${s.quizMix.pct_itembank}% vraagbank, ${s.quizMix.pct_llm}% vrij door de AI.`);
  if (s.ragSettings) {
    const parts = ['chat', 'explain', 'quiz', 'project']
      .filter(m => s.ragSettings[m])
      .map(m => `${m} drempel ${s.ragSettings[m].similarity_threshold}${s.ragSettings[m].rag_strict_mode ? ' (strikt)' : ''}`);
    if (parts.length) out.push(`- Zoekgevoeligheid: ${parts.join(', ')}.`);
  }
  if (Array.isArray(s.projects)) {
    if (!s.projects.length) out.push('- Projecten: nog geen.');
    for (const p of s.projects) {
      const personas = (p.personas || []).map(x => {
        const extra = x.persona_type === 'roleplayer' && x.reputation_enabled ? ', met verstandhouding' : x.persona_type === 'evaluator' && x.max_reviews ? `, ${x.max_reviews} feedbackrondes` : '';
        return `${x.name} (${ROLE_NL[x.persona_type] || 'begeleider'}${extra})`;
      }).join(', ');
      out.push(`- Project "${p.title}"${p.research_question ? ` — beoogd resultaat: ${p.research_question}` : ''}; inleveren ${p.submissions_enabled ? 'aan' : 'uit'}; persona's: ${personas || 'geen'}.`);
    }
  }
  return out.join('\n');
}

// ── Instructie van de bot (alleen de beheerder kan die aanpassen) ─────────────
export const DEFAULT_DESIGN_ASSISTANT_PROMPT = `Je bent de Ontwerphulp van LEAP: een ervaren onderwijskundige van de VU die docenten helpt hun cursus in LEAP in te richten. Je spreekt de docent aan met "je".

Je onderwijskundige basis (gebruik die bij elk advies, zonder er een college over te geven):
- Constructive alignment: leerdoelen, leeractiviteiten en toetsing/feedback sluiten op elkaar aan. Begin bij wat studenten na de cursus moeten kunnen (bij voorkeur een werkwoord dat het denkniveau aangeeft), dan hoe dat zichtbaar wordt, dan welke activiteiten daarheen leiden. Benoem het als iets niet aansluit.
- Scaffolding: bouw op van ondersteund naar zelfstandig. Bijvoorbeeld eerst uitleg en een begeleider, dan oefenen met feedback (quiz, Ik leg uit, feedbackrondes op een tussenproduct), en pas daarna een open of uitdagende opdracht, zoals een eindproduct of een simulatie met een rolspeler. Laat de ondersteuning gaandeweg afnemen.
- Activerend onderwijs: studenten doen het denkwerk. Geef de voorkeur aan activiteiten waarin studenten zelf iets formuleren, uitleggen, toepassen of beslissen boven activiteiten waarin ze alleen ontvangen. Stel waar passend voor de tutor wedervragen te laten stellen in plaats van antwoorden voor te zeggen.
- Blended onderwijs: LEAP is het online deel van een geheel. Verbind het met de contactmomenten: voorbereiden in LEAP en toepassen in de les, vragen uit het Studiecafé of veelvoorkomende misverstanden (Analyse) als startpunt van een werkcollege, tussenproducten van projecten bespreken in een begeleidingsmoment. Vraag hoe de cursus verder is opgebouwd voordat je hier concreet over adviseert.
- Variatie in toetsvormen: kies de vorm die bij het leerdoel past. Kennis en begrip oefen je met de quiz en Ik leg uit; toepassen, analyseren en samenwerken met een project en een eindproduct; communicatieve vaardigheden met een rolspeler. Combineer formatief (oefenen met feedback, vaak en laagdrempelig) en summatief (het eindoordeel). Belangrijk: in LEAP zijn quiz, Ik leg uit, chat en feedbackrondes oefenruimtes; docenten zien die resultaten bewust niet. Adviseer ze dus nooit als cijferbron. Summatief beoordelen gebeurt buiten LEAP of via ingeleverde projectproducten (eventueel met voorbeoordeling), en het oordeel is altijd van de docent.

Op de achtergrond spelen de drie VU-waarden mee. Laat ze je advies kleuren; noem ze alleen als de docent ernaar vraagt of als ze een keuze echt verhelderen:
- Open: transparant over hoe AI wordt ingezet en waarop studenten worden beoordeeld; ruimte voor verschillende perspectieven; aansluiting bij vraagstukken uit de wereld buiten de universiteit (bijvoorbeeld realistische opdrachtgevers als rolspeler).
- Persoonlijk: onderwijs dat aansluit bij de student, met aandacht en feedback die verder helpt, waarbij de student eigenaar blijft van het eigen leren (eigen niveau, eigen leerdagboek).
- Verantwoordelijk: zorgvuldig met AI en met gegevens van studenten; de student blijft de maker van het eigen werk; AI-uitvoer wordt kritisch bekeken (bijvoorbeeld met "Klopt dit wel?"); beoordelen is eerlijk, met heldere criteria, en het oordeel ligt bij de docent.

Je werkwijze:
- De docent bepaalt. Jij denkt mee, stelt vragen en doet voorstellen; een docent die al weet wat hij wil, help je kort en praktisch verder. Vraag één ding tegelijk als iets nog niet duidelijk is.
- Wees concreet over LEAP: noem het onderdeel en link ernaar (markdown-link met het adres uit de kennis). Gebruik de actuele stand van de cursus om gericht te adviseren ("je hebt nog geen beoordelaar die bij leerdoel 2 past"). Voor projecten volg je het stappenplan in de kennis.
- Noem ALLEEN functies die in de LEAP-kennis hieronder staan. Bestaat iets niet, zeg dat eerlijk en bied een alternatief binnen LEAP. Kan alleen de beheerder iets, zeg dan dat de docent dat aan de beheerder kan vragen.
- Je kunt zelf niets in LEAP veranderen. Bied wel kant-en-klare concepten aan die de docent kan kopiëren: chat-instructies, de instructie voor een persona, gedragsregels voor een rolspeler, een rubric voor een beoordelaar, een indeling van projectfasen. Zet zo'n concept in een kader (codeblok) met een korte kop erboven.
- Als het ontwerp rond is: geef een overzicht als tabel (leerdoel | activiteit in LEAP | feedback/toetsing) en een korte afvinklijst met links.
- Houd antwoorden kort en overzichtelijk. Liever een gerichte vraag dan een lang betoog.
- Je hebt geen documenten met regels van de VU, een faculteit of een opleiding (toetsregels, beleid over AI-gebruik, programmaleerdoelen). Verzin die niet. Komt het ter sprake, geef dan de algemene onderwijskundige afweging en verwijs voor de precieze regels naar de opleiding of faculteit en het VU Centre for Teaching & Learning.`;

const STEP_NL = { files: 'stap 1 Bestanden', processing: 'stap 2 Verwerking', concepts: 'stap 3 Begrippen', ready: 'stap 4 Klaar voor studenten' };

/** Pure: leesbare beschrijving van waar de docent in het beheer is, of ''. */
export function describePlace(context, locale = {}) {
  if (!context || typeof context.tab !== 'string') return '';
  const section = ADMIN_SECTIONS.find(s => s.tab === context.tab);
  if (!section) return '';
  const parts = [`${locale[section.labelKey] || section.labelKey} (/admin?tab=${section.tab})`];
  if (context.tab === 'material' && STEP_NL[context.step]) parts.push(STEP_NL[context.step]);
  if (context.tab === 'projects_admin' && context.view === 'templates') parts.push('Persona-sjablonen');
  return parts.join(' → ');
}

/** Pure: de berichten voor het taalmodel. */
export function buildDesignAssistantMessages({ adminPrompt, knowledge, courseSummary, messages, languageInstruction = '', place = '' }) {
  const system = [
    (adminPrompt && adminPrompt.trim()) || DEFAULT_DESIGN_ASSISTANT_PROMPT,
    '',
    '────────── LEAP-KENNIS (actueel, gezaghebbend) ──────────',
    knowledge,
    '',
    '────────── STAND VAN DE CURSUS ──────────',
    courseSummary || '(niet beschikbaar)',
    ...(place ? ['', '────────── WAAR DE DOCENT NU IS ──────────', `De docent heeft dit onderdeel open naast het gesprek: ${place}. Sluit daar zo mogelijk op aan (bv. bij "wat zie ik hier?").`] : []),
    languageInstruction || '',
  ].join('\n');
  const history = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  return [{ role: 'system', content: system }, ...history];
}

// ── Routes ────────────────────────────────────────────────────────────────────
export const ENABLED_KEY = '__design_assistant_enabled__';
export const PROMPT_KEY = '__design_assistant_prompt__';

/**
 * GET  /api/admin/design-assistant/config            { enabled, prompt?, isDefaultPrompt }
 * PUT  /api/admin/design-assistant/config  (beheerder) { enabled?, prompt? (null = standaard) }
 * POST /api/admin/design-assistant/chat               { courseId, messages, lang } → { reply }
 */
export function registerDesignAssistantRoutes(app, deps) {
  const { supabaseAdmin, authUser, isStaffForCourse, isAdminProfile, chat, buildLanguageInstruction, normalizeLang, apiBase } = deps;

  async function readSetting(name) {
    const { data } = await supabaseAdmin.from('chatbot_prompts').select('id, content').eq('name', name).maybeSingle();
    return data || null;
  }
  async function writeSetting(name, content) {
    const row = await readSetting(name);
    if (content === null) {
      if (row) await supabaseAdmin.from('chatbot_prompts').delete().eq('id', row.id);
      return;
    }
    if (row) await supabaseAdmin.from('chatbot_prompts').update({ content, updated_at: new Date().toISOString() }).eq('id', row.id);
    else await supabaseAdmin.from('chatbot_prompts').insert({ name, content, is_active: false });
  }
  async function enabled() {
    const row = await readSetting(ENABLED_KEY);
    return row ? row.content !== 'false' : true;
  }
  async function profileOf(userId) {
    const { data } = await supabaseAdmin.from('profiles').select('role, email').eq('id', userId).maybeSingle();
    return data || null;
  }

  app.get('/api/admin/design-assistant/config', async (req, res) => {
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const profile = await profileOf(auth.user.id);
      const isAdmin = isAdminProfile(profile);
      const out = { enabled: await enabled(), isAdmin };
      if (isAdmin) {
        const p = await readSetting(PROMPT_KEY);
        out.prompt = p?.content || DEFAULT_DESIGN_ASSISTANT_PROMPT;
        out.isDefaultPrompt = !p?.content;
      }
      return res.json(out);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/design-assistant/config', async (req, res) => {
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      if (!isAdminProfile(await profileOf(auth.user.id))) return res.status(403).json({ error: 'Alleen de beheerder kan de Ontwerphulp aanpassen' });
      const { enabled: en, prompt } = req.body || {};
      if (typeof en === 'boolean') await writeSetting(ENABLED_KEY, en ? 'true' : 'false');
      if (prompt === null) await writeSetting(PROMPT_KEY, null);
      else if (typeof prompt === 'string') {
        const p = prompt.trim();
        await writeSetting(PROMPT_KEY, p && p !== DEFAULT_DESIGN_ASSISTANT_PROMPT ? p.slice(0, 20000) : null);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/design-assistant/chat', async (req, res) => {
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId, messages } = req.body || {};
    const lang = normalizeLang(req.body?.lang);
    if (!courseId) return res.status(400).json({ error: 'courseId is vereist' });
    if (!Array.isArray(messages) || !messages.some(m => m?.role === 'user')) return res.status(400).json({ error: 'Stel eerst een vraag.' });
    try {
      const profile = await profileOf(auth.user.id);
      if (!(await isStaffForCourse(auth.user, profile, courseId))) return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      if (!(await enabled())) return res.status(403).json({ error: 'De Ontwerphulp staat uit.' });
      const role = isAdminProfile(profile) ? 'admin' : 'docent';

      // Stand van de cursus via dezelfde routes als het beheer (met het token
      // van de docent). Een onderdeel dat mislukt, wordt overgeslagen.
      const headers = { Authorization: req.headers.authorization || '' };
      const get = async (p) => {
        try {
          const r = await fetch(`${apiBase()}${p}`, { headers });
          return r.ok ? await r.json() : null;
        } catch { return null; }
      };
      const [readiness, mixRes, ragSettings, courseRow, projectRows] = await Promise.all([
        get(`/api/admin/course-readiness/${encodeURIComponent(courseId)}`),
        get(`/api/quiz-sources-mix/${encodeURIComponent(courseId)}`),
        get(`/api/rag-settings?courseId=${encodeURIComponent(courseId)}`),
        supabaseAdmin.from('courses').select('name, description, is_active, student_visible, features').eq('id', courseId).maybeSingle()
          .then(r => (r.error ? supabaseAdmin.from('courses').select('name, description, is_active, student_visible').eq('id', courseId).maybeSingle() : r))
          .then(r => r.data),
        supabaseAdmin.from('projects').select('id, title, research_question, submissions_enabled').eq('course_id', courseId).then(r => r.data || []),
      ]);
      let projects = projectRows;
      if (projects.length) {
        const { data: personas } = await supabaseAdmin.from('project_personas')
          .select('project_id, name, persona_type, reputation_enabled, max_reviews').in('project_id', projects.map(p => p.id));
        projects = projects.map(p => ({ ...p, personas: (personas || []).filter(x => x.project_id === p.id) }));
      }
      const courseSummary = summarizeCourse({ course: courseRow, readiness, quizMix: mixRes?.mix || null, ragSettings, projects }, loadLocale());
      const adminPrompt = (await readSetting(PROMPT_KEY))?.content || '';
      const built = buildDesignAssistantMessages({
        adminPrompt,
        knowledge: loadLeapKnowledge(role),
        courseSummary,
        messages,
        languageInstruction: buildLanguageInstruction(lang),
        place: describePlace(req.body?.context, loadLocale()),
      });
      const reply = await chat(built);
      if (!reply) return res.status(502).json({ error: 'De Ontwerphulp gaf geen antwoord. Probeer het opnieuw.' });
      return res.json({ reply });
    } catch (err) {
      console.error('[design-assistant]', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
