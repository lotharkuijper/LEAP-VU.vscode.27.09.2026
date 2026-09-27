import { describe, it, expect } from 'vitest';
import { sanitizeAvatar, AVATAR_STYLES } from '../personaAvatar.js';

describe('sanitizeAvatar', () => {
  it('neemt een geldige configuratie over', () => {
    const a = { style: 'avataaars', seed: 'Zemouri', options: { top: ['longButNotTooLong'], hairColor: ['2c1b18'], topProbability: 100 } };
    expect(sanitizeAvatar(a)).toEqual(a);
  });

  it('null wist de avatar (terug naar het standaard-robotje)', () => {
    expect(sanitizeAvatar(null)).toBeNull();
  });

  it('weigert onbekende stijlen en rommel', () => {
    expect(sanitizeAvatar({ style: 'adventurer', seed: 'x' })).toBeUndefined();
    expect(sanitizeAvatar('bottts')).toBeUndefined();
    expect(sanitizeAvatar([])).toBeUndefined();
  });

  it('laat onveilige of onbekende waarden weg in plaats van ze op te slaan', () => {
    const out = sanitizeAvatar({
      style: 'bottts',
      seed: 'a'.repeat(200),
      options: {
        eyes: ['bulging', '<script>'], mouth: 'smile', 'bad-key': ['x'], seed: ['override'],
        textureProbability: 500, sidesProbability: 30, nested: { a: 1 },
      },
    });
    expect(out.seed).toHaveLength(64);
    expect(out.options).toEqual({ eyes: ['bulging'], sidesProbability: 30 });
  });

  it('kent precies de stijlen die de app aanbiedt', () => {
    expect(AVATAR_STYLES).toEqual(['bottts', 'avataaars', 'lorelei', 'notionists', 'open-peeps']);
  });
});
