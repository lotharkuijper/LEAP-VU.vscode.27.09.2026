import { createClient } from '@supabase/supabase-js';
import {
  buildExplainUserMessage,
  cleanKeyPoints,
  explainFeedbackMarkdown,
  explainFormatInstruction,
  parseExplainFeedback,
  rankRelatedConcepts,
} from './explainFeedback.js';
import { registerFlawedExplanationRoutes } from './flawedExplanations.js';
import { resolveJournalCourseId } from '../journal/journalCourse.js';
import { journalFieldsFromModel, journalFormatInstruction } from '../journal/journalSections.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { isStaffForCourse, requireAuthUser, userCache, userHasCourseAccess } from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { courseRagFolderIds } from '../lib/courseData.js';
import { courseFeatureOnFor, rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { conceptsHasCourseId } from '../lib/schemaFlags.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from '../lib/supabase.js';
import { TURN_SECRET } from '../lib/turnSigning.js';
import { resolveChatPromptMode } from '../prompts/promptStore.js';
import { searchChunksServerSide } from '../rag/search.js';

// "Verbeter deze uitleg" (server/flawedExplanations.js): oefening ter plekke
// gemaakt en blind gecontroleerd; niets bewaard behalve een dagboekreflectie op verzoek.
async function flawedChunksFor(concept, courseId) {
  const out = [];
  const seen = new Set();
  const { data: ev } = await supabaseAdmin.from('concept_evidence')
    .select('chunk_id, document_id, similarity').eq('concept_id', concept.id)
    .order('similarity', { ascending: false }).limit(12);
  const ids = [...new Set((ev || []).map(e => e.chunk_id).filter(Boolean))].slice(0, 6);
  if (ids.length) {
    const { data: rows } = await supabaseAdmin.from('document_chunks').select('id, content, document_id').in('id', ids);
    for (const id of ids) {
      const r = (rows || []).find(x => x.id === id);
      if (r?.content && !seen.has(r.id)) { seen.add(r.id); out.push({ id: r.id, content: r.content, documentId: r.document_id }); }
    }
  }
  if (out.length < 6 && courseId) {
    const folders = await courseRagFolderIds(courseId);
    const q = [concept.name, concept.definition || ''].filter(Boolean).join('. ');
    const { matched } = await searchChunksServerSide(q, 0.3, 6, folders, null, 'nl', 'explain');
    for (const m of matched || []) {
      if (out.length >= 6) break;
      if (!seen.has(m.id)) { seen.add(m.id); out.push({ id: m.id, content: m.content, documentId: m.document_id }); }
    }
  }
  const docIds = [...new Set(out.map(c => c.documentId).filter(Boolean))];
  if (docIds.length) {
    const { data: docs } = await supabaseAdmin.from('documents').select('id, title, filename').in('id', docIds);
    const title = new Map((docs || []).map(d => [d.id, d.title || d.filename || '']));
    for (const c of out) c.title = title.get(c.documentId) || '';
  }
  return out;
}

async function flawedLlm(system, user, { effort = 'low', maxTokens = 6000, json = false } = {}) {
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }];
  const r = await openaiChatCompletion({
    model: OPENAI_MODEL,
    messages,
    ...chatModelParams({ temperature: 0.7, maxTokens, reasoningEffort: effort }),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  }, { timeoutMs: 120_000 });
  if (!r.ok) {
    console.warn('[explain/improve] taalmodel-fout', r.status);
    return null;
  }
  return ((await r.json())?.choices?.[0]?.message?.content || '').trim() || null;
}

