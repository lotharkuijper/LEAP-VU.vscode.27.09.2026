// Vertaalt de servermeldingen (server/i18n/messages.source.json, Nederlands)
// naar alle ondersteunde talen via de VU Azure OpenAI-resource — dezelfde
// werkwijze als scripts/i18n-generate.mjs (geen publieke OpenAI).
// Schrijft server/i18n/messages.<lang>.json = { "<Nederlandse sjabloon>": "<vertaling>" }.
//
// Hervatbaar: alleen ONTBREKENDE meldingen worden vertaald; per taal wordt na
// elke ronde weggeschreven. Een vertaling die {0}, {1}, … niet exact behoudt,
// wordt verworpen (die melding blijft dan Nederlands tot een volgende run).
//
// Gebruik:  node --env-file=.env scripts/server-i18n-generate.mjs
//           LANGS=en,de node --env-file=.env scripts/server-i18n-generate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeChatConfig } from '../server/chatConfig.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(root, 'server', 'i18n');
const BATCH = parseInt(process.env.BATCH || '40', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8', 10);
const TIME_BUDGET_MS = parseInt(process.env.TIME_BUDGET_MS || '100000', 10);

const TARGET_LANGS = [
  ['en', 'English'], ['yue', 'Cantonese (Traditional Chinese characters)'], ['zh', 'Mandarin Chinese (Simplified characters)'],
  ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'],
  ['uk', 'Ukrainian'], ['ro', 'Romanian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['id', 'Indonesian'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['hr', 'Croatian'], ['el', 'Greek'],
];

const cfg = computeChatConfig(process.env);
if (!cfg.azureChatReady) { console.error('[server-i18n] Azure chat niet geconfigureerd. Stop.'); process.exit(1); }
const MODEL = process.env.OPENAI_MODEL || cfg.deployment || '';
const IS_REASONING = /^(gpt-5|o1|o3|o4)/i.test(MODEL);
const START = Date.now();

const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

async function callAzure(messages, attempt = 0) {
  const body = { messages, response_format: { type: 'json_object' }, [IS_REASONING ? 'max_completion_tokens' : 'max_tokens']: 8000 };
  if (IS_REASONING) body.reasoning_effort = 'low';
  const res = await fetch(cfg.chatUrl, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (!res.ok) {
    if ((res.status === 0 || res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return callAzure(messages, attempt + 1);
    }
    throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

function systemPrompt(language) {
  return [
    `You translate short server messages (errors and status notices) of a Dutch university learning platform called LEAP-VU from Dutch into ${language}.`,
    'Return ONLY a JSON object with exactly the same keys as the input, each mapped to its translation.',
    'Preserve placeholder tokens like {0}, {1} exactly (they stand for names, numbers or technical details). Keep technical identifiers (field names such as courseId, file extensions, product names like Azure, Supabase, LibreOffice, LEAP-VU) unchanged.',
    'Use the informal second person where the language distinguishes formality. Be concise and natural; do not add explanations.',
  ].join('\n');
}

async function main() {
  const sources = readJson(path.join(DIR, 'messages.source.json'), []);
  if (!sources.length) { console.error('Geen bronmeldingen: draai eerst node scripts/extract-server-messages.mjs'); process.exit(1); }
  const only = (process.env.LANGS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const langs = only.length ? TARGET_LANGS.filter(([c]) => only.includes(c)) : TARGET_LANGS;
  let remainingTotal = 0;
  for (const [code, language] of langs) {
    const file = path.join(DIR, `messages.${code}.json`);
    const dict = readJson(file, {});
    // Verouderde vertalingen (bron verdwenen) opruimen.
    for (const k of Object.keys(dict)) if (!sources.includes(k)) delete dict[k];
    const missing = sources.filter((s) => !dict[s]);
    const batches = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
    let idx = 0;
    const worker = async () => {
      while (idx < batches.length && Date.now() - START < TIME_BUDGET_MS) {
        const batch = batches[idx++];
        const input = Object.fromEntries(batch.map((s, i) => [String(i), s]));
        let parsed = {};
        try { parsed = JSON.parse(await callAzure([{ role: 'system', content: systemPrompt(language) }, { role: 'user', content: JSON.stringify(input) }])); } catch (e) { console.warn(`[server-i18n] ${code}: batch mislukt: ${e.message}`); continue; }
        batch.forEach((s, i) => {
          const v = parsed[String(i)];
          if (typeof v === 'string' && v.trim() && placeholders(v) === placeholders(s)) dict[s] = v;
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    const ordered = Object.fromEntries(sources.filter((s) => dict[s]).map((s) => [s, dict[s]]));
    fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n');
    const left = sources.length - Object.keys(ordered).length;
    remainingTotal += left;
    console.log(`[server-i18n] ${code}: ${Object.keys(ordered).length}/${sources.length}${left ? ` (${left} resterend)` : ' klaar'}`);
    // Tijd op: de volgende talen worden niet meer vertaald, maar wél meegeteld
    // (anders meldt het script ten onrechte "alle talen compleet").
  }
  console.log(`[server-i18n] RESTEREND totaal: ${remainingTotal}${remainingTotal ? ' — draai opnieuw' : ' (alle talen compleet)'}`);
}
main();
