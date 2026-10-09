// Mijn gegevens (2026-10-09): eigen gegevens downloaden en het eigen account
// verwijderen. Alleen eigen rijen; nooit gegevens van anderen.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { EXPORT_SOURCES, NOT_EXPORTED, buildExport, registerMyDataRoutes } from '../myData.js';

const root = path.resolve(__dirname, '..', '..');

/** Tabellen uit de migraties met een kolom die naar een gebruiker wijst. */
function tablesWithUserColumns() {
  const dir = path.join(root, 'supabase/migrations');
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
      if (/^\s*[a-z_]+\s+uuid[^,\n]*REFERENCES\s+(?:auth\.users|profiles|public\.profiles)/m.test(m[2])) out.add(m[1]);
    }
    for (const m of s.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:public\.)?([a-z_]+)\s+ADD COLUMN (?:IF NOT EXISTS )?[a-z_]+\s+uuid[^;]*REFERENCES\s+(?:auth\.users|profiles|public\.profiles)/g)) out.add(m[1]);
  }
  return out;
}

describe('welke gegevens zijn "van mij"', () => {
  it('elke tabel met een gebruikerskolom is bewust ingedeeld (export of niet)', () => {
    const known = new Set([...EXPORT_SOURCES.map(s => s.table), ...NOT_EXPORTED]);
    const missing = [...tablesWithUserColumns()].filter(t => !known.has(t));
    // Faalt deze test? Er is een tabel met persoonlijke gegevens bijgekomen:
    // zet hem in EXPORT_SOURCES of (met reden) in NOT_EXPORTED in server/myData.js.
    expect(missing).toEqual([]);
  });
  it('de leerdossier-onderdelen zitten erin', () => {
    const t = EXPORT_SOURCES.map(s => s.table);
    for (const x of ['learning_journal_entries', 'student_achievements', 'quiz_attempts', 'student_explanations', 'conversations']) expect(t).toContain(x);
  });
});

// Nagebootste database: filtert echt op kolom = waarde.
function fakeDb(tables, { missing = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      const b = {
        select: () => b,
        eq: (c, v) => { filters.push(r => r[c] === v); return b; },
        in: (c, vs) => { filters.push(r => vs.includes(r[c])); return b; },
        range: async () => (missing.includes(table)
          ? { data: null, error: { message: 'relation does not exist' } }
          : { data: (tables[table] || []).filter(r => filters.every(f => f(r))), error: null }),
        then: (res, rej) => b.range().then(res, rej),
      };
      return b;
    },
    auth: { admin: { deleteUser: async (id) => { tables.__deleted = id; return { error: null }; } } },
  };
}

describe('export', () => {
  it('alleen eigen rijen, chatberichten via eigen gesprekken, ontbrekende tabellen overgeslagen', async () => {
    const db = fakeDb({
      profiles: [{ id: 'me', email: 'ik@vu.nl' }, { id: 'ander' }],
      learning_journal_entries: [{ id: 'j1', user_id: 'me' }, { id: 'j2', user_id: 'ander' }],
      group_chat_messages: [{ id: 'g1', user_id: 'me', content: 'mijn bericht' }, { id: 'g2', user_id: 'ander', content: 'van een ander' }],
      conversations: [{ id: 'c1', user_id: 'me' }, { id: 'c2', user_id: 'ander' }],
      messages: [{ id: 'm1', conversation_id: 'c1' }, { id: 'm2', conversation_id: 'c2' }],
    }, { missing: ['collaboration_messages'] });
    const out = await buildExport(db, { id: 'me', email: 'ik@vu.nl' }, new Date('2026-10-09T10:00:00Z'));
    expect(out.sources.learning_journal_entries.map(r => r.id)).toEqual(['j1']);
    expect(out.sources.group_chat_messages.map(r => r.id)).toEqual(['g1']);
    expect(out.sources.messages.map(r => r.id)).toEqual(['m1']);
    expect(out.skipped).toContain('collaboration_messages');
    expect(JSON.stringify(out)).not.toContain('van een ander');
    expect(out.exportedAt).toBe('2026-10-09T10:00:00.000Z');
  });
});

describe('eigen account verwijderen', () => {
  let server;
  afterEach(() => new Promise(r => (server ? server.close(() => r()) : r())));

  async function start(profile) {
    const tables = {};
    const forgotten = [];
    const app = express();
    app.use(express.json());
    registerMyDataRoutes(app, {
      supabaseAdmin: fakeDb(tables),
      authUser: async () => ({ user: { id: 'me', email: profile.email } }),
      getProfile: async () => profile,
      superuserEmail: 'baas@vu.nl',
      onDeleted: (id) => forgotten.push(id),
    });
    const base = await new Promise(r => { server = app.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)); });
    const del = (confirmEmail) => fetch(`${base}/api/me/delete-account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmEmail }),
    });
    return { del, tables, forgotten };
  }

  it('zonder het eigen e-mailadres gebeurt er niets', async () => {
    const { del, tables } = await start({ role: 'student', email: 'ik@vu.nl' });
    const r = await del('iemand@vu.nl');
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('confirmMismatch');
    expect(tables.__deleted).toBeUndefined();
  });

  it('met het eigen e-mailadres (hoofdletters maken niet uit): verwijderd en direct vergeten', async () => {
    const { del, tables, forgotten } = await start({ role: 'student', email: 'ik@vu.nl' });
    const r = await del('  IK@vu.nl ');
    expect(r.status).toBe(200);
    expect(tables.__deleted).toBe('me');
    expect(forgotten).toEqual(['me']);
  });

  it('een beheerder kan het eigen account niet zelf verwijderen', async () => {
    const { del, tables } = await start({ role: 'admin', email: 'ik@vu.nl' });
    const r = await del('ik@vu.nl');
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('adminSelfDelete');
    expect(tables.__deleted).toBeUndefined();
  });
});
