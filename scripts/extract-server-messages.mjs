// Verzamelt alle meldingen die de server naar gebruikers kan sturen en schrijft
// ze naar server/i18n/messages.source.json (de Nederlandse bronteksten).
// Daarna vult `node --env-file=.env scripts/server-i18n-generate.mjs` de
// vertalingen per taal aan (server/i18n/messages.<lang>.json).
//
// Wat telt als melding:
//  * letterlijke teksten bij `error:`, `message:`, `warning:`, `hint:` in objecten
//    (res.json({ error: '…' }), return { status, error: '…' }, …);
//  * `new Error('…')` — die komen via err.message vaak in een JSON-respons;
//  * constanten die op _MSG eindigen (const X_MSG = '…').
// Template-literals met ${…} worden sjablonen met {0}, {1}, … — de middleware
// (server/serverI18n.js) vult bij het vertalen de echte waarden weer in.
//
// Gebruik:  node scripts/extract-server-messages.mjs          (schrijft het bestand)
//           node scripts/extract-server-messages.mjs --check  (faalt als het bestand verouderd is)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMessages } from '../server/serverI18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(root, 'server');
const files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.js')).map((f) => path.join(serverDir, f));
const found = new Set();
for (const f of files) for (const m of extractMessages(fs.readFileSync(f, 'utf8'))) found.add(m);
const sorted = [...found].sort((a, b) => a.localeCompare(b, 'nl'));

const out = path.join(serverDir, 'i18n', 'messages.source.json');
const next = JSON.stringify(sorted, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur.replace(/\r\n/g, '\n') !== next) {
    console.error('server/i18n/messages.source.json is verouderd — draai: node scripts/extract-server-messages.mjs');
    process.exit(1);
  }
  console.log(`ok: ${sorted.length} servermeldingen, bestand is actueel`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, next);
  console.log(`${sorted.length} servermeldingen geschreven naar ${path.relative(root, out)}`);
}
