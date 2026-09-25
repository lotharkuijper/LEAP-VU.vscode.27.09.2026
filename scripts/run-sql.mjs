// Voert één SQL-bestand uit tegen de database uit SUPABASE_DB_URL (.env).
// Gebruik:  node scripts/run-sql.mjs supabase/migrations/<bestand>.sql
//           node scripts/run-sql.mjs supabase/rollback/<bestand>_down.sql
// Bedoeld voor migraties en terugdraaiscripts ("val terug op de oude
// systematiek"); het bestand bevat zelf BEGIN/COMMIT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const file = process.argv[2];
if (!file) {
  console.error('Gebruik: node scripts/run-sql.mjs <pad-naar-sql-bestand>');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL ontbreekt in .env');
  process.exit(1);
}

const sql = fs.readFileSync(path.resolve(root, file), 'utf8');
const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();
  await client.query(sql);
  console.log(`Uitgevoerd: ${file}`);
} catch (err) {
  console.error(`Mislukt: ${file}\n${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
