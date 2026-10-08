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
//   3. de handleiding (docs/handleiding/handleiding.html), voor het waarom;
//   4. de actuele stand van de cursus, via dezelfde routes die het beheer
//      zelf gebruikt (met het token van de docent, dus met diens rechten).
// De kennisbank van het CTL komt later als vijfde bron.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * De onderdelen van het beheer. `audience`: 'all' = docent en beheerder,
 * 'admin' = alleen beheerder. `helpGroups`: groepen hulpteksten (help.<groep>.*)
 * die bij dit onderdeel horen. `tab`: waarde van ?tab= in /admin.
 */
export const ADMIN_SECTIONS = [
  { tab: 'material', labelKey: 'admin.tabs.material', audience: 'all', helpGroups: ['material', 'concepts'],
    what: 'Bestanden en websites toevoegen met een doel (leerstof, cursusinformatie, projectmateriaal, alleen delen, alleen docenten), verwerking controleren, begrippen (kernbegrippen, dubbelingen, maximum) en de controle "Klaar voor studenten".' },
  { tab: 'quiz_sources', labelKey: 'admin.tabs.quizSources', audience: 'all', helpGroups: ['quizSources'],
    what: 'Waar quizvragen vandaan komen: cursusmateriaal (RAG), een vraagbank (ShareStats/CSV) of vrij door de AI, met dekking per begrip.' },
  { tab: 'projects_admin', labelKey: 'admin.tabs.projects', audience: 'all', helpGroups: ['projects', 'personas'],
    what: 'Groepsprojecten met persona\'s in drie rollen: begeleider, beoordelaar (rubric, feedbackrondes per product) en rolspeler (simulatie, eventueel met verstandhouding en gedragsregels). Ook persona-sjablonen en inleveren.' },
  { tab: 'course_info', labelKey: 'admin.tabs.courseInfo', audience: 'all', helpGroups: [],
    what: 'Praktische cursusinformatie (rooster, deadlines) die de chat mag gebruiken voor praktische vragen.' },
  { tab: 'learning_levels', labelKey: 'admin.tabs.learningLevels', audience: 'all', helpGroups: ['learningLevels'],
    what: 'Overzicht van de leerniveaus die studenten zelf kiezen (alleen bekijken).' },
  { tab: 'prompts', labelKey: 'admin.tabs.prompts', audience: 'all', helpGroups: ['chatInstructions'],
    what: 'Chat-instructies: toon en aanpak van de tutor in de chat en bij Ik leg uit, eventueel per cursus.' },
  { tab: 'rag_settings', labelKey: 'admin.tabs.ragSettings', audience: 'all', helpGroups: ['searchSensitivity'],
    what: 'Zoekgevoeligheid: hoe ruim de AI passages uit het materiaal meeneemt (Ruim/Gebalanceerd/Streng of eigen drempel), per onderdeel en per cursus.' },
  { tab: 'imports', labelKey: 'admin.tabs.imports', audience: 'all', helpGroups: [],
    what: 'Vraagbanken importeren (onder andere ShareStats).' },
  { tab: 'add_users', labelKey: 'admin.tabs.addUsers', audience: 'all', helpGroups: [],
    what: 'Studenten en docenten aan de cursus toevoegen, ook in bulk.' },
  { tab: 'users', labelKey: 'admin.tabs.users', audience: 'admin', helpGroups: [],
    what: 'Alle gebruikers van LEAP en hun rol.' },
  { tab: 'settings', labelKey: 'admin.tabs.settings', audience: 'admin', helpGroups: [],
    what: 'Systeeminstellingen van LEAP.' },
  { tab: 'documents', labelKey: 'admin.tabs.documents', audience: 'all', helpGroups: [], classic: true,
    what: 'Klassieke weergave: mappen en documenten (vervangen door Cursusmateriaal).' },
  { tab: 'rag_beheer', labelKey: 'admin.tabs.ragBeheer', audience: 'all', helpGroups: [], classic: true,
    what: 'Klassieke weergave: verwerking van documenten (vervangen door Cursusmateriaal).' },
  { tab: 'concepts', labelKey: 'admin.tabs.concepts', audience: 'all', helpGroups: [], classic: true,
    what: 'Klassieke weergave: begrippenlijst (ook bereikbaar via Cursusmateriaal → Begrippen).' },
];

/** Buiten de tabbladen van /admin, maar wel relevant voor het inrichten. */
export const OTHER_PAGES = [
  { path: '(zijpaneel in heel Beheer)', label: 'Ontwerphulp', helpGroups: ['designAssistant'],
    what: 'Dit gesprek zelf: een zijpaneel dat open blijft terwijl de docent tussen onderdelen wisselt. Links in je antwoorden openen het onderdeel achter het paneel.' },
  { path: '/admin/courses', label: 'Cursussen beheren', what: 'Cursussen aanmaken, leden beheren, beschikbaar maken voor studenten.' },
  { path: '/projects', label: 'Projectruimte', what: 'De werkplek van een groep. Alleen de groepsleden zien wat daar gebeurt; docenten niet (privacy). Docenten zien in Projecten alleen wie in welke groep zit. Het contact met een rolspeler herstellen en extra gesprekken toekennen kan alleen een beheerder.' },
];

