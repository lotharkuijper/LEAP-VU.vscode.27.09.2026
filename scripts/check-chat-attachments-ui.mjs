#!/usr/bin/env node
// Bijlagen in de chat in een echte browser (Edge via playwright-core):
//   - plakken van een schermafbeelding in het chatvenster geeft een voorbeeld,
//   - versturen: de tutor begint met "Dit zie ik:", het bericht toont de miniatuur,
//   - na herladen is de afbeelding weg en staat alleen het label er nog,
//   - beheer: blok "Bijlagen in de chat" met waarschuwing en dubbele bevestiging,
//   - beheer: hoofdschakelaar onder Instellingen.
// Zet de platformschakelaar tijdelijk aan en zet alles aan het eind terug.
// Vereist: de app draait (npm run dev) en het testaccount bestaat.
//   node --env-file=.env scripts/check-chat-attachments-ui.mjs [afbeelding.png] [map-voor-schermafbeeldingen]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.UI_AUDIT_BASE || 'http://localhost:5000';
const [imgArg, shotsArg] = process.argv.slice(2);
const shots = shotsArg || 'ui-audit-output/chat-bijlagen';
fs.mkdirSync(shots, { recursive: true });
const img = imgArg || 'attached_assets/image_1776096257596.png';
const imgB64 = fs.readFileSync(img).toString('base64');

const KEY = '__chat_attachments__';
const url = process.env.VITE_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: me } = await admin.from('profiles').select('id, last_active_course_id').eq('email', process.env.UI_AUDIT_EMAIL).maybeSingle();
const courseId = me?.last_active_course_id;
const { data: course } = await admin.from('courses').select('id, name, features').eq('id', courseId).maybeSingle();
const { data: platformRow } = await admin.from('chatbot_prompts').select('id, content').eq('name', KEY).maybeSingle();

const results = [];
const check = (label, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'NEE '} ${label}${extra ? ` (${extra})` : ''}`); };
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  const content = JSON.stringify({ enabled: true, detail: 'high' });
  if (platformRow) await admin.from('chatbot_prompts').update({ content }).eq('id', platformRow.id);
  else await admin.from('chatbot_prompts').insert({ name: KEY, content, is_active: false });
  await new Promise(r => setTimeout(r, 15500)); // server onthoudt de instelling 15 s

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('input-email').fill(process.env.UI_AUDIT_EMAIL);
  await page.getByTestId('input-password').fill(process.env.UI_AUDIT_PASSWORD);
  await page.getByTestId('button-login').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /nieuwe chat|new chat/i }).first().click();
  const input = page.getByTestId('input-chat-message');
  await input.waitFor({ timeout: 30000 });
  await page.getByTestId('button-chat-attach').waitFor({ timeout: 15000 });
  check('paperclip zichtbaar', true);

  // Plakken zoals na Windows+Shift+S.
  await input.click();
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    const ta = document.querySelector('[data-testid="input-chat-message"]');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, imgB64);
  await page.getByTestId('chip-attachment-image').waitFor({ timeout: 15000 });
  check('plakken: voorbeeld van de afbeelding', true);
  check('melding over niet bewaren', await page.getByTestId('text-chat-attachments-notice').isVisible());
  await shot(page, '1-geplakt');

  await input.fill('Ik snap deze grafiek niet. Wat laat hij zien?');
  await input.press('Enter');
  const answer = page.locator('text=/Dit zie ik/i').first();
  await answer.waitFor({ timeout: 120000 });
  check('tutor begint met "Dit zie ik:"', true);
  check('miniatuur bij het verstuurde bericht', await page.locator('[data-testid="list-sent-attachments"] img').first().isVisible());
  await shot(page, '2-antwoord');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('list-sent-attachments').first().waitFor({ timeout: 30000 });
  const imgsAfter = await page.locator('[data-testid="list-sent-attachments"] img').count();
  const label = await page.getByTestId('list-sent-attachments').first().innerText();
  check('na herladen: afbeelding weg, label staat er nog', imgsAfter === 0 && /niet bewaard|not stored/i.test(label), label.trim());
  await shot(page, '3-na-herladen');

  // Beheer: Onderdelen.
  await page.goto(`${BASE}/admin?tab=course_features`, { waitUntil: 'domcontentloaded' });
  const section = page.getByTestId('section-course-attachments');
  await section.waitFor({ timeout: 30000 });
  await section.scrollIntoViewIfNeeded();
  await shot(page, '4-onderdelen');
  await page.getByTestId('switch-feature-attachments').click();
  await page.getByTestId('dialog-attachments-confirm').waitFor();
  check('aanzetten opent de waarschuwing', true);
  check('"Verder" pas na het vinkje', await page.getByTestId('button-attachments-next').isDisabled());
  await shot(page, '5-waarschuwing');
  await page.getByTestId('checkbox-attachments-understood').check();
  await page.getByTestId('button-attachments-next').click();
  await shot(page, '6-tweede-bevestiging');
  await page.getByTestId('button-attachments-confirm').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="switch-feature-attachments"]')?.getAttribute('aria-checked') === 'true', null, { timeout: 15000 });
  const { data: after } = await admin.from('courses').select('features').eq('id', courseId).maybeSingle();
  check('na dubbele bevestiging aan (database)', after?.features?.attachments === true);
  const { data: log } = await admin.from('leap_setting_changes').select('setting, value').eq('course_id', courseId).order('created_at', { ascending: false }).limit(1);
  check('wijziging in het logboek', log?.[0]?.setting === 'chat_attachments' && log?.[0]?.value?.on === true);
  await page.getByTestId('switch-feature-attachments').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="switch-feature-attachments"]')?.getAttribute('aria-checked') === 'false', null, { timeout: 15000 });
  check('uitzetten met één klik', true);

  // Beheer: Instellingen.
  await page.goto(`${BASE}/admin?tab=settings`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('panel-chat-attachments-platform').waitFor({ timeout: 30000 });
  await page.getByTestId('switch-chat-attachments-platform').waitFor({ timeout: 15000 });
  check('hoofdschakelaar bij Instellingen', true);
  await shot(page, '7-instellingen');
} catch (e) {
  check('onverwachte fout', false, e.message);
  await shot(page, 'fout').catch(() => {});
} finally {
  await browser.close();
  await admin.from('courses').update({ features: course?.features || {} }).eq('id', courseId);
  if (platformRow) await admin.from('chatbot_prompts').update({ content: platformRow.content }).eq('id', platformRow.id);
  else await admin.from('chatbot_prompts').delete().eq('name', KEY);
  console.log(`Schakelaars teruggezet. Schermafbeeldingen: ${shots}`);
}
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
