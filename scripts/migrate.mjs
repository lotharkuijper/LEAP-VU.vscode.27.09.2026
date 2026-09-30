// Voert de databasemigraties uit die nog niet zijn uitgevoerd, en houdt in de
// tabel public.leap_migrations bij welke al gedaan zijn. Draait bij hosting op
// Azure automatisch bij het starten van de app (MIGRATE_ON_START=true), zodat
// een nieuwe migratie in supabase/migrations/ vanzelf meegaat met een uitrol.
//
// Gebruik (database uit SUPABASE_DB_URL, net als scripts/run-sql.mjs):
//   node scripts/migrate.mjs             nog niet uitgevoerde migraties uitvoeren
//   node scripts/migrate.mjs --status    alleen tonen wat er nog open staat
//   node scripts/migrate.mjs --baseline  alle bestaande migraties als uitgevoerd
//                                        vastleggen ZONDER ze te draaien (voor een
//                                        database die al is overgezet)
//   node scripts/migrate.mjs --on-start  als de eerste vorm, maar doet niets
//                                        tenzij MIGRATE_ON_START=true
//
// Een migratie die mislukt stopt het script (exitcode 1); eerdere migraties
// blijven staan. Op Azure start de nieuwe versie van de app dan niet en blijft
// de vorige draaien.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { planMigrations, needsBaseline } from '../server/migrationPlan.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const args = new Set(process.argv.slice(2));
if (args.has('--on-start') && process.env.MIGRATE_ON_START !== 'true') process.exit(0);
if (!process.env.SUPABASE_DB_URL) {
  console.error('[migraties] SUPABASE_DB_URL ontbreekt');
  process.exit(1);
}

const dir = path.join(root, 'supabase', 'migrations');
const files = fs.readdirSync(dir);
// Versleuteld, behalve voor een lokale database met sslmode=disable in het adres.
const ssl = /[?&]sslmode=disable\b/.test(process.env.SUPABASE_DB_URL) ? false : { rejectUnauthorized: false };
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl });

try {
  await client.connect();
  // Eén tegelijk: een tweede start wacht tot de eerste klaar is.
  await client.query('select pg_advisory_lock(7275340)');
  await client.query(`
    create table if not exists public.leap_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
    alter table public.leap_migrations enable row level security;
  `);
  const applied = (await client.query('select name from public.leap_migrations')).rows.map((r) => r.name);
  const { pending, missing } = planMigrations(files, applied);
  if (missing.length) console.warn(`[migraties] wel uitgevoerd, bestand ontbreekt: ${missing.join(', ')}`);

  if (args.has('--status')) {
    console.log(pending.length ? `[migraties] nog uit te voeren:\n  ${pending.join('\n  ')}` : '[migraties] alles is uitgevoerd');
  } else if (args.has('--baseline')) {
    for (const name of pending) {
      await client.query('insert into public.leap_migrations (name) values ($1) on conflict do nothing', [name]);
    }
    console.log(`[migraties] ${pending.length} migratie(s) als uitgevoerd vastgelegd`);
  } else {
    const existing = await client.query("select to_regclass('public.profiles') is not null as found");
    if (needsBaseline({ appliedCount: applied.length, hasExistingSchema: existing.rows[0].found })) {
      throw new Error(
        'de database heeft al tabellen maar nog geen administratie van migraties. ' +
          'Leg eerst vast wat er al is: node scripts/migrate.mjs --baseline',
      );
    }
    for (const name of pending) {
      try {
        await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch (err) {
        // Een migratie met een eigen BEGIN laat de verbinding na een fout in
        // een afgebroken transactie achter.
        await client.query('rollback').catch(() => {});
        throw new Error(`${name}: ${err.message}`);
      }
      await client.query('insert into public.leap_migrations (name) values ($1)', [name]);
      console.log(`[migraties] uitgevoerd: ${name}`);
    }
    if (!pending.length) console.log('[migraties] alles is al uitgevoerd');
  }
} catch (err) {
  console.error(`[migraties] mislukt: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
