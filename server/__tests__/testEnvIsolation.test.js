import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// server/index.js begint met dotenv.config(). Dotenv vult elke variabele aan die
// NIET bestaat — ook een die een test net met `delete process.env.X` heeft
// weggehaald. Op een laptop met een echte .env draaide een test "zonder Azure"
// of "zonder databaseverbinding" daardoor tóch met Azure en met de gedeelde
// (live) database (gevonden 2026-10-27). Een lege waarde laat dotenv staan en
// telt in LEAP als "niet ingesteld". Herstellen in afterAll mag wel met delete.

const dir = __dirname;
const ENV_RE = /^\s*delete process\.env\.((?:AZURE|SUPABASE|VITE_PUBLIC_SUPABASE|VITE_SUPABASE|OPENAI)[A-Z_]*);/m;

describe('tests die de server laden, zetten instellingen leeg in plaats van ze te verwijderen', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes("import('../index.js')"));
  it('er zijn zulke tests', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    it(f, () => {
      const m = ENV_RE.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(m ? `delete process.env.${m[1]} (gebruik = '')` : null).toBeNull();
    });
  }
});
