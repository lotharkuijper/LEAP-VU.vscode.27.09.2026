#!/usr/bin/env node
// Fase 0 "Verbeter deze uitleg": meting tegen het echte model. Schrijft NIETS weg.
//
// Per begrip doet het script wat de productieversie doet (zelfde module, server/explain/flawedExplanations.js):
//   1. fragmenten uit het cursusmateriaal ophalen (embedding + match_document_chunks);
//   2. één aanroep: eerst een juiste uitleg, dan een versie met k fouten (k = 1..3, willekeurig);
//   3. een BLINDE controle (weet niet dat er fouten in zitten) moet precies de bedoelde
//      fouten vinden, allemaal wezenlijk, zonder extra fouten. Anders opnieuw (max. 3 pogingen).
// Daarna — alleen voor de meting, niet in productie — beoordeelt een ONAFHANKELIJKE
// beoordelaar met een andere instructie elke goedgekeurde oefening (en de eerste
// afgekeurde poging, om te zien of de controle niet te streng is).
// Geen mens beoordeelt oefeningen: uitkomst is alleen cijfers (+ voorbeelden in het rapport).
//
//   node --env-file=.env scripts/eval-flawed-explanations.mjs [per-cursus=20] [uitvoermap]
// Cursussen via EVAL_COURSES (komma-gescheiden namen), standaard E&B1, Methodologie 2, Microbiologie.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { computeChatConfig } from '../server/chat/chatConfig.js';
import { makeExercise as prodMakeExercise, sourcesText as srcText, MAX_ATTEMPTS } from '../server/explain/flawedExplanations.js';

const PER_COURSE = Number(process.argv[2] || 20);
const OUT = process.argv[3] || 'eval-output';
const COURSE_NAMES = (process.env.EVAL_COURSES || 'E&B1,Methodologie 2 - Gezondheidswetenschappen,Microbiologie').split(',').map(s => s.trim());
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);
const EFFORT = { generate: process.env.EVAL_EFFORT_GEN || 'low', verify: process.env.EVAL_EFFORT_VERIFY || 'medium', judge: 'high' };
// Prijsaanname voor de kostenschatting (USD per 1M tokens); pas aan met EVAL_PRICE_IN / EVAL_PRICE_OUT.
const PRICE = { in: Number(process.env.EVAL_PRICE_IN || 1.25), out: Number(process.env.EVAL_PRICE_OUT || 10) };

