import {
  isThreadStale as conIsThreadStale,
  normalizeAutoCloseHours as conNormalizeAutoCloseHours,
} from './consultationLimit.js';
import { languageEnglishName } from '../i18n/languages.js';
import { AZURE_CHAT_READY, OPENAI_MODEL, chatModelParams, openaiChatCompletion } from '../lib/azureOpenai.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { reputationActive } from './personaRoles.js';
import { applyConversationJudgement, precomputeJudgement } from './threadClose.js';
import { createClosePrep, generateThreadSummary } from './threadClosePrep.js';

// Gesprek afsluiten: neerslag en oordeel worden tussen het venster en de
// bevestiging bewaard (server/projects/threadClosePrep.js), zodat de klik op
// "Gesprek afsluiten" niet opnieuw op het taalmodel hoeft te wachten.
export const threadClosePrep = createClosePrep();

const THREAD_CLOSE_LLM_TIMEOUT_MS = 60000;

async function threadCloseChat(messages, maxTokens, temperature) {
  const r = await openaiChatCompletion({
    model: OPENAI_MODEL,
    messages,
    ...chatModelParams({ temperature, maxTokens }),
    response_format: { type: 'json_object' },
  }, { timeoutMs: THREAD_CLOSE_LLM_TIMEOUT_MS });
  if (!r.ok) throw new Error(`Taalmodel-fout (${r.status})`);
  return (await r.json()).choices?.[0]?.message?.content || '';
}

export async function loadThreadMessages(threadId) {
  const { data: msgs } = await supabaseAdmin
    .from('group_persona_messages')
    .select('role, content')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });
  return { allMsgs: msgs || [] };
}

// Persona + project van een gesprek (voor de verstandhouding).
export async function loadThreadCloseContext(thread, groupId) {
  let persona = null;
  let projectId = null;
  if (thread.persona_id) {
    const { data: p } = await supabaseAdmin
      .from('project_personas')
      .select('id, name, project_id, system_prompt, persona_type, reputation_enabled, conduct_rules, start_level')
      .eq('id', thread.persona_id).maybeSingle();
    persona = p || null;
    projectId = persona?.project_id || null;
  }
  if (!projectId) {
    const { data: g } = await supabaseAdmin
      .from('project_groups').select('project_id').eq('id', groupId).maybeSingle();
    projectId = g?.project_id || null;
  }
  return { persona, projectId };
}

// De twee taalmodel-klussen bij het afsluiten, als uitstelbare functies.
export function threadCloseJobs({ thread, groupId, lang, allMsgs, persona, projectId }) {
  const languageName = languageEnglishName(lang);
  return {
    threadId: thread.id,
    allMsgs,
    lang,
    summarize: () => (AZURE_CHAT_READY
      ? generateThreadSummary({ chat: (m) => threadCloseChat(m, 700, 0.2), allMsgs, lang, languageName })
      : generateThreadSummary({ chat: null, allMsgs, lang, languageName })),
    judge: (persona && AZURE_CHAT_READY && reputationActive(persona))
      ? () => precomputeJudgement({ supabaseAdmin, chat: (m) => threadCloseChat(m, 300, 0) }, {
        persona, projectId, groupId, allMsgs, lang, languageName,
      })
      : null,
  };
}

// Voer de afronding van één thread uit: server-side samenvatting (topics/
// agreements), DB-update en — indien van toepassing — cue-emissie op de
// relatie. Wordt gedeeld door het /close-endpoint én de lazy auto-close.
export async function performThreadClose({ thread, groupId, lang, closedBy }) {
  const [{ allMsgs }, ctx] = await Promise.all([loadThreadMessages(thread.id), loadThreadCloseContext(thread, groupId)]);
  const { persona, projectId } = ctx;

  // Neerslag + oordeel: uit het venster als dat nog geldig is, anders nu
  // (tegelijk in plaats van na elkaar).
  const { summary, judgement } = await threadClosePrep.forClose(threadCloseJobs({ thread, groupId, lang, allMsgs, ...ctx }));
  const { topics, agreements } = summary;

  // --- Schrijf naar DB: alleen server gegenereerde waarden ---
  const { error: updErr } = await supabaseAdmin
    .from('group_persona_threads')
    .update({
      closed_at: new Date().toISOString(),
      closed_by: closedBy || null,
      topics,
      agreements,
    })
    .eq('id', thread.id);
  if (updErr) throw new Error(updErr.message);

  // Verstandhouding (alleen een rolspeler die er een bijhoudt): het oordeel met
  // de gedragsregels van de docent opslaan. Idempotent per gesprek.
  let reputation = null;
  if (persona && AZURE_CHAT_READY && reputationActive(persona)) {
    try {
      reputation = await applyConversationJudgement({
        supabaseAdmin,
        chat: (m) => threadCloseChat(m, 300, 0),
      }, {
        persona, projectId, groupId, threadId: thread.id, allMsgs,
        lang, languageName: languageEnglishName(lang), precomputed: judgement,
      });
    } catch (relErr) {
      console.warn('[threads/close] verstandhouding bijwerken mislukte:', relErr.message);
    }
  }

  return { topics, agreements, reputation, personaName: persona?.name || null };
}

// Lazy auto-close: rond stille open threads van (groep, persona) automatisch af
// wanneer de laatste activiteit langer dan auto_close_hours geleden was. Geen
// cron — wordt aangeroepen vanuit room-load en persona-chat. Best-effort:
// fouten per thread worden gelogd, niet gegooid. Retourneert het aantal
// afgesloten threads.
export async function autoCloseStaleThreads({ groupId, personaId, autoCloseHours, closedBy, lang }) {
  const hours = conNormalizeAutoCloseHours(autoCloseHours);
  if (hours === null) return 0;
  const { data: openThreads, error } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id, persona_id, created_at')
    .eq('group_id', groupId).eq('persona_id', personaId).is('closed_at', null);
  if (error || !openThreads || openThreads.length === 0) return 0;
  const now = Date.now();
  let closed = 0;
  for (const th of openThreads) {
    const { data: lastMsg } = await supabaseAdmin
      .from('group_persona_messages')
      .select('created_at')
      .eq('thread_id', th.id)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    const lastTs = lastMsg?.created_at || th.created_at;
    if (conIsThreadStale(lastTs, hours, now)) {
      try {
        await performThreadClose({ thread: th, groupId, lang, closedBy: closedBy || null });
        closed++;
      } catch (e) {
        console.warn(`[auto-close] thread ${th.id} afronden mislukte:`, e.message);
      }
    }
  }
  return closed;
}