// ── Bronnen inlezen (met cache op wijzigingstijd) ─────────────────────────────
const fileCache = new Map();
function readCached(rel) {
  const p = path.join(ROOT, rel);
  try {
    const st = fs.statSync(p);
    const hit = fileCache.get(p);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    const text = fs.readFileSync(p, 'utf8');
    fileCache.set(p, { mtime: st.mtimeMs, text });
    return text;
  } catch {
    return null;
  }
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

/** Pure: hulpteksten per groep uit een locale-object. */
export function helpTextsByGroup(locale) {
  const groups = {};
  for (const [k, v] of Object.entries(locale || {})) {
    const m = k.match(/^help\.([^.]+)\.([^.]+)\.(title|body)$/);
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
export function buildLeapKnowledge({ locale, handbookText, role }) {
  const help = helpTextsByGroup(locale);
  const label = (key) => (locale && locale[key]) || key;
  const lines = ['# LEAP — onderdelen van het beheer (actueel)'];
  lines.push(`De gebruiker is ${role === 'admin' ? 'BEHEERDER (mag alles)' : 'DOCENT (onderdelen gemarkeerd "alleen beheerder" kan deze gebruiker niet zelf; verwijs dan naar de beheerder)'}.`);
  lines.push('Link naar een onderdeel altijd als markdown-link met precies dit adres, bijvoorbeeld [Quiz-bronnen](/admin?tab=quiz_sources).');
  for (const s of ADMIN_SECTIONS) {
    const who = s.audience === 'admin' ? ' — ALLEEN BEHEERDER' : '';
    lines.push('', `## ${label(s.labelKey)} (/admin?tab=${s.tab})${who}${s.classic ? ' — klassieke weergave' : ''}`, s.what);
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
  if (handbookText) {
    lines.push('', '# Handleiding voor docenten (achtergrond en werkwijze)', handbookText.slice(0, 60000));
  }
  return lines.join('\n');
}

function loadLocale() {
  const raw = readCached('src/i18n/locales/nl.json');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export function loadLeapKnowledge(role) {
  const locale = loadLocale();
  const handbookText = htmlToText(readCached('docs/handleiding/handleiding.html') || '');
  return buildLeapKnowledge({ locale, handbookText, role });
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
export const DEFAULT_DESIGN_ASSISTANT_PROMPT = `Je bent de Ontwerphulp van LEAP: een ervaren onderwijskundige die docenten helpt hun cursus in LEAP in te richten. Je spreekt de docent aan met "je".

Je werkwijze:
- De docent bepaalt. Jij denkt mee, stelt vragen en doet voorstellen; je legt nooit één didactisch model op. Een docent die al weet wat hij wil, help je kort en praktisch verder.
- Begin bij de bedoeling: wat moeten studenten na de cursus kunnen (leerdoelen, bij voorkeur met een werkwoord dat het denkniveau aangeeft), hoe wordt dat getoetst, en welke activiteiten leiden daarheen. Vraag hier één ding tegelijk naar als het nog niet duidelijk is.
- Constructive alignment: zorg dat leerdoelen, leeractiviteiten in LEAP (chat, Ik leg uit, quiz, projecten met persona's, studiecafé) en toetsing/feedback op elkaar aansluiten. Benoem het als iets niet aansluit.
- Scaffolding: bouw op van ondersteund naar zelfstandig — bijvoorbeeld een begeleider en uitleg op een lager niveau eerst, feedbackrondes op een tussenproduct vóór het eindproduct, en pas daarna een uitdagende simulatie met een rolspeler.
- Wees concreet over LEAP: noem het onderdeel en link ernaar (markdown-link met het adres uit de kennis). Gebruik de actuele stand van de cursus om gericht te adviseren ("je hebt nog geen beoordelaar die bij leerdoel 2 past").
- Noem ALLEEN functies die in de LEAP-kennis hieronder staan. Bestaat iets niet, zeg dat eerlijk en bied een alternatief binnen LEAP. Kan alleen de beheerder iets, zeg dan dat de docent dat aan de beheerder kan vragen.
- Je kunt zelf niets in LEAP veranderen. Bied wel kant-en-klare concepten aan die de docent kan kopiëren: chat-instructies, de instructie voor een persona, gedragsregels voor een rolspeler, een rubric voor een beoordelaar, een indeling van projectfasen. Zet zo'n concept in een kader (codeblok) met een korte kop erboven.
- Als het ontwerp rond is: geef een overzicht als tabel (leerdoel | activiteit in LEAP | feedback/toetsing) en een korte afvinklijst met links.
- Houd antwoorden kort en overzichtelijk. Liever een gerichte vraag dan een lang betoog.
- Over VU-specifiek beleid (toetsbeleid, programmaleerdoelen) heb je nog geen documenten; zeg dat als het ter sprake komt en geef algemene onderwijskundige principes.`;

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
        supabaseAdmin.from('courses').select('name, description, is_active, student_visible').eq('id', courseId).maybeSingle().then(r => r.data),
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