const cfg = computeChatConfig(process.env);
const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.OPENAI_MODEL || '';
const REASONING = /^(gpt-5|o1|o3|o4)/i.test(MODEL);
const EMB_URL = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${encodeURIComponent(process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT)}/embeddings?api-version=${process.env.AZURE_OPENAI_EMBEDDING_API_VERSION || process.env.AZURE_OPENAI_API_VERSION}`;
const db = createClient(process.env.VITE_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const usage = { in: 0, out: 0, calls: 0 };

function pickK() { const r = Math.random(); return r < 0.4 ? 1 : r < 0.75 ? 2 : 3; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function llm(system, user, effort, maxTokens = 6000) {
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } };
  if (REASONING) { body.max_completion_tokens = maxTokens + 8000; body.reasoning_effort = effort; } else { body.max_tokens = maxTokens; body.temperature = 0.7; }
  for (let i = 0; i < 4; i++) {
    const r = await fetch(cfg.chatUrl, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 3000 * (i + 1))); continue; }
    const d = await r.json();
    usage.calls++; usage.in += d?.usage?.prompt_tokens || 0; usage.out += d?.usage?.completion_tokens || 0;
    try { return JSON.parse(d?.choices?.[0]?.message?.content || ''); } catch { return null; }
  }
  return null;
}

// Zoals in productie (flawedChunksFor in server/explain/routes.js): eerst het opgeslagen
// bewijs van het begrip (concept_evidence), aangevuld met zoeken in het materiaal.
async function retrieve(concept, docIds) {
  const out = [];
  const seen = new Set();
  const { data: ev } = await db.from('concept_evidence').select('chunk_id, similarity').eq('concept_id', concept.id).order('similarity', { ascending: false }).limit(12);
  const ids = [...new Set((ev || []).map(e => e.chunk_id).filter(Boolean))].slice(0, 6);
  if (ids.length) {
    const { data: rows } = await db.from('document_chunks').select('id, content').in('id', ids);
    for (const r of rows || []) if (r.content && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  if (out.length < 6) {
    const q = [concept.name, concept.definition || ''].join('. ').slice(0, 2000);
    const r = await fetch(EMB_URL, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: [q] }) });
    const emb = (await r.json())?.data?.[0]?.embedding;
    if (emb) {
      const { data } = await db.rpc('match_document_chunks', { query_embedding: emb, match_threshold: 0, match_count: 40, filter_document_ids: docIds });
      for (const c of (data || []).filter(c => c.similarity >= 0.3)) {
        if (out.length >= 6) break;
        if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
      }
    }
  }
  return out;
}

const JUDGE_SYSTEM = `Je beoordeelt de kwaliteit van een oefening voor studenten. De oefening is een uitleg van een begrip waarin bewust fouten zijn gestopt; de student moet ze vinden. Je krijgt de bronfragmenten uit het cursusmateriaal, de bedoelde juiste uitleg, de uitleg met fouten, en de lijst bedoelde fouten.
Wees streng en eerlijk. Beoordeel:
- per bedoelde fout: "echt_fout": "ja" | "twijfel" | "nee" (is de bewering werkelijk onjuist, gegeven het cursusmateriaal en algemeen aanvaarde vakkennis? "twijfel" als ze in een redelijke lezing te verdedigen is); "wezenlijk": "ja" | "nee" (echte misvatting, geen detail of woordkeus);
- "extra_fouten": wezenlijke onjuistheden in de uitleg met fouten die NIET in de lijst staan (citaat + waarom);
- "juiste_tekst_klopt": "ja" | "nee";
- "geloofwaardig": 1-5 (zou een student die het begrip half begrijpt de foute uitleg geloven? 1 = doorzichtig, 5 = zeer overtuigend);
- "oordeel": "goed" (bruikbaar als oefening), "twijfel" of "slecht", met "toelichting".
Antwoord uitsluitend met JSON: {"per_fout": [{"echt_fout": "...", "wezenlijk": "...", "toelichting": "..."}], "extra_fouten": [{"citaat": "...", "waarom": "..."}], "juiste_tekst_klopt": "...", "geloofwaardig": 3, "oordeel": "...", "toelichting": "..."}`;

function sourcesText(chunks) { return srcText(chunks); }

// Productieweg (server/explain/flawedExplanations.js), met de pogingen bewaard voor de meting.
async function makeExercise(concept, chunks, related) {
  const attempts = [];
  const t0 = Date.now();
  const r = await prodMakeExercise({
    concept, chunks, related,
    llmJson: (system, user, { effort }) => llm(system, user, effort === 'low' ? EFFORT.generate : EFFORT.verify),
    onAttempt: (x) => attempts.push(x),
  });
  const accepted = attempts.find(x => x.ok) || null;
  return { k: r.k, attempts, ms: Date.now() - t0, accepted };
}

async function judge(concept, chunks, g) {
  return llm(JUDGE_SYSTEM, `Begrip: ${concept.name}\n\nBronfragmenten:\n${sourcesText(chunks)}\n\nBedoelde juiste uitleg:\n${g.juist}\n\nUitleg met fouten:\n${g.fout}\n\nBedoelde fouten:\n${JSON.stringify(g.fouten, null, 2)}`, EFFORT.judge);
}

function judgePass(j, k) {
  if (!j) return 'geen oordeel';
  const per = Array.isArray(j.per_fout) ? j.per_fout : [];
  if (per.length !== k) return j.oordeel === 'goed' ? 'goed' : j.oordeel || 'onbekend';
  const allReal = per.every(p => p.echt_fout === 'ja' && p.wezenlijk === 'ja');
  const anyNo = per.some(p => p.echt_fout === 'nee');
  const extra = (j.extra_fouten || []).length > 0;
  if (allReal && !extra && j.juiste_tekst_klopt === 'ja' && j.oordeel === 'goed') return 'goed';
  if (anyNo || j.oordeel === 'slecht') return 'slecht';
  return 'twijfel';
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }));
  return out;
}

// ── Begrippen kiezen ──
const { data: courses } = await db.from('courses').select('id, name');
const work = [];
for (const name of COURSE_NAMES) {
  const course = courses.find(c => c.name === name);
  if (!course) { console.warn('Cursus niet gevonden:', name); continue; }
  const { data: assigns } = await db.from('course_folder_assignments').select('folder_id').eq('course_id', course.id);
  const { data: docs } = await db.from('documents').select('id, purpose').in('folder_id', (assigns || []).map(a => a.folder_id));
  const docIds = (docs || []).filter(d => d.purpose === 'course_material').map(d => d.id);
  const { data: concepts } = await db.from('concepts').select('id, name, definition').eq('course_id', course.id).eq('review_status', 'approved').limit(2000);
  const all = concepts || [];
  for (const c of shuffle([...all]).slice(0, PER_COURSE)) work.push({ course: course.name, concept: c, docIds, allNames: all.map(x => x.name) });
}
console.log(`${work.length} begrippen uit ${COURSE_NAMES.length} cursussen; model ${MODEL}; inspanning ${JSON.stringify(EFFORT)}; max ${MAX_ATTEMPTS} pogingen`);

const results = await pool(work, CONCURRENCY, async (w, idx) => {
  const chunks = await retrieve(w.concept, w.docIds);
  if (chunks.length < 2) { console.log(`[${idx + 1}] ${w.concept.name}: te weinig bewijs (${chunks.length})`); return { ...w, skipped: true }; }
  const text = chunks.map(c => c.content).join(' ').toLowerCase();
  const related = w.allNames.filter(n => n !== w.concept.name && n.length > 3 && text.includes(n.toLowerCase())).slice(0, 8);
  const ex = await makeExercise(w.concept, chunks, related);
  let j = null, jRejected = null;
  if (ex.accepted) j = await judge(w.concept, chunks, ex.accepted.g);
  const firstRejected = ex.attempts.find(a => !a.ok && a.v);
  if (firstRejected) jRejected = await judge(w.concept, chunks, firstRejected.g);
  const verdict = ex.accepted ? judgePass(j, ex.k) : null;
  console.log(`[${idx + 1}] ${w.course} · ${w.concept.name}: K=${ex.k}, ${ex.accepted ? `goedgekeurd bij poging ${ex.accepted.attempt}` : 'geen oefening'} (${(ex.ms / 1000).toFixed(0)}s)${verdict ? ` → beoordelaar: ${verdict}` : ''}`);
  return { ...w, chunks: chunks.length, related, ...ex, judge: j, verdict, judgeRejected: jRejected, verdictRejected: jRejected ? judgePass(jRejected, ex.k) : null };
});

// ── Cijfers ──
const done = results.filter(r => !r.skipped);
const acc = done.filter(r => r.accepted);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const firstTry = done.filter(r => r.attempts[0]?.ok).length;
const verdicts = { goed: 0, twijfel: 0, slecht: 0 };
for (const r of acc) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1;
const rej = done.filter(r => r.verdictRejected);
const rejGood = rej.filter(r => r.verdictRejected === 'goed').length;
const ms = acc.map(r => r.ms).sort((a, b) => a - b);
const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
const p90 = ms.length ? ms[Math.floor(ms.length * 0.9)] : 0;
const believ = acc.map(r => Number(r.judge?.geloofwaardig) || 0).filter(Boolean);
const byK = [1, 2, 3].map(k => { const s = acc.filter(r => r.k === k); return `K=${k}: ${s.filter(r => r.verdict === 'goed').length}/${s.length} goed`; });
const reasons = {};
for (const r of done) for (const a of r.attempts) if (!a.ok) reasons[a.reason] = (reasons[a.reason] || 0) + 1;
const cost = (usage.in * PRICE.in + usage.out * PRICE.out) / 1e6;

const summary = [
  `Begrippen: ${work.length}; met genoeg bewijs: ${done.length}`,
  `Oefening gemaakt (≤${MAX_ATTEMPTS} pogingen): ${acc.length}/${done.length} (${pct(acc.length, done.length)}); in één keer: ${pct(firstTry, done.length)}`,
  `Onafhankelijke beoordelaar over goedgekeurde oefeningen: goed ${verdicts.goed} (${pct(verdicts.goed, acc.length)}), twijfel ${verdicts.twijfel} (${pct(verdicts.twijfel, acc.length)}), slecht ${verdicts.slecht} (${pct(verdicts.slecht, acc.length)})`,
  `Per aantal fouten: ${byK.join(' · ')}`,
  `Geloofwaardigheid (1-5, beoordelaar): gemiddeld ${(believ.reduce((a, b) => a + b, 0) / (believ.length || 1)).toFixed(1)}`,
  `Afgekeurde pogingen die de beoordelaar toch "goed" vond (controle te streng?): ${rejGood}/${rej.length}`,
  `Redenen van afkeuring: ${Object.entries(reasons).map(([k, v]) => `${k} (${v})`).join('; ') || '–'}`,
  `Wachttijd voor de student (maken + controle, incl. herkansingen): mediaan ${(med / 1000).toFixed(0)}s, 90% binnen ${(p90 / 1000).toFixed(0)}s`,
  `Tokens (alles, incl. meting): ${usage.in} in / ${usage.out} uit in ${usage.calls} aanroepen ≈ $${cost.toFixed(2)} (aanname $${PRICE.in}/$${PRICE.out} per 1M)`,
  `Doelgrens: ≥90% van de goedgekeurde oefeningen "goed" → ${verdicts.goed / (acc.length || 1) >= 0.9 ? 'GEHAALD' : 'NIET GEHAALD'}`,
];
console.log('\n' + summary.join('\n'));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'flawed-explanations.json'), JSON.stringify({ summary, usage, results }, null, 2));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const rows = acc.map(r => `<section><h3>${esc(r.course)} · ${esc(r.concept.name)} <small>K=${r.k} · poging ${r.accepted.attempt} · ${esc(r.verdict)}</small></h3>
<p><b>Met fouten:</b> ${esc(r.accepted.g.fout)}</p>
<ol>${r.accepted.g.fouten.map((f, i) => `<li><i>${esc(f.zin)}</i> — ${esc(f.soort)}: ${esc(f.waarom_fout)} <br><small>beoordelaar: echt fout ${esc(r.judge?.per_fout?.[i]?.echt_fout)}, wezenlijk ${esc(r.judge?.per_fout?.[i]?.wezenlijk)} — ${esc(r.judge?.per_fout?.[i]?.toelichting)}</small></li>`).join('')}</ol>
<p><small>Oordeel beoordelaar: ${esc(r.judge?.oordeel)} — ${esc(r.judge?.toelichting)}${(r.judge?.extra_fouten || []).length ? ` · extra fouten: ${esc(JSON.stringify(r.judge.extra_fouten))}` : ''}</small></p></section>`).join('\n');
fs.writeFileSync(path.join(OUT, 'flawed-explanations.html'), `<!doctype html><meta charset="utf-8"><title>Pilot Verbeter deze uitleg</title><style>body{font-family:system-ui;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.45}section{border-top:1px solid #ddd;padding:.5rem 0}small{color:#555}</style><h1>Pilot "Verbeter deze uitleg"</h1><pre>${esc(summary.join('\n'))}</pre>${rows}`);
console.log(`\nRapport: ${path.join(OUT, 'flawed-explanations.html')}`);
