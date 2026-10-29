import { csvRowToQuizQuestion, parseItembankCsv } from './itembankCsv.js';
import {
  isAdminAuth,
  isCourseTeacher,
  isStaffForCourse,
  requireAdminOrDocent,
  requireAuthUser,
  userHasCourseAccess,
} from '../lib/auth.js';
import {
  AZURE_EMBEDDINGS_READY,
  EMBEDDINGS_NOT_CONFIGURED_MSG,
  OPENAI_EMBEDDINGS_URL,
  embeddingAuthHeaders,
} from '../lib/azureOpenai.js';
import { rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { conceptsHasCourseId, quizSourcesSchemaReady } from '../lib/schemaFlags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { promptsHasSection } from '../prompts/promptStore.js';
import { expandQuery } from '../rag/queryExpansion.js';
import { itembankSourceOrFilter } from './itembankScope.js';

// Task #412: GitHub-proxy dichtgezet. Voorheen open voor anonieme
// internetgebruikers én willekeurige api.github.com-paden (SSRF + gratis
// gebruik van onze GITHUB_TOKEN). Nu: ingelogde gebruiker vereist + strikte
// allowlist (alleen-lezen ShareStats-itembank-endpoints op toegestane repos).
const GITHUB_DEFAULT_REPOS = [{ owner: 'sharestats', repo: 'itembank' }];

let _githubAllowedReposCache = { at: 0, repos: null };

function parseGithubOwnerRepo(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase() };
}

async function getGithubAllowedRepos() {
  const now = Date.now();
  if (_githubAllowedReposCache.repos && now - _githubAllowedReposCache.at < 60000) {
    return _githubAllowedReposCache.repos;
  }
  const set = new Map();
  for (const r of GITHUB_DEFAULT_REPOS) set.set(`${r.owner}/${r.repo}`, r);
  try {
    if (supabaseAdmin) {
      const { data } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('content')
        .like('name', '__quiz_itembank_config%');
      for (const row of data || []) {
        const cfg = parseItembankConfig(row.content);
        const parsed = cfg && parseGithubOwnerRepo(cfg.repositoryUrl);
        if (parsed) set.set(`${parsed.owner}/${parsed.repo}`, parsed);
      }
    }
  } catch (err) {
    console.warn('[github-proxy] Kon toegestane repos niet laden:', err.message);
  }
  const repos = Array.from(set.values());
  _githubAllowedReposCache = { at: now, repos };
  return repos;
}

// Per-cursus ItemBank-bronconfiguratie (Task #334, stap 5). De globale bron
// blijft in `__quiz_itembank_config__` (admin-only); een cursus mag een eigen
// bron-override hebben in `__quiz_itembank_config_<courseId>__`. Net als de
// chat-prompt-override: section='internal' + is_active=false zodat geen enkele
// prompt-resolver de rij oppikt. De waarde is JSON {repositoryUrl,lastSyncedAt}.
const ITEMBANK_CONFIG_GLOBAL_KEY = '__quiz_itembank_config__';

const ITEMBANK_CONFIG_KEY_PREFIX = '__quiz_itembank_config_';

function itembankConfigKey(courseId) {
  return `${ITEMBANK_CONFIG_KEY_PREFIX}${courseId}__`;
}

function parseItembankConfig(content) {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.repositoryUrl === 'string' && parsed.repositoryUrl.trim()) {
      return { repositoryUrl: parsed.repositoryUrl, lastSyncedAt: parsed.lastSyncedAt };
    }
  } catch { /* ongeldige JSON → geen config */ }
  return null;
}

async function loadGlobalItembankConfig() {
  try {
    const { data } = await supabaseAdmin
      .from('chatbot_prompts')
      .select('content')
      .eq('name', ITEMBANK_CONFIG_GLOBAL_KEY)
      .maybeSingle();
    return parseItembankConfig(data?.content);
  } catch (err) {
    console.warn('[itembank-config] Kon globale config niet laden:', err.message);
    return null;
  }
}

