// Momentopname van tabellen vóór een databasewijziging tijdens het testen.
// Schrijft per tabel een JSON-bestand naar db-backups/<datum-tijd>-<label>/
// (niet in git). Terugzetten: node scripts/db-restore.mjs <map> [tabel …]
//
//   node --env-file=.env scripts/db-snapshot.mjs <label> <tabel> [tabel …]
//   bv. node --env-file=.env scripts/db-snapshot.mjs voor-samenvoegen concepts concept_evidence
//
// Database uit SUPABASE_DB_URL (net als scripts/run-sql.mjs). Toont geen geheimen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [label, ...tables] = process.argv.slice(2);
if (!label || !tables.length) {
  console.error('Gebruik: node --env-file=.env scripts/db-snapshot.mjs <label> <tabel> [tabel …]');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) { console.error('SUPABASE_DB_URL ontbreekt'); process.exit(1); }
const safe = (s) => /^[a-z_][a-z0-9_]*$/.test(s);
const bad = tables.filter((t) => !safe(t));
if (bad.length) { console.error('Ongeldige tabelnaam:', bad.join(', ')); process.exit(1); }

const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dir = path.join(root, 'db-backups', `${stamp}-${label.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
fs.mkdirSync(dir, { recursive: true });
try {
  const manifest = { createdAt: new Date().toISOString(), label, tables: {} };
  for (const t of tables) {
    const { rows } = await client.query(`select * from public.${t}`);
    fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows));
    manifest.tables[t] = rows.length;
    console.log(`  ${t}: ${rows.length} rijen`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Momentopname: ${path.relative(root, dir)}`);
} finally {
  await client.end();
}
