import { describe, it, expect } from 'vitest';
import { searchBody, defaultSearchMode, describeSearchResult } from '../conceptSearch';

describe('searchBody', () => {
  it('alleen gekozen bestanden: aanvullen met documentIds', () => {
    expect(searchBody('c1', 'files', 'auto', ['d1', 'd2'])).toEqual({ courseId: 'c1', replace: false, documentIds: ['d1', 'd2'] });
  });
  it('alle leerstof: aanvullen zonder selectie', () => {
    expect(searchBody('c1', 'all', 'nl', ['d1'])).toEqual({ courseId: 'c1', replace: false, language: 'nl' });
  });
  it('opnieuw samenstellen: altijd uit alle leerstof', () => {
    expect(searchBody('c1', 'rebuild', 'auto', ['d1'])).toEqual({ courseId: 'c1', replace: true });
  });
});

describe('defaultSearchMode', () => {
  it('met nieuwe bestanden: alleen daarin zoeken; anders alles aanvullen', () => {
    expect(defaultSearchMode(2)).toBe('files');
    expect(defaultSearchMode(0)).toBe('all');
  });
});

describe('describeSearchResult', () => {
  it('nieuwe begrippen die beoordeeld moeten worden', () => {
    const lines = describeSearchResult({ concepts: [{ name: 'Bias' }, { name: 'Confounder' }], needsReview: true, removedSkipped: 1 }, 'files');
    expect(lines[0]).toEqual({ key: 'material.search.result.foundReview', vars: { n: '2', names: 'Bias, Confounder' } });
    expect(lines[1]).toEqual({ key: 'material.search.result.removedSkipped', vars: { n: '1' } });
  });
  it('niets nieuws gevonden', () => {
    expect(describeSearchResult({ concepts: [] }, 'all')).toEqual([{ key: 'material.search.result.none' }]);
  });
  it('opnieuw samengesteld met verborgen en verwijderde begrippen', () => {
    const keys = describeSearchResult({ netTotal: 40, staleDeleted: 3, staleHidden: 2, failedDocuments: ['H3'] }, 'rebuild').map((l) => l.key);
    expect(keys).toEqual([
      'material.search.result.rebuilt', 'material.search.result.staleDeleted',
      'material.search.result.staleHidden', 'material.search.result.failed',
    ]);
  });
});