export function registerExplainRoutes(app) {
  // ============================================================
  // Ik Leg Uit – history, save, delete, archive (naar leerdagboek)
  // ============================================================

  app.get('/api/explain/history', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      // Cursus-scoping (Task #246): alleen uitleg van begrippen uit de actieve
      // cursus tonen. Begrippen zijn cursus-gekoppeld via een echte course_id-kolom
      // (nieuw schema) óf via de key_points-marker `course_id:<uuid>` (fallback).
      // We resolven eerst de begrip-ids van de cursus en filteren de uitleg daarop.
      const courseId = typeof req.query.courseId === 'string' ? req.query.courseId.trim() : '';

      let allowedConceptIds = null; // null = geen cursusfilter
      if (courseId) {
        // Alleen begrippen van deze cursus (begrippen blijven binnen hun cursus).
        if (conceptsHasCourseId) {
          const { data: courseConcepts, error: courseErr } = await supabaseAdmin
            .from('concepts').select('id').eq('course_id', courseId);
          if (courseErr) {
            console.error('[explain/history] cursus-begrip-query fout:', courseErr);
            return res.status(500).json({ error: courseErr.message });
          }
          allowedConceptIds = (courseConcepts || []).map((c) => c.id);
        } else {
          const { data: courseConcepts, error: courseErr } = await supabaseAdmin
            .from('concepts').select('id').contains('key_points', [`course_id:${courseId}`]);
          if (courseErr) {
            console.error('[explain/history] cursus-begrip-query fout:', courseErr);
            return res.status(500).json({ error: courseErr.message });
          }
          allowedConceptIds = (courseConcepts || []).map((c) => c.id);
        }
        // Geen begrippen in deze cursus ⇒ geen uitleg-geschiedenis.
        if (allowedConceptIds.length === 0) {
          return res.json({ items: [] });
        }
      }

      let query = supabaseAdmin
        .from('student_explanations')
        .select('id, concept_id, version, created_at, score, concepts(id, name, category)')
        .eq('student_id', user.id);
      if (allowedConceptIds !== null) {
        query = query.in('concept_id', allowedConceptIds);
      }
      const { data, error } = await query.order('created_at', { ascending: false });

      if (error) {
        console.error('[explain/history] query error:', error);
        return res.status(500).json({ error: error.message });
      }

      const items = (data || []).map(r => ({
        id: r.id,
        conceptId: r.concept_id,
        conceptName: r.concepts?.name || '(onbekend begrip)',
        conceptCategory: r.concepts?.category || null,
        version: r.version || 1,
        createdAt: r.created_at,
        score: typeof r.score?.total === 'number' ? r.score.total : null,
      }));

      return res.json({ items });
    } catch (err) {
      console.error('[explain/history] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  app.get('/api/explain/:id', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { id } = req.params;
      const { data, error } = await supabaseAdmin
        .from('student_explanations')
        .select('id, concept_id, explanation_text, feedback, score, version, created_at, student_id, concepts(id, name, category, definition, key_points)')
        .eq('id', id)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Uitleg niet gevonden' });
      if (data.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

      return res.json({
        id: data.id,
        conceptId: data.concept_id,
        explanationText: data.explanation_text,
        feedback: data.feedback?.content || (typeof data.feedback === 'string' ? data.feedback : null),
        // Vier blokken + score (sinds 2026-10-15; oudere uitleg heeft alleen tekst).
        sections: data.feedback?.sections || null,
        score: typeof data.score?.total === 'number' ? data.score : null,
        version: data.version,
        createdAt: data.created_at,
        concept: data.concepts,
      });
    } catch (err) {
      console.error('[explain GET] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  // (POST /api/explain/save is op 2026-10-15 vervangen door /api/explain/evaluate:
  // de server beoordeelt, scoort en slaat in één stap op.)
  // POST /api/explain/evaluate — "Ik leg uit" beoordelen, uitlezen en opslaan in
  // één stap (server/explainFeedback.js). De server bepaalt de instructie (toon
  // van de docent + vaste blokken en meetlat), de verwante begrippen (alleen
  // goedgekeurde cursusbegrippen uit hetzelfde materiaal) en de score; de browser
  // stuurt alleen de uitleg en de gevonden cursusfragmenten mee.
  app.post('/api/explain/evaluate', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    const {
      conceptId, explanation, courseId = null, lang = 'nl',
      context = '', sources = [], ragStrictMode = false,
    } = req.body || {};
    if (!conceptId || typeof explanation !== 'string' || !explanation.trim()) {
      return res.status(400).json({ error: 'conceptId en explanation zijn vereist' });
    }
    if (explanation.length > 8000) return res.status(400).json({ error: 'Uitleg is te lang (max 8000 tekens)' });

    try {
      const { data: concept, error: cErr } = await supabaseAdmin
        .from('concepts')
        .select('id, name, definition, key_points, course_id')
        .eq('id', conceptId).maybeSingle();
      if (cErr) return res.status(500).json({ error: cErr.message });
      if (!concept) return res.status(404).json({ error: 'Begrip niet gevonden' });
      const scopeCourseId = concept.course_id || courseId || null;
      if (scopeCourseId && !(await userHasCourseAccess(auth.user, auth.profile, scopeCourseId))) {
        return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      }
      if (await rejectIfFeatureOff(res, auth.user, auth.profile, scopeCourseId, 'explain')) return;
      if (await rejectIfFeatureOff(res, auth.user, auth.profile, scopeCourseId, 'explainSelf')) return;

      // Verwante begrippen: goedgekeurde begrippen van dezelfde cursus die in
      // dezelfde cursusfragmenten (of documenten) voorkomen.
      let related = [];
      if (concept.course_id) {
        const [{ data: own }, { data: courseConcepts }] = await Promise.all([
          supabaseAdmin.from('concept_evidence').select('chunk_id, document_id').eq('concept_id', concept.id),
          supabaseAdmin.from('concepts').select('id, name').eq('course_id', concept.course_id).eq('review_status', 'approved'),
        ]);
        const conceptsById = new Map((courseConcepts || []).filter(c => c.id !== concept.id).map(c => [c.id, c]));
        if ((own || []).length && conceptsById.size) {
          const { data: other } = await supabaseAdmin
            .from('concept_evidence').select('concept_id, chunk_id, document_id')
            .eq('course_id', concept.course_id).neq('concept_id', concept.id);
          related = rankRelatedConcepts({ ownEvidence: own, otherEvidence: other, conceptsById, conceptId: concept.id });
        }
      }

      const teacherPrompt = await resolveChatPromptMode('explain', { user: auth.user, profile: auth.profile, courseId: scopeCourseId });
      // Geen leerniveau: bij Ik leg uit beheers je een begrip of niet.
      const system = `${teacherPrompt}${explainFormatInstruction(lang, related.map(r => r.name))}${buildLanguageInstruction(lang)}`;
      const user = buildExplainUserMessage({
        concept,
        keyPoints: cleanKeyPoints(concept.key_points),
        context: typeof context === 'string' ? context.slice(0, 24000) : '',
        sources: Array.isArray(sources) ? sources.slice(0, 12) : [],
        ragStrictMode: ragStrictMode === true,
        explanation: explanation.trim(),
      });

      const r = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
      }, { timeoutMs: 90_000 });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[explain/evaluate] taalmodel-fout', r.status, txt.slice(0, 300));
        return res.status(502).json({ error: 'De feedback kon niet worden gemaakt. Probeer het opnieuw.' });
      }
      const raw = ((await r.json())?.choices?.[0]?.message?.content || '').trim();
      if (!raw) return res.status(502).json({ error: 'De feedback kon niet worden gemaakt. Probeer het opnieuw.' });

      const parsed = parseExplainFeedback(raw, related);
      const content = parsed ? explainFeedbackMarkdown(parsed, lang) : raw;
      const sections = parsed
        ? { feedback: parsed.feedback, related: parsed.related, feedforward: parsed.feedforward }
        : null;
      const score = parsed && parsed.score != null ? { total: parsed.score, reason: parsed.scoreReason } : null;

      // Opslaan: nieuwe versie, oudere uitleg voor dit begrip verdwijnt (zoals voorheen).
      const { data: existing } = await supabaseAdmin
        .from('student_explanations').select('id, version')
        .eq('concept_id', concept.id).eq('student_id', auth.user.id);
      const version = existing && existing.length ? Math.max(...existing.map(x => x.version || 1)) + 1 : 1;
      if (existing && existing.length) {
        const { error: delErr } = await supabaseAdmin
          .from('student_explanations').delete().eq('concept_id', concept.id).eq('student_id', auth.user.id);
        if (delErr) return res.status(500).json({ error: `Kon oudere uitleg niet verwijderen: ${delErr.message}` });
      }
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('student_explanations')
        .insert({
          concept_id: concept.id,
          student_id: auth.user.id,
          explanation_text: explanation.trim(),
          feedback: { content, sections },
          score: score || {},
          version,
        })
        .select('id').single();
      if (insErr) return res.status(500).json({ error: insErr.message });

      return res.json({ id: inserted.id, version, content, sections, score });
    } catch (err) {
      console.error('[explain/evaluate] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  app.delete('/api/explain/:id', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { id } = req.params;
      const { data: row, error: fetchErr } = await supabaseAdmin
        .from('student_explanations')
        .select('id, student_id')
        .eq('id', id)
        .maybeSingle();

      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!row) return res.status(404).json({ error: 'Uitleg niet gevonden' });
      if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

      const { error: delErr } = await supabaseAdmin
        .from('student_explanations')
        .delete()
        .eq('id', id);

      if (delErr) return res.status(500).json({ error: delErr.message });
      console.log(`[explain DELETE] Uitleg ${id} verwijderd door ${user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[explain DELETE] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  // Task #265 — net als bij chat (Task #251) is dit een definitieve delete (geen
  // archief/soft-delete). De canonieke route is /api/explain/delete; de oude
  // /api/explain/archive blijft als alias bestaan zodat oudere clients niet breken.
  app.post(['/api/explain/delete', '/api/explain/archive'], async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { explanationId, generateSummary = true, lang = 'nl', courseId } = req.body;
    if (!explanationId) return res.status(400).json({ error: 'explanationId is vereist' });

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: row, error: fetchErr } = await supabaseAdmin
        .from('student_explanations')
        .select('id, student_id, explanation_text, feedback, version, created_at, concepts(name, category, definition, key_points)')
        .eq('id', explanationId)
        .maybeSingle();

      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!row) return res.status(404).json({ error: 'Uitleg niet gevonden' });
      if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze uitleg' });

      let journalEntryId = null;
      let summaryFailed = false;

      if (generateSummary && (await courseFeatureOnFor(user, null, courseId, 'journal'))) {
        const apiKey = process.env.OPENAI_API_KEY;
        const conceptName = row.concepts?.name || 'Onbekend begrip';
        const conceptDef = row.concepts?.definition || '';
        const keyPoints = Array.isArray(row.concepts?.key_points) ? row.concepts.key_points : [];
        const feedbackText = row.feedback?.content || (typeof row.feedback === 'string' ? row.feedback : '(geen feedback)');

        const summaryPrompt = (lang !== 'nl'
          ? `You are a "critical friend" for a student at VU Amsterdam. A student has explained the concept "${conceptName}" in their own words and received feedback from the learning assistant. Write a formative reflection report of 5 to 10 lines in English, addressed directly to the student.

Addressing rule (follow STRICTLY):
- Address the student directly using "you" / "your".
- NEVER use formulations like "the student", "this student", "the student has" or other third-person references. Write as if giving feedback one-on-one.

Your report contains:
1. A reasoned formative judgement of what you have demonstrated and learned about this concept
2. Concrete strengths and areas for improvement in your explanation (honest but constructive)
3. A specific suggestion for further deepening or a next step

Concept: "${conceptName}"
Official definition: ${conceptDef || '(not provided)'}${keyPoints.length > 0 ? `\nKey points: ${keyPoints.join('; ')}` : ''}

Your explanation:
${row.explanation_text}

Feedback from the learning assistant:
${feedbackText}

Write the report directly without salutation. Be concrete, honest and motivating.`
          : `Je bent een "critical friend" voor een student aan de VU Amsterdam. Een student heeft het begrip "${conceptName}" in eigen woorden uitgelegd en feedback ontvangen van de leerassistent. Schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd over dit begrip
2. Concrete sterke punten én verbeterpunten in jouw uitleg (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping of een vervolgstap

Begrip: "${conceptName}"
Officiële definitie: ${conceptDef || '(niet opgegeven)'}${keyPoints.length > 0 ? `\nKernpunten: ${keyPoints.join('; ')}` : ''}

Jouw uitleg:
${row.explanation_text}

Feedback van de leerassistent:
${feedbackText}

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.`) + journalFormatInstruction(lang) + buildLanguageInstruction(lang);

        if (AZURE_CHAT_READY) {
          try {
            const chatResp = await openaiChatCompletion({
              model: OPENAI_MODEL,
              messages: [{ role: 'user', content: summaryPrompt }],
              ...chatModelParams({ temperature: 0.5, maxTokens: 600 }),
            });

            if (chatResp.ok) {
              const chatData = await chatResp.json();
              const summaryContent = chatData.choices?.[0]?.message?.content;
              if (summaryContent) {
                const journalCourseId = await resolveJournalCourseId(courseId, user);
                const { data: entry, error: journalError } = await supabaseAdmin
                  .from('learning_journal_entries')
                  .insert({
                    user_id: user.id,
                    title: lang === 'nl' ? `Uitleg-reflectie: ${conceptName}` : `Explanation reflection: ${conceptName}`,
                    ...journalFieldsFromModel(summaryContent, lang),
                    activity_type: 'explanation_reflection',
                    course_id: journalCourseId,
                  })
                  .select('id')
                  .single();

                if (journalError) {
                  console.error('[explain/delete] Journal insert error:', journalError);
                  summaryFailed = true;
                } else {
                  journalEntryId = entry.id;
                  console.log(`[explain/delete] Journal entry aangemaakt: ${journalEntryId}`);
                }
              } else {
                summaryFailed = true;
              }
            } else {
              console.error('[explain/delete] OpenAI fout:', chatResp.status, await chatResp.text());
              summaryFailed = true;
            }
          } catch (chatErr) {
            console.error('[explain/delete] OpenAI request mislukt:', chatErr.message);
            summaryFailed = true;
          }
        } else {
          console.warn('[explain/delete] Azure OpenAI niet geconfigureerd — samenvatting overgeslagen');
          summaryFailed = true;
        }
      }

      // Verwijder de uitleg uit de actieve lijst
      const { error: delErr } = await supabaseAdmin
        .from('student_explanations')
        .delete()
        .eq('id', explanationId);

      if (delErr) {
        console.error('[explain/delete] kon uitleg niet verwijderen:', delErr);
        return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
      }

      return res.json({
        success: true,
        journalEntryId,
        summaryCreated: generateSummary && journalEntryId !== null,
        summaryFailed: generateSummary && summaryFailed,
      });
    } catch (err) {
      console.error('[explain/delete] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  registerFlawedExplanationRoutes(app, {
    supabaseAdmin,
    requireAuthUser,
    userHasCourseAccess,
    rejectIfFeatureOff,
    courseFeatureOnFor,
    isStaffForCourse,
    getChunks: flawedChunksFor,
    llmJson: async (system, user, opts) => {
      const raw = await flawedLlm(system, user, { ...opts, json: true });
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    },
    llmText: (system, user, opts) => flawedLlm(system, user, opts),
    secret: TURN_SECRET,
    resolveJournalCourseId,
    get llmReady() { return AZURE_CHAT_READY; },
  });
}
