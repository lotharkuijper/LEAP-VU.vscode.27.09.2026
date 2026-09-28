#!/usr/bin/env node
// Automatische schermcontrole: opent elke pagina van LEAP (ook alle
// beheertabbladen) op meerdere schermbreedtes en MEET of de weergave misgaat:
//   * page-hscroll   — de pagina scrolt horizontaal (iets is breder dan het scherm)
//   * squeezed-text  — tekst is in een te smalle kolom geperst ("DEB- / learn")
//   * overlap        — tekst/knoppen liggen over elkaar heen
//   * clipped-text   — tekst wordt afgesneden zonder "…"
//   * sticks-out     — tekst/knop steekt buiten de rand van zijn eigen kaart
// Per pagina en breedte: een schermafbeelding met rode kaders om de problemen,
// plus report.json en index.html in de uitvoermap.
//
// Vereist: de app draait (npm run dev) en het testaccount bestaat
// (node --env-file=.env scripts/ui-audit-account.mjs create).
//
//   node --env-file=.env scripts/ui-audit.mjs
//   node --env-file=.env scripts/ui-audit.mjs --only=admin --widths=1280
//   node --env-file=.env scripts/ui-audit.mjs --out=<map>
// Exitcode 1 als er problemen gevonden zijn (bruikbaar als controle).

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = process.env.UI_AUDIT_BASE || arg('base', 'http://localhost:5000');
const WIDTHS = arg('widths', '390,1024,1366').split(',').map(Number).filter(Boolean);
const ONLY = arg('only', '');
const OUT = path.resolve(arg('out', path.join('ui-audit-output', new Date().toISOString().replace(/[:.]/g, '-'))));
const EMAIL = process.env.UI_AUDIT_EMAIL;
const PASSWORD = process.env.UI_AUDIT_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error('UI_AUDIT_EMAIL/UI_AUDIT_PASSWORD ontbreken. Maak eerst het testaccount: node --env-file=.env scripts/ui-audit-account.mjs create');
  process.exit(2);
}

const ADMIN_TABS = ['material', 'users', 'add_users', 'documents', 'rag_beheer', 'concepts', 'imports', 'quiz_sources',
  'prompts', 'rag_settings', 'settings', 'projects_admin', 'course_info', 'learning_levels'];
export const PAGES = [
  '/dashboard', '/chat', '/explain', '/quiz', '/projects', '/studiecafe', '/feedback', '/feedback?tab=achievements',
  '/resources', '/choose-course', '/admin/courses', '/admin/documenten',
  ...ADMIN_TABS.map(t => `/admin?tab=${t}`), '/admin?tab=projects_admin&view=templates',
].filter(p => !ONLY || p.includes(ONLY));

