import { validateReviewResponse } from './documentReview.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { authUser, isLeapAdmin, loadProfileRoleEmail, profileCache } from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { loadEvaluatorMaterial } from './personaKnowledge.js';
import { DEFAULT_FORMATIVE_FEEDBACK_PROMPT } from '../prompts/promptStore.js';
import { isGroupMember } from './access.js';
import { formativeJournalEntry } from './projectJournalSave.js';

// =============================================================================
// Feedback van een beoordelaar op werk dat de groep inlevert. Zuiver formatief
// (besluit 2026-11-10): waar staan jullie en wat is de volgende stap, zonder
// cijfer, oordeel of badge. Opgeslagen in project_document_reviews (verdict en
// grade blijven leeg); een groepslid kan het zelf in het eigen leerdagboek
// bewaren (projectJournalSave.js).
// =============================================================================

// Feedback van een beoordelaar-persona op een tekst: rubric + LLM (JSON) en
// opslaan. Gebruikt door 'Inleveren voor feedback' (ingeleverd werk van de
// groep, `productId`). Fouten gooien we als { status, body } zodat de route ze
// één-op-één kan teruggeven.
export async function runEvaluatorReview({ project, group, persona, title, text, lang, requesterId, documentId = null, productId = null }) {
  const groupId = group.id;
  // Materiaal van deze beoordelaar: de projectdocumenten van de docent die hij
  // kent, in hun geheel (personaKnowledge.js). Nooit uploads van studenten —
  // voorkomt sturing van de feedback via een geüpload bestand.
  const rubricBlock = await loadEvaluatorMaterial(supabaseAdmin, persona);

  // Opdracht uit chatbot_prompts (sectie 'project'), anders de standaard.
  const { data: promptRow } = await supabaseAdmin
    .from('chatbot_prompts')
    .select('content')
    .eq('section', 'project').eq('name', 'formative_feedback')
    .maybeSingle();
  const systemTemplate = (promptRow?.content || DEFAULT_FORMATIVE_FEEDBACK_PROMPT).trim();

  const personaIntro = (persona.system_prompt || '').trim();
  const productLine = persona.deliverable_label ? `\nProduct waarover je feedback geeft: ${persona.deliverable_label}` : '';
  const userBlock = `Persona-achtergrond:
${personaIntro || '(geen extra persona-instructies)'}

Project: ${project.title || '(naamloos)'}
Beoogd projectresultaat: ${project.research_question || '(geen)'}
Leerdoelen: ${project.goals || '(geen)'}${productLine}

Rubric en materiaal:
${rubricBlock || '(geen rubric gekoppeld; gebruik dan de leerdoelen hierboven)'}

Groep: ${group.name}

Werk van de groep "${title}":
${String(text).slice(0, 20000)}

Geef nu je feedback als JSON-object volgens het eerder beschreven schema.`;

  if (!AZURE_CHAT_READY) throw { status: 503, body: { error: LLM_NOT_CONFIGURED_MSG } };

  // JSON-mode; bij een ongeldig antwoord één retry met een striktere herinnering.
  async function callModel(extraReminder) {
    const messages = [
      { role: 'system', content: systemTemplate + buildLanguageInstruction(lang, { json: true }) },
      { role: 'user', content: userBlock + (extraReminder ? `\n\n${extraReminder}` : '') },
    ];
    const r = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: 'json_object' },
      ...chatModelParams({ temperature: 0.2, maxTokens: 1000 }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Taalmodel-fout (${r.status}): ${txt.slice(0, 200)}`);
    }
    const j = await r.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  }

  let rawResponse;
  let validation;
  try {
    rawResponse = await callModel(null);
    validation = validateReviewResponse(rawResponse);
    if (!validation.ok) {
      rawResponse = await callModel(`Je vorige antwoord was ongeldig: ${validation.error}. Antwoord nu uitsluitend met het JSON-object volgens het schema.`);
      validation = validateReviewResponse(rawResponse);
    }
  } catch (modelErr) {
    throw { status: 502, body: { error: modelErr.message } };
  }
  if (!validation.ok) {
    throw { status: 502, body: { error: `Persona gaf geen geldige feedback: ${validation.error}`, raw: rawResponse?.slice(0, 500) } };
  }

  const { feedback, feed_forward: feedForward } = validation.value;
  const reviewRow = {
    document_id: documentId,
    product_id: productId,
    persona_id: persona.id,
    group_id: groupId,
    verdict: null,
    grade: null,
    reasoning: feedback,
    feed_forward: feedForward,
    relationship_delta: 0,
    requested_by: requesterId,
    raw_llm_response: { content: rawResponse },
    journal_entry: formativeJournalEntry({ personaName: persona.name, emoji: persona.avatar_emoji, title, feedback, feedForward }),
  };
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('project_document_reviews').insert(reviewRow)
    .select('id, document_id, product_id, persona_id, group_id, reasoning, feed_forward, requested_by, created_at').single();
  if (insErr) throw { status: 500, body: { error: insErr.message } };
  return { inserted };
}

// Aantal gebruikte feedbackrondes van een groep bij een beoordelaar: feedback op
// ingeleverd werk plus elke keer "Feedback op jullie aanpak" (roomRoutes.js),
// zodat de docent met één maximum bepaalt hoeveel feedback een groep krijgt.
export async function countFeedbackRounds(groupId, personaId) {
  const [reviews, assessments] = await Promise.all([
    supabaseAdmin.from('project_document_reviews')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId).eq('persona_id', personaId)
      .not('product_id', 'is', null),
    supabaseAdmin.from('project_group_assessments')
      .select('id', { count: 'exact', head: true })
      .eq('group_id', groupId).eq('persona_id', personaId),
  ]);
  if (reviews.error) throw reviews.error;
  // Ontbrekende tabel (oude database): alleen de feedback op ingeleverd werk.
  if (assessments.error && assessments.error.code !== '42P01') throw assessments.error;
  return (reviews.count || 0) + (assessments.count || 0);
}

// Gedeelde checks voor de feedback-routes: project, groep, persona (beoordelaar)
// en rechten (groepslid of docent van de cursus).
export async function loadFeedbackContext(req, res, { requirePersona = true } = {}) {
  const auth = await authUser(req);
  if (auth.error) { res.status(auth.error.status).json(auth.error.body); return null; }
  const { projectId, groupId, personaId } = req.params;
  const { data: project } = await supabaseAdmin
    .from('projects').select('id, course_id, title, research_question, goals, status, preassessment_persona_id').eq('id', projectId).maybeSingle();
  if (!project) { res.status(404).json({ error: 'Project niet gevonden' }); return null; }
  const { data: group } = await supabaseAdmin
    .from('project_groups').select('id, project_id, name, status').eq('id', groupId).maybeSingle();
  if (!group || group.project_id !== projectId) { res.status(404).json({ error: 'Groep niet gevonden in dit project' }); return null; }
  const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
  const isStaff = isLeapAdmin(profile);
  const memberOfGroup = await isGroupMember(groupId, auth.user.id);
  if (!isStaff && !memberOfGroup) { res.status(403).json({ error: 'Geen toegang tot deze groep' }); return null; }
  let persona = null;
  if (requirePersona) {
    const { data: p } = await supabaseAdmin
      .from('project_personas').select('*').eq('id', personaId).eq('project_id', projectId).maybeSingle();
    if (!p) { res.status(404).json({ error: 'Persona niet gevonden in dit project' }); return null; }
    if (p.persona_type !== 'evaluator') { res.status(400).json({ error: 'Alleen evaluator-persona\'s kunnen oordelen afgeven' }); return null; }
    // De voorbeoordelaar van het eindproduct geeft geen feedbackrondes.
    if (p.id === project.preassessment_persona_id) { res.status(400).json({ error: 'Deze beoordelaar schrijft alleen nakijkcommentaar bij het eindproduct, voor de docent' }); return null; }
    persona = p;
  }
  return { auth, project, group, persona, isStaff, memberOfGroup };
}
