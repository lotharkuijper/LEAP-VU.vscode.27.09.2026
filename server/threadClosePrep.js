// Gesprek afsluiten zonder dubbel werk (2026-10-09).
//
// Vroeger maakte de server de neerslag (onderwerpen + afspraken) twee keer:
// voor het venster "Gesprek afsluiten" en bij de bevestiging opnieuw. Daarna
// volgde pas het oordeel over de verstandhouding. Alles na elkaar; dat kostte
// 6–9 s na de klik.
//
// Nu:
//  * de neerslag van het venster wordt bewaard (in het geheugen, 30 min) en bij
//    het afsluiten hergebruikt, zolang het gesprek niet is veranderd
//    (vingerafdruk van de berichten + taal). Het blijft de eigen tekst van de
//    server; de browser stuurt nog steeds niets mee.
//  * het oordeel over de verstandhouding start al tijdens het venster, op de
//    achtergrond; opslaan gebeurt pas bij het afsluiten (server/threadClose.js
//    controleert dan of het niveau intussen niet is veranderd).
//  * zonder venster (bv. automatisch afronden) lopen neerslag en oordeel
//    tegelijk in plaats van na elkaar.

import { createHash } from 'node:crypto';

/** Vingerafdruk van een gesprek: verandert bij elk nieuw of gewijzigd bericht. */
export function messagesFingerprint(allMsgs, lang) {
  const h = createHash('sha1');
  h.update(String(lang || ''));
  for (const m of allMsgs || []) h.update(`\u0000${m.role}\u0001${m.content || ''}`);
  return h.digest('hex');
}

/** Gesprek als tekst voor de notulist (zelfde vorm als voorheen). */
function conversationText(allMsgs) {
  return (allMsgs || [])
    .map(m => `${m.role === 'user' ? 'Student' : 'Persona'}: ${(m.content || '').slice(0, 2000)}`)
    .join('\n').slice(0, 12000);
}

/** Terugval als het model niets bruikbaars geeft: de eerste studentberichten. */
export function fallbackTopics(allMsgs) {
  return (allMsgs || []).filter(m => m.role === 'user')
    .map(m => (m.content || '').slice(0, 100))
    .filter(Boolean).slice(0, 3);
}

export function buildSummaryPrompt(allMsgs, lang, languageName) {
  const msgCount = (allMsgs || []).filter(m => m.role === 'user').length;
  const topicsInstruction = lang !== 'nl'
    ? (msgCount <= 3 ? '2-3 short topics' : msgCount <= 8 ? '3-5 topics' : '5-8 topics')
    : (msgCount <= 3 ? '2-3 korte onderwerpen' : msgCount <= 8 ? '3-5 onderwerpen' : '5-8 onderwerpen');
  const langInstruction = lang === 'nl'
    ? 'Schrijf in het Nederlands.'
    : `Write everything in ${languageName}. Keep every JSON property name exactly as written in the structure above (do not translate the keys); only the string values may be in ${languageName}.`;
  const text = conversationText(allMsgs);
  return lang !== 'nl'
    ? `You are a minute-taker. Analyse the following conversation between a student and an AI persona.\n\nRespond ONLY with valid JSON in this structure:\n{\n  "topics": [...],\n  "agreements": [...]\n}\n\n- "topics": array of ${topicsInstruction}. Each item is one discussed topic (concise, max 1 sentence).\n- "agreements": array of 0 or more strings. Only concrete agreements or commitments. Leave empty if none.\n\n${langInstruction} No markdown outside the JSON, no explanation.\n\nConversation:\n${text}`
    : `Je bent een notulist. Analyseer het volgende gesprek tussen een student en een AI-persona.\n\nGeef je antwoord UITSLUITEND als geldige JSON met deze structuur:\n{\n  "topics": [...],\n  "agreements": [...]\n}\n\n- "topics": array van ${topicsInstruction}. Elk item is één besproken onderwerp (bondig, maximaal 1 zin).\n- "agreements": array van 0 of meer strings. Alleen concrete afspraken of toezeggingen. Laat leeg als er geen zijn.\n\n${langInstruction} Geen markdown buiten de JSON, geen uitleg.\n\nGesprek:\n${text}`;
}

/**
 * Neerslag van een gesprek. `chat(messages)` levert de ruwe modeltekst (of
 * gooit). Te kort gesprek of een mislukte aanroep → terugval, nooit een fout.
 */
export async function generateThreadSummary({ chat, allMsgs, lang, languageName = 'English', log = console }) {
  let topics = [];
  let agreements = [];
  if ((allMsgs || []).length >= 2 && chat) {
    try {
      const raw = String((await chat([{ role: 'user', content: buildSummaryPrompt(allMsgs, lang, languageName) }])) || '{}').trim();
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      topics = Array.isArray(parsed.topics) ? parsed.topics.filter(t => typeof t === 'string' && t.trim()) : [];
      agreements = Array.isArray(parsed.agreements) ? parsed.agreements.filter(a => typeof a === 'string' && a.trim()) : [];
    } catch (e) {
      log.error?.('[threads/close] neerslag mislukt:', e?.message || e);
    }
  }
  if (topics.length === 0) topics = fallbackTopics(allMsgs);
  return { topics, agreements };
}

/**
 * Geheugen tussen het venster en de bevestiging, per gesprek.
 *  preview(): neerslag maken of hergebruiken; oordeel (judge) alvast starten.
 *  forClose(): neerslag + oordeel; hergebruikt wat er nog geldig is, en doet
 *              de rest tegelijk. Daarna is het gesprek uit het geheugen.
 * `summarize()` en `judge()` zijn de echte aanroepen (judge mag null zijn).
 */
export function createClosePrep({ ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
  const entries = new Map();

  function prune() {
    const t = now();
    for (const [k, e] of entries) if (t - e.at > ttlMs) entries.delete(k);
  }
  function valid(threadId, fp) {
    prune();
    const e = entries.get(threadId);
    return e && e.fp === fp ? e : null;
  }

  async function preview({ threadId, allMsgs, lang, summarize, judge }) {
    const fp = messagesFingerprint(allMsgs, lang);
    let e = valid(threadId, fp);
    if (!e) {
      e = { fp, at: now(), summary: null, judgement: null };
      entries.set(threadId, e);
    }
    if (judge && !e.judgement) e.judgement = Promise.resolve().then(judge).catch(() => null);
    if (!e.summary) {
      e.summary = Promise.resolve().then(summarize);
      e.summary.catch(() => { if (entries.get(threadId) === e) e.summary = null; });
    }
    return e.summary;
  }

  async function forClose({ threadId, allMsgs, lang, summarize, judge }) {
    const fp = messagesFingerprint(allMsgs, lang);
    const e = valid(threadId, fp);
    entries.delete(threadId);
    const [summary, judgement] = await Promise.all([
      e?.summary ? e.summary.catch(() => summarize()) : summarize(),
      judge ? (e?.judgement ? e.judgement.then(j => j ?? judge()) : judge()) : null,
    ]);
    return { summary, judgement: judgement ?? null, reused: { summary: !!e?.summary, judgement: !!e?.judgement } };
  }

  return { preview, forClose, size: () => { prune(); return entries.size; } };
}
