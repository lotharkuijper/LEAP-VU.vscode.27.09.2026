// Uitnodigingsveld: adressen gescheiden door komma, puntkomma, spatie of regel,
// en een geplakte Outlook-lijst met namen telt alleen de adressen.
import { describe, it, expect } from 'vitest';
import { parseEmailList } from '../emailList';

describe('parseEmailList', () => {
  it('accepteert komma, puntkomma, spatie en nieuwe regel', () => {
    const r = parseEmailList('a@vu.nl, b@vu.nl; c@vu.nl d@vu.nl\ne@vu.nl');
    expect(r.valid).toEqual(['a@vu.nl', 'b@vu.nl', 'c@vu.nl', 'd@vu.nl', 'e@vu.nl']);
    expect(r.invalid).toEqual([]);
  });

  it('slaat namen uit een Outlook-lijst over', () => {
    const text = 'Breet, J.J. (Jordy) j.j.breet@vu.nl;\n\nBruin, M. le (Milan) m.le.bruin@vu.nl;\n'
      + 'Holla, S.K. (Sita) <s.k.holla@student.vu.nl>;';
    const r = parseEmailList(text);
    expect(r.valid).toEqual(['j.j.breet@vu.nl', 'm.le.bruin@vu.nl', 's.k.holla@student.vu.nl']);
    expect(r.invalid).toEqual([]);
  });

  it('meldt kapotte adressen en telt dubbele', () => {
    const r = parseEmailList('x@vu, A@vu.nl a@vu.nl');
    expect(r.valid).toEqual(['a@vu.nl']);
    expect(r.invalid).toEqual(['x@vu']);
    expect(r.duplicates).toBe(1);
  });
});
