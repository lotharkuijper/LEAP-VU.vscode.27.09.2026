import { describe, it, expect } from 'vitest';
import {
  parseSearchRecord, recordSearch, isUnsearched, describeSearchScope,
  parseRemovedKeys, withoutRemoved, planStaleConcepts, conceptCourseId, keepAsHidden,
} from '../concepts/conceptSearchScope.js';
import { conceptKey } from '../concepts/conceptConsolidation.js';

const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-10T10:00:00.000Z';
const T2 = '2026-11-20T10:00:00.000Z';

describe('parseSearchRecord', () => {
  it('leest oud en nieuw formaat en negeert rommel', () => {
    expect(parseSearchRecord(JSON.stringify({ lastRegenAt: T1 }))).toEqual({ lastRegenAt: T1, searched: {} });
    expect(parseSearchRecord('geen json')).toEqual({ lastRegenAt: null, searched: {} });
    expect(parseSearchRecord({ lastRegenAt: T1, searched: { a: T1, b: 'nonsens', c: 3 } }).searched).toEqual({ a: T1 });
  });
});

describe('recordSearch', () => {
  it('voegt gelezen documenten toe en houdt eerdere', () => {
    const r1 = recordSearch(null, ['a'], T1);
    const r2 = recordSearch(JSON.stringify(r1), ['b'], T2);
    expect(r2).toEqual({ lastRegenAt: T2, searched: { a: T1, b: T2 } });
  });
});

describe('isUnsearched', () => {
  const rec = { lastRegenAt: T1, searched: { a: T1 } };
  it('doorzocht en daarna niet gewijzigd = niet nieuw', () => {
    expect(isUnsearched({ id: 'a', created_at: T0, updated_at: T0 }, rec)).toBe(false);
  });
  it('na het zoeken opnieuw ingelezen = gewijzigd', () => {
    expect(isUnsearched({ id: 'a', created_at: T0, updated_at: T2 }, rec)).toBe(true);
  });
  it('nooit doorzocht = nieuw, ook als het ouder is', () => {
    expect(isUnsearched({ id: 'b', created_at: T0, updated_at: T0 }, rec)).toBe(true);
  });
  it('oude cursus zonder lijst: alleen wat na de laatste zoektocht kwam', () => {
    const old = { lastRegenAt: T1 };
    expect(isUnsearched({ id: 'x', created_at: T0, updated_at: T0 }, old)).toBe(false);
    expect(isUnsearched({ id: 'y', created_at: T2, updated_at: T2 }, old)).toBe(true);
  });
  it('nog nooit gezocht: alles is nieuw', () => {
    expect(isUnsearched({ id: 'x', created_at: T0 }, null)).toBe(true);
  });
});

describe('describeSearchScope', () => {
  it('zet nieuwe bestanden bovenaan', () => {
    const out = describeSearchScope(
      [{ id: 'a', title: 'Week 1', created_at: T0 }, { id: 'b', title: 'Week 2', created_at: T2 }],
      { lastRegenAt: T1, searched: { a: T1 } },
    );
    expect(out).toEqual([{ id: 'b', title: 'Week 2', isNew: true }, { id: 'a', title: 'Week 1', isNew: false }]);
  });
});

describe('withoutRemoved', () => {
  it('slaat verwijderde begrippen over, ook via een alias of spellingvariant', () => {
    const removed = parseRemovedKeys(JSON.stringify([conceptKey('Herkansing'), conceptKey('Confounder')]));
    const { kept, skipped } = withoutRemoved(
      [{ name: 'herkansingen' }, { name: 'Verstorende variabele', aliases: ['confounders'] }, { name: 'Bias' }],
      removed, conceptKey,
    );
    expect(kept.map((c) => c.name)).toEqual(['Bias']);
    expect(skipped).toEqual(['herkansingen', 'Verstorende variabele']);
  });
  it('zonder verwijderde begrippen verandert er niets', () => {
    const list = [{ name: 'Bias' }];
    expect(withoutRemoved(list, new Set(), conceptKey).kept).toBe(list);
  });
});

describe('conceptCourseId', () => {
  it('course_id gaat voor de oude markering in key_points', () => {
    expect(conceptCourseId({ course_id: 'B', key_points: ['course_id:A'] })).toBe('B');
    expect(conceptCourseId({ course_id: null, key_points: ['x', 'course_id:A'] })).toBe('A');
    expect(conceptCourseId({ course_id: null, key_points: [] })).toBeNull();
  });
});

describe('keepAsHidden', () => {
  it('verbergt wat studenten konden zien of waar quizbronnen aan hangen; verwijdert de rest', () => {
    expect(keepAsHidden({ id: 'a', review_status: 'approved' }, new Set())).toBe(true);
    expect(keepAsHidden({ id: 'a', review_status: null }, new Set())).toBe(true);
    expect(keepAsHidden({ id: 'b', review_status: 'rejected' }, new Set(['b']))).toBe(true);
    expect(keepAsHidden({ id: 'c', review_status: 'needs_review' }, new Set())).toBe(false);
    expect(keepAsHidden({ id: 'd', review_status: 'rejected' }, new Set())).toBe(false);
  });
});

describe('planStaleConcepts', () => {
  it('verbergt wat werk van studenten of quizbronnen heeft, verwijdert de rest', () => {
    expect(planStaleConcepts(['a', 'b', 'c'], new Set(['b']))).toEqual({ hideIds: ['b'], deleteIds: ['a', 'c'] });
  });
});
