import { describe, it, expect } from 'vitest';
import { visibilityOf, buildPickerRows, filterRows, countsFor, summarize, NO_FILTERS, type PickerConcept } from '../conceptPicker';

const c = (id: string, name: string, extra: Partial<PickerConcept> = {}): PickerConcept => ({ id, name, ...extra });
const concepts = [
  c('1', 'odds ratio', { difficulty: 'hard', review_status: 'approved' }),
  c('2', 'gemiddelde', { difficulty: 'easy', review_status: 'rejected' }),
  c('3', 'casus Jansen', { concept_role: 'example_instance', difficulty: 'easy' }),
  c('4', 'bias', { difficulty: 'hard', review_status: 'needs_review', aliases: ['vertekening'] }),
  c('5', 'mediaan', { difficulty: 'medium', review_status: null }),
];
const docs = { '1': 3, '2': 1, '4': 2, '5': 1 };

describe('keuzelijst begrippen', () => {
  it('status volgt wat studenten zien: goedgekeurd of leeg = zichtbaar', () => {
    expect(visibilityOf('approved')).toBe('visible');
    expect(visibilityOf(null)).toBe('visible');
    expect(visibilityOf('needs_review')).toBe('review');
    expect(visibilityOf('rejected')).toBe('hidden');
  });

  it('vaste volgorde: cursus, module, voorbeeld; moeilijk eerst; dan op naam', () => {
    const rows = buildPickerRows(concepts, docs);
    expect(rows.map((r) => r.concept.name)).toEqual(['bias', 'odds ratio', 'mediaan', 'gemiddelde', 'casus Jansen']);
    expect(rows.map((r) => r.kind)).toEqual(['course', 'course', 'module', 'module', 'example']);
  });

  it('filters combineren; zoeken kijkt ook naar andere namen', () => {
    const rows = buildPickerRows(concepts, docs);
    expect(filterRows(rows, { ...NO_FILTERS, kind: 'course', tier: 'hard' }).map((r) => r.concept.id)).toEqual(['4', '1']);
    expect(filterRows(rows, { ...NO_FILTERS, status: 'review' }).map((r) => r.concept.id)).toEqual(['4']);
    expect(filterRows(rows, { ...NO_FILTERS, q: 'vertek' }).map((r) => r.concept.id)).toEqual(['4']);
  });

  it('aantallen op de knoppen houden rekening met de andere filters', () => {
    const rows = buildPickerRows(concepts, docs);
    const f = { ...NO_FILTERS, tier: 'hard' as const };
    expect(countsFor(rows, f, 'kind')).toEqual({ all: 2, course: 2 });
    expect(countsFor(rows, NO_FILTERS, 'status')).toEqual({ all: 5, visible: 3, review: 1, hidden: 1 });
  });

  it('overzicht: zichtbaar, te beoordelen, verborgen', () => {
    expect(summarize(buildPickerRows(concepts, docs))).toEqual({ total: 5, visible: 3, review: 1, hidden: 1 });
  });
});
