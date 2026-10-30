#!/usr/bin/env node
// Bijlagen in de chat end-to-end tegen de draaiende API (docs/plans/chat-bijlagen-plan.html).
//
// Gebruik: node --env-file=.env scripts/check-chat-attachments.mjs [afbeelding.png] [bestand.pdf]
//
// Met het testaccount (scripts/ui-audit-account.mjs). Zet tijdelijk de
// platformschakelaar en de cursusschakelaar aan (service role) en zet ze aan
// het eind terug zoals ze waren. Controleert: config, afbeelding → "Dit zie
// ik:", bestand uitlezen en bespreken, weigering bij platform uit en cursus
// uit, en dat de database geen ingebed bestand in een bericht accepteert.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const API = process.env.LEAP_API_URL || 'http://localhost:3001';
const url = process.env.VITE_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const anon = process.env.VITE_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const [imgArg, pdfArg] = process.argv.slice(2);
if (!process.env.UI_AUDIT_EMAIL || !process.env.UI_AUDIT_PASSWORD) {
  console.error('Testaccount ontbreekt: node --env-file=.env scripts/ui-audit-account.mjs create');
  process.exit(1);
}
const KEY = '__chat_attachments__';
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const sb = createClient(url, anon, { auth: { persistSession: false } });
const { data: login, error: loginErr } = await sb.auth.signInWithPassword({ email: process.env.UI_AUDIT_EMAIL, password: process.env.UI_AUDIT_PASSWORD });
if (loginErr) { console.error('Inloggen mislukt:', loginErr.message); process.exit(1); }
const token = login.session.access_token;
const userId = login.user.id;

const { data: prof } = await admin.from('profiles').select('role').eq('id', userId).maybeSingle();
const { data: memberships } = await admin.from('course_members').select('course_id, member_role').eq('user_id', userId);
const courseId = process.env.EVAL_COURSE_ID || memberships?.find(m => m.member_role !== 'teacher')?.course_id || memberships?.[0]?.course_id || '8ca986e2-67f8-48ca-938d-4b77b841b398'; // E&B1, zoals eval-level-language
if (!courseId) { console.error('Testaccount is geen lid van een cursus.'); process.exit(1); }
const { data: course } = await admin.from('courses').select('id, name, features').eq('id', courseId).maybeSingle();
const { data: platformRow } = await admin.from('chatbot_prompts').select('id, content').eq('name', KEY).maybeSingle();
console.log(`testaccount rol=${prof?.role} cursus="${course.name}"`);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FOUT'} ${name}${detail ? ` — ${detail}` : ''}`); };
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-LEAP-Lang': 'nl' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const setPlatform = async (enabled) => {
  const content = JSON.stringify({ enabled, detail: 'high' });
  const { data: row } = await admin.from('chatbot_prompts').select('id').eq('name', KEY).maybeSingle();
  if (row) await admin.from('chatbot_prompts').update({ content }).eq('id', row.id);
  else await admin.from('chatbot_prompts').insert({ name: KEY, content, is_active: false });
};
const setCourse = async (on) => {
  const f = { ...(course.features || {}) };
  if (on) f.attachments = true; else delete f.attachments;
  await admin.from('courses').update({ features: f }).eq('id', courseId);
};
// De server onthoudt instellingen 15 s.
const settle = () => new Promise(r => setTimeout(r, 15500));

const img = imgArg;
if (!img) { console.error('Geef een testafbeelding (png) mee als eerste argument.'); process.exit(1); }
const imageData = `data:image/png;base64,${fs.readFileSync(img).toString('base64')}`;
const chatBody = (attachments, text = 'Ik snap deze afbeelding niet goed. Wat staat erop?') => ({
  messages: [{ role: 'user', content: text }],
  courseId, purpose: 'tutor_chat', lang: 'nl', learningLevel: 3, attachments,
});

