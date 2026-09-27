import { describe, it, expect } from 'vitest';
import { sanitizeAvatar, AVATAR_STYLES, faceFields, changedFaceFields, syncPersonaFace } from '../personaAvatar.js';

// Kleine in-memory database met dezelfde update().eq().select()-vorm als supabase-js.
function memoryDb(tables) {
  return {
    tables,
    from(table) {
      return {
        update(fields) {
          const filters = [];
          const q = {
            eq(col, val) { filters.push([col, val]); return q; },
            async select() {
              const rows = tables[table].filter(r => filters.every(([c, v]) => r[c] === v));
              rows.forEach(r => Object.assign(r, fields));
              return { data: rows.map(r => ({ id: r.id })), error: null };
            },
          };
          return q;
        },
      };
    },
  };
}

describe('syncPersonaFace — één persona, overal hetzelfde gezicht', () => {
  const face = { style: 'avataaars', seed: 's', options: {} };
  const fresh = () => memoryDb({
    course_personas: [{ id: 'T', course_id: 'C1', avatar: null }, { id: 'T2', course_id: 'C2', avatar: null }],
    project_personas: [
      { id: 'P1', source_persona_id: 'T', avatar: null, name: 'Eigen naam' },
      { id: 'P2', source_persona_id: 'T', avatar: null },
      { id: 'P3', source_persona_id: null, avatar: null },
      { id: 'P4', source_persona_id: 'T2', avatar: null },
    ],
  });

  it('sjabloon aangepast → alle projectkopieën krijgen het nieuwe gezicht (regressie)', async () => {
    const db = fresh();
    const r = await syncPersonaFace(db, { templateId: 'T', fields: { avatar: face }, fromTemplate: true });
    expect(r.copies).toBe(2);
    const pp = Object.fromEntries(db.tables.project_personas.map(p => [p.id, p.avatar]));
    expect(pp).toEqual({ P1: face, P2: face, P3: null, P4: null });
    expect(db.tables.project_personas[0].name).toBe('Eigen naam');
  });

  it('kopie aangepast → sjabloon en de andere kopieën volgen', async () => {
    const db = fresh();
    const r = await syncPersonaFace(db, { templateId: 'T', courseId: 'C1', fields: { avatar: face } });
    expect(r).toEqual({ copies: 2, template: true });
    expect(db.tables.course_personas[0].avatar).toEqual(face);
  });

  it('sjabloon van een andere cursus wordt niet aangeraakt', async () => {
    const db = fresh();
    const r = await syncPersonaFace(db, { templateId: 'T2', courseId: 'C1', fields: { avatar: face } });
    expect(r).toEqual({ copies: 0, template: false });
    expect(db.tables.course_personas[1].avatar).toBeNull();
    expect(db.tables.project_personas[3].avatar).toBeNull();
  });

  it('een kopie zonder gezicht die gewoon wordt opgeslagen, maakt het sjabloon niet leeg', () => {
    const before = { avatar: null, avatar_emoji: '🤖' };
    expect(changedFaceFields(before, { name: 'x', avatar: null, avatar_emoji: '🤖' })).toBeNull();
    expect(changedFaceFields(before, { avatar: face, avatar_emoji: '🤖' })).toEqual({ avatar: face });
  });

  it('faceFields pakt alleen het gezicht uit een patch', () => {
    expect(faceFields({ name: 'x', system_prompt: 'y' })).toBeNull();
    expect(faceFields({ name: 'x', avatar: null, avatar_emoji: '🦊' })).toEqual({ avatar: null, avatar_emoji: '🦊' });
  });
});

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
