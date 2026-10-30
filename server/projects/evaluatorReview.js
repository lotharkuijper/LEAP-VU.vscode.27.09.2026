import { badgeForGrade, normalizeBadgeAwardMode, validateReviewResponse } from './documentReview.js';
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
import { DEFAULT_DOCUMENT_REVIEW_PROMPT } from '../prompts/promptStore.js';
import { isGroupMember } from './access.js';

// =============================================================================
// Task #166 — Documentoordelen (Fase 1). Een evaluator-persona geeft een
// gestructureerd JSON-oordeel over een geüpload student-document. Het oordeel
// (verdict, reasoning, relationship_delta) wordt opgeslagen in
// project_document_reviews én gespiegeld in learning_journal_entries per
// groepslid (idempotent op source_ref).
// =============================================================================

const VERDICT_LABELS_NL = {
  accepted: 'Aanvaard',
  conditional: 'Onder voorwaarden',
  rejected: 'Afgewezen',
};

// Task #253: badge-labels + emoji voor journal-spiegeling (server-side weergave).
const BADGE_LABELS_NL = {
  platina: 'Platina',
  goud: 'Goud',
  zilver: 'Zilver',
  brons: 'Brons',
};

const BADGE_EMOJI = {
  platina: '💎',
  goud: '🥇',
  zilver: '🥈',
  brons: '🥉',
};

