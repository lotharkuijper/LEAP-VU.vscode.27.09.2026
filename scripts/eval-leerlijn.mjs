#!/usr/bin/env node
// Meting leerlijn (server/courseUnits.js) tegen het echte model. Schrijft niets
// weg. Een vraag uit een VROEG onderdeel, drie varianten van de systeemprompt:
//   A  zonder leerlijn
//   B  met leerlijn; het LATE onderdeel is nog niet geoefend
//   C  met leerlijn; het LATE onderdeel is al geoefend
// Telt hoe vaak het antwoord termen uit het late onderdeel gebruikt.
// Verwacht: B duidelijk minder dan A, en C weer meer dan B.
//
//   node --env-file=.env scripts/eval-leerlijn.mjs [herhalingen=3]
// Standaard E&B1: vroeg = "Studiedesigns", laat = "Toetsen"; aan te passen met
// EVAL_COURSE_ID, EVAL_EARLY, EVAL_LATE, EVAL_QUESTION, EVAL_LATE_TERMS (regex).
import { createClient } from '@supabase/supabase-js';
import { computeChatConfig } from '../server/chatConfig.js';
import { proposeUnits, buildLeerlijnBlock } from '../server/courseUnits.js';

const REPEATS = Number(process.argv[2] || 3);
const COURSE = process.env.EVAL_COURSE_ID || '8ca986e2-67f8-48ca-938d-4b77b841b398';
const EARLY = (process.env.EVAL_EARLY || 'studiedesign').toLowerCase();
const LATE = (process.env.EVAL_LATE || 'toetsen').toLowerCase();
const QUESTION = process.env.EVAL_QUESTION || 'Hoe kom je er bij een onderzoek achter of een verband tussen een blootstelling en een uitkomst echt bestaat?';
const LATE_TERMS = new RegExp(process.env.EVAL_LATE_TERMS || 'toets|p-waarde|significan|nulhypothese|alternatieve hypothese', 'gi');

const cfg = computeChatConfig(process.env);
const MODEL = process.env.OPENAI_MODEL || '';
const REASONING = /^(gpt-5|o1|o3|o4)/i.test(MODEL);
const db = createClient(process.env.VITE_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: assigns } = await db.from('course_folder_assignments').select('folder_id').eq('course_id', COURSE);
const { data: docs } = await db.from('documents').select('id, title, filename, purpose').in('folder_id', (assigns || []).map((a) => a.folder_id));
const material = (docs || []).filter((d) => d.purpose === 'course_material');
const proposal = proposeUnits(material);
const units = proposal.units.map((u, i) => ({ id: `u${i}`, title: u.title, position: u.position }));
const docUnit = new Map();
proposal.units.forEach((u, i) => u.documentIds.forEach((d) => docUnit.set(d, `u${i}`)));
const early = units.find((u) => u.title.toLowerCase().includes(EARLY));
const late = units.find((u) => u.title.toLowerCase().includes(LATE));
if (!early || !late) { console.error('Onderdelen niet gevonden:', units.map((u) => u.title).join(', ')); process.exit(1); }
const earlyDocs = [...docUnit].filter(([, u]) => u === early.id).map(([d]) => d);
const { data: chunks } = await db.from('document_chunks').select('content, document_id').in('document_id', earlyDocs).order('chunk_index').limit(6);
const docTitle = new Map(material.map((d) => [d.id, d.title]));
const context = (chunks || []).map((c, i) => `[Bron ${i + 1}: ${docTitle.get(c.document_id)}]\n${c.content.slice(0, 1800)}`).join('\n\n---\n\n');
const sources = earlyDocs.map((d) => ({ documentId: d, title: docTitle.get(d) }));

const base = 'Je bent een tutor voor studenten. Leg helder uit, baseer je op het cursusmateriaal en eindig met één vraag aan de student.'
  + `\n\nContext uit cursusmateriaal:\n${context}`;
const variants = {
  A: base,
  B: base + buildLeerlijnBlock({ units, anchor: early, practiced: new Set(), sources, docUnit }),
  C: base + buildLeerlijnBlock({ units, anchor: early, practiced: new Set([late.id]), sources, docUnit }),
};

async function ask(system) {
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: QUESTION }], [REASONING ? 'max_completion_tokens' : 'max_tokens']: 1500 };
  if (REASONING) body.reasoning_effort = 'low';
  const r = await fetch(cfg.chatUrl, { method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  return d?.choices?.[0]?.message?.content || '';
}

console.log(`Vroeg: "${early.title}" (positie ${early.position}); laat: "${late.title}" (positie ${late.position}); ${REPEATS}x per variant`);
const result = {};
for (const [k, sys] of Object.entries(variants)) {
  const counts = [];
  for (let i = 0; i < REPEATS; i++) {
    const answer = await ask(sys);
    counts.push((answer.match(LATE_TERMS) || []).length);
    if (i === 0) console.log(`\n── ${k} (eerste antwoord, ingekort) ──\n${answer.slice(0, 600)}`);
  }
  result[k] = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`${k}: termen uit "${late.title}" per antwoord: ${counts.join(', ')} (gemiddeld ${result[k].toFixed(1)})`);
}
const ok = result.B < result.A && result.C > result.B;
console.log(`\n${ok ? 'OK' : 'NIET OK'}: A ${result.A.toFixed(1)} · B ${result.B.toFixed(1)} · C ${result.C.toFixed(1)} (verwacht B < A en C > B)`);
process.exit(ok ? 0 : 1);
