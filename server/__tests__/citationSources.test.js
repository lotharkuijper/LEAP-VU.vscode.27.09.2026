import { describe, it, expect } from 'vitest';
import { buildNumberedRagContext, buildSourcesInstructionBlock, locationFromMetadata } from '../citationSources.js';

// Regressie 2026-09-27: persona "Dr. C. Zemouri" gaf voetnoten als ^1 zonder
// verwijzing naar het cursusmateriaal. De context bevatte alleen "[Bron i]"
// zonder documenttitel of verwijsregels, en er ging geen bronnenlijst mee.
const chunk = (document_id, document_title, similarity, extra = {}) => ({
  document_id, document_title, similarity, content: `inhoud van ${document_title}`, ...extra,
});

describe('buildNumberedRagContext', () => {
  it('nummert per document: meerdere fragmenten uit één document delen hetzelfde [n]', () => {
    const { sources, context } = buildNumberedRagContext([
      chunk('d1', 'Hoorcollege 3 – Confounding', 0.8, { metadata: { pageStart: 12, pageEnd: 13 } }),
      chunk('d2', 'Werkgroep 2', 0.7, { metadata: { source: 'pptx', slideStart: 4 } }),
      chunk('d1', 'Hoorcollege 3 – Confounding', 0.6),
    ]);
    expect(sources).toEqual([
      { index: 1, title: 'Hoorcollege 3 – Confounding', documentId: 'd1', similarity: 0.8, pageStart: 12, pageEnd: 13 },
      { index: 2, title: 'Werkgroep 2', documentId: 'd2', similarity: 0.7, slideStart: 4, slideEnd: 4 },
    ]);
    const labels = context.match(/^\[\d+\] .*$/gm);
    expect(labels).toEqual(['[1] Hoorcollege 3 – Confounding', '[2] Werkgroep 2', '[1] Hoorcollege 3 – Confounding']);
  });

  it('laat fragmenten van documenten buiten de top weg, zodat [n] altijd in de bronnenlijst staat', () => {
    const matched = ['a', 'b', 'c'].map((id, i) => chunk(id, `Doc ${id}`, 0.9 - i / 10));
    const { sources, context } = buildNumberedRagContext(matched, 2);
    expect(sources.map(s => s.index)).toEqual([1, 2]);
    expect(context).not.toContain('Doc c');
  });

  it('geeft niets bij geen treffers', () => {
    expect(buildNumberedRagContext([])).toEqual({ sources: [], context: '' });
  });
});

describe('buildSourcesInstructionBlock', () => {
  it('geeft het model de genummerde lijst en de strikte [n]-verwijsregels', () => {
    const block = buildSourcesInstructionBlock([{ title: 'Hoorcollege 3' }, { title: 'Werkgroep 2' }]);
    expect(block).toContain('[1] Hoorcollege 3');
    expect(block).toContain('[2] Werkgroep 2');
    expect(block).toMatch(/geen voetnoten/);
    expect(buildSourcesInstructionBlock([])).toBe('');
  });
});

describe('locationFromMetadata', () => {
  it('dia bij PowerPoint, pagina bij pdf, niets bij onbekend', () => {
    expect(locationFromMetadata({ source: 'pptx', slideStart: 3, slideEnd: 5 })).toEqual({ slideStart: 3, slideEnd: 5 });
    expect(locationFromMetadata({ pageStart: 7 })).toEqual({ pageStart: 7, pageEnd: 7 });
    expect(locationFromMetadata({ pageStart: 0 })).toEqual({});
    expect(locationFromMetadata(null)).toEqual({});
  });
});
