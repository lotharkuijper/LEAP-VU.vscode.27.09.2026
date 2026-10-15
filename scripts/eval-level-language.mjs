#!/usr/bin/env node
// Doet het leerniveau in de chat echt iets met de taal? (2026-10-15)
//
// Stelt dezelfde vragen op niveau 1..5 aan de echte /api/chat (met het
// testaccount uit scripts/ui-audit-account.mjs) en meet per antwoord:
//   - LIX (leesbaarheid; hoger = moeilijker; ~30 eenvoudig, >50 moeilijk),
//   - woorden per zin, aandeel lange woorden (>6 letters),
//   - vaktermen uit een vaste lijst.
// Het aantal zinnen laat zien of het kader van de docent (bv. "maximaal 3-4 zinnen")
// gerespecteerd wordt: de docent bepaalt het soort reactie, het niveau hoe technisch.
// Elke combinatie wordt meerdere keren gesteld (ruis); het script toont het
// gemiddelde per niveau en controleert de doelen:
//   - LIX stijgt van niveau 1 naar 5 (gemiddeld);
//   - niveau 1: gemiddeld hoogstens 1 vakterm;
//   - niveau 5 duidelijk moeilijker dan niveau 1 (LIX-verschil >= 10).
//
// Gebruik (lokale API op poort 3001 moet draaien):
//   node --env-file=.env scripts/eval-level-language.mjs [herhalingen=3] [uitvoer.json]
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const REPEATS = Number(process.argv[2] || 3);
const OUT = process.argv[3] || null;
const API = process.env.LEAP_API_URL || 'http://localhost:3001';
const COURSE = process.env.EVAL_COURSE_ID || '8ca986e2-67f8-48ca-938d-4b77b841b398'; // E&B1

const url = process.env.VITE_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const anon = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
if (!process.env.UI_AUDIT_EMAIL || !process.env.UI_AUDIT_PASSWORD) {
  console.error('Testaccount ontbreekt: node --env-file=.env scripts/ui-audit-account.mjs create');
  process.exit(1);
}
const sb = createClient(url, anon, { auth: { persistSession: false } });
const { data: login, error } = await sb.auth.signInWithPassword({ email: process.env.UI_AUDIT_EMAIL, password: process.env.UI_AUDIT_PASSWORD });
if (error) { console.error('Inloggen mislukt:', error.message); process.exit(1); }
const token = login.session.access_token;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Cursusfragmenten bij het begrip, zoals de chat ze ook als context meekrijgt.
async function evidenceContext(name) {
  const { data: c } = await admin.from('concepts').select('id').eq('course_id', COURSE).ilike('name', name).limit(1).maybeSingle();
  if (!c) return {};
  const { data: ev } = await admin.from('concept_evidence').select('snippet, document_id')
    .eq('concept_id', c.id).order('similarity', { ascending: false }).limit(4);
  if (!ev?.length) return {};
  return {
    context: ev.map((e, i) => `[${i + 1}] ${e.snippet}`).join('\n\n'),
    sources: ev.map((e, i) => ({ index: i + 1, title: `Cursusdocument ${i + 1}`, documentId: e.document_id })),
  };
}

const JARGON = ['determinant', 'blootstelling', 'exposure', 'covariaat', 'stratific', 'causa', 'bias', 'vertekening', 'associatie',
  'effectmodificatie', 'collider', 'randomis', 'incidentie', 'prevalentie', 'multivariab', 'regressie', 'adjust', 'corrigeer',
  'relatief risico', 'risk ratio', 'variabele', 'observationeel', 'kruistabel', 'logistisch', 'significant', 'schatting',
  'mediator', 'intermediair', 'conditioneren', 'dichotoom', 'proportie', 'dag'];

export function languageMetrics(text) {
  const clean = String(text).replace(/\\\(.*?\\\)|\$[^$]*\$/g, ' ').replace(/[*_#>`\[\]()]/g, ' ');
  const sentences = clean.split(/[.!?]+(?:\s|$)/).map(s => s.trim()).filter(s => /\w/.test(s));
  const words = clean.match(/[A-Za-zÀ-ÿ'-]+/g) || [];
  const long = words.filter(w => w.length > 6).length;
  const wps = words.length / Math.max(1, sentences.length);
  const lower = String(text).toLowerCase();
  return {
    words: words.length,
    sentences: sentences.length,
    wordsPerSentence: wps,
    longWordPct: 100 * long / Math.max(1, words.length),
    lix: wps + 100 * long / Math.max(1, words.length),
    jargon: JARGON.filter(j => new RegExp(`\\b${j}`, 'i').test(lower)).length,
  };
}

const QUESTIONS = [
  { q: 'Wat is confounding?', concept: 'confounding' },
  { q: 'Ik snap niet goed wat een odds ratio is.', concept: '%odds ratio%' },
  { q: 'Wat is het verschil tussen incidentie en prevalentie?', concept: 'incidentie%' },
];

const rows = [];
for (const { q, concept } of QUESTIONS) {
  const ctx = await evidenceContext(concept);
  for (let level = 1; level <= 5; level++) {
    for (let rep = 0; rep < REPEATS; rep++) {
      const r = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-LEAP-Lang': 'nl' },
        body: JSON.stringify({ purpose: 'tutor_chat', courseId: COURSE, lang: 'nl', learningLevel: level, messages: [{ role: 'user', content: q }], ...ctx }),
      });
      const d = await r.json().catch(() => ({}));
      const text = d?.choices?.[0]?.message?.content;
      if (!text) { console.error(`Fout bij "${q}" niveau ${level}: ${r.status}`); continue; }
      rows.push({ q, level, rep, text, ...languageMetrics(text) });
      process.stdout.write('.');
    }
  }
}
console.log('');

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const perLevel = [1, 2, 3, 4, 5].map(level => {
  const rs = rows.filter(r => r.level === level);
  return {
    level, n: rs.length,
    lix: avg(rs.map(r => r.lix)), wps: avg(rs.map(r => r.wordsPerSentence)), sentences: avg(rs.map(r => r.sentences)),
    long: avg(rs.map(r => r.longWordPct)), jargon: avg(rs.map(r => r.jargon)), words: avg(rs.map(r => r.words)),
  };
});
console.log('niveau |  n |  LIX | w/zin | lang% | vaktermen | woorden | zinnen');
for (const p of perLevel) {
  console.log(`  ${p.level}    | ${String(p.n).padStart(2)} | ${p.lix.toFixed(1).padStart(4)} | ${p.wps.toFixed(1).padStart(5)} | ${p.long.toFixed(1).padStart(5)} | ${p.jargon.toFixed(1).padStart(9)} | ${p.words.toFixed(0).padStart(7)} | ${p.sentences.toFixed(1).padStart(6)}`);
}
const lix = perLevel.map(p => p.lix);
const checks = [
  ['LIX stijgt over de niveaus (hoogstens één kleine dip < 3)', lix.slice(1).every((v, i) => v >= lix[i] - 3) && lix[4] > lix[0]],
  ['niveau 1: gemiddeld hoogstens 1 vakterm', perLevel[0].jargon <= 1],
  ['niveau 5 duidelijk moeilijker dan niveau 1 (LIX +10)', lix[4] - lix[0] >= 10],
];
for (const [label, ok] of checks) console.log(`${ok ? 'OK  ' : 'NEE '} ${label}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ perLevel, rows }, null, 2));
