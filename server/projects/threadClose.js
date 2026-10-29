// Verstandhouding bij het afronden van een gesprek (herzien 2026-09-29).
// Los van Express zodat de keten "gesprek → oordeel → nieuw niveau" in
// server/__tests__/close.integration.test.js getest kan worden. De samenvatting
// (onderwerpen/afspraken) blijft in server/index.js (performThreadClose).
//
// Alleen voor een rolspeler met verstandhouding (reputationActive). Het oordeel
// is een APARTE aanroep met de gedragsregels van de docent: de persona krijgt
// die regels in het gesprek nooit te zien.

import {
  appendHistory,
  hasHistoryRef,
  clampLevel,
  nextLevel,
  buildConductJudgeMessages,
  validateConductJudgement,
} from './personaRelationship.js';
import { reputationActive, clampStartLevel } from './personaRoles.js';

/** Gesprek als tekst voor de beoordeling ("Student: …" / "<naam>: …"). */
export function transcriptOf(allMsgs, personaName = 'Persona') {
  return (Array.isArray(allMsgs) ? allMsgs : [])
    .map(m => `${m.role === 'user' ? 'Student' : personaName}: ${String(m.content || '').slice(0, 2000)}`)
    .join('\n')
    .slice(0, 12000);
}

/**
 * Beoordeel een afgerond gesprek. `chat(messages)` is de (injecteerbare)
 * taalmodel-aanroep en levert de ruwe tekst. Een gesprek zonder inbreng van
 * de studenten verandert niets. Retour: { step, reason }.
 */
export async function judgeConversation({ chat, persona, level, allMsgs, lang, languageName }) {
  if (!reputationActive(persona)) return { step: 0, reason: '' };
  const studentTurns = (allMsgs || []).filter(m => m.role === 'user' && String(m.content || '').trim()).length;
  if (studentTurns === 0) return { step: 0, reason: '' };
  try {
    const raw = await chat(buildConductJudgeMessages({
      personaName: persona.name || 'Persona',
      conductRules: persona.conduct_rules,
      level,
      transcript: transcriptOf(allMsgs, persona.name || 'Persona'),
      lang,
      languageName,
    }));
    return validateConductJudgement(raw);
  } catch (e) {
    console.warn('[reputation] beoordeling mislukt, niveau blijft gelijk:', e.message);
    return { step: 0, reason: '', failed: true };
  }
}

/** Huidige rij (score + history) of null; tabel ontbreekt → { missing: true }. */
async function readRelationship(supabaseAdmin, { projectId, groupId, personaId }) {
  const { data, error } = await supabaseAdmin
    .from('project_persona_relationships')
    .select('id, score, history, updated_at')
    .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01' || /project_persona_relationships/i.test(error.message || '')) return { missing: true };
    throw error;
  }
  return { row: data || null };
}

/**
 * Zet het niveau van de verstandhouding. `compute(current)` levert het nieuwe
 * niveau; zonder rij begint de groep op `startLevel`. Idempotent op
 * (event.source, event.refId): dezelfde gebeurtenis telt maar één keer.
 * Retour: de bijgewerkte rij, of null als de tabel nog niet bestaat.
 */
export async function setRelationshipLevelImpl(
  { supabaseAdmin },
  { projectId, groupId, personaId, startLevel = 0, compute, event },
) {
  if (!supabaseAdmin) return null;
  const read = await readRelationship(supabaseAdmin, { projectId, groupId, personaId });
  if (read.missing) return null;
  const existing = read.row;
  const history = Array.isArray(existing?.history) ? existing.history : [];
  const source = event?.source || '';
  const refId = event?.refId || '';
  if (refId && hasHistoryRef(history, source, refId)) return existing;
  const current = existing ? clampLevel(existing.score) : clampStartLevel(startLevel);
  const level = clampLevel(compute(current));
  const newHistory = appendHistory(history, { ...(event || {}), from: current, to: level });
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from('project_persona_relationships')
      .update({ score: level, history: newHistory, updated_at: new Date().toISOString() })
      .eq('id', existing.id).select('id, score, history, updated_at').single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabaseAdmin
    .from('project_persona_relationships')
    .insert({ project_id: projectId, group_id: groupId, persona_id: personaId, score: level, history: newHistory })
    .select('id, score, history, updated_at').single();
  if (error) {
    // Race: een parallelle afronding maakte de rij net aan → één keer opnieuw.
    if (error.code === '23505') {
      return setRelationshipLevelImpl({ supabaseAdmin }, { projectId, groupId, personaId, startLevel, compute, event });
    }
    throw error;
  }
  return data;
}

/**
 * Oordeel alvast uitrekenen (tijdens het venster "Gesprek afsluiten"), zonder
 * iets op te slaan. Retour: null (geen verstandhouding of mislukt) of
 * { level, step, reason } — `level` is het niveau waarmee is geoordeeld.
 */
export async function precomputeJudgement(deps, { persona, projectId, groupId, allMsgs, lang, languageName }) {
  if (!reputationActive(persona) || !projectId) return null;
  const read = await readRelationship(deps.supabaseAdmin, { projectId, groupId, personaId: persona.id });
  if (read.missing) return null;
  const level = read.row ? clampLevel(read.row.score) : clampStartLevel(persona.start_level);
  const j = await judgeConversation({ chat: deps.chat, persona, level, allMsgs, lang, languageName });
  if (j.failed) return null;
  return { level, step: j.step, reason: j.reason };
}

/**
 * Hele stap na het afronden van een gesprek: oordeel vragen en — bij een
 * verandering — het nieuwe niveau opslaan. Retour: null (geen verstandhouding)
 * of { step, reason, from, to }. Een vooraf berekend oordeel (`precomputed`,
 * zie precomputeJudgement) wordt alleen gebruikt als het niveau sindsdien niet
 * is veranderd; anders wordt opnieuw geoordeeld.
 */
export async function applyConversationJudgement(deps, { persona, projectId, groupId, threadId, allMsgs, lang, languageName, precomputed = null }) {
  if (!reputationActive(persona) || !projectId) return null;
  const read = await readRelationship(deps.supabaseAdmin, { projectId, groupId, personaId: persona.id });
  if (read.missing) return null;
  const from = read.row ? clampLevel(read.row.score) : clampStartLevel(persona.start_level);
  const { step, reason } = (precomputed && precomputed.level === from)
    ? precomputed
    : await judgeConversation({ chat: deps.chat, persona, level: from, allMsgs, lang, languageName });
  if (step === 0) return { step: 0, reason: '', from, to: from };
  const row = await setRelationshipLevelImpl(deps, {
    projectId, groupId, personaId: persona.id,
    startLevel: persona.start_level,
    compute: (cur) => nextLevel(cur, step),
    event: { source: 'persona_chat_close', refId: `thread_close:${threadId}`, step, note: reason },
  });
  return { step, reason, from, to: row ? clampLevel(row.score) : nextLevel(from, step) };
}
