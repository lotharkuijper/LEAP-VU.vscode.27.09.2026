// Server-side documentconversie voor de in-app documentviewer (Task #209).
// LibreOffice (headless) converteert .docx/.pptx → PDF zodat één pdf.js-viewer
// alle formaten kan tonen. Conversies worden geserialiseerd: één soffice-proces
// tegelijk, elk met een eigen UserInstallation-profiel zodat ze elkaar niet
// in de weg zitten.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Welk LibreOffice-programma we starten. Op Replit/Linux staat `soffice` in het
// PATH (replit.nix); een Windows-installatie zet het daar níet in. Zonder deze
// detectie faalden op Windows zowel de documentviewer (docx/pptx → pdf) als de
// paginanummers bij het inlezen van Word-bestanden, stil (2026-09-27).
export function resolveSofficeBin(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.SOFFICE_BIN) return env.SOFFICE_BIN;
  if (platform === 'win32') {
    const candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
      .filter(Boolean)
      .map((dir) => path.win32.join(dir, 'LibreOffice', 'program', 'soffice.exe'));
    const found = candidates.find((p) => exists(p));
    if (found) return found;
  }
  return 'soffice';
}

const SOFFICE_BIN = resolveSofficeBin();
const CONVERSION_TIMEOUT_MS = 90_000;

// Extensies die we via LibreOffice naar PDF converteren voor weergave.
export const CONVERT_TO_PDF_EXT = new Set(['docx', 'doc', 'pptx', 'ppt', 'odt', 'odp']);
// Pagineerbare Word-bronnen die tijdens RAG-ingestie via LibreOffice→PDF een
// paginanummer per chunk krijgen (Task #377). PowerPoint (pptx/ppt/odp) gebruikt
// dia-nummering en loopt via processPptxCore, niet hierlangs.
export const DOCX_PAGED_EXT = new Set(['docx', 'doc', 'odt']);
// Extensies die rechtstreeks (zonder conversie) als PDF te tonen zijn.
export const NATIVE_PDF_EXT = new Set(['pdf']);
// Platte-tekst extensies die als tekst in de viewer komen.
export const TEXT_EXT = new Set(['txt', 'md']);

export function extIsViewable(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  return CONVERT_TO_PDF_EXT.has(e) || NATIVE_PDF_EXT.has(e) || TEXT_EXT.has(e);
}

export function normalizeExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '');
}

// Serialiseer conversies via een promise-keten zodat er nooit twee
// soffice-processen tegelijk draaien (geheugen/stabiliteit).
let conversionChain = Promise.resolve();
export function queueConversion(fn) {
  const run = conversionChain.then(fn, fn);
  conversionChain = run.then(() => {}, () => {});
  return run;
}

// Vaste basisnaam voor het tijdelijke invoerbestand; LibreOffice noemt de
// uitvoer-PDF naar deze basisnaam (input.<ext> → input.pdf).
export const SOFFICE_INPUT_BASENAME = 'input';

// Naam van het tijdelijke invoerbestand voor een gegeven bronextensie.
export function sofficeInputName(ext) {
  return `${SOFFICE_INPUT_BASENAME}.${normalizeExt(ext)}`;
}

// Naam van de door LibreOffice geproduceerde PDF, afgeleid van de invoernaam
// (basisnaam zonder extensie + .pdf). Zo blijft de uitvoerpad-verwachting in
// sync met de invoernaam als die ooit verandert.
export function sofficePdfOutputName(inputName) {
  const base = path.basename(String(inputName || '')).replace(/\.[^.]+$/, '');
  return `${base}.pdf`;
}

// Bouwt de argumentenlijst voor de headless LibreOffice-conversie naar PDF.
// Apart en puur zodat een test de command-bedrading kan controleren zonder
// een echte conversie te draaien.
// file-URL voor het LibreOffice-profiel: `file:///tmp/x` op Linux en
// `file:///C:/Users/.../x` op Windows (een kaal `file://C:\...` is ongeldig).
export function profileDirUrl(profileDir) {
  const p = String(profileDir || '').replace(/\\/g, '/');
  return `file://${p.startsWith('/') ? '' : '/'}${p}`;
}

export function buildSofficeArgs({ profileDir, outDir, inputPath }) {
  return [
    '--headless',
    '--norestore',
    '--nolockcheck',
    `-env:UserInstallation=${profileDirUrl(profileDir)}`,
    '--convert-to', 'pdf',
    '--outdir', outDir,
    inputPath,
  ];
}

// Cache-sleutel (opslagpad) voor de PDF-rendition van een Office-bron.
// De sleutel volgt het BRONBESTAND (bucket + file_path), niet updated_at: een
// trigger zet updated_at bij élke wijziging (status, doel, titel), waardoor een
// bij het uploaden gemaakte rendition meteen "verouderd" zou zijn. Een vervangen
// bestand krijgt altijd een nieuw file_path, en dus een verse rendition.
export function renditionSourceKey(doc) {
  if (!doc || !doc.file_path) return '';
  return `${doc.bucket || ''}/${doc.file_path}`;
}

export function renditionCachePath(documentId, sourceKey) {
  const key = String(sourceKey || '');
  const tag = key ? `-${createHash('sha1').update(key).digest('hex').slice(0, 12)}` : '';
  return `__renditions__/${documentId}${tag}.pdf`;
}

// Bron-type-label voor de viewer: presentatie-formaten tonen als 'pptx',
// de rest (tekstdocumenten) als 'docx'.
export function renditionSourceType(ext) {
  const e = normalizeExt(ext);
  return (e === 'pptx' || e === 'ppt' || e === 'odp') ? 'pptx' : 'docx';
}

function runSoffice(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SOFFICE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('LibreOffice-conversie duurde te lang (time-out).'));
    }, CONVERSION_TIMEOUT_MS);
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`LibreOffice kon niet worden gestart: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice-conversie mislukte (code ${code}). ${stderr.slice(0, 500)}`));
    });
  });
}

// Converteer een Office-document (buffer) naar een PDF-buffer.
// `ext` is de bronextensie (zonder punt), bv. 'pptx'.
export async function convertOfficeToPdf(inputBuffer, ext) {
  const e = normalizeExt(ext);
  if (!CONVERT_TO_PDF_EXT.has(e)) {
    throw new Error(`Conversie naar PDF wordt niet ondersteund voor .${e}`);
  }
  const workDir = await mkdtemp(path.join(tmpdir(), 'leapvu-render-'));
  const profileDir = await mkdtemp(path.join(tmpdir(), 'leapvu-loprofile-'));
  const inputName = sofficeInputName(e);
  const inputPath = path.join(workDir, inputName);
  try {
    await writeFile(inputPath, inputBuffer);
    await runSoffice(buildSofficeArgs({ profileDir, outDir: workDir, inputPath }));
    const outPath = path.join(workDir, sofficePdfOutputName(inputName));
    return await readFile(outPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}