// ── In de pagina uitgevoerde meting ──────────────────────────────────────────
function measure() {
  const issues = [];
  const vw = window.innerWidth;
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 2) {
    // Diepste elementen die buiten het scherm uitsteken, niet binnen een eigen schuifvak.
    const culprits = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right <= vw + 2 || r.width < 1 || r.height < 1) continue;
      let scrolled = false;
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { scrolled = true; break; }
      }
      if (scrolled) continue;
      if ([...el.children].some(c => c.getBoundingClientRect().right > vw + 2)) continue; // alleen de diepste
      culprits.push(el);
    }
    const names = culprits.slice(0, 4).map(el => {
      const tid = el.closest('[data-testid]')?.getAttribute('data-testid');
      const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${tid || el.tagName.toLowerCase()}${txt ? ` “${txt}”` : ''} (tot ${Math.round(el.getBoundingClientRect().right)}px)`;
    });
    issues.push({ kind: 'page-hscroll', text: `${docW}px breed bij een scherm van ${vw}px`, detail: names.join('; '), rect: null });
  }

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    // Breedte 0 telt WEL mee: een tot 0px samengedrukte kolom met tekst die
    // eroverheen loopt is juist een van de problemen die we zoeken.
    if (r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  };
  const inLayer = (el) => {
    // Bewuste lagen (menu's, meldingen, tellers op pictogrammen, sr-only) niet meetellen.
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.position === 'fixed' || s.position === 'absolute' || s.position === 'sticky') return true;
      if (n.getAttribute('aria-hidden') === 'true' || n.classList.contains('sr-only')) return true;
    }
    return false;
  };
  const describe = (el) => ({
    testid: el.closest('[data-testid]')?.getAttribute('data-testid') || null,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 70),
  });
  const rectOf = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  // Getekende tekstregels van de eigen tekst van een element.
  const textRects = (el) => {
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const cr of range.getClientRects()) if (cr.width >= 1 && cr.height >= 1) out.push(cr);
    }
    return out;
  };
  const paintedText = (el) => {
    const rs = textRects(el);
    return { lines: new Set(rs.map(cr => Math.round(cr.top))).size, textW: rs.reduce((m, cr) => Math.max(m, cr.width), 0) };
  };
  const painted = (el) => {
    const rs = textRects(el);
    if (!rs.length) return null;
    const left = Math.min(...rs.map(c => c.left)), top = Math.min(...rs.map(c => c.top));
    const right = Math.max(...rs.map(c => c.right)), bottom = Math.max(...rs.map(c => c.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  // Rechthoek bijsnijden tot wat de voorouders met overflow ≠ visible tonen
  // (ook het element zelf, bv. line-clamp). null = helemaal niet zichtbaar.
  const clipToVisible = (rect, el) => {
    let { left, top, right, bottom } = rect;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = n.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
      if (right - left < 1 || bottom - top < 1) return null;
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const ownText = (el) => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();

  const atoms = [];
  for (const el of document.querySelectorAll('body *')) {
    if (['SCRIPT', 'STYLE', 'SVG', 'PATH', 'OPTION', 'NOSCRIPT'].includes(el.tagName.toUpperCase())) continue;
    if (el.closest('svg') || el.closest('.katex') || !isVisible(el)) continue;
    const closedDetails = el.closest('details:not([open])');
    if (closedDetails && !el.closest('summary')) continue;
    const text = ownText(el);
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();

    if (text.length >= 6 && !inLayer(el)) {
      // Samengeperste tekst: veel regels voor weinig tekens in een smalle kolom.
      // Regels tellen via de echte tekstregels (niet via de hoogte: knoppen met
      // een pictogram zijn hoger dan één tekstregel).
      const { lines, textW } = paintedText(el);
      const perLine = text.length / Math.max(1, lines);
      if (r.width < 8 && textW > r.width + 8) {
        issues.push({ kind: 'squeezed-text', ...describe(el), detail: `kolom ${Math.round(r.width)}px breed, tekst ${Math.round(textW)}px`, rect: rectOf(painted(el) || r) });
      } else if (lines >= 2 && perLine < 9 && textW < 120 && !/^[\d\s.,:%€$+-]+$/.test(text)) {
        issues.push({ kind: 'squeezed-text', ...describe(el), detail: `${lines} regels in ${Math.round(textW)}px`, rect: rectOf(r) });
      }
      // Afgesneden tekst zonder "…".
      if ((s.overflow === 'hidden' || s.overflowX === 'hidden') && s.textOverflow !== 'ellipsis'
          && el.scrollWidth > el.clientWidth + 4 && s.whiteSpace === 'nowrap') {
        issues.push({ kind: 'clipped-text', ...describe(el), detail: `${el.scrollWidth}px inhoud in ${el.clientWidth}px`, rect: rectOf(r) });
      }
    }
    const interactive = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName);
    if ((text.length >= 2 || interactive) && !inLayer(el)) {
      // Voor tekst: de werkelijk getekende tekst (ook als het kader 0px breed is),
      // maar alleen het ZICHTBARE deel: tekst die door een ingekorte omschrijving
      // of een lijst met eigen schuifbalk buiten beeld valt, telt niet mee.
      const boxes = interactive ? [r] : (textRects(el).length ? textRects(el) : [r]);
      for (const b0 of boxes) {
        const box = clipToVisible(b0, el);
        if (box && box.width >= 1 && box.height >= 1) atoms.push({ el, r: box });
      }
    }
  }

  // Steekt uit: tekst/knop die buiten de rand van zijn eigen kaart/vak valt
  // (dichtstbijzijnde voorouder met een rand of achtergrond).
  const boxOf = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (['MAIN', 'HTML'].includes(n.tagName)) return null;
      const s = getComputedStyle(n);
      const bordered = ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none');
      const bg = s.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
      if (bordered || bg) return n;
    }
    return null;
  };
  const stuck = new Set();
  for (const a of atoms) {
    const box = boxOf(a.el);
    if (!box) continue;
    const b = box.getBoundingClientRect();
    const out = Math.max(a.r.right - b.right, b.left - a.r.left);
    if (out > 4) {
      const d = describe(a.el);
      const key = `${d.testid}|${d.text}`;
      if (stuck.has(key)) continue; stuck.add(key);
      issues.push({ kind: 'sticks-out', ...d, detail: `${Math.round(out)}px buiten de rand van zijn vak`, rect: rectOf(a.r) });
    }
  }

  // Overlap tussen tekst/knoppen die niet in elkaar genest zijn (via een raster).
  const CELL = 80;
  const grid = new Map();
  atoms.forEach((a, i) => {
    const x0 = Math.floor(a.r.left / CELL), x1 = Math.floor(a.r.right / CELL);
    const y0 = Math.floor((a.r.top + scrollY) / CELL), y1 = Math.floor((a.r.bottom + scrollY) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = `${x},${y}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  const seen = new Set();
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = atoms[list[i]], B = atoms[list[j]];
      const key = list[i] < list[j] ? `${list[i]}-${list[j]}` : `${list[j]}-${list[i]}`;
      if (seen.has(key)) continue; seen.add(key);
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w <= 2 || h <= 2) continue;
      const smaller = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (smaller > 0 && (w * h) / smaller > 0.25) {
        const a = describe(A.el), b = describe(B.el);
        issues.push({ kind: 'overlap', testid: a.testid || b.testid, tag: `${a.tag}+${b.tag}`, text: `“${a.text.slice(0, 30)}” over “${b.text.slice(0, 30)}”`, rect: rectOf(A.r) });
      }
    }
  }
  return issues;
}

