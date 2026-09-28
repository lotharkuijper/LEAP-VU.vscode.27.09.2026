#!/usr/bin/env node
// Testaccount voor de automatische schermcontrole (scripts/ui-audit.mjs).
//
//   node --env-file=.env scripts/ui-audit-account.mjs create   → maakt het account (beheerder)
//   node --env-file=.env scripts/ui-audit-account.mjs delete   → verwijdert het weer
//
// Het wachtwoord wordt ALLEEN in je lokale .env gezet (UI_AUDIT_EMAIL /
// UI_AUDIT_PASSWORD); .env staat nooit in git. Het account krijgt de rol admin
// en de eerste actieve cursus als actieve cursus, zodat alle pagina's en
// beheertabbladen te openen zijn.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const EMAIL = process.env.UI_AUDIT_EMAIL || 'leap-ui-audit@example.com';
const url = process.env.VITE_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Supabase-URL of service-role-sleutel ontbreekt in .env. Stop.'); process.exit(1); }
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUser() {
  for (let page = 1; page < 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find(u => u.email?.toLowerCase() === EMAIL.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

function writeEnv(password) {
  let env = fs.readFileSync('.env', 'utf8');
  const set = (k, v) => {
    const line = `${k}=${v}`;
    env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
  };
  set('UI_AUDIT_EMAIL', EMAIL);
  set('UI_AUDIT_PASSWORD', password);
  fs.writeFileSync('.env', env);
}

const cmd = process.argv[2];
if (cmd === 'create') {
  const password = crypto.randomBytes(18).toString('base64url');
  let user = await findUser();
  if (user) {
    const { error } = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    if (error) throw error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL, password, email_confirm: true,
      user_metadata: { full_name: 'UI-controle (testaccount)' },
    });
    if (error) throw error;
    user = data.user;
  }
  const { data: course } = await admin.from('courses').select('id').eq('is_active', true).order('created_at').limit(1).maybeSingle();
  const { error: pErr } = await admin.from('profiles').upsert({
    id: user.id, email: EMAIL, full_name: 'UI-controle (testaccount)', role: 'admin',
    last_active_course_id: course?.id ?? null, preferred_lang: 'nl',
  }, { onConflict: 'id' });
  if (pErr) throw pErr;
  writeEnv(password);
  console.log(`Testaccount klaar: ${EMAIL} (admin). Wachtwoord staat in .env (UI_AUDIT_PASSWORD).`);
} else if (cmd === 'delete') {
  const user = await findUser();
  if (!user) { console.log('Geen testaccount gevonden.'); process.exit(0); }
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw error;
  console.log(`Testaccount ${EMAIL} verwijderd. (De regels UI_AUDIT_* in .env kun je weghalen.)`);
} else {
  console.log('Gebruik: create | delete');
}
