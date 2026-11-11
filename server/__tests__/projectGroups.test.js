import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allServerSource, fileSource, functionSource, routeSource } from './helpers/serverSource.js';
import {
  normalizeGroupMode, defaultGroupMode, studentMayFormGroups, canvasGroupRef, cleanGroupName, splitIntoGroups,
} from '../projects/projectGroups.js';

// Groepsindeling per project (2026-10-27): 'self' (studenten vormen zelf groepen),
// 'teacher' (docent deelt in, open cursussen) of 'canvas' (groepen uit Canvas).
// Bij 'teacher' en 'canvas' doorbreekt een student de indeling niet zelf.

const root = path.resolve(__dirname, '..', '..');
const route = (start) => routeSource(start);

describe('regels', () => {
  it('standaard: Canvas-cursus → via Canvas, anders deelt de docent in', () => {
    expect(defaultGroupMode('canvas')).toBe('canvas');
    expect(defaultGroupMode('canvas_open')).toBe('canvas');
    expect(defaultGroupMode('open')).toBe('teacher');
    expect(defaultGroupMode('closed')).toBe('teacher');
    expect(normalizeGroupMode('x')).toBe('self');
  });
  it('alleen bij "zelf" mag een student een groep maken, aansluiten of opnieuw beginnen', () => {
    expect(studentMayFormGroups({ group_mode: 'self' })).toBe(true);
    expect(studentMayFormGroups({ group_mode: 'teacher' })).toBe(false);
    expect(studentMayFormGroups({ group_mode: 'canvas' })).toBe(false);
    // Oud project zonder group_mode: allow_self_signup bepaalt.
    expect(studentMayFormGroups({ allow_self_signup: false })).toBe(false);
    expect(studentMayFormGroups({})).toBe(true);
  });
  it('Canvas-groep is uniek per platform en groep; namen worden opgeschoond', () => {
    expect(canvasGroupRef('https://canvas.instructure.com', '481')).toBe('canvas:https://canvas.instructure.com:481');
    expect(cleanGroupName('  Groep   3 ')).toBe('Groep 3');
  });
  it('automatisch verdelen: zo gelijk mogelijk rond de gekozen grootte', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);
    const parts = splitIntoGroups(ids, 4);
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.length).sort()).toEqual([3, 3, 4]);
    expect(parts.flat().sort()).toEqual([...ids].sort());
    expect(splitIntoGroups([], 4)).toEqual([]);
    // Nooit groter dan de gekozen grootte (5 studenten, max 4 → 3 + 2, niet 5).
    expect(splitIntoGroups(['a', 'b', 'c', 'd', 'e'], 4).map((p) => p.length).sort()).toEqual([2, 3]);
  });
  it('automatisch verdelen is willekeurig, niet op naam', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);
    let seed = 7;
    const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const parts = splitIntoGroups(ids, 4, rng);
    expect(parts.flat().sort()).toEqual([...ids].sort());
    expect(parts.flat()).not.toEqual(ids);
    expect(parts.every((p) => p.length === 4)).toBe(true);
  });
});

describe('koppeling', () => {
  const GUARD = /if \(!(isStaff && )?!?studentMayFormGroups\(project\)|!studentMayFormGroups\(project\)/;
  it('zelf een groep maken, aansluiten en opnieuw beginnen controleren de groepsindeling', () => {
    expect(route("app.post('/api/projects/groups',")).toMatch(GUARD);
    expect(route("app.post('/api/projects/groups/join'")).toMatch(GUARD);
    expect(route("app.post('/api/projects/student-restart'")).toMatch(GUARD);
  });
  it('de beheerroutes zijn alleen voor de docent van het project (requireProjectStaff)', () => {
    const src = fileSource('server/projects/projectGroups.js');
    expect(src).toMatch(/const access = await deps\.requireProjectStaff\(req\.params\.projectId, auth\.user, profile\);/);
    expect((src.match(/const s = await staff\(req, res\);/g) || []).length).toBe(6);
    expect((allServerSource().match(/registerProjectGroupRoutes\(app, \{/g) || []).length).toBe(1);
  });
  it('een docent die verplaatst gaat voor: Canvas zet een student die al in een groep zit niet terug', () => {
    const fn = functionSource('placeInCanvasGroup');
    expect(fn).toMatch(/const existing = await activeGroupOf\(db, projectId, userId\);\s*if \(existing\) return existing;/);
  });
  it('de Canvas-launch plaatst alleen een student, alleen bij groepsindeling via Canvas', () => {
    const lti = fs.readFileSync(path.join(root, 'server', 'lti', 'lti.js'), 'utf8');
    expect(lti).toMatch(/role === 'student' && project\.group_mode === 'canvas' && group/);
  });
  it('migratie met terugdraaiscript', () => {
    expect(fs.existsSync(path.join(root, 'supabase', 'migrations', '20261027160000_project_group_modes.sql'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261027160000_project_group_modes_down.sql'))).toBe(true);
  });
});

describe('testgroep van de docent (2026-11-11)', () => {
  it('het overzicht geeft docenten en beheerders altijd "uitproberen", ook bij een open project', () => {
    const ov = routeSource("app.get('/api/projects/student-overview'");
    expect(ov).toMatch(/tryout: teacherCourseIds\.has\(c\.id\)/);
    expect(ov).toMatch(/if \(allowed && m\.member_role === 'teacher'\) teacherCourseIds\.add\(c\.id\)/);
  });
  it('de projectenpagina toont de startknop voor wie mag uitproberen', () => {
    const page = fs.readFileSync(path.join(root, 'src', 'pages', 'ProjectsPage.tsx'), 'utf8');
    expect(page).toMatch(/const tryout = !!p\.tryout \|\| !!p\.draft;/);
    expect(page).toMatch(/const selfGroups = \(groupMode === 'self' \|\| tryout\) && !archived;/);
  });
  it('een student maakt nog steeds geen eigen groep als de docent of Canvas indeelt', () => {
    const block = route("app.post('/api/projects/groups',");
    expect(block).toMatch(/if \(!isStaff\) \{[\s\S]*if \(!studentMayFormGroups\(project\)\)/);
  });
});

describe('leden met naam ophalen', () => {
  it('project_group_members verwijst twee keer naar profiles (user_id en added_by): altijd de kolom noemen', () => {
    // Zonder hint weigert de database de vraag ("more than one relationship") en
    // toont de projectruimte 0 leden.
    const src = allServerSource();
    const calls = src.match(/from\('project_group_members'\)[^;]*?profiles[!(][^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/profiles!user_id\(/);
  });
});
