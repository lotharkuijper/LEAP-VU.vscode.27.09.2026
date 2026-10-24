// Volgorde en kleur van begrippen (src/lib/conceptOrder.ts) en de voortgang (conceptProgress) — 2026-10-24.
import { describe, it, expect } from 'vitest';
import { sortByCourseOrder, placeColor, phaseOf, type ConceptPlace } from '../conceptOrder';
import { buildConceptProgress } from '../conceptProgress';

const place = (id: string, order: number | null, pos: number | null): ConceptPlace => ({ id, order, pos, unitTitle: null, unitIndex: null, unitCount: 3 });
const places = new Map([place('a', 2, 1), place('b', 0, 0), place('c', 1, 0.5), place('z', null, null)].map(p => [p.id, p]));
const items = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alfa' }, { id: 'c', name: 'Gamma' }, { id: 'b', name: 'Bèta' }, { id: 'y', name: 'Ypsilon' }];

describe('volgorde van de stof', () => {
  it('op volgorde van eerste voorkomen; zonder plek achteraan, alfabetisch', () => {
    expect(sortByCourseOrder(items, x => x.id, x => x.name, places).map(x => x.id)).toEqual(['b', 'c', 'a', 'y', 'z']);
  });
  it('zonder volgorde: alfabetisch', () => {
    expect(sortByCourseOrder(items, x => x.id, x => x.name, null).map(x => x.name)).toEqual(['Alfa', 'Bèta', 'Gamma', 'Ypsilon', 'Zeta']);
  });
});

describe('kleur en fase', () => {
  it('één kleur van licht (begin) naar donker (eind), uit het palet; onbekend is grijs', () => {
    expect(placeColor(0)).toBe('rgb(var(--leap-brand-300))');
    expect(placeColor(1)).toBe('rgb(var(--leap-brand-950))');
    expect(placeColor(null)).toBe('rgb(var(--leap-ink-300))');
    expect(placeColor(0.5)).not.toMatch(/#/);
  });
  it('begin, midden, eind', () => {
    expect([0, 0.5, 0.9, null].map(phaseOf)).toEqual(['begin', 'middle', 'end', 'unknown']);
  });
});

describe('Jouw voortgang', () => {
  it('nieuwe begrippen op volgorde van de stof; lastig en herhalen blijven voorgaan', () => {
    const topics = [{ id: 'a', name: 'Alfa' }, { id: 'b', name: 'Bèta' }, { id: 'c', name: 'Gamma' }];
    const now = new Date('2026-10-24T12:00:00Z');
    const attempts = [{ topics: ['Alfa'], score_percentage: 30, created_at: '2026-10-23T12:00:00Z' }];
    const order = (id: string) => places.get(id)?.order ?? null;
    expect(buildConceptProgress(topics, attempts, now, order).map(p => p.id)).toEqual(['a', 'b', 'c']);
    expect(buildConceptProgress(topics, [], now, order).map(p => p.id)).toEqual(['b', 'c', 'a']);
    expect(buildConceptProgress(topics, [], now).map(p => p.id)).toEqual(['a', 'b', 'c']);
  });
});
