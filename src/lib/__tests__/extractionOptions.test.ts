// Taal- en documentkeuze bij het extraheren van begrippen, overgenomen uit de
// klassieke weergave (RAG Beheer) toen die op 2026-10-15 verdween.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractionBody, DEFAULT_EXTRACTION_OPTIONS } from '../conceptExtractionJob';

describe('extractionBody', () => {
  it('standaard: hele cursus, taal van het materiaal', () => {
    expect(extractionBody('c1', false)).toEqual({ courseId: 'c1', replace: false });
    expect(extractionBody('c1', true, DEFAULT_EXTRACTION_OPTIONS)).toEqual({ courseId: 'c1', replace: true });
  });
  it('geeft taal en documentselectie mee aan de server', () => {
    expect(extractionBody('c1', true, { language: 'en', documentIds: ['d1', 'd2'] }))
      .toEqual({ courseId: 'c1', replace: true, language: 'en', documentIds: ['d1', 'd2'] });
  });
});

describe('klassieke weergave is weg, oude links blijven werken', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const admin = fs.readFileSync(path.join(root, 'src/pages/AdminPage.tsx'), 'utf8');
  it('geen klassieke tabbladen meer in het beheer', () => {
    expect(admin).not.toMatch(/button-toggle-classic|RAGSetupPanel|DocumentsPage/);
    expect(admin).not.toMatch(/id: '(documents|rag_beheer|concepts)' as TabType/);
  });
  it('oude ?tab= links gaan naar de juiste stap in Cursusmateriaal', () => {
    expect(admin).toContain("LEGACY_MATERIAL_TABS: Record<string, MaterialStep> = { documents: 'files', rag_beheer: 'processing', concepts: 'concepts' }");
  });
  it('het takenvak verwijst niet meer naar het klassieke tabblad', () => {
    const job = fs.readFileSync(path.join(root, 'src/lib/conceptExtractionJob.ts'), 'utf8');
    expect(job).not.toContain("'/admin?tab=concepts'");
  });
});
