import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMigrationFile, planMigrations, needsBaseline } from '../migrationPlan.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');

describe('planMigrations', () => {
  it('geeft de nog niet uitgevoerde migraties in volgorde', () => {
    const files = ['20260102000000_b.sql', '20260101000000_a.sql', '20260103000000_c.sql'];
    expect(planMigrations(files, ['20260101000000_a.sql'])).toEqual({
      pending: ['20260102000000_b.sql', '20260103000000_c.sql'],
      missing: [],
    });
  });

  it('slaat andere bestanden in de map over', () => {
    const { pending } = planMigrations(['README.md', '.DS_Store', 'notes.sql', '20260101000000_a.sql'], []);
    expect(pending).toEqual(['20260101000000_a.sql']);
  });

  it('meldt migraties die wel zijn uitgevoerd maar niet meer bestaan', () => {
    const { pending, missing } = planMigrations(['20260101000000_a.sql'], ['20260101000000_a.sql', '20250101000000_weg.sql']);
    expect(pending).toEqual([]);
    expect(missing).toEqual(['20250101000000_weg.sql']);
  });

  it('herkent elk bestand in supabase/migrations als migratie', () => {
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => !isMigrationFile(f))).toEqual([]);
    expect(planMigrations(files, []).pending).toHaveLength(files.length);
  });

  it('zet een migratie met alleen een datum op de goede dag in de volgorde', () => {
    const files = ['20260404120000_c.sql', '20260403_b.sql', '20260403090000_a.sql', '20260402230000_z.sql'];
    expect(planMigrations(files, []).pending).toEqual([
      '20260402230000_z.sql',
      '20260403090000_a.sql',
      '20260403_b.sql',
      '20260404120000_c.sql',
    ]);
  });
});

describe('needsBaseline', () => {
  it('weigert alles opnieuw uit te voeren op een overgezette database', () => {
    expect(needsBaseline({ appliedCount: 0, hasExistingSchema: true })).toBe(true);
  });
  it('laat een lege database en een bijgehouden database door', () => {
    expect(needsBaseline({ appliedCount: 0, hasExistingSchema: false })).toBe(false);
    expect(needsBaseline({ appliedCount: 117, hasExistingSchema: true })).toBe(false);
  });
});