try {
  await setPlatform(true);
  await setCourse(true);
  await settle();

  const cfg = await api('GET', `/api/chat/attachments/config?courseId=${courseId}`);
  check('config: beschikbaar als platform en cursus aan staan', cfg.status === 200 && cfg.body?.available === true, JSON.stringify({ reason: cfg.body?.reason }));

  const t0 = Date.now();
  const withImage = await api('POST', '/api/chat', chatBody([{ kind: 'image', name: 'test.png', dataUrl: imageData }]));
  const answer = withImage.body?.choices?.[0]?.message?.content || '';
  check('afbeelding: model beschrijft eerst wat het ziet', withImage.status === 200 && /Dit zie ik/i.test(answer), `${withImage.status}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log('---\n' + answer.slice(0, 700) + '\n---');

  const pdf = pdfArg;
  if (!pdf) throw new Error('Geef een test-pdf mee als argument (geen auteursrechtelijk materiaal in de repo).');
  const ex = await api('POST', '/api/chat/attachments/extract', { courseId, name: 'hoofdstuk.pdf', data: fs.readFileSync(pdf).toString('base64') });
  check('bestand: tekst uit PDF gehaald', ex.status === 200 && ex.body?.chars > 1000 && !ex.body?.scanned, `${ex.body?.pages} pagina's, ${ex.body?.chars} tekens, afgekapt=${ex.body?.truncated}`);
  const withFile = await api('POST', '/api/chat', chatBody([{ kind: 'file', name: 'hoofdstuk.pdf', text: ex.body?.text || '', pages: ex.body?.pages, isNew: true }], 'Waar gaat dit bestand over, in twee zinnen?'));
  check('bestand: tutor bespreekt de inhoud', withFile.status === 200 && (withFile.body?.choices?.[0]?.message?.content || '').length > 40, `${withFile.status}`);

  const bad = await api('POST', '/api/chat/attachments/extract', { courseId, name: 'nep.pdf', data: Buffer.from('geen pdf').toString('base64') });
  check('bestand: nep-PDF geweigerd', bad.status === 400 && bad.body?.code === 'attachments_type');

  const spoof = await api('POST', '/api/chat', chatBody([{ kind: 'image', name: 'x.png', dataUrl: `data:image/png;base64,${Buffer.from('<svg/> geen plaatje hoor').toString('base64')}` }]));
  check('afbeelding: nep-afbeelding geweigerd', spoof.status === 400);

  const noPurpose = await api('POST', '/api/chat', { ...chatBody([{ kind: 'image', name: 'test.png', dataUrl: imageData }]), purpose: undefined });
  check('alleen in de tutorchat', noPurpose.status === 400);

  const { error: dbErr } = await sb.from('messages').insert({ conversation_id: '00000000-0000-0000-0000-000000000000', role: 'user', content: `kijk ${imageData.slice(0, 80)}` });
  check('database weigert een ingebed bestand in een bericht', !!dbErr && /Bijlagen worden niet bewaard/.test(dbErr.message), dbErr?.message);

  await setPlatform(false);
  await settle();
  const off = await api('POST', '/api/chat', chatBody([{ kind: 'image', name: 'test.png', dataUrl: imageData }]));
  check('platform uit: geweigerd', off.status === 403 && off.body?.code === 'attachments_disabled' && off.body?.reason === 'platform_off');
  const cfgOff = await api('GET', `/api/chat/attachments/config?courseId=${courseId}`);
  check('platform uit: config zegt tijdelijk niet beschikbaar', cfgOff.body?.available === false && cfgOff.body?.courseOn === true && cfgOff.body?.platformEnabled === false);

  await setPlatform(true);
  await setCourse(false);
  await settle();
  const courseOff = await api('POST', '/api/chat', chatBody([{ kind: 'image', name: 'test.png', dataUrl: imageData }]));
  const isStaffTest = prof?.role === 'admin' || memberships?.some(m => m.course_id === courseId && m.member_role === 'teacher');
  check(isStaffTest ? 'cursus uit: staf mag testen' : 'cursus uit: student geweigerd',
    isStaffTest ? courseOff.status === 200 : (courseOff.status === 403 && courseOff.body?.reason === 'course_off'));
  const plain = await api('POST', '/api/chat', chatBody(undefined, 'Wat is een begrip?'));
  check('chat zonder bijlage werkt gewoon', plain.status === 200);
} finally {
  // Terugzetten zoals het was.
  await admin.from('courses').update({ features: course.features || {} }).eq('id', courseId);
  if (platformRow) await admin.from('chatbot_prompts').update({ content: platformRow.content }).eq('id', platformRow.id);
  else await admin.from('chatbot_prompts').delete().eq('name', KEY);
  console.log('Schakelaars teruggezet.');
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
