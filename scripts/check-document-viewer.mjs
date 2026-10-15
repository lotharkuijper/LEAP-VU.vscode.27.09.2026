#!/usr/bin/env node
// Controle van de documentviewer in een echte browser (Edge via playwright-core):
// stelt een vraag in de chat, opent de eerste bron en controleert
//   - dat er een tekstlaag over de pagina ligt (tekst selecteren/kopiëren),
//   - dat inzoomen de pagina groter maakt,
//   - dat volledig scherm aan en (met Esc) weer uit gaat,
//   - dat geselecteerde tekst via "Vraag in de chat" in de chatinvoer komt.
// Vereist: de app draait (npm run dev) en het testaccount bestaat
// (node --env-file=.env scripts/ui-audit-account.mjs create); de actieve cursus
// van het testaccount moet materiaal hebben.
//   node --env-file=.env scripts/check-document-viewer.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.UI_AUDIT_BASE || 'http://localhost:5000';
const results = [];
const check = (label, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'NEE '} ${label}${extra ? ` (${extra})` : ''}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('input-email').fill(process.env.UI_AUDIT_EMAIL);
  await page.getByTestId('input-password').fill(process.env.UI_AUDIT_PASSWORD);
  await page.getByTestId('button-login').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });

  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  const input = page.getByTestId('input-chat-message');
  await input.waitFor({ timeout: 30000 });
  await input.fill(process.env.VIEWER_QUESTION || 'Wat is confounding?');
  await input.press('Enter');

  // Wacht op een antwoord met bronnen en open de eerste bron.
  await page.getByTestId('btn-toggle-sources').first().waitFor({ timeout: 120000 });
  await page.getByTestId('btn-toggle-sources').first().click();
  await page.locator('[data-testid^="link-source-"]').first().click();
  // Keuzevenster: bekijken in de viewer (of downloaden).
  const view = page.getByTestId(process.env.VIEWER_CHOICE_TESTID || 'btn-source-choice-view');
  if (await view.isVisible({ timeout: 5000 }).catch(() => false)) await view.click();
  await page.getByTestId('document-viewer').waitFor({ timeout: 30000 });
  await page.getByTestId('canvas-viewer-page').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewer-text-layer"] span').length > 5, null, { timeout: 30000 }).catch(() => {});

  const spans = await page.locator('[data-testid="viewer-text-layer"] span').count();
  check('tekstlaag over de pagina', spans > 5, `${spans} tekststukken`);

  // Ligt de tekstlaag over het canvas (zelfde grootte)?
  const sizes = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="canvas-viewer-page"]').getBoundingClientRect();
    const l = document.querySelector('[data-testid="viewer-text-layer"]').getBoundingClientRect();
    return { cw: Math.round(c.width), ch: Math.round(c.height), lw: Math.round(l.width), lh: Math.round(l.height) };
  });
  check('tekstlaag even groot als de pagina', Math.abs(sizes.cw - sizes.lw) <= 2 && Math.abs(sizes.ch - sizes.lh) <= 2, JSON.stringify(sizes));

  // Inzoomen
  const before = sizes.cw;
  await page.getByTestId('btn-viewer-zoom-in').click();
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => Math.round(document.querySelector('[data-testid="canvas-viewer-page"]').getBoundingClientRect().width));
  check('inzoomen maakt de pagina groter', after > before * 1.15, `${before}px → ${after}px, ${await page.getByTestId('btn-viewer-zoom-reset').innerText()}`);
  await page.getByTestId('btn-viewer-zoom-reset').click();

  // Volledig scherm
  await page.getByTestId('btn-viewer-fullscreen').click();
  await page.waitForTimeout(500);
  const fs1 = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="document-viewer"]').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight };
  });
  check('volledig scherm vult het venster', fs1.w >= fs1.vw - 2 && fs1.h >= fs1.vh - 2, JSON.stringify(fs1));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const fs2 = await page.evaluate(() => Math.round(document.querySelector('[data-testid="document-viewer"]').getBoundingClientRect().width));
  check('Esc sluit volledig scherm', fs2 < fs1.vw - 50, `${fs2}px breed`);

  // Tekst selecteren in de tekstlaag → "Vraag in de chat"
  const selected = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('[data-testid="viewer-text-layer"] span')].filter((s) => (s.textContent || '').trim().length > 3);
    const first = spans[2] || spans[0];
    const last = spans[5] || first;
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, last.firstChild.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString().replace(/\s+/g, ' ').trim();
  });
  check('tekst te selecteren (en dus te kopiëren)', selected.length > 10, `"${selected.slice(0, 60)}…"`);
  await page.getByTestId('viewer-original-pane').dispatchEvent('mouseup');
  await page.getByTestId('btn-viewer-quote').waitFor({ timeout: 5000 }).catch(() => {});
  const quoteVisible = await page.getByTestId('btn-viewer-quote').isVisible().catch(() => false);
  check('knop "Vraag in de chat" verschijnt bij de selectie', quoteVisible);
  if (quoteVisible) {
    await page.getByTestId('btn-viewer-quote').click();
    const value = await input.inputValue();
    check('selectie staat als citaat in de chatinvoer', value.includes(selected.slice(0, 20)), `"${value.slice(0, 70)}…"`);
  }
  await page.screenshot({ path: process.env.VIEWER_SHOT || 'ui-audit-output/document-viewer.png' });
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} controle(s) mislukt` : 'alle controles geslaagd');
process.exit(failed ? 1 : 0);