function outline(issues) {
  document.querySelectorAll('.__ui_audit_box').forEach(n => n.remove());
  for (const i of issues) {
    if (!i.rect) continue;
    const b = document.createElement('div');
    b.className = '__ui_audit_box';
    Object.assign(b.style, {
      position: 'absolute', left: `${i.rect.x - 3}px`, top: `${i.rect.y - 3}px`, width: `${i.rect.w + 6}px`, height: `${i.rect.h + 6}px`,
      border: '3px solid #ef4444', borderRadius: '6px', zIndex: 2147483647, pointerEvents: 'none',
    });
    document.body.appendChild(b);
  }
}

const slug = (p) => p.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_') || 'root';

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('input-email').fill(EMAIL);
  await page.getByTestId('input-password').fill(PASSWORD);
  await page.getByTestId('button-login').click();
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30000 });
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.animate-spin'), null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];
try {
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', locale: 'nl-NL' });
    const page = await context.newPage();
    await login(page);
    for (const p of PAGES) {
      let issues = [];
      let error = null;
      try {
        await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
        await settle(page);
        issues = await page.evaluate(measure);
        await page.evaluate(outline, issues);
      } catch (e) { error = e.message.split('\n')[0]; }
      const shot = `${slug(p)}__${width}.png`;
      await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
      report.push({ page: p, width, issues, error, screenshot: shot });
      const n = issues.length;
      console.log(`${n ? '✗' : '✓'} ${String(width).padStart(4)}px  ${p}${n ? `  — ${n} probleem/problemen` : ''}${error ? `  (fout: ${error})` : ''}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rows = report.filter(r => r.issues.length || r.error).map(r => `
  <section><h2>${esc(r.page)} <small>${r.width}px</small></h2>
  ${r.error ? `<p class="err">Fout: ${esc(r.error)}</p>` : ''}
  <ul>${r.issues.map(i => `<li><b>${esc(i.kind)}</b> ${esc(i.testid || '')} <code>${esc(i.tag || '')}</code> ${esc(i.text || '')} ${esc(i.detail || '')}</li>`).join('')}</ul>
  <img src="${esc(r.screenshot)}" loading="lazy"></section>`).join('');
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>LEAP schermcontrole</title>
<style>body{font:14px system-ui;margin:24px;max-width:1500px}img{max-width:100%;border:1px solid #ddd}section{margin-bottom:40px}small{color:#666}.err{color:#b91c1c}</style>
<h1>LEAP schermcontrole</h1><p>${report.length} schermen gecontroleerd; ${report.filter(r => r.issues.length).length} met problemen.</p>${rows || '<p>Geen problemen gevonden. 🎉</p>'}`);

const total = report.reduce((n, r) => n + r.issues.length, 0);
console.log(`\n${report.length} schermen, ${total} problemen. Verslag: ${path.join(OUT, 'index.html')}`);
process.exit(total > 0 ? 1 : 0);
