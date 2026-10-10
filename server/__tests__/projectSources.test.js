// Projectmateriaal citeerbaar (2026-10-10): de persona kreeg documenten van
// de docent en uploads van de groep zonder bronnummer mee en verzon dan een
// voetnoot naar "het cursusmateriaal" die nergens heen ging.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { numberDocumentSources, buildNoSourcesInstructionBlock, buildSourcesInstructionBlock } from '../citationSources.js';

describe('projectdocumenten krijgen een bronnummer', () => {
  it('doorgenummerd na het cursusmateriaal, met soort en id', () => {
    const { sources, context } = numberDocumentSources(
      [{ id: 'pd1', filename: 'Opdracht.pdf', content_text: 'Onderzoek slaap en stress.' }, { id: 'pd2', filename: 'Data.csv', content_text: 'a,b' }],
      { startIndex: 3, kind: 'project_document' },
    );
    expect(sources).toEqual([
      { index: 3, title: 'Opdracht.pdf', kind: 'project_document', documentRef: 'pd1' },
      { index: 4, title: 'Data.csv', kind: 'project_document', documentRef: 'pd2' },
    ]);
    expect(context).toContain('[3] Opdracht.pdf\nOnderzoek slaap en stress.');
    expect(context).toContain('[4] Data.csv');
  });
  it('lange documenten worden ingekort', () => {
    const { context } = numberDocumentSources([{ id: 'x', filename: 'lang.txt', content_text: 'a'.repeat(10000) }], { kind: 'persona_document', maxChars: 100 });
    expect(context.length).toBeLessThan(130);
  });
  it('de verwijsregels noemen ook het projectmateriaal', () => {
    const block = buildSourcesInstructionBlock([{ title: 'Hoorcollege 3' }, { title: 'Opdracht.pdf' }]);
    expect(block).toContain('[2] Opdracht.pdf');
    expect(block).toMatch(/geen voetnoten/);
  });
  it('zonder bronnen: expliciet geen verwijzingen of voetnoten', () => {
    expect(buildNoSourcesInstructionBlock()).toMatch(/géén bronverwijzingen, voetnoten/);
  });
});

describe('persona-chat gebruikt het', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf("app.post('/api/projects/persona-chat'");
  const route = src.slice(start, src.indexOf('\n});\n', start));
  it('projectmateriaal en groepsuploads doorgenummerd; één verwijsblok; zonder bronnen het "geen verwijzingen"-blok', () => {
    expect(route).toContain("kind: 'project_document'");
    expect(route).toContain("kind: 'persona_document'");
    expect(route).toContain('buildNoSourcesInstructionBlock()');
    expect(route).toMatch(/\$\{sourcesRulesBlock\}\$\{langSuffix\}/);
  });
});
