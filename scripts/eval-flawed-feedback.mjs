#!/usr/bin/env node
// IJking van de BEOORDELING bij "Verbeter deze uitleg" (server/flawedExplanations.js),
// tegen het echte model. Schrijft niets weg. Per begrip maakt het script een echte
// oefening en stuurt er vier gesimuleerde antwoorden op in:
//   A  alle fouten gevonden en goed uitgelegd      → verwacht: gevonden = totaal, niets onterecht
//   B  alleen de eerste fout (bij ≥2 fouten)       → verwacht: gevonden = 1
//   C  juiste zinnen aangewezen, verkeerde uitleg  → verwacht: gevonden < totaal
//   D  alles goed + een juiste zin als fout        → verwacht: gevonden = totaal én iets onterecht aangewezen
//
//   node --env-file=.env scripts/eval-flawed-feedback.mjs [begrippen=8]
import { createClient } from '@supabase/supabase-js';
import { computeChatConfig } from '../server/chatConfig.js';
import { makeExercise, evaluationSystem, evaluationUser, parseEvaluation } from '../server/flawedExplanations.js';

const N = Number(process.argv[2] || 8);
const COURSE_NAMES = (process.env.EVAL_COURSES || 'E&B1,Methodologie 2 - Gezondheidswetenschappen,Microbiologie').split(',').map(s => s.trim());
const cfg = computeChatConfig(process.env);
const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.OPENAI_MODEL || '';
const REASONING = /^(gpt-5|o1|o3|o4)/i.test(MODEL);
const EMB_URL = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${encodeURIComponent(process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT)}/embeddings?api-version=${process.env.AZURE_OPENAI_EMBEDDING_API_VERSION || process.env.AZURE_OPENAI_API_VERSION}`;
const db = createClient(process.env.VITE_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function chat(system, user, effort, json) {
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (json) body.response_format = { type: 'json_object' };
  if (REASONING) { body.max_completion_tokens = 14000; body.reasoning_effort = effort; } else { body.max_tokens = 4000; body.temperature = 0.7; }
  for (let i = 0; i < 4; i++) {
    const r = await fetch(cfg.chatUrl, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 3000 * (i + 1))); continue; }
    return (await r.json())?.choices?.[0]?.message?.content || '';
  }
  return '';
}
const llmJson = async (s, u, { effort }) => { try { return JSON.parse(await chat(s, u, effort, true)); } catch { return null; } };

async function chunksFor(concept, docIds) {
  const out = [];
  const { data: ev } = await db.from('concept_evidence').select('chunk_id').eq('concept_id', concept.id).order('similarity', { ascending: false }).limit(12);
  const ids = [...new Set((ev || []).map(e => e.chunk_id).filter(Boolean))].slice(0, 6);
  if (ids.length) { const { data } = await db.from('document_chunks').select('id, content').in('id', ids); out.push(...(data || [])); }
  if (out.length < 6) {
    const r = await fetch(EMB_URL, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input: [`${concept.name}. ${concept.definition || ''}`] }) });
    const emb = (await r.json())?.data?.[0]?.embedding;
    if (emb) {
      const { data } = await db.rpc('match_document_chunks', { query_embedding: emb, match_threshold: 0, match_count: 40, filter_document_ids: docIds });
      for (const c of (data || []).filter(c => c.similarity >= 0.3)) { if (out.length >= 6) break; if (!out.some(o => o.id === c.id)) out.push(c); }
    }
  }
  return out;
}

const sentences = (t) => t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

const { data: courses } = await db.from('courses').select('id, name');
const picks = [];
for (const name of COURSE_NAMES) {
  const course = courses.find(c => c.name === name);
  if (!course) continue;
  const { data: assigns } = await db.from('course_folder_assignments').select('folder_id').eq('course_id', course.id);
  const { data: docs } = await db.from('documents').select('id, purpose').in('folder_id', (assigns || []).map(a => a.folder_id));
  const docIds = (docs || []).filter(d => d.purpose === 'course_material').map(d => d.id);
  const { data: concepts } = await db.from('concepts').select('id, name, definition').eq('course_id', course.id).eq('review_status', 'approved').limit(2000);
  for (const c of (concepts || []).sort(() => Math.random() - 0.5).slice(0, Math.ceil(N / COURSE_NAMES.length))) picks.push({ concept: c, docIds });
}

const tally = { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0] };
for (const { concept, docIds } of picks.slice(0, N)) {
  const chunks = await chunksFor(concept, docIds);
  if (chunks.length < 2) continue;
  const r = await makeExercise({ concept, chunks, llmJson });
  if (!r.ok) { console.log(`${concept.name}: geen oefening`); continue; }
  const e = r.exercise;
  const sources = chunks.map((c, i) => ({ index: i + 1, excerpt: String(c.content).slice(0, 700) }));
  const payload = { ...e, sources };
  const good = (x) => `"${x.sentence}" klopt niet: ${x.why} Juist is: ${x.correct}`;
  const correctSentence = sentences(e.flawed).find(s => e.errors.every(x => !s.includes(x.sentence.slice(0, 20))));
  const answers = {
    A: e.errors.map(good).join('\n'),
    B: e.errors.length >= 2 ? good(e.errors[0]) : null,
    C: e.errors.map(x => `"${x.sentence}" klopt niet, want het is te kort geformuleerd.`).join('\n'),
    D: correctSentence ? `${e.errors.map(good).join('\n')}\n"${correctSentence}" klopt ook niet.` : null,
  };
  const line = [];
  for (const [k, ans] of Object.entries(answers)) {
    if (!ans) continue;
    const raw = await chat(evaluationSystem('nl'), evaluationUser({ concept: concept.name, payload, answer: ans }), 'low', false);
    const p = parseEvaluation(raw, e.errors.length);
    const f = p?.found;
    const ok = k === 'A' ? f === e.errors.length && !p?.wronglyFlagged
      : k === 'B' ? f === 1
      : k === 'C' ? f != null && f < e.errors.length
      : f === e.errors.length && !!p?.wronglyFlagged;
    tally[k][0] += ok ? 1 : 0; tally[k][1]++;
    line.push(`${k}:${f ?? '?'}/${e.errors.length}${p?.wronglyFlagged ? '+onterecht' : ''}${ok ? '' : ' ✗'}`);
  }
  console.log(`${concept.name} (${e.errors.length} fout${e.errors.length > 1 ? 'en' : ''}): ${line.join('  ')}`);
}
console.log('\nVerwacht oordeel gehaald:');
for (const [k, [ok, n]] of Object.entries(tally)) console.log(`  ${k}: ${ok}/${n}`);
const total = Object.values(tally).reduce((a, [ok, n]) => [a[0] + ok, a[1] + n], [0, 0]);
console.log(`Totaal: ${total[0]}/${total[1]} (${Math.round((100 * total[0]) / (total[1] || 1))}%)`);