// ---- Endpoint: ItemBank-mapping-suggesties via embeddings -------------------
// Voor een gegeven concept (naam + optionele definitie) ranken we alle
// itembank-secties op cosine-similarity en geven we de top-N terug.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function fetchOpenAIEmbeddings(texts) {
  if (!AZURE_EMBEDDINGS_READY) throw new Error(EMBEDDINGS_NOT_CONFIGURED_MSG);
  const response = await fetch(OPENAI_EMBEDDINGS_URL, {
    method: 'POST',
    headers: embeddingAuthHeaders(),
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Azure embeddings error: ${err}`);
  }
  const data = await response.json();
  return (data.data || []).map(d => d.embedding);
}

export function registerItembankRoutes(app) {
  app.get('/api/github/*path', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const token = process.env.GITHUB_TOKEN;

    // In Express 5 levert `*path` een array van (gedecodeerde) segmenten op; in
    // Express 4 een string. Normaliseer naar één pad en strip een trailing slash
    // (fetchGitHubDirectory('') stuurt `.../contents/`).
    const rawPath = req.params.path;
    const joined = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
    const path = joined.replace(/\/+$/, '');
    const segments = path.split('/');

    // Weiger lege, dot- en traversal-segmenten. Decodeer elk segment zelf zodat
    // ook geëncodeerde varianten (%2e%2e, %2f) worden gevangen, ongeacht of
    // Express al gedecodeerd heeft.
    for (const seg of segments) {
      let dec;
      try { dec = decodeURIComponent(seg); } catch { return res.status(400).json({ error: 'Ongeldig pad' }); }
      if (dec === '' || dec === '.' || dec === '..' || dec.includes('/') || dec.includes('\\')) {
        return res.status(400).json({ error: 'Ongeldig pad' });
      }
    }

    // Alleen 3 alleen-lezen vormen toestaan:
    //   repos/{owner}/{repo}
    //   repos/{owner}/{repo}/contents[/{...}]
    //   repos/{owner}/{repo}/git/trees/{branch}
    const shape = path.match(/^repos\/([^/]+)\/([^/]+)(?:\/(contents(?:\/.+)?|git\/trees\/[^/]+))?$/);
    if (!shape) {
      return res.status(400).json({ error: 'Alleen-lezen ShareStats-endpoints toegestaan' });
    }
    const owner = shape[1].toLowerCase();
    const repo = shape[2].toLowerCase();
    const allowed = await getGithubAllowedRepos();
    if (!allowed.some((r) => r.owner === owner && r.repo === repo)) {
      return res.status(403).json({ error: 'Repository niet toegestaan' });
    }

    // Alleen `ref` en `recursive` uit de query overnemen, streng gevalideerd —
    // de rauwe query-string wordt bewust niet doorgestuurd.
    const outParams = new URLSearchParams();
    const ref = req.query.ref;
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) {
        return res.status(400).json({ error: 'Ongeldige ref-parameter' });
      }
      outParams.set('ref', ref);
    }
    const recursive = req.query.recursive;
    if (recursive !== undefined) {
      if (recursive === '1' || recursive === 'true') outParams.set('recursive', '1');
      else return res.status(400).json({ error: 'Ongeldige recursive-parameter' });
    }

    // Bouw de doel-URL via new URL() en verifieer dat het pad binnen de repo
    // blijft (extra verdediging tegen path-normalisatie-trucs).
    let target;
    try {
      target = new URL(`https://api.github.com/${path}`);
    } catch {
      return res.status(400).json({ error: 'Ongeldig pad' });
    }
    const prefix = `/repos/${shape[1]}/${shape[2]}`;
    if (target.pathname !== prefix && !target.pathname.startsWith(prefix + '/')) {
      return res.status(400).json({ error: 'Ongeldig pad' });
    }
    target.search = outParams.toString();

    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'EpiLearning-App',
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    try {
      const response = await fetch(target.toString(), { headers });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (err) {
      console.error('[/api/github] Error:', err);
      res.status(500).json({ error: 'GitHub proxy error' });
    }
  });

  app.get('/api/admin/itembank-config', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.query;
    try {
      const global = await loadGlobalItembankConfig();
      if (!courseId) {
        if (!isAdminAuth(auth)) return res.status(403).json({ error: 'Onvoldoende rechten' });
        return res.json({
          scope: 'global',
          hasOverride: !!global,
          repositoryUrl: global?.repositoryUrl || '',
          lastSyncedAt: global?.lastSyncedAt,
          globalRepositoryUrl: global?.repositoryUrl || '',
        });
      }
      if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
        return res.status(403).json({ error: 'Onvoldoende rechten' });
      }
      const { data: row } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('content')
        .eq('name', itembankConfigKey(courseId))
        .maybeSingle();
      const override = parseItembankConfig(row?.content);
      const effective = override || global;
      return res.json({
        scope: 'course',
        hasOverride: !!override,
        repositoryUrl: effective?.repositoryUrl || '',
        lastSyncedAt: effective?.lastSyncedAt,
        globalRepositoryUrl: global?.repositoryUrl || '',
      });
    } catch (err) {
      console.error('[/api/admin/itembank-config GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/itembank-config', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, repositoryUrl, lastSyncedAt } = req.body || {};
    if (typeof repositoryUrl !== 'string' || !repositoryUrl.trim()) {
      return res.status(400).json({ error: 'repositoryUrl (niet-leeg) vereist' });
    }
    if (courseId) {
      if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
        return res.status(403).json({ error: 'Onvoldoende rechten' });
      }
    } else if (!isAdminAuth(auth)) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    const key = courseId ? itembankConfigKey(courseId) : ITEMBANK_CONFIG_GLOBAL_KEY;
    const content = JSON.stringify({ repositoryUrl: repositoryUrl.trim(), lastSyncedAt });
    try {
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts').select('id').eq('name', key).maybeSingle();
      if (existing) {
        const { error: updErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, is_active: false, updated_at: new Date().toISOString() })
          .eq('name', key);
        if (updErr) throw new Error(`DB update mislukt: ${updErr.message}`);
      } else {
        const insertRow = { name: key, content, is_active: false };
        if (promptsHasSection) insertRow.section = 'internal';
        const { error: insErr } = await supabaseAdmin
          .from('chatbot_prompts').insert(insertRow);
        if (insErr) throw new Error(`DB insert mislukt: ${insErr.message}`);
      }
      console.log(`[itembank-config PUT] Saved ${courseId ? `courseId=${courseId}` : 'global'} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/itembank-config PUT] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/itembank-config/:courseId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { error: delErr } = await supabaseAdmin
        .from('chatbot_prompts').delete().eq('name', itembankConfigKey(courseId));
      if (delErr) throw new Error(`DB delete mislukt: ${delErr.message}`);
      console.log(`[itembank-config DELETE] Removed override for courseId=${courseId} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/itembank-config DELETE] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoints: itembank-mappings (concept ↔ exsection_path) ----------------
  app.get('/api/admin/itembank-mappings/:courseId', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('concept_itembank_sections')
        .select('id, concept_id, course_id, exsection_path, created_at')
        .or(`course_id.eq.${courseId},course_id.is.null`);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ mappings: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/itembank-mappings/:courseId', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    const { mappings } = req.body || {};
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ error: 'mappings moet een array zijn' });
    }
    // Vervang alle mappings voor deze cursus.
    try {
      await supabaseAdmin
        .from('concept_itembank_sections')
        .delete()
        .eq('course_id', courseId);
      const rows = mappings
        .filter(m => m && m.concept_id && Array.isArray(m.exsection_path) && m.exsection_path.length > 0)
        .map(m => ({
          concept_id: m.concept_id,
          course_id: courseId,
          exsection_path: m.exsection_path,
          created_by: auth.user.id,
        }));
      if (rows.length > 0) {
        const { error } = await supabaseAdmin.from('concept_itembank_sections').insert(rows);
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true, saved: rows.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: auto-koppel ShareStats-imports aan begrippen in een cursus --
  // Na een ShareStats-import bevatten de items een `exsection_path` (bv.
  // ["Probability","ConditionalProbability"]). Studenten kunnen die items pas
  // als quiz oefenen wanneer er een `concepts`-rij bestaat in hun cursus die
  // via `concept_itembank_sections` aan dat pad gekoppeld is. Deze endpoint
  // doet dat volautomatisch voor de top-level segmenten die door de import
  // zijn aangeleverd: per segment een begrip aanmaken (als het nog niet
  // bestaat) en een 1-op-1 mapping leggen op `[segment]`.
  app.post('/api/admin/sharestats/auto-link-concepts', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    // Twee modi:
    //  - `selectedTopics`: lijst van GitHub-folder-namen die de docent zojuist
    //    heeft geïmporteerd. Server zoekt zélf de echte exsection_path[0]-
    //    waarden op in quiz_questions zodat we niets missen wanneer items
    //    al eerder waren geïmporteerd (skip-pad geeft anders een lege set).
    //  - `topSegments` (legacy): expliciete lijst van top-level
    //    exsection-segmenten. Behouden voor backwards-compat.
    const { courseId, topSegments, selectedTopics } = req.body || {};
    const hasSelected = Array.isArray(selectedTopics) && selectedTopics.length > 0;
    const hasSegments = Array.isArray(topSegments) && topSegments.length > 0;
    if (!courseId || (!hasSelected && !hasSegments)) {
      return res.status(400).json({ error: 'courseId en (niet-lege selectedTopics of topSegments) vereist' });
    }
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }

    // Engelse folder/segment-naam → leesbare Nederlandse begrip-naam.
    // Onbekende segmenten worden netjes genormaliseerd (koppeltekens en
    // underscores naar spaties, eerste letter hoofdletter) zodat ook nieuwe
    // ShareStats-topics een fatsoenlijk label krijgen zonder code-wijziging.
    const SEGMENT_TRANSLATIONS = {
      Probability: 'Kansrekening',
      ConditionalProbability: 'Voorwaardelijke kans',
      ElementaryProbability: 'Elementaire kans',
      Events: 'Gebeurtenissen',
      SampleSpace: 'Uitkomstenruimte',
      ExpectedValue: 'Verwachte waarde',
      Variance: 'Variantie',
      StandardDeviation: 'Standaardafwijking',
      Distributions: 'Verdelingen',
      NormalDistribution: 'Normale verdeling',
      BinomialDistribution: 'Binomiale verdeling',
      Assumptions: 'Aannames',
      Reliability: 'Betrouwbaarheid',
      'Descriptive-statistics': 'Beschrijvende statistiek',
      'Inferential_Statistics': 'Inferentiële statistiek',
      'Inferential-Statistics': 'Inferentiële statistiek',
      'Factor-analysis': 'Factoranalyse',
      'Measurement-Level': 'Meetniveau',
      'Variable-type': 'Variabele type',
      Union: 'Vereniging',
    };
    function humanizeSegment(seg) {
      if (SEGMENT_TRANSLATIONS[seg]) return SEGMENT_TRANSLATIONS[seg];
      const spaced = String(seg).replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
      if (!spaced) return seg;
      return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
    }

    // Bouw een lijst van { topic, segments[] }-paren waar het endpoint
    // op gaat werken. Per topic krijg je één begrip; alle gevonden
    // exsection-segmenten worden daaraan gekoppeld zodat álle vragen
    // van dat topic zichtbaar worden in Quiz, ongeacht hoe diep hun
    // exsection-pad is gecodeerd.
    const topicJobs = [];
    if (hasSelected) {
      const cleanTopics = [...new Set(selectedTopics.map(s => String(s || '').trim()).filter(Boolean))];
      for (const topic of cleanTopics) {
        // Haal de werkelijk in de database aanwezige exsection-paden op voor
        // dit topic. We pakken álle items (mcq én open) van source=sharestats.
        const { data: rows, error: qErr } = await supabaseAdmin
          .from('quiz_questions')
          .select('exsection_path')
          .eq('source', 'sharestats')
          .eq('topic', topic);
        if (qErr) {
          console.error('[auto-link] Kon exsection-paden niet ophalen voor topic', topic, qErr);
        }
        const segs = new Set();
        for (const row of rows || []) {
          const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
          if (path.length > 0 && path[0]) segs.add(String(path[0]).trim());
        }
        // Fallback: nog geen items in de DB? Toch alvast het concept met
        // mapping op de foldernaam aanmaken zodat een latere import
        // automatisch in de quiz verschijnt.
        if (segs.size === 0) segs.add(topic);
        topicJobs.push({ topic, segments: [...segs] });
      }
    } else {
      // Legacy-pad: één topic-job per top-segment, label = segment zelf.
      const segs = [...new Set(topSegments.map(s => String(s || '').trim()).filter(Boolean))];
      for (const seg of segs) topicJobs.push({ topic: seg, segments: [seg] });
    }

    if (topicJobs.length === 0) {
      return res.json({ created: 0, linked: 0, conceptsByTopic: {} });
    }

    try {
      let created = 0;
      let linked = 0;
      const conceptsByTopic = {};

      // Bestaande concepten in deze cursus ophalen (zowel course_id-pad als
      // key_points-fallback) zodat we case-insensitive op naam kunnen matchen.
      const courseMarker = `[RAG-geëxtraheerd uit cursusmateriaal]`;
      let existingForCourse = [];
      if (conceptsHasCourseId) {
        const { data, error } = await supabaseAdmin
          .from('concepts')
          .select('id, name')
          .eq('course_id', courseId);
        if (error) throw error;
        existingForCourse = data || [];
      } else {
        // Fallback: alle concepts ophalen, filteren op course-marker.
        const { data, error } = await supabaseAdmin
          .from('concepts')
          .select('id, name, key_points');
        if (error) throw error;
        existingForCourse = (data || []).filter(c => (c.key_points || []).includes(`course_id:${courseId}`));
      }
      const byNameLc = new Map(existingForCourse.map(c => [String(c.name || '').toLowerCase().trim(), c]));

      for (const job of topicJobs) {
        const dutchName = humanizeSegment(job.topic);
        const key = dutchName.toLowerCase().trim();
        let concept = byNameLc.get(key);

        // Begrip aanmaken als het nog niet bestaat.
        if (!concept) {
          const insertRow = conceptsHasCourseId
            ? {
                name: dutchName,
                definition: `Begrip automatisch aangemaakt vanuit ShareStats-import (topic "${job.topic}"). Vul de definitie aan via de begrippen-beheerpagina.`,
                key_points: ['[Geïmporteerd vanuit ShareStats]'],
                examples: [],
                course_id: courseId,
              }
            : {
                name: dutchName,
                definition: `Begrip automatisch aangemaakt vanuit ShareStats-import (topic "${job.topic}"). Vul de definitie aan via de begrippen-beheerpagina.`,
                key_points: [`course_id:${courseId}`, '[Geïmporteerd vanuit ShareStats]'],
                examples: [],
              };
          const { data: ins, error: insErr } = await supabaseAdmin
            .from('concepts')
            .insert(insertRow)
            .select('id, name')
            .single();
          if (insErr) {
            console.error('[auto-link] Begrip aanmaken mislukt voor', job.topic, insErr);
            continue;
          }
          concept = ins;
          created++;
          byNameLc.set(key, concept);
        }

        // Voor elk gevonden exsection-segment één mapping leggen via blinde
        // insert. De UNIQUE-constraint (concept_id, exsection_path) garandeert
        // idempotentie: een tweede aanroep met hetzelfde segment gooit een
        // duplicate-key fout, die we als "bestond al" interpreteren —
        // `linked` telt dus alléén daadwerkelijk nieuwe koppelingen.
        const mappedSegments = [];
        for (const seg of job.segments) {
          const { error: mapErr } = await supabaseAdmin
            .from('concept_itembank_sections')
            .insert({
              concept_id: concept.id,
              course_id: courseId,
              exsection_path: [seg],
              created_by: auth.user.id,
            });
          if (mapErr) {
            if (!/duplicate key|unique constraint|23505/i.test(mapErr.message || '')) {
              console.error('[auto-link] Mapping aanmaken mislukt voor', seg, mapErr);
              continue;
            }
          } else {
            linked++;
          }
          mappedSegments.push(seg);
        }

        conceptsByTopic[job.topic] = {
          conceptId: concept.id,
          conceptName: concept.name,
          mappedSegments,
        };
      }

      return res.json({ created, linked, conceptsByTopic });
    } catch (err) {
      console.error('[auto-link] Onverwachte fout:', err);
      return res.status(500).json({ error: err.message || 'Onbekende fout' });
    }
  });

  // Lijst van unieke exsection_path-waarden in de database — handig voor de
  // docent-UI om uit te kiezen.
  app.get('/api/admin/itembank-sections', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : null;
    if (!courseId) {
      return res.status(400).json({ error: 'courseId is verplicht' });
    }
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('quiz_questions')
        .select('exsection_path, topic, subtopic, item_type')
        .or(itembankSourceOrFilter(courseId))
        .not('exsection_path', 'is', null);
      if (error) return res.status(500).json({ error: error.message });
      const seen = new Map();
      for (const row of data || []) {
        const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
        if (path.length === 0) continue;
        const key = path.join(' / ');
        const entry = seen.get(key) || {
          exsection_path: path,
          count: 0,
          mcq_count: 0,
          open_count: 0,
          topic: row.topic,
          subtopic: row.subtopic,
        };
        entry.count += 1;
        if (row.item_type === 'open') entry.open_count += 1;
        else entry.mcq_count += 1;
        seen.set(key, entry);
      }
      const sections = [...seen.values()].sort((a, b) => a.exsection_path.join('/').localeCompare(b.exsection_path.join('/')));
      return res.json({ sections });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: itembank-vragen ophalen voor quiz ----------------------------
  // Geeft een lijst itembank-vragen terug die matchen op de mappings van de
  // gegeven concepten binnen een cursus. De client doet de mix-coördinatie.
  app.post('/api/quiz/itembank-questions', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, conceptIds = [], limit = 5, questionType = 'mcq' } = req.body || {};
    if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
      return res.status(400).json({ error: 'courseId en niet-lege conceptIds vereist' });
    }
    // ItemBank ondersteunt alleen mcq + open (geen casus). Casus → leeg resultaat.
    const wantedItemType = questionType === 'open' ? 'open' : (questionType === 'mcq' ? 'mcq' : null);
    if (!wantedItemType) {
      return res.json({ questions: [], reason: 'unsupported_question_type' });
    }
    // Cross-course leak voorkomen: itembank-vragen mogen alleen door cursusleden
    // (en admins/superuser) opgehaald worden.
    const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
    if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    if (await rejectIfFeatureOff(res, auth.user, auth.profile, courseId, 'quiz')) return;
    if (!quizSourcesSchemaReady) {
      return res.json({ questions: [], schema_ready: false });
    }
    try {
      // Mappings ophalen voor de concepten.
      const { data: mappings, error: mapErr } = await supabaseAdmin
        .from('concept_itembank_sections')
        .select('concept_id, exsection_path, course_id')
        .in('concept_id', conceptIds)
        .or(`course_id.eq.${courseId},course_id.is.null`);
      if (mapErr) return res.status(500).json({ error: mapErr.message });

      const sectionPaths = (mappings || [])
        .map(m => Array.isArray(m.exsection_path) ? m.exsection_path : null)
        .filter(p => p && p.length > 0);

      if (sectionPaths.length === 0) {
        return res.json({ questions: [], reason: 'no_mappings' });
      }

      // Trek kandidaten zonder exacte-string-prefilter. De ShareStats-bank kent
      // case-varianten ("Inferential Statistics" vs "inferential statistics") en
      // overlaps() in PostgREST is hoofdletter-gevoelig; daarom matchen we
      // hieronder in JS met genormaliseerde (lower-case) paden. 1564 items
      // passen ruim binnen de limit, dus we filteren in-memory.
      // Bronscoping (ShareStats + cursus-eigen CSV) gaat via één `.or()`. Het
      // item_type-filter wordt in-memory toegepast (zie hieronder) zodat we geen
      // tweede `.or()` op dezelfde query stapelen — dat houdt de bronscoping
      // ondubbelzinnig en voorkomt cross-course lekken.
      const candidatesQuery = supabaseAdmin
        .from('quiz_questions')
        .select('id, question_text, answer_options, correct_answer, explanation, sharestats_id, exsection_path, topic, subtopic, item_type, metadata')
        .or(itembankSourceOrFilter(courseId))
        .limit(5000);
      const { data: candidates, error: qErr } = await candidatesQuery;
      if (qErr) return res.status(500).json({ error: qErr.message });

      // item_type-kolom is pas vanaf migratie 20260507130000 aanwezig.
      // Voor mcq: accepteer item_type='mcq' óf NULL (oude rijen zijn historisch
      // mchoice). Voor open: vereis expliciet item_type='open'.
      const itemTypeMatches = (it) => wantedItemType === 'mcq'
        ? (it === 'mcq' || it === null || it === undefined)
        : it === 'open';

      const normalizePath = (p) => (Array.isArray(p) ? p : []).map(s => String(s ?? '').toLowerCase().trim());
      const targetsLower = sectionPaths.map(normalizePath);
      const matches = (candidates || []).filter(q => {
        if (!itemTypeMatches(q.item_type)) return false;
        const qPath = normalizePath(q.exsection_path);
        return targetsLower.some(target => {
          if (qPath.length < target.length) return false;
          for (let i = 0; i < target.length; i++) {
            if (qPath[i] !== target[i]) return false;
          }
          return true;
        });
      });

      // Shuffle en limiteer.
      for (let i = matches.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [matches[i], matches[j]] = [matches[j], matches[i]];
      }
      const picked = matches.slice(0, Math.max(1, Math.min(limit, 50)));

      // Normaliseer naar het frontend-format. Voor open vragen geven we het
      // modelantwoord terug (uit Solution + eventueel exsolution-numeric) plus
      // het R/exams-extype + exsolution + extol, zodat de evaluator kan kiezen
      // tussen numerieke tolerantie-check (extype=num) en tekstuele beoordeling
      // tegen het ShareStats-modelantwoord (Task #67).
      const parseNumberLoose = (raw) => {
        if (raw === null || raw === undefined) return null;
        const s = String(raw).replace(/,/g, '.').trim();
        const m = s.match(/-?\d+(?:\.\d+)?(?:[eE]-?\d+)?/);
        if (!m) return null;
        const n = Number(m[0]);
        return Number.isFinite(n) ? n : null;
      };
      const questions = picked.map(q => {
        const itemType = q.item_type || 'mcq';
        if (itemType === 'open') {
          const meta = (q.metadata && typeof q.metadata === 'object') ? q.metadata : {};
          const extype = String(meta.extype || '').toLowerCase().trim() || undefined;
          const numericSolution = q.correct_answer || '';
          const writtenSolution = q.explanation || '';
          // Bij numerieke vragen houden we het exacte getal apart, zodat de
          // evaluator een echte tolerantie-check kan doen i.p.v. LLM-vergelijking.
          const numericExpected = extype === 'num' ? parseNumberLoose(numericSolution) : null;
          // R/exams `extol` is meestal een absolute tolerantie. Wanneer de
          // metadata een lijst/range bevat, nemen we het grootste positieve
          // verschil als tolerantie — strikt genoeg om vals-positieven te
          // voorkomen en ruim genoeg om afronding op te vangen.
          let numericTolerance = null;
          const extolRaw = meta.extol;
          if (Array.isArray(extolRaw)) {
            const nums = extolRaw.map(parseNumberLoose).filter(n => n !== null && n >= 0);
            if (nums.length > 0) numericTolerance = Math.max(...nums);
          } else if (extolRaw !== undefined && extolRaw !== null && String(extolRaw).trim() !== '') {
            const t = parseNumberLoose(extolRaw);
            if (t !== null && t >= 0) numericTolerance = t;
          }
          // Voor numerieke vragen is `modelAnswer` puur de geschreven uitleg
          // (Solution); het verwachte getal staat al apart in numericExpected.
          // Voor tekst/cloze vallen we terug op de oude samenvoeging zodat de
          // LLM zoveel mogelijk context krijgt.
          const modelAnswer = extype === 'num'
            ? writtenSolution
            : (numericSolution
                ? (writtenSolution ? `${numericSolution}\n\n${writtenSolution}` : numericSolution)
                : writtenSolution);
          return {
            id: `itembank-${q.id}`,
            type: 'open',
            source: 'itembank',
            sharestats_id: q.sharestats_id,
            question: q.question_text,
            modelAnswer,
            explanation: writtenSolution,
            exsection_path: q.exsection_path,
            extype,
            numericExpected: numericExpected ?? undefined,
            numericTolerance: numericTolerance ?? undefined,
          };
        }
        return {
          id: `itembank-${q.id}`,
          type: 'mcq',
          source: 'itembank',
          sharestats_id: q.sharestats_id,
          question: q.question_text,
          options: q.answer_options || {},
          correctAnswer: q.correct_answer,
          explanation: q.explanation || '',
          exsection_path: q.exsection_path,
        };
      });

      return res.json({ questions, total_candidates: matches.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/itembank-mapping-suggestions', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
    }
    const { conceptName, conceptDefinition, courseId, topN = 3 } = req.body || {};
    if (!conceptName || typeof conceptName !== 'string') {
      return res.status(400).json({ error: 'conceptName is verplicht' });
    }
    if (!courseId || typeof courseId !== 'string') {
      return res.status(400).json({ error: 'courseId is verplicht' });
    }
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    // Bound de werkverzameling om timeouts en grote OpenAI-bills te voorkomen
    // bij onverwacht grote itembanks. 800 unieke secties is ruim voldoende voor
    // een cursus en kost ~1 OpenAI-call.
    const MAX_SECTIONS = 800;
    const ITEM_PAGE_LIMIT = 5000;
    try {
      // 1) Verzamel unieke secties met counts. We pagineren lichtjes om geheugen
      // te beperken: pak max ITEM_PAGE_LIMIT records, deduplate naar pad-key,
      // en cap daarna op MAX_SECTIONS (meest voorkomende paden eerst).
      const { data: rows, error: secErr } = await supabaseAdmin
        .from('quiz_questions')
        .select('exsection_path')
        .or(itembankSourceOrFilter(courseId))
        .not('exsection_path', 'is', null)
        .limit(ITEM_PAGE_LIMIT);
      if (secErr) return res.status(500).json({ error: secErr.message });
      const seen = new Map();
      for (const row of rows || []) {
        const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
        if (path.length === 0) continue;
        const key = path.join(' / ');
        const entry = seen.get(key) || { exsection_path: path, count: 0 };
        entry.count += 1;
        seen.set(key, entry);
      }
      let sections = [...seen.values()];
      let sectionsTruncated = false;
      if (sections.length > MAX_SECTIONS) {
        sections.sort((a, b) => b.count - a.count);
        sections = sections.slice(0, MAX_SECTIONS);
        sectionsTruncated = true;
      }
      if (sections.length === 0) return res.json({ suggestions: [], truncated: false });

      // 2) Bereken embeddings: één voor concept, één voor elke sectielabel
      const conceptText = conceptDefinition
        ? `${conceptName}. ${String(conceptDefinition).slice(0, 600)}`
        : conceptName;
      const sectionTexts = sections.map(s => s.exsection_path.join(' / '));
      const allTexts = [conceptText, ...sectionTexts];

      // OpenAI embeddings in chunks van max 100 om limieten te vermijden
      const embeddings = [];
      const CHUNK = 100;
      for (let i = 0; i < allTexts.length; i += CHUNK) {
        const part = await fetchOpenAIEmbeddings(allTexts.slice(i, i + CHUNK));
        embeddings.push(...part);
      }
      const conceptEmb = embeddings[0];
      const ranked = sections.map((s, idx) => ({
        ...s,
        similarity: cosineSimilarity(conceptEmb, embeddings[1 + idx]),
      }));
      ranked.sort((a, b) => b.similarity - a.similarity);
      return res.json({
        suggestions: ranked.slice(0, Math.max(1, Math.min(topN, 10))),
        truncated: sectionsTruncated,
        candidates_evaluated: sections.length,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Diagnose-endpoint: per concept tonen welke ShareStats-secties (case-
  // insensitief, op substring van begripsnaam + queryExpansion-synoniemen +
  // key_points) zouden matchen. Bedoeld om docenten te laten zien waarom een
  // begrip leeg blijft in de itembank en om handmatige mapping-keuzes te
  // ondersteunen — deterministisch, geen embeddings/LLM-call.
  app.post('/api/admin/itembank-mapping-diagnose', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
    }
    const { conceptId, courseId, topN = 5 } = req.body || {};
    if (!conceptId || typeof conceptId !== 'string') {
      return res.status(400).json({ error: 'conceptId is verplicht' });
    }
    if (!courseId || typeof courseId !== 'string') {
      return res.status(400).json({ error: 'courseId is verplicht' });
    }
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    try {
      // 1) Laad begrip (naam + definitie + key_points).
      const { data: concept, error: conceptErr } = await supabaseAdmin
        .from('concepts')
        .select('id, name, definition, key_points, aliases')
        .eq('id', conceptId)
        .maybeSingle();
      if (conceptErr) return res.status(500).json({ error: conceptErr.message });
      if (!concept) return res.status(404).json({ error: 'Begrip niet gevonden' });

      // 2) Huidige mapping(s) voor dit begrip in deze cursus.
      let currentMappings = [];
      if (courseId) {
        const { data: mapRows } = await supabaseAdmin
          .from('concept_itembank_sections')
          .select('exsection_path, course_id')
          .eq('concept_id', conceptId)
          .or(`course_id.eq.${courseId},course_id.is.null`);
        currentMappings = (mapRows || [])
          .map(r => Array.isArray(r.exsection_path) ? r.exsection_path : null)
          .filter(p => p && p.length > 0);
      }

      // 3) Bouw zoek-tokens: begripsnaam + andere namen + key_points + definitie.
      const keyPoints = Array.isArray(concept.key_points)
        ? concept.key_points.filter(kp => typeof kp === 'string' && !kp.startsWith('course_id:') && !kp.startsWith('['))
        : [];
      const expandedNl = expandQuery(concept.name, { definition: concept.definition, keyPoints, aliases: concept.aliases }, 'nl');
      const expandedEn = expandedNl;
      const STOP = new Set(['de','het','een','en','of','in','op','van','met','voor','door','aan','bij','te','dat','dan','als','is','zijn','the','a','an','of','to','in','on','for','and','or','with','by','at','is','are','this','that']);
      const tokens = [...new Set(
        `${expandedNl} ${expandedEn}`
          .toLowerCase()
          .split(/[^a-zà-ÿ0-9-]+/i)
          .map(t => t.trim())
          .filter(t => t.length >= 3 && !STOP.has(t))
      )];

      // 4) Trek alle unieke itembank-secties (cursus-scoped) met counts.
      const { data: rows, error: rowsErr } = await supabaseAdmin
        .from('quiz_questions')
        .select('exsection_path, item_type')
        .or(itembankSourceOrFilter(courseId))
        .not('exsection_path', 'is', null)
        .limit(5000);
      if (rowsErr) return res.status(500).json({ error: rowsErr.message });
      const sectionMap = new Map();
      for (const row of rows || []) {
        const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
        if (path.length === 0) continue;
        const key = path.join(' / ');
        const entry = sectionMap.get(key) || { exsection_path: path, count: 0, mcq_count: 0, open_count: 0 };
        entry.count += 1;
        if (row.item_type === 'open') entry.open_count += 1;
        else entry.mcq_count += 1;
        sectionMap.set(key, entry);
      }
      const sections = [...sectionMap.values()];

      // 5) Score per sectie: aantal unieke tokens dat (substring) voorkomt in
      // de gejoined-lower-case-pad-string. Hits-lijst voor transparantie.
      const ranked = sections.map(s => {
        const haystack = s.exsection_path.join(' / ').toLowerCase();
        const matchedTokens = tokens.filter(tok => haystack.includes(tok));
        return { ...s, matched_tokens: matchedTokens, score: matchedTokens.length };
      })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score || b.count - a.count);

      return res.json({
        concept: { id: concept.id, name: concept.name },
        current_mappings: currentMappings,
        tokens_used: tokens.slice(0, 40),
        tokens_truncated: tokens.length > 40,
        total_sections_scanned: sections.length,
        candidates: ranked.slice(0, Math.max(1, Math.min(topN, 20))),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: automatische bulk-matching begrip ↔ itembank-sectie ---------
  // Berekent in één embedding-pass de semantische gelijkenis tussen ELK begrip
  // van de cursus en ELKE itembank-sectie, en geeft per begrip de top-N secties
  // terug met een vlag of ze boven de drempel liggen. De docent reviewt het
  // voorstel in de UI en slaat de geaccepteerde koppelingen op via het bestaande
  // itembank-mappings-endpoint. Dit endpoint schrijft zelf NIETS weg (dry-run).
  app.post('/api/admin/itembank-bulk-match', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
    }
    const { courseId, threshold = 0.35, topN = 3 } = req.body || {};
    if (!courseId || typeof courseId !== 'string') {
      return res.status(400).json({ error: 'courseId is verplicht' });
    }
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    const MAX_SECTIONS = 800;
    const MAX_CONCEPTS = 400;
    const ITEM_PAGE_LIMIT = 5000;
    const thr = Math.max(0, Math.min(1, Number(threshold) || 0.35));
    const top = Math.max(1, Math.min(Number(topN) || 3, 8));
    try {
      // 1) Begrippen van de cursus (zelfde filter als de admin-UI). Schema-bewust:
      // de kolom concepts.course_id bestaat niet in elke database — vraag haar
      // alleen op wanneer aanwezig (conceptsHasCourseId) en val anders terug op de
      // course_id:<uuid>-markering in key_points (nooit begrippen zonder cursus).
      const conceptSelect = conceptsHasCourseId
        ? 'id, name, definition, key_points, course_id'
        : 'id, name, definition, key_points';
      const { data: conceptRows, error: cErr } = await supabaseAdmin
        .from('concepts')
        .select(conceptSelect)
        .order('name');
      if (cErr) return res.status(500).json({ error: cErr.message });
      const marker = `course_id:${courseId}`;
      const concepts = (conceptRows || []).filter(c => {
        if (conceptsHasCourseId && c.course_id === courseId) return true;
        if (Array.isArray(c.key_points) && c.key_points.includes(marker)) return true;
        return false; // begrippen blijven binnen hun cursus
      }).slice(0, MAX_CONCEPTS);
      if (concepts.length === 0) return res.json({ results: [], threshold: thr, sections_evaluated: 0, truncated: false });

      // 2) Huidige mappings voor de cursus (om al-gekoppelde te markeren).
      const { data: mapRows } = await supabaseAdmin
        .from('concept_itembank_sections')
        .select('concept_id, exsection_path, course_id')
        .or(`course_id.eq.${courseId},course_id.is.null`);
      const currentByConcept = new Map();
      for (const m of mapRows || []) {
        if (!Array.isArray(m.exsection_path) || m.exsection_path.length === 0) continue;
        const arr = currentByConcept.get(m.concept_id) || [];
        arr.push(m.exsection_path);
        currentByConcept.set(m.concept_id, arr);
      }

      // 3) Unieke itembank-secties (cursus-scoped) met counts.
      const { data: rows, error: secErr } = await supabaseAdmin
        .from('quiz_questions')
        .select('exsection_path, item_type')
        .or(itembankSourceOrFilter(courseId))
        .not('exsection_path', 'is', null)
        .limit(ITEM_PAGE_LIMIT);
      if (secErr) return res.status(500).json({ error: secErr.message });
      const seen = new Map();
      for (const row of rows || []) {
        const path = Array.isArray(row.exsection_path) ? row.exsection_path : [];
        if (path.length === 0) continue;
        const key = path.join(' / ');
        const entry = seen.get(key) || { exsection_path: path, count: 0, mcq_count: 0, open_count: 0 };
        entry.count += 1;
        if (row.item_type === 'open') entry.open_count += 1; else entry.mcq_count += 1;
        seen.set(key, entry);
      }
      let sections = [...seen.values()];
      let truncated = false;
      if (sections.length > MAX_SECTIONS) {
        sections.sort((a, b) => b.count - a.count);
        sections = sections.slice(0, MAX_SECTIONS);
        truncated = true;
      }
      if (sections.length === 0) return res.json({ results: [], threshold: thr, sections_evaluated: 0, truncated: false });

      // 4) Embeddings: één per begrip + één per sectie, in één gebatchte reeks.
      const conceptTexts = concepts.map(c => c.definition
        ? `${c.name}. ${String(c.definition).slice(0, 600)}`
        : c.name);
      const sectionTexts = sections.map(s => s.exsection_path.join(' / '));
      const allTexts = [...conceptTexts, ...sectionTexts];
      const embeddings = [];
      const CHUNK = 100;
      for (let i = 0; i < allTexts.length; i += CHUNK) {
        const part = await fetchOpenAIEmbeddings(allTexts.slice(i, i + CHUNK));
        embeddings.push(...part);
      }
      const conceptEmbs = embeddings.slice(0, concepts.length);
      const sectionEmbs = embeddings.slice(concepts.length);

      // 5) Per begrip: rank secties, neem top-N, markeer boven drempel.
      const results = concepts.map((c, ci) => {
        const ranked = sections.map((s, si) => ({
          exsection_path: s.exsection_path,
          count: s.count,
          mcq_count: s.mcq_count,
          open_count: s.open_count,
          similarity: cosineSimilarity(conceptEmbs[ci], sectionEmbs[si]),
        })).sort((a, b) => b.similarity - a.similarity);
        const current = currentByConcept.get(c.id) || [];
        const currentKeys = new Set(current.map(p => p.join('/')));
        const candidates = ranked.slice(0, top).map(r => ({
          ...r,
          above_threshold: r.similarity >= thr,
          already_linked: currentKeys.has(r.exsection_path.join('/')),
        }));
        return {
          conceptId: c.id,
          conceptName: c.name,
          currentMappings: current,
          candidates,
        };
      });
      return res.json({ results, threshold: thr, sections_evaluated: sections.length, truncated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: CSV-import van itembank-vragen (bron-agnostisch) -------------
  // Laat docenten een eigen vragenbank als CSV aanleveren. De items komen met
  // source='csv_import' in quiz_questions, met een exsection_path dat met het
  // cursuslabel is genamespaced zodat secties niet botsen met die van andere
  // cursussen. Daarna zijn ze koppelbaar (incl. bulk-match) en komen ze via de
  // mix in studentquizzes.
  app.post('/api/admin/itembank/import-csv', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar' });
    }
    const { courseId, csvText, courseLabel } = req.body || {};
    if (!courseId || typeof courseId !== 'string') {
      return res.status(400).json({ error: 'courseId is verplicht' });
    }
    if (typeof csvText !== 'string' || csvText.trim().length === 0) {
      return res.status(400).json({ error: 'csvText is verplicht' });
    }
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    // Begrens omvang om geheugen/timeouts te beschermen (~2 MB CSV).
    if (csvText.length > 2_000_000) {
      return res.status(413).json({ error: 'CSV te groot (max ~2 MB)' });
    }
    try {
      const { records, errors, totalRows } = parseItembankCsv(csvText);
      if (records.length === 0) {
        return res.status(400).json({
          error: 'Geen geldige rijen gevonden in de CSV.',
          errors: errors.slice(0, 50),
          totalRows,
        });
      }
      const label = (typeof courseLabel === 'string' && courseLabel.trim()) ? courseLabel.trim().slice(0, 60) : null;
      const rows = records.map(r => csvRowToQuizQuestion(r, {
        sourceLabel: 'csv_import',
        courseLabel: label,
        courseId,
        createdBy: auth.user.id,
      }));
      let imported = 0;
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const { error } = await supabaseAdmin.from('quiz_questions').insert(slice);
        if (error) return res.status(500).json({ error: error.message, imported });
        imported += slice.length;
      }
      return res.json({
        imported,
        skipped: errors.length,
        errors: errors.slice(0, 50),
        totalRows,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
