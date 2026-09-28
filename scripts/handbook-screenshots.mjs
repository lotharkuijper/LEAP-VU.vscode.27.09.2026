#!/usr/bin/env node
// Schermafbeeldingen voor de handleiding (docs/handleiding/img/). Gebruikt het
// testaccount van de schermcontrole (scripts/ui-audit-account.mjs) en de Edge
// op deze computer. De app moet draaien (npm run dev).
//
//   node --env-file=.env scripts/handbook-screenshots.mjs [--only=naam] [--skip=chat,uitleg]

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.UI_AUDIT_BASE || 'http://localhost:5000';
const OUT = path.resolve('docs/handleiding/img');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SKIP = new Set((process.argv.find((a) => a.startsWith('--skip=')) || '').slice(7).split(',').filter(Boolean));

// [bestandsnaam, pad, optionele actie vóór de foto]
const SHOTS = [
  ['dashboard', '/dashboard'],
  ['chat', '/chat'],
  ['uitleg', '/explain'],
  ['quiz', '/quiz'],
  ['projecten', '/projects'],
  ['studiecafe', '/studiecafe'],
  ['leerdagboek', '/feedback'],
  ['achievements', '/feedback?tab=achievements'],
  ['beheer-materiaal', '/admin?tab=material'],
  ['beheer-begrippen', '/admin?tab=material&step=concepts'],
  ['beheer-klaar', '/admin?tab=material&step=ready'],
  ['beheer-quizbronnen', '/admin?tab=quiz_sources'],
  ['beheer-projecten', '/admin?tab=projects_admin'],
  ['beheer-sjablonen', '/admin?tab=projects_admin&view=templates'],
  ['beheer-leerniveaus', '/admin?tab=learning_levels'],
  ['beheer-chatinstructies', '/admin?tab=prompts'],
  ['beheer-zoekgevoeligheid', '/admin?tab=rag_settings'],
  ['beheer-cursusinfo', '/admin?tab=course_info'],
  ['beheer-imports', '/admin?tab=imports'],
  ['cursussen', '/admin/courses'],
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, deviceScaleFactor: 2, locale: 'nl-NL', reducedMotion: 'reduce' });
const page = await context.newPage();
await page.goto(`${BASE}/login`);
await page.getByTestId('input-email').fill(process.env.UI_AUDIT_EMAIL);
await page.getByTestId('input-password').fill(process.env.UI_AUDIT_PASSWORD);
await page.getByTestId('button-login').click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });

for (const [name, p] of SHOTS) {
  if ((ONLY && !name.includes(ONLY)) || SKIP.has(name)) continue;
  await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.animate-spin'), null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('✓', name);
}
await browser.close();
