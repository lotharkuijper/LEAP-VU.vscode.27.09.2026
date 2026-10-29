// Beveiligingsronde 2026-10-30: bewaakt dat de databaseregels uit
// 20261030100000_security_hardening.sql blijven staan, en dat de migraties een
// nieuwe database vanaf nul kunnen opbouwen. De werking zelf is getest op een
// lokale database (scripts/local-db/, test-security-hardening.sql).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const migration = read('supabase/migrations/20261030100000_security_hardening.sql');

describe('databaseregels na de beveiligingsronde', () => {
  it('de browser kan geen projectgroepen maken, verhangen of zich zelf aanmelden', () => {
    for (const p of ['project_groups_insert ON public.project_groups', 'project_groups_update ON public.project_groups', 'pgm_insert ON public.project_group_members']) {
      expect(migration).toContain(`DROP POLICY IF EXISTS ${p}`);
    }
  });
  it('projectdocumenten: docent van DEZE cursus; studenten alleen zichtbare documenten zonder rubric', () => {
    const policy = migration.slice(migration.indexOf('CREATE POLICY project_documents_select'));
    expect(policy).toMatch(/pr_is_course_staff\(p\.course_id\)/);
    expect(policy).toMatch(/is_visible_to_students/);
    expect(policy).toMatch(/material_kind, ''\) <> 'rubric'/);
    expect(policy).not.toMatch(/'docent'/); // geen globale docentrol meer
  });
  it('profiles.email wijzigt alleen een beheerder of de server', () => {
    expect(migration).toMatch(/NEW\.email IS DISTINCT FROM OLD\.email/);
  });
  it('er is een rollback', () => {
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261030100000_security_hardening_down.sql'))).toBe(true);
  });
});

describe('migraties bouwen een nieuwe database vanaf nul', () => {
  it('course_members en profiles.last_active_course_id bestaan vóór de eerste migratie die ze gebruikt', () => {
    const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
    const firstUse = (re) => files.find((f) => re.test(read(`supabase/migrations/${f}`)) && !/_baseline\.sql$/.test(f));
    const cm = files.indexOf('20260507090000_course_members_baseline.sql');
    const lac = files.indexOf('20260608100000_profiles_last_active_course_baseline.sql');
    expect(cm).toBeGreaterThanOrEqual(0);
    expect(lac).toBeGreaterThanOrEqual(0);
    expect(cm).toBeLessThan(files.indexOf(firstUse(/\bcourse_members\b/)));
    expect(lac).toBeLessThan(files.indexOf(firstUse(/last_active_course_id/)));
  });
  it('de basismigraties doen niets op een database die al bestaat', () => {
    expect(read('supabase/migrations/20260507090000_course_members_baseline.sql')).toMatch(/CREATE TABLE IF NOT EXISTS public\.course_members/);
    expect(read('supabase/migrations/20260608100000_profiles_last_active_course_baseline.sql')).toMatch(/ADD COLUMN IF NOT EXISTS last_active_course_id/);
  });
});
