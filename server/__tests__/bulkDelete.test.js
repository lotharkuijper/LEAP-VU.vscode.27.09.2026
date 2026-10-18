// Meerdere bestanden tegelijk verwijderen (server/courseFiles.js, 2026-10-18).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BULK_CONFIRM_THRESHOLD, bulkDeleteNeedsName, courseNameMatches } from '../courseFiles.js';

describe('bevestiging met de cursusnaam', () => {
  it('pas boven de drempel, en dan streng genoeg maar niet pietluttig', () => {
    expect(bulkDeleteNeedsName(BULK_CONFIRM_THRESHOLD)).toBe(false);
    expect(bulkDeleteNeedsName(BULK_CONFIRM_THRESHOLD + 1)).toBe(true);
    expect(courseNameMatches(' microbiologie ', 'Microbiologie')).toBe(true);
    expect(courseNameMatches('Methoden  2', 'Methoden 2')).toBe(true);
    expect(courseNameMatches('Microbiologie 2', 'Microbiologie')).toBe(false);
    expect(courseNameMatches('', '')).toBe(false);
  });

  it('de route controleert de naam zelf, verwijdert alleen binnen de cursus en laat begrippen staan', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'courseFiles.js'), 'utf8');
    const route = src.slice(src.indexOf("app.post('/api/admin/course-files/:courseId/delete'"), src.indexOf("app.post('/api/admin/course-files/:courseId/reprocess'"));
    expect(route).toMatch(/requireStaff\(req, res\)/);
    expect(route).toMatch(/bulkDeleteNeedsName\(sel\.allIds\.length\) && !courseNameMatches\(/);
    expect(route).not.toMatch(/from\('concepts'\)/);
    const resolve = src.slice(src.indexOf('async function resolveBulkSelection'), src.indexOf('async function conceptsLosingEvidence'));
    expect(resolve).toMatch(/scope\.ids\.has\(d\.folder_id\)/);
    expect(resolve).toMatch(/loadWebSource\(courseId, id\)/);
  });
});

describe('fragmenten tellen (regressie Microbiologie, 2026-10-18)', () => {
  it('telt in de database, niet in de browser (de API geeft hoogstens 1000 rijen)', () => {
    const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'RAGDocumentStatusPanel.tsx'), 'utf8');
    expect(panel).not.toMatch(/from\('document_chunks'\)/);
    expect(panel).toMatch(/fetchChunkStats\(/);
    const src = fs.readFileSync(path.join(__dirname, '..', 'courseFiles.js'), 'utf8');
    const route = src.slice(src.indexOf("'/api/admin/course-files/:courseId/chunk-stats'"), src.indexOf('// ── Meerdere bestanden tegelijk verwijderen'));
    expect(route).toMatch(/count\(c\.id\)/);
    expect(route).toMatch(/GROUP BY d\.id/);
    expect(route).toMatch(/requireStaff\(req, res\)/);
  });
});
