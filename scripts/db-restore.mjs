// Zet een momentopname van scripts/db-snapshot.mjs terug.
//
//   node --env-file=.env scripts/db-restore.mjs <map> [tabel …]            (proefdraai: toont wat er zou gebeuren)
//   node --env-file=.env scripts/db-restore.mjs <map> [tabel …] --apply    (echt terugzetten)
//
// Per tabel, in één transactie: rijen die er nu zijn maar niet in de
// momentopname, worden verwijderd; rijen uit de momentopname worden
// teruggezet (bestaand = overschreven op id, verdwenen = opnieuw ingevoegd).
// Daarna is de tabel precies zoals bij de momentopname. Alleen voor tabellen
// met een kolom `id`. Let op verwijzingen: zet samenhangende tabellen samen
// terug (bv. concepts én concept_evidence), ouders eerst.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [dirArg, ...rest] = args.filter((a) => a !== '--apply');
if (!dirArg) { console.error('Gebruik: node --env-file=.env scripts/db-restore.mjs <map> [tabel …] [--apply]'); process.exit(1); }
const dir = path.resolve(dirArg);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const tables = rest.length ? rest : Object.keys(manifest.tables);

const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t) || !(t in manifest.tables)) { console.error(`Tabel ${t} zit niet in deze momentopname`); continue; }
    const snap = JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), 'utf8'));
    const { rows: cols } = await client.query(
      `select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1`, [t]);
    const types = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
    if (!types.id) { console.error(`${t}: geen kolom id — handmatig terugzetten`); continue; }
    const snapIds = snap.map((r) => r.id);
    const { rows: [{ n: extra }] } = await client.query(`select count(*)::int n from public.${t} where not (id = any($1))`, [snapIds]);
    console.log(`${t}: ${snap.length} rijen terugzetten, ${extra} rij(en) die er sindsdien bij kwamen verwijderen`);
    if (!apply) continue;
    await client.query('begin');
    try {
      await client.query(`delete from public.${t} where not (id = any($1))`, [snapIds]);
      for (const row of snap) {
        const keys = Object.keys(row).filter((k) => k in types);
        const vals = keys.map((k) => (types[k] === 'jsonb' || types[k] === 'json') && row[k] !== null ? JSON.stringify(row[k]) : row[k]);
        const ph = keys.map((_, i) => `$${i + 1}`).join(', ');
        const upd = keys.filter((k) => k !== 'id').map((k) => `"${k}" = excluded."${k}"`).join(', ');
        await client.query(
          `insert into public.${t} (${keys.map((k) => `"${k}"`).join(', ')}) values (${ph}) on conflict (id) do update set ${upd || 'id = excluded.id'}`,
          vals,
        );
      }
      await client.query('commit');
      console.log(`  ✓ ${t} teruggezet`);
    } catch (e) {
      await client.query('rollback');
      console.error(`  ✗ ${t} niet teruggezet (niets veranderd): ${e.message}`);
    }
  }
  if (!apply) console.log('\nProefdraai — er is niets veranderd. Voeg --apply toe om echt terug te zetten.');
} finally {
  await client.end();
}