// Eén oordeel van een beoordelaar-persona over een tekst: rubric + LLM (JSON),
// opslaan, badges toekennen en in het leerdagboek van de groepsleden zetten.
// Gedeeld door het oordeel over een projectdocument en door "Inleveren voor
// feedback" (ingeleverd werk van de groep, `productId`). Fouten gooien we als
// { status, body } zodat de route ze één-op-één kan teruggeven.
export async function runEvaluatorReview({ project, group, persona, title, text, lang, requesterId, documentId = null, productId = null }) {
  const groupId = group.id;
  // Beoordelingsmateriaal van deze beoordelaar: de projectdocumenten van de
  // docent die hij kent, in hun geheel (personaKnowledge.js). Nooit uploads van
  // studenten — voorkomt sturing van het oordeel via een geüpload bestand.
  const rubricBlock = await loadEvaluatorMaterial(supabaseAdmin, persona);

  // Actieve document_review-prompt uit chatbot_prompts (sectie 'project').
  const { data: drPromptRow } = await supabaseAdmin
    .from('chatbot_prompts')
    .select('content')
    .eq('section', 'project').eq('name', 'document_review')
    .maybeSingle();
  const systemTemplate = (drPromptRow?.content || DEFAULT_DOCUMENT_REVIEW_PROMPT).trim();

  const personaIntro = (persona.system_prompt || '').trim();
  const productLine = persona.deliverable_label ? `\nProduct waarover je feedback geeft: ${persona.deliverable_label}` : '';
  const userBlock = `Persona-achtergrond:
${personaIntro || '(geen extra persona-instructies)'}

Project: ${project.title || '(naamloos)'}
Beoogd projectresultaat: ${project.research_question || '(geen)'}
Leerdoelen: ${project.goals || '(geen)'}${productLine}

Verborgen rubric/criteria (alleen voor jou):
${rubricBlock || '(geen rubric-bestand gekoppeld; gebruik dan de leerdoelen hierboven)'}

Groep: ${group.name}

Studentdocument "${title}":
${String(text).slice(0, 20000)}

Geef nu je oordeel als JSON-object volgens het eerder beschreven schema.`;

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
      ...chatModelParams({ temperature: 0.2, maxTokens: 800 }),
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
    throw { status: 502, body: { error: `Persona gaf geen geldig JSON-oordeel: ${validation.error}`, raw: rawResponse?.slice(0, 500) } };
  }

  // Task #253: badge deterministisch uit het cijfer.
  const grade = validation.value.grade;
  const feedForward = validation.value.feed_forward || '';
  const badge = badgeForGrade(grade);
  const awardMode = normalizeBadgeAwardMode(persona.badge_award_mode);

  // Beoordelaars hebben geen verstandhouding: relationship_delta blijft 0.
  const reviewRow = {
    document_id: documentId,
    product_id: productId,
    persona_id: persona.id,
    group_id: groupId,
    verdict: validation.value.verdict,
    grade,
    reasoning: validation.value.reasoning,
    feed_forward: feedForward,
    relationship_delta: 0,
    requested_by: requesterId,
    raw_llm_response: { content: rawResponse },
  };
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('project_document_reviews').insert(reviewRow)
    .select('id, document_id, product_id, persona_id, group_id, verdict, grade, reasoning, feed_forward, requested_by, created_at').single();
  if (insErr) throw { status: 500, body: { error: insErr.message } };

  const { data: groupMembers } = await supabaseAdmin
    .from('project_group_members').select('user_id').eq('group_id', groupId);

  // Task #253: badges. group → elk groepslid; individual → alleen de indiener
  // (mits groepslid). Idempotent via unique(review_id,user_id).
  let badgeRecipients = [];
  if (badge) {
    const memberIds = (groupMembers || []).map(m => m.user_id);
    if (awardMode === 'group') badgeRecipients = memberIds;
    else if (memberIds.includes(requesterId)) badgeRecipients = [requesterId];
    if (badgeRecipients.length > 0) {
      const badgeRows = badgeRecipients.map(uid => ({
        review_id: inserted.id, persona_id: persona.id, group_id: groupId,
        user_id: uid, grade, badge, award_mode: awardMode,
      }));
      const { error: bErr } = await supabaseAdmin.from('project_review_badges').insert(badgeRows);
      if (bErr && bErr.code !== '23505' && bErr.code !== '42P01') {
        console.warn('[document_review] badge-toekenning mislukte:', bErr.message);
      }
    }
  }

  // Dagboektekst bij het oordeel (2026-10-27): niet meer automatisch in de
  // dagboeken van alle groepsleden; elk lid bewaart het zelf (journal-save).
  const verdictLabel = VERDICT_LABELS_NL[validation.value.verdict] || validation.value.verdict;
  const gradeStr = Number.isFinite(Number(grade)) ? Number(grade).toFixed(1).replace('.', ',') : null;
  const badgeLabelNl = badge ? (BADGE_LABELS_NL[badge] || badge) : null;
  const titleBase = gradeStr
    ? `${persona.avatar_emoji || '🧑‍⚖️'} Cijfer ${gradeStr} (${verdictLabel}) — ${persona.name} over "${title}"`
    : `${persona.avatar_emoji || '🧑‍⚖️'} Oordeel ${verdictLabel} — ${persona.name} over "${title}"`;
  const contentParts = [];
  if (gradeStr) contentParts.push(`Cijfer: ${gradeStr}`);
  contentParts.push(`Feedback: ${validation.value.reasoning}`);
  if (feedForward) contentParts.push(`Feed-forward: ${feedForward}`);
  const journalContentBase = contentParts.join('\n\n');
  const journalEntry = {
    title: titleBase,
    content: journalContentBase,
    sections: {
      summary: '', went_well: [], to_improve: [],
      feedback: validation.value.reasoning,
      next_steps: feedForward ? [feedForward] : [],
    },
    // Wie een badge kreeg, ziet die bij het bewaren in het eigen dagboek.
    badge: badge ? { emoji: BADGE_EMOJI[badge] || '🏅', label: badgeLabelNl } : null,
  };
  const { error: jeErr } = await supabaseAdmin.from('project_document_reviews')
    .update({ journal_entry: journalEntry }).eq('id', inserted.id);
  if (jeErr) console.warn('[document_review] dagboektekst niet opgeslagen:', jeErr.message);

  return { inserted, badge, awardMode, badgeRecipients };
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
    if (p.id === project.preassessment_persona_id) { res.status(400).json({ error: 'Deze beoordelaar maakt alleen de voorbeoordeling van het eindproduct voor de docent' }); return null; }
    persona = p;
  }
  return { auth, project, group, persona, isStaff, memberOfGroup };
}
