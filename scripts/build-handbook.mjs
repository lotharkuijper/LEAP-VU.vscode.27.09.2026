#!/usr/bin/env node
// Zet de docentenhandleiding (docs/handleiding/handleiding.html) om naar PDF
// met paginanummers, via de Edge op deze computer (playwright-core).
//
//   node scripts/build-handbook.mjs
//
// Schermafbeeldingen vernieuwen: node --env-file=.env scripts/handbook-screenshots.mjs

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const SRC = path.resolve('docs/handleiding/handleiding.html');
const OUT = path.resolve('docs/handleiding/LEAP-handleiding-docenten.pdf');

const footer = `
  <div style="width:100%;font-family:'Segoe UI',sans-serif;font-size:8px;color:#94a3b8;padding:0 17mm;display:flex;justify-content:space-between">
    <span>LEAP-VU · Handleiding voor docenten</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto(pathToFileURL(SRC).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: footer,
});
await browser.close();
console.log('✓', OUT);
