// Sluit je lokale ontwikkelomgeving aan op LEAP op Azure.
//
// Zet de Supabase-waarden van Azure in je .env (de overige regels blijven
// staan) en laat je eigen IP-adres toe op de database. Toont nooit een geheim.
//
// Nodig: de Azure CLI, aangemeld bij de VU:
//   az login --tenant vunl.onmicrosoft.com
//   az account set --subscription "VU - BETA AI Hub Pilot"
// Gebruik, vanuit de projectmap:
//   node azure/scripts/local-env.mjs
// Werkt op macOS, Windows en Linux.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RG = 'vu-leap-rg';
const KV = 'kv-vu-leap';
const SUPABASE_APP = 'vu-leap-supabase';
const PG_SERVER = 'vu-leap-db';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = process.env.LEAP_ENV_FILE || path.join(root, '.env');

function az(args) {
  try {
    return execSync(`az ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0] || '';
    throw new Error(`az ${args.split(' ').slice(0, 3).join(' ')} … mislukt: ${msg}`);
  }
}

// 1. Aangemeld?
let account;
try {
  account = az('account show --query "[user.name, name]" -o tsv').split(/\r?\n/);
} catch {
  console.error('Je bent niet aangemeld bij Azure. Doe eerst:');
  console.error('  az login --tenant vunl.onmicrosoft.com');
  console.error('  az account set --subscription "VU - BETA AI Hub Pilot"');
  process.exit(1);
}
console.log(`Aangemeld als ${account[0]} (abonnement: ${account[1]})`);
az('config set extension.use_dynamic_install=yes_without_prompt core.only_show_errors=true');

// 2. Waarden ophalen
const supabaseUrl = `https://${az(`containerapp show -g ${RG} -n ${SUPABASE_APP} --query properties.configuration.ingress.fqdn -o tsv`)}`;
const secret = (name) => az(`keyvault secret show --vault-name ${KV} -n ${name} --query value -o tsv`);
const values = {
  VITE_PUBLIC_SUPABASE_URL: supabaseUrl,
  SUPABASE_URL: supabaseUrl,
  VITE_PUBLIC_SUPABASE_ANON_KEY: secret('anon-key'),
  SUPABASE_ANON_KEY: secret('anon-key'),
  SUPABASE_SERVICE_ROLE_KEY: secret('service-role-key'),
  SUPABASE_DB_URL: secret('app-db-url'),
  // Supabase Realtime draait niet op Azure; de app ververst dan periodiek.
  VITE_PUBLIC_REALTIME: 'off',
};

// 3. .env bijwerken: bestaande regels vervangen, ontbrekende toevoegen
let lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
if (fs.existsSync(envFile)) {
  const backup = `${envFile}.backup-${new Date().toISOString().slice(0, 10)}`;
  fs.copyFileSync(envFile, backup);
  console.log(`Kopie van je oude .env: ${path.basename(backup)}`);
}
const seen = new Set();
lines = lines.map((line) => {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
  if (m && values[m[1]] !== undefined) {
    seen.add(m[1]);
    return `${m[1]}=${values[m[1]]}`;
  }
  return line;
});
const missing = Object.keys(values).filter((k) => !seen.has(k));
if (missing.length) {
  if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  lines.push('# LEAP op Azure (gezet door azure/scripts/local-env.mjs)');
  for (const k of missing) lines.push(`${k}=${values[k]}`);
}
fs.writeFileSync(envFile, lines.join('\n').replace(/\n*$/, '\n'));
if (process.platform !== 'win32') fs.chmodSync(envFile, 0o600); // alleen voor jou leesbaar
console.log(`.env bijgewerkt: ${Object.keys(values).length} regels (${seen.size} vervangen, ${missing.length} toegevoegd)`);

// 4. Eigen IP-adres toelaten op de database
const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
const ruleName = `lokaal-${os.userInfo().username.replace(/[^a-zA-Z0-9]/g, '')}`;
const serverId = az(`postgres flexible-server show -g ${RG} -n ${PG_SERVER} --query id -o tsv`);
az(
  `rest --method put --url "https://management.azure.com${serverId}/firewallRules/${ruleName}?api-version=2024-08-01" ` +
    `--body "{\\"properties\\":{\\"startIpAddress\\":\\"${ip}\\",\\"endIpAddress\\":\\"${ip}\\"}}" -o none`,
);
console.log(`Database laat je IP-adres toe (${ip}, regel "${ruleName}"). Verander je van netwerk, draai dit script dan opnieuw.`);
console.log('Klaar. Start de app met: npm run dev');
