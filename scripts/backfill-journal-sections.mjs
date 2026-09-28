#!/usr/bin/env node
// Eenmalige omzetting: bestaande (automatische) leerdagboekregels opdelen in de
// drie blokken — samenvatting, feedback (ging goed / kan beter) en volgende
// stap. Het taalmodel mag de tekst alleen HERVERDELEN, niets toevoegen.
//
// Veilig:
//  * `content` (de oorspronkelijke tekst) blijft onaangeroerd; alleen
//    `sections` wordt gevuld. Terugdraaien = sections weer op NULL zetten.
//  * Eigen notities van studenten (activity_type 'reflection') blijven buiten schot.
//  * Alleen regels zonder blokken (sections IS NULL); nogmaals draaien is veilig.
//  * Lukt het opdelen niet, dan blijft de regel zoals hij is (en staat in het verslag).
//
// Gebruik:
//   node --env-file=.env scripts/backfill-journal-sections.mjs --dry-run   (alleen tonen)
//   node --env-file=.env scripts/backfill-journal-sections.mjs             (echt opslaan)

import pg from 'pg';
import { computeChatConfig } from '../server/chatConfig.js';
import { journalRedistributePrompt, parseJournalSections } from '../server/journalSections.js';

const DRY = process.argv.includes('--dry-run');
const AUTO_TYPES = ['chat_reflection', 'explanation_reflection', 'quiz_reflection', 'project_reflection'];

const cfg = computeChatConfig(process.env);
if (!cfg.azureChatReady) {
  console.error('[journal-backfill] Azure chat NIET geconfigureerd (AZURE_OPENAI_ENDPOINT/API_KEY). Stop.');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) {
  console.error('[journal-backfill] SUPABASE_DB_URL ontbreekt. Stop.');
  process.exit(1);
}
const MODEL = process.env.OPENAI_MODEL || cfg.deployment || 'gpt-5.5';
const IS_REASONING = /^(gpt-5|o1|o3|o4)/i.test(MODEL);

const buildPrompt = (entry) => journalRedistributePrompt(entry.title, entry.content);

async function callAzure(prompt, attempt = 0) {
  const body = {
    messages: [{ role: 'user', content: prompt }],
    [IS_REASONING ? 'max_completion_tokens' : 'max_tokens']: 4000,
  };
  if (IS_REASONING) body.reasoning_effort = 'low';
  else body.temperature = 0.2;
  const res = await fetch(cfg.chatUrl, {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      return callAzure(prompt, attempt + 1);
    }
    throw new Error(`Azure ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(
  `SELECT id, activity_type, title, content FROM learning_journal_entries
    WHERE sections IS NULL AND activity_type = ANY($1) AND length(trim(content)) > 0
    ORDER BY created_at`,
  [AUTO_TYPES],
);
console.log(`[journal-backfill] ${rows.length} regel(s) om te zetten${DRY ? ' (proefdraai, er wordt niets opgeslagen)' : ''}; model=${MODEL}`);

let done = 0; const failed = [];
for (const entry of rows) {
  try {
    const text = await callAzure(buildPrompt(entry));
    const sections = parseJournalSections(text);
    if (!sections) { failed.push({ id: entry.id, reason: 'geen bruikbare blokken' }); continue; }
    if (DRY) {
      console.log(`\n— ${entry.title} (${entry.activity_type})\n${JSON.stringify(sections, null, 2)}`);
    } else {
      await client.query('UPDATE learning_journal_entries SET sections = $1 WHERE id = $2 AND sections IS NULL', [sections, entry.id]);
    }
    done++;
  } catch (e) {
    failed.push({ id: entry.id, reason: e.message });
  }
}
await client.end();
console.log(`\n[journal-backfill] ${DRY ? 'Zou omzetten' : 'Omgezet'}: ${done}; niet gelukt: ${failed.length}`);
for (const f of failed) console.log(`  - ${f.id}: ${f.reason}`);
